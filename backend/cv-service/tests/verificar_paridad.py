"""Comprueba que el modelo exportado a JSON sigue siendo el .tflite.

    python tests/verificar_paridad.py

Que hace:

1. Corre el interprete de TFLite sobre ventanas aleatorias.
2. Corre la misma cuenta con los pesos de `ml/fisioclin_lstm_pesos.json`,
   que es lo que empaqueta la app.
3. Compara. Si difieren, el export esta mal y la app esta prediciendo
   otra cosa que el modelo entrenado.
4. Regenera `ml/fisioclin_vector_prueba.json`, el caso que la app usa
   para comprobarse a si misma en el telefono (`autoprueba()` en
   lib/fisioclin/modelo.ts). Eso cubre lo que esta prueba no puede ver:
   que Hermes calcule igual que Node y que CPython.

Necesita tensorflow, que el servicio en si no usa:

    pip install tensorflow==2.17.1

Volver a correrlo cada vez que se reentrene el modelo.
"""
from __future__ import annotations

import json
import os
import sys

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
SERVICIO = os.path.dirname(AQUI)
APP_ML = os.path.join(os.path.dirname(os.path.dirname(SERVICIO)), "ml")

TFLITE = os.path.join(SERVICIO, "fisioclin_lstm.tflite")
PESOS = os.path.join(APP_ML, "fisioclin_lstm_pesos.json")
ESCALADOR = os.path.join(APP_ML, "fisioclin_escalador.json")

#: Por encima de esto el export esta roto. El ruido esperable es ~3e-4:
#: los pesos del .tflite son int8 y la app trabaja en float32.
TOLERANCIA = 1e-3


def cargar_json(ruta):
    with open(ruta, encoding="utf-8") as f:
        return json.load(f)


def lstm(capa, seq, devolver_secuencia):
    u, ent = capa["unidades"], capa["entrada"]
    W = np.array(capa["W"], np.float32).reshape(4 * u, ent)
    U = np.array(capa["U"], np.float32).reshape(4 * u, u)
    b = np.array(capa["b"], np.float32)
    h = np.zeros(u, np.float32)
    c = np.zeros(u, np.float32)
    salida = []
    sig = lambda x: 1 / (1 + np.exp(-x))
    for x in seq:
        z = W @ x + U @ h + b
        i, f, g, o = z[:u], z[u:2 * u], z[2 * u:3 * u], z[3 * u:]
        c = sig(f) * c + sig(i) * np.tanh(g)
        h = sig(o) * np.tanh(c)
        salida.append(h.copy())
    return np.array(salida) if devolver_secuencia else h


def afin(m, x, filas, cols):
    W = np.array(m["W"], np.float32).reshape(filas, cols)
    return W @ x + np.array(m["b"], np.float32)


def softmax(z):
    e = np.exp(z - z.max())
    return e / e.sum()


def predecir_desde_json(pesos, escalador, crudo):
    media = np.array(escalador["media"], np.float32)
    desv = np.array(escalador["desviacion"], np.float32)
    x = (crudo - media) / np.where(desv > 1e-9, desv, 1.0)
    s1 = lstm(pesos["lstm1"], x, True)
    h2 = lstm(pesos["lstm2"], s1, False)
    d = np.maximum(afin(pesos["densa"], h2, pesos["densa"]["unidades"],
                        pesos["densa"]["entrada"]), 0)
    n = pesos["densa"]["unidades"]
    return (softmax(afin(pesos["cabeza_ejercicio"], d, pesos["cabeza_ejercicio"]["clases"], n)),
            softmax(afin(pesos["cabeza_calidad"], d, pesos["cabeza_calidad"]["clases"], n)))


#: Campos que `lib/fisioclin/evaluador.ts` da por hechos en cada ficha del
#: catalogo. El JSON viene del dataset y TypeScript no puede comprobarlo,
#: asi que se comprueba aqui.
CAMPOS_FICHA = (
    "id", "ejercicio", "grupo", "postura", "senal", "bilateral",
    "articulacion_medida", "medible_goniometricamente", "rom_esperado_max",
    "tempo_esperado", "sentido", "umbrales",
)

#: Ademas de los anteriores, en los ejercicios que si se pueden contar.
#: Los tres sin banda medida (C09, R03, R10) no los traen, y no hace falta:
#: el evaluador se niega a arrancar con ellos.
CAMPOS_CONTABLES = ("tronco_mediano_grados",)


def revisar_catalogo() -> list[str]:
    """Devuelve los problemas encontrados en configuracion_ejercicios.json."""
    ruta = os.path.join(APP_ML, "configuracion_ejercicios.json")
    fichas = cargar_json(ruta)["ejercicios"]
    problemas = []
    for id_ej, ficha in fichas.items():
        faltan = [c for c in CAMPOS_FICHA if c not in ficha]
        if faltan:
            problemas.append(f"{id_ej}: faltan campos {', '.join(faltan)}")
        u = ficha.get("umbrales")
        if u is None:
            continue
        faltan = [c for c in CAMPOS_CONTABLES if c not in ficha]
        if faltan:
            problemas.append(f"{id_ej}: es contable pero le faltan {', '.join(faltan)}")
        if not {"bajo", "alto", "prominencia_minima"} <= set(u):
            problemas.append(f"{id_ej}: umbrales incompletos")
        elif u["bajo"] >= u["alto"]:
            problemas.append(f"{id_ej}: umbral bajo ({u['bajo']}) >= alto ({u['alto']})")
        if ficha.get("sentido") not in ("desciende", "asciende"):
            problemas.append(
                f"{id_ej}: tiene umbrales pero sentido={ficha.get('sentido')!r}; "
                "el contador no sabria hacia donde va el movimiento")
    return problemas


def main() -> int:
    problemas = revisar_catalogo()
    if problemas:
        print("Problemas en el catalogo de ejercicios:")
        for p in problemas:
            print("  -", p)
        return 1

    try:
        import tensorflow as tf
    except ImportError:
        print("Falta tensorflow. Instalalo solo para esta prueba:")
        print("    pip install tensorflow==2.17.1")
        return 2

    for ruta in (TFLITE, PESOS, ESCALADOR):
        if not os.path.exists(ruta):
            print(f"No encuentro {ruta}")
            return 2

    pesos = cargar_json(PESOS)
    escalador = cargar_json(ESCALADOR)
    media = np.array(escalador["media"], np.float32)
    desv = np.array(escalador["desviacion"], np.float32)

    interprete = tf.lite.Interpreter(model_path=TFLITE)
    firma = interprete.get_signature_runner("serving_default")

    rng = np.random.default_rng(7)
    peor = 0.0
    desacuerdos = 0
    vectores = []

    for _ in range(16):
        # Ventana en unidades reales (grados, grados/s), como la que arma la app.
        crudo = (rng.normal(0, 1, (30, 14)) * desv + media).astype(np.float32)
        escalado = ((crudo - media) / desv).astype(np.float32)
        ref = firma(secuencia_in=escalado[None])
        ref_ej, ref_cal = ref["output_0"][0], ref["output_1"][0]

        ej, cal = predecir_desde_json(pesos, escalador, crudo)
        peor = max(peor, float(np.abs(ref_ej - ej).max()), float(np.abs(ref_cal - cal).max()))
        if int(ref_ej.argmax()) != int(ej.argmax()) or int(ref_cal.argmax()) != int(cal.argmax()):
            desacuerdos += 1

        vectores.append({
            "crudo": crudo.ravel().tolist(),
            "ejercicio": ref_ej.tolist(),
            "calidad": ref_cal.tolist(),
        })

    # La app solo necesita un caso para comprobarse en el telefono.
    destino = os.path.join(APP_ML, "fisioclin_vector_prueba.json")
    with open(destino, "w", encoding="utf-8") as f:
        json.dump({
            "nota": "Salida del interprete de TFLite para esta ventana. "
                    "La usa autoprueba() en lib/fisioclin/modelo.ts.",
            "tolerancia": TOLERANCIA,
            "ventana": vectores[0]["crudo"],
            "ejercicio": vectores[0]["ejercicio"],
            "calidad": vectores[0]["calidad"],
        }, f, ensure_ascii=False)

    print(f"ventanas comparadas : {len(vectores)}")
    print(f"error maximo        : {peor:.2e}   (tolerancia {TOLERANCIA:.0e})")
    print(f"argmax distinto     : {desacuerdos}")
    print(f"vector para la app  : {destino}")

    if peor > TOLERANCIA or desacuerdos:
        print("\nFALLA: el JSON de la app no reproduce el .tflite.")
        return 1
    print("\nOK: la app predice lo mismo que el modelo entrenado.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
