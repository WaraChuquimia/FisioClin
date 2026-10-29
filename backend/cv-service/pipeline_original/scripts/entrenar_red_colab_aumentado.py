"""FisioClin — entrenamiento de la red temporal con aumento de datos.
Version autonoma para Google Colab.

Es `entrenar_red_colab.py` (ya existente en el proyecto) + aumento de
datos sintetico, para intentar subir el 0,558 por tanda documentado
(dataset/documentacion/08_modelo.md) — el techo real es tener solo 2
sujetos en el material, asi que esto no lo resuelve del todo, pero da mas
variedad de ROM/ritmo al entrenamiento sin inventar ejercicios que nunca
se grabaron.

## Como correrlo en Colab

    # 1. Activar GPU: Entorno de ejecucion -> Cambiar tipo de entorno -> GPU
    # 2. Subir estos DOS archivos (estan en dataset/06_ventanas/ del
    #    paquete): ventanas.npz y clases.json
    from google.colab import files
    files.upload()
    !pip install -q scikit-learn
    !python entrenar_red_colab_aumentado.py --semillas 5 --aumento 3

## Que hace el aumento (y por que, canal por canal)

Las ventanas de ENTRENAMIENTO (nunca las de prueba, nunca antes de partir
por escena) se multiplican con variaciones fisiologicamente plausibles:

  - Angulos e inclinacion de tronco: ruido gaussiano de ~1 grado (el orden
    de magnitud del ruido de deteccion de MediaPipe) + escalado de
    amplitud +-5% por ventana (otro cuerpo con un poco mas o menos ROM en
    el mismo movimiento).
  - Velocidades: ruido proporcional del 5% (vienen de derivar angulos ya
    ruidosos).
  - Deformacion temporal: cada ventana se remuestrea a 90%-110% de su
    ritmo y se recorta/rellena de vuelta a 30 pasos (la misma repeticion,
    un poco mas rapida o mas lenta).
  - NO se toca `visibilidad` ni `contra_presente`: son señales de si hay
    dato, no mediciones con ruido fisico.
  - NO hay espejo izquierda/derecha: el vector ya esta canonizado como
    lado medido/contralateral (artrosis_07_ventanas.py); espejar no
    cambia el dato.

Con `--aumento 0` este script entrena exactamente igual que
`entrenar_red_colab.py` (sirve para comparar antes/despues en la misma
corrida).

Arquitecturas disponibles: `lstm` (la del proyecto), `gru`,
`lstm_profunda`, `bilstm`. Compararlas es valido para la tesis, pero
siempre con la misma particion y varias semillas: con 899 ventanas la
diferencia entre dos folds pesa mas que la diferencia entre dos
arquitecturas.

## Lo que este script NO permite hacer, a proposito

* **Partir al azar.** Las ventanas se solapan dos tercios: dos
  consecutivas son casi el mismo dato. Repartir al azar da una exactitud
  altisima y falsa. Siempre se agrupa por escena.
* **Aumentar antes de partir, o aumentar la prueba.** Seria fuga de
  informacion: el modelo veria variantes de una ventana que despues se
  usa para medir que tan bien generaliza.
* **Escalar antes de partir.** La media y la desviacion se calculan solo
  con el fold de entrenamiento (ya aumentado).
* **Reportar una sola cifra.** Siempre media y desviacion sobre todas las
  corridas, y la linea base al lado.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np
from sklearn.metrics import confusion_matrix, f1_score
from sklearn.model_selection import StratifiedGroupKFold

EPOCAS = 80
PACIENCIA = 15
LOTE = 32
APRENDIZAJE = 1e-3
PESO_CALIDAD = 0.3        # cuanto pesa la cabeza de calidad en la perdida

#: Indices del vector de 14 features (artrosis_07_ventanas.py): 0-8
#: angulos e inclinacion de tronco, 9-11 velocidades, 12-13
#: visibilidad/contra_presente (no se tocan, no son mediciones continuas).
CANALES_ANGULO = list(range(0, 9))
CANALES_VELOCIDAD = [9, 10, 11]

RUIDO_ANGULO_GRADOS = 1.0
RUIDO_VELOCIDAD_FRAC = 0.05
ESCALA_AMPLITUD = (0.95, 1.05)
ESCALA_TIEMPO = (0.90, 1.10)


# ---------------------------------------------------------------------
# ARQUITECTURAS
# ---------------------------------------------------------------------
def construir(nombre, n_pasos, n_features, n_clases, n_calidad):
    from tensorflow import keras
    from tensorflow.keras import layers

    entrada = keras.Input(shape=(n_pasos, n_features), name="secuencia")

    if nombre == "lstm":                       # la del proyecto
        x = layers.LSTM(64, return_sequences=True)(entrada)
        x = layers.Dropout(0.3)(x)
        x = layers.LSTM(32)(x)
        x = layers.Dropout(0.3)(x)
    elif nombre == "gru":
        x = layers.GRU(64, return_sequences=True)(entrada)
        x = layers.Dropout(0.3)(x)
        x = layers.GRU(32)(x)
        x = layers.Dropout(0.3)(x)
    elif nombre == "lstm_profunda":
        x = layers.LSTM(96, return_sequences=True)(entrada)
        x = layers.Dropout(0.3)(x)
        x = layers.LSTM(64, return_sequences=True)(x)
        x = layers.Dropout(0.3)(x)
        x = layers.LSTM(32)(x)
        x = layers.Dropout(0.3)(x)
    elif nombre == "bilstm":
        x = layers.Bidirectional(layers.LSTM(64, return_sequences=True))(entrada)
        x = layers.Dropout(0.3)(x)
        x = layers.Bidirectional(layers.LSTM(32))(x)
        x = layers.Dropout(0.3)(x)
    else:
        raise ValueError("Arquitectura desconocida: " + nombre)

    tronco = layers.Dense(32, activation="relu")(x)
    salida_ej = layers.Dense(n_clases, activation="softmax", name="ejercicio")(tronco)
    salida_ca = layers.Dense(n_calidad, activation="softmax", name="calidad")(tronco)

    modelo = keras.Model(entrada, [salida_ej, salida_ca])
    modelo.compile(
        optimizer=keras.optimizers.Adam(APRENDIZAJE),
        loss=["sparse_categorical_crossentropy"] * 2,
        loss_weights=[1.0, PESO_CALIDAD],
    )
    return modelo


# ---------------------------------------------------------------------
# AUMENTO DE DATOS (solo se aplica al fold de entrenamiento)
# ---------------------------------------------------------------------
def _deformar_tiempo(ventana: np.ndarray, factor: float) -> np.ndarray:
    """Remuestrea una ventana (pasos, features) a `factor` de su ritmo y
    la recorta/rellena de vuelta al largo original."""
    n = ventana.shape[0]
    t_orig = np.linspace(0.0, 1.0, n)
    n_nuevo = max(2, int(round(n * factor)))
    t_nuevo = np.linspace(0.0, 1.0, n_nuevo)
    remuestreada = np.stack(
        [np.interp(t_nuevo, t_orig, ventana[:, c]) for c in range(ventana.shape[1])],
        axis=1,
    )
    if n_nuevo >= n:
        return remuestreada[:n]
    relleno = np.repeat(remuestreada[-1:], n - n_nuevo, axis=0)
    return np.concatenate([remuestreada, relleno], axis=0)


def aumentar(X: np.ndarray, veces: int, rng: np.random.Generator) -> np.ndarray:
    """`X` son SOLO ventanas de entrenamiento (ya separadas del fold de
    prueba). Devuelve X seguido de `veces` copias aumentadas; el original
    nunca se descarta."""
    if veces <= 0:
        return X
    salidas = [X]
    for _ in range(veces):
        Xa = X.copy()
        Xa[:, :, CANALES_ANGULO] += rng.normal(
            0.0, RUIDO_ANGULO_GRADOS, Xa[:, :, CANALES_ANGULO].shape)
        Xa[:, :, CANALES_VELOCIDAD] *= (1.0 + rng.normal(
            0.0, RUIDO_VELOCIDAD_FRAC, Xa[:, :, CANALES_VELOCIDAD].shape))
        factor_amplitud = rng.uniform(*ESCALA_AMPLITUD, size=(Xa.shape[0], 1, 1))
        Xa[:, :, CANALES_ANGULO] *= factor_amplitud
        for i in range(Xa.shape[0]):
            Xa[i] = _deformar_tiempo(Xa[i], rng.uniform(*ESCALA_TIEMPO))
        salidas.append(Xa)
    return np.concatenate(salidas, axis=0)


# ---------------------------------------------------------------------
def pesos_por_clase(y, mascara=None):
    """Compensa el desbalance. En este dataset es de 8,9x entre clases."""
    w = np.zeros(len(y), dtype=np.float32)
    valido = np.ones(len(y), bool) if mascara is None else mascara
    cuenta = Counter(y[valido].tolist())
    n = int(valido.sum())
    for i in np.where(valido)[0]:
        w[i] = n / (len(cuenta) * cuenta[y[i]])
    return w


def escalar(train, test):
    """Media y desviacion del fold de ENTRENAMIENTO (ya aumentado), aplicadas a los dos."""
    plano = train.reshape(-1, train.shape[-1])
    media, desv = plano.mean(axis=0), plano.std(axis=0)
    desv[desv < 1e-6] = 1.0
    return (train - media) / desv, (test - media) / desv, media, desv


def voto_por_tanda(segmentos, y_real, y_pred):
    """Exactitud por tanda: la unidad que ve el paciente, no la ventana."""
    votos, reales = defaultdict(list), {}
    for s, r, p in zip(segmentos, y_real, y_pred):
        votos[s].append(p)
        reales[s] = r
    aciertos = sum(1 for s, v in votos.items()
                   if Counter(v).most_common(1)[0][0] == reales[s])
    return aciertos / len(votos), len(votos)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="ventanas.npz")
    ap.add_argument("--clases", default="clases.json")
    ap.add_argument("--arquitectura", default="lstm",
                    choices=["lstm", "gru", "lstm_profunda", "bilstm"])
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--semillas", type=int, default=3)
    ap.add_argument("--aumento", type=int, default=3,
                    help="Copias aumentadas por ventana de entrenamiento (0 = apagado, igual que el script original).")
    ap.add_argument("--salida", default="modelo_final.keras")
    args = ap.parse_args()

    from tensorflow import keras
    import tensorflow as tf
    print("TensorFlow", tf.__version__, "| GPU:",
          tf.config.list_physical_devices("GPU") or "no (CPU)")

    d = np.load(args.datos, allow_pickle=True)
    meta = json.loads(Path(args.clases).read_text(encoding="utf-8"))
    X = d["X"].astype(np.float32)
    y_ej = d["y_ejercicio"].astype(np.int32)
    y_ca = d["y_calidad"].astype(np.int32)
    escena, segmento = d["escena"], d["segmento"]
    clases = meta["ejercicios"]

    con_calidad = y_ca >= 0
    y_ca_seguro = np.where(con_calidad, y_ca, 0)

    base_ej = Counter(y_ej.tolist()).most_common(1)[0][1] / len(y_ej)
    base_ca = (Counter(y_ca[con_calidad].tolist()).most_common(1)[0][1]
               / int(con_calidad.sum()))

    print("\nDATOS")
    print("  X {}  ->  {} ventanas de {} muestras x {} features".format(
        X.shape, X.shape[0], X.shape[1], X.shape[2]))
    print("  {} clases de ejercicio, {} escenas, {} segmentos".format(
        len(clases), len(set(escena.tolist())), len(set(segmento.tolist()))))
    print("  ventanas por clase: min {} max {} (desbalance {:.1f}x)".format(
        min(Counter(y_ej.tolist()).values()), max(Counter(y_ej.tolist()).values()),
        max(Counter(y_ej.tolist()).values()) / max(min(Counter(y_ej.tolist()).values()), 1)))
    print("  con etiqueta de calidad: {} de {}".format(int(con_calidad.sum()), len(y_ca)))
    print("  LINEA BASE ejercicio {:.3f} | calidad {:.3f}".format(base_ej, base_ca))
    print("  AUMENTO: x{} (0 = apagado)".format(args.aumento))

    filas = []
    matriz = np.zeros((len(clases), len(clases)), dtype=int)
    print("\nENTRENAMIENTO ({}, {} folds x {} semillas)".format(
        args.arquitectura, args.folds, args.semillas))

    for semilla in range(args.semillas):
        keras.utils.set_random_seed(1000 + semilla)
        rng_aumento = np.random.default_rng(5000 + semilla)
        gkf = StratifiedGroupKFold(n_splits=args.folds, shuffle=True,
                                   random_state=1000 + semilla)
        for fold, (tr, te) in enumerate(gkf.split(X, y_ej, groups=escena), 1):
            X_tr_aum = aumentar(X[tr], args.aumento, rng_aumento)
            y_ej_aum = np.tile(y_ej[tr], args.aumento + 1)
            y_ca_aum = np.tile(y_ca_seguro[tr], args.aumento + 1)
            con_cal_aum = np.tile(con_calidad[tr], args.aumento + 1)

            Xtr, Xte, _, _ = escalar(X_tr_aum, X[te])
            modelo = construir(args.arquitectura, X.shape[1], X.shape[2],
                               len(clases), 3)
            parada = keras.callbacks.EarlyStopping(
                monitor="val_loss", patience=PACIENCIA, restore_best_weights=True)
            hist = modelo.fit(
                Xtr, [y_ej_aum, y_ca_aum],
                sample_weight=[pesos_por_clase(y_ej_aum),
                               pesos_por_clase(y_ca_aum, con_cal_aum)],
                validation_data=(Xte, [y_ej[te], y_ca_seguro[te]]),
                epochs=EPOCAS, batch_size=LOTE, verbose=0, callbacks=[parada])

            p_ej, p_ca = modelo.predict(Xte, verbose=0)
            pred = p_ej.argmax(axis=1)
            m = con_calidad[te]
            tanda, n_tandas = voto_por_tanda(segmento[te], y_ej[te], pred)
            matriz += confusion_matrix(y_ej[te], pred, labels=list(range(len(clases))))
            filas.append({
                "arquitectura": args.arquitectura, "aumento": args.aumento,
                "semilla": semilla, "fold": fold,
                "ventanas_entrenamiento": len(X_tr_aum),
                "epocas": len(hist.history["loss"]),
                "exactitud_ventana": round(float((pred == y_ej[te]).mean()), 4),
                "f1_macro": round(float(f1_score(y_ej[te], pred, average="macro",
                                                 zero_division=0)), 4),
                "exactitud_tanda": round(float(tanda), 4),
                "tandas": n_tandas,
                "exactitud_calidad": round(float(
                    (p_ca.argmax(axis=1)[m] == y_ca[te][m]).mean()), 4) if m.any() else "",
            })
            print("  semilla {} fold {}: ventana {:.3f}  f1 {:.3f}  tanda {:.3f}"
                  "  [{} epocas, {} ventanas train]".format(
                      semilla, fold, filas[-1]["exactitud_ventana"],
                      filas[-1]["f1_macro"], tanda, filas[-1]["epocas"],
                      len(X_tr_aum)), flush=True)

    print("\nRESULTADO FUERA DE FOLD ({} corridas, aumento x{})".format(len(filas), args.aumento))
    for col, nombre in (("exactitud_ventana", "Ejercicio por ventana"),
                        ("f1_macro", "Ejercicio F1 macro"),
                        ("exactitud_tanda", "Ejercicio por tanda (voto)"),
                        ("exactitud_calidad", "Calidad (cabeza de la red)")):
        v = [f[col] for f in filas if f[col] != ""]
        print("  {:28} {:.3f} +- {:.3f}".format(nombre, float(np.mean(v)),
                                                float(np.std(v))))
    print("  {:28} {:.3f}".format("linea base ejercicio", base_ej))
    print("  {:28} {:.3f}".format("linea base calidad", base_ca))

    sufijo = "{}_aum{}".format(args.arquitectura, args.aumento)
    with open("metricas_{}.csv".format(sufijo), "w", newline="",
              encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)

    with open("matriz_confusion_{}.csv".format(sufijo), "w", newline="",
              encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["real\\predicho"] + clases)
        for c, fila in zip(clases, matriz):
            w.writerow([c] + fila.tolist())

    # --- modelo final: entrena con TODO (ya aumentado), SOLO para desplegar
    keras.utils.set_random_seed(1000)
    rng_final = np.random.default_rng(9000)
    X_aum = aumentar(X, args.aumento, rng_final)
    y_ej_aum = np.tile(y_ej, args.aumento + 1)
    y_ca_aum = np.tile(y_ca_seguro, args.aumento + 1)
    con_cal_aum = np.tile(con_calidad, args.aumento + 1)
    plano = X_aum.reshape(-1, X_aum.shape[-1])
    media, desv = plano.mean(axis=0), plano.std(axis=0)
    desv[desv < 1e-6] = 1.0
    modelo = construir(args.arquitectura, X.shape[1], X.shape[2], len(clases), 3)
    modelo.fit((X_aum - media) / desv, [y_ej_aum, y_ca_aum],
               sample_weight=[pesos_por_clase(y_ej_aum),
                              pesos_por_clase(y_ca_aum, con_cal_aum)],
               epochs=int(np.mean([f["epocas"] for f in filas])),
               batch_size=LOTE, verbose=0)
    modelo.save(args.salida)
    np.savez("escalador.npz", media=media, desviacion=desv)
    print("\nmodelo final -> {} (+ escalador.npz)".format(args.salida))
    print("AVISO: el modelo final entreno con TODAS las escenas (aumentadas). Su")
    print("exactitud sobre este mismo material esta contaminada. La cifra")
    print("publicable es la de fuera de fold, siempre junto a la linea base.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
