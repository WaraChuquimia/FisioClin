"""Etapa 11: destila el dataset en un archivo de configuracion para la app.

La app no puede cargar 26 MB de CSV para saber como se cuenta una
repeticion de puente de gluteos. Necesita un archivo pequeno con, por cada
ejercicio, lo que el dataset aprendio de el:

* que angulo lo describe y de que lado se mide
* en que sentido va el ciclo -- un puente EMPIEZA arriba y una elevacion de
  rodilla empieza abajo, y un contador que solo entiende un sentido detecta
  la mitad de los ejercicios
* la banda angular observada, para poner los umbrales de histeresis
* cuanto dura una repeticion y cuanto se mueve el tronco, para los
  indicadores de tempo y compensacion
* los criterios clinicos de la ficha

Todo sale del dataset y de la ficha, nada esta escrito a mano aqui.

    python artrosis_11_configuracion.py
"""
from __future__ import annotations

import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
SALIDA = RAIZ / "07_modelo/configuracion_ejercicios.json"

MIN_REPS = 2   # con menos de esto no se publica banda medida


def main() -> int:
    ficha = {f["id"]: f for f in csv.DictReader(
        (RAIZ / "referencia/ficha_normalizada.csv").open(encoding="utf-8"))}
    reps = list(csv.DictReader(
        (RAIZ / "05_repeticiones/repeticiones.csv").open(encoding="utf-8")))

    por_id = defaultdict(list)
    for r in reps:
        por_id[r["id"]].append(r)

    salida = {}
    for vid, f in sorted(ficha.items()):
        rs = por_id.get(vid, [])

        def col(nombre):
            return np.array([float(x[nombre]) for x in rs if x.get(nombre)])

        rom = col("rom_grados")
        minimos = col("flex_min_grados")
        maximos = col("flex_max_grados")
        duracion = col("duracion_s")
        tronco = col("rom_tronco_grados")
        sentidos = [x["sentido"] for x in rs if x.get("sentido")]

        medido = len(rs) >= MIN_REPS
        entrada = {
            "id": vid,
            "ejercicio": f["ejercicio"],
            "grupo": f["grupo"],
            "tipo": f["tipo"],
            "postura": f["postura"],

            # --- que se mide -------------------------------------------
            "articulacion_objetivo": f["articulacion_objetivo"],
            "articulacion_medida": f["articulacion_medida"],
            "movimiento": f["movimiento"],
            "plano": f["plano_movimiento"],
            "senal": ("abduccion" if f["movimiento"] == "abduccion" else "flexion"),
            "bilateral": f["bilateral_medido"] == "1",
            "lado_trabajado": f["lado_trabajado"],

            # --- fiabilidad de la medicion -----------------------------
            "alineado_con_camara": f["alineado_con_camara"],
            "desalineacion_grados": f["desalineacion_grados"],
            "medible_goniometricamente": f["alineado_con_camara"] != "no",

            # --- criterio clinico, de la ficha -------------------------
            "rom_esperado_min": f["rom_esperado_min_grados"],
            "rom_esperado_max": f["rom_esperado_max_grados"],
            "tolerancia_rom": f["tolerancia_rom_grados"],
            "tempo_esperado": f["tempo_esperado"],
            "criterio_ejecucion": f["criterio_ejecucion_correcta"],
            "errores_esperables": [e for e in f["errores_esperables"].split(";") if e],
            "compensaciones": [c for c in f["compensaciones_a_vigilar"].split(";") if c],
            "validado_por": f["validado_por"],

            # --- lo que aprendio el dataset ----------------------------
            "repeticiones_observadas": len(rs),
        }

        if medido:
            # El sentido del ciclo. Un contador que solo entiende
            # valle-pico-valle pierde todos los ejercicios que empiezan
            # arriba, que en este catalogo son la mitad.
            entrada["sentido"] = Counter(sentidos).most_common(1)[0][0] \
                if sentidos else "asciende"
            entrada["banda_observada"] = {
                "flex_min_p25": round(float(np.percentile(minimos, 25)), 1),
                "flex_max_p75": round(float(np.percentile(maximos, 75)), 1),
                "rom_mediano": round(float(np.median(rom)), 1),
                "rom_p25": round(float(np.percentile(rom, 25)), 1),
                "rom_p75": round(float(np.percentile(rom, 75)), 1),
            }
            # Umbrales de histeresis: se cruza al 30 % y al 70 % del
            # recorrido observado, no en un punto unico. Asi un temblor
            # en el umbral no cuenta dos repeticiones.
            lo = float(np.percentile(minimos, 25))
            hi = float(np.percentile(maximos, 75))
            entrada["umbrales"] = {
                "bajo": round(lo + 0.30 * (hi - lo), 1),
                "alto": round(lo + 0.70 * (hi - lo), 1),
                "prominencia_minima": round(max(10.0, 0.35 * float(np.median(rom))), 1),
            }
            entrada["duracion_esperada_s"] = {
                "p25": round(float(np.percentile(duracion, 25)), 1),
                "mediana": round(float(np.median(duracion)), 1),
                "p75": round(float(np.percentile(duracion, 75)), 1),
            }
            entrada["tronco_mediano_grados"] = round(float(np.median(tronco)), 1) \
                if len(tronco) else None
        else:
            entrada["sentido"] = None
            entrada["banda_observada"] = None
            entrada["umbrales"] = None
            entrada["aviso"] = (
                "Sin repeticiones suficientes en el dataset ({}). El conteo en vivo "
                "no tiene banda de referencia medida para este ejercicio.".format(len(rs)))

        salida[vid] = entrada

    doc = {
        "version": "1.0",
        "origen": "generado por artrosis_11_configuracion.py desde ficha_normalizada.csv y repeticiones.csv",
        "aviso": (
            "Las bandas y umbrales salen de las demostraciones del catalogo, no de "
            "pacientes. Sirven para detectar y describir el movimiento; el criterio "
            "de si una ejecucion es aceptable es el de la ficha clinica."),
        "ejercicios": salida,
    }
    SALIDA.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")

    listos = sum(1 for e in salida.values() if e["umbrales"])
    print("{} ejercicios -> {}".format(len(salida), SALIDA))
    print("con banda medida: {} | sin banda: {}".format(listos, len(salida) - listos))
    print("medibles goniometricamente: {}".format(
        sum(1 for e in salida.values() if e["medible_goniometricamente"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
