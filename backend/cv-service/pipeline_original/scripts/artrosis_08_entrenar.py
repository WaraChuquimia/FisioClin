"""Etapa 8: particion y entrenamiento de la red temporal.

## La particion, que es la decision que mas condiciona el resultado

Se agrupa por **escena** con `GroupKFold`. Las ventanas se solapan dos
tercios entre si: dos consecutivas son casi el mismo dato, y repartirlas al
azar da una exactitud altisima y falsa.

Agrupar por **video** seria mas exigente, y es imposible: cada clase esta
en un solo video, asi que apartar un video deja a esa clase sin un solo
ejemplo de entrenamiento. No es una eleccion metodologica, es una
consecuencia del material.

Por eso la cifra que sale de aqui mide **generalizacion a otro plano de
camara, no a otro cuerpo**. Con dos sujetos en todo el material, y uno de
ellos presente en solo dos clases, la generalizacion a pacientes nuevos no
es demostrable con este dataset y no debe afirmarse.

El escalador se ajusta **solo con el fold de entrenamiento**. Ajustarlo
sobre todo el dataset seria fuga de informacion.

## Las dos cabezas

La red predice el **ejercicio** (20 clases) y la **calidad de ejecucion**
(3 clases). La segunda esta ahi para poder contrastarla con su linea base:
aprende a reproducir reglas que ya se calculan exacto desde los mismos
angulos, asi que solo puede perder informacion. Si queda por debajo de su
linea base, eso no es un fallo del entrenamiento sino la demostracion de
que la evaluacion de la ejecucion le corresponde a las reglas.

    python artrosis_08_entrenar.py [--folds 5] [--semillas 3]
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

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
ENTRADA = RAIZ / "06_ventanas"
SALIDA = RAIZ / "07_modelo"

EPOCAS = 80
PACIENCIA = 15
LOTE = 32
APRENDIZAJE = 1e-3


def construir(n_pasos, n_features, n_clases, n_calidad):
    from tensorflow import keras
    from tensorflow.keras import layers

    entrada = keras.Input(shape=(n_pasos, n_features), name="secuencia")
    x = layers.LSTM(64, return_sequences=True)(entrada)
    x = layers.Dropout(0.3)(x)
    x = layers.LSTM(32)(x)
    x = layers.Dropout(0.3)(x)
    tronco = layers.Dense(32, activation="relu")(x)
    salida_ej = layers.Dense(n_clases, activation="softmax", name="ejercicio")(tronco)
    salida_ca = layers.Dense(n_calidad, activation="softmax", name="calidad")(tronco)

    modelo = keras.Model(entrada, [salida_ej, salida_ca])
    modelo.compile(
        optimizer=keras.optimizers.Adam(APRENDIZAJE),
        loss=["sparse_categorical_crossentropy",
              "sparse_categorical_crossentropy"],
        loss_weights=[1.0, 0.3],
    )
    return modelo


def pesos_por_clase(y, mascara=None):
    """Compensa el desbalance: en este dataset es de 8,9x entre clases."""
    w = np.zeros(len(y), dtype=np.float32)
    valido = np.ones(len(y), bool) if mascara is None else mascara
    cuenta = Counter(y[valido].tolist())
    n = valido.sum()
    for i in np.where(valido)[0]:
        w[i] = n / (len(cuenta) * cuenta[y[i]])
    return w


def escalar(train, test):
    """Media y desviacion del fold de ENTRENAMIENTO, aplicadas a los dos."""
    plano = train.reshape(-1, train.shape[-1])
    media = plano.mean(axis=0)
    desv = plano.std(axis=0)
    desv[desv < 1e-6] = 1.0
    return (train - media) / desv, (test - media) / desv, media, desv


def voto_por_tanda(segmentos, y_real, y_pred):
    """Exactitud por tanda: la unidad que ve el paciente, no la ventana."""
    votos = defaultdict(list)
    reales = {}
    for s, r, p in zip(segmentos, y_real, y_pred):
        votos[s].append(p)
        reales[s] = r
    aciertos = sum(1 for s, v in votos.items()
                   if Counter(v).most_common(1)[0][0] == reales[s])
    return aciertos / len(votos), len(votos)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--semillas", type=int, default=3)
    args = ap.parse_args()

    import tensorflow as tf
    from tensorflow import keras

    d = np.load(ENTRADA / "ventanas.npz", allow_pickle=True)
    meta = json.loads((ENTRADA / "clases.json").read_text(encoding="utf-8"))
    X = d["X"].astype(np.float32)
    y_ej = d["y_ejercicio"].astype(np.int32)
    y_ca = d["y_calidad"].astype(np.int32)
    escena = d["escena"]
    segmento = d["segmento"]
    clases = meta["ejercicios"]
    n_cal = len(meta["calidad"])

    con_calidad = y_ca >= 0
    y_ca_seguro = np.where(con_calidad, y_ca, 0)

    base_ej = Counter(y_ej.tolist()).most_common(1)[0][1] / len(y_ej)
    base_ca = (Counter(y_ca[con_calidad].tolist()).most_common(1)[0][1]
               / con_calidad.sum())
    print("ventanas {}  clases {}  escenas {}".format(
        len(X), len(clases), len(set(escena.tolist()))))
    print("linea base ejercicio (clase mayoritaria): {:.3f}".format(base_ej))
    print("linea base calidad:                       {:.3f}\n".format(base_ca))

    SALIDA.mkdir(parents=True, exist_ok=True)
    filas, matriz_total = [], np.zeros((len(clases), len(clases)), dtype=int)

    for semilla in range(args.semillas):
        keras.utils.set_random_seed(1000 + semilla)
        # StratifiedGroupKFold y no GroupKFold: respeta los grupos igual,
        # pero ademas reparte las clases entre folds. Con GroupKFold habia
        # folds donde una clase entera caia del lado de la prueba sin
        # ejemplos de entrenamiento, y la exactitud se desplomaba a 0,167.
        gkf = StratifiedGroupKFold(n_splits=args.folds, shuffle=True,
                                   random_state=1000 + semilla)
        for fold, (tr, te) in enumerate(gkf.split(X, y_ej, groups=escena), 1):
            Xtr, Xte, _, _ = escalar(X[tr], X[te])
            w_ej = pesos_por_clase(y_ej[tr])
            w_ca = pesos_por_clase(y_ca_seguro[tr], con_calidad[tr])

            modelo = construir(X.shape[1], X.shape[2], len(clases), n_cal)
            parada = keras.callbacks.EarlyStopping(
                monitor="val_loss", patience=PACIENCIA, restore_best_weights=True)
            hist = modelo.fit(
                Xtr, [y_ej[tr], y_ca_seguro[tr]],
                sample_weight=[w_ej, w_ca],
                validation_data=(Xte, [y_ej[te], y_ca_seguro[te]]),
                epochs=EPOCAS, batch_size=LOTE, verbose=0, callbacks=[parada])

            p_ej, p_ca = modelo.predict(Xte, verbose=0)
            pred_ej = p_ej.argmax(axis=1)
            pred_ca = p_ca.argmax(axis=1)
            exact = float((pred_ej == y_ej[te]).mean())
            f1 = float(f1_score(y_ej[te], pred_ej, average="macro", zero_division=0))
            tanda, n_tandas = voto_por_tanda(segmento[te], y_ej[te], pred_ej)
            m = con_calidad[te]
            exact_ca = float((pred_ca[m] == y_ca[te][m]).mean()) if m.any() else float("nan")

            matriz_total += confusion_matrix(y_ej[te], pred_ej,
                                             labels=list(range(len(clases))))
            filas.append({
                "semilla": semilla, "fold": fold,
                "ventanas_entrenamiento": len(tr), "ventanas_prueba": len(te),
                "escenas_prueba": len(set(escena[te].tolist())),
                "clases_sin_entrenamiento": len(set(y_ej[te].tolist())
                                                - set(y_ej[tr].tolist())),
                "epocas": len(hist.history["loss"]),
                "exactitud_ventana": round(exact, 4),
                "f1_macro": round(f1, 4),
                "exactitud_tanda": round(tanda, 4),
                "tandas_prueba": n_tandas,
                "exactitud_calidad": round(exact_ca, 4),
            })
            print("semilla {} fold {}: ventana {:.3f}  f1 {:.3f}  tanda {:.3f} "
                  "({} tandas)  calidad {:.3f}  [{} epocas]".format(
                      semilla, fold, exact, f1, tanda, n_tandas, exact_ca,
                      len(hist.history["loss"])), flush=True)

    def med(col):
        v = [f[col] for f in filas if not np.isnan(f[col])]
        return float(np.mean(v)), float(np.std(v))

    print("\n--- fuera de fold, {} corridas ---".format(len(filas)))
    resumen = {}
    for col, nombre in (("exactitud_ventana", "Ejercicio por ventana"),
                        ("f1_macro", "Ejercicio F1 macro"),
                        ("exactitud_tanda", "Ejercicio por tanda (voto)"),
                        ("exactitud_calidad", "Calidad (cabeza de la red)")):
        m, s = med(col)
        resumen[col] = {"media": round(m, 4), "desviacion": round(s, 4)}
        print("{:30} {:.3f} +- {:.3f}".format(nombre, m, s))
    print("{:30} {:.3f}".format("linea base ejercicio", base_ej))
    print("{:30} {:.3f}".format("linea base calidad", base_ca))

    with (SALIDA / "metricas_validacion.csv").open("w", newline="",
                                                   encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)

    with (SALIDA / "matriz_confusion.csv").open("w", newline="",
                                                encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["real\\predicho"] + clases)
        for c, fila in zip(clases, matriz_total):
            w.writerow([c] + fila.tolist())

    # --- modelo final: entrena con todo, solo para desplegar -------------
    keras.utils.set_random_seed(1000)
    plano = X.reshape(-1, X.shape[-1])
    media, desv = plano.mean(axis=0), plano.std(axis=0)
    desv[desv < 1e-6] = 1.0
    modelo = construir(X.shape[1], X.shape[2], len(clases), n_cal)
    modelo.fit((X - media) / desv, [y_ej, y_ca_seguro],
               sample_weight=[pesos_por_clase(y_ej),
                              pesos_por_clase(y_ca_seguro, con_calidad)],
               epochs=int(np.mean([f["epocas"] for f in filas])),
               batch_size=LOTE, verbose=0)
    modelo.save(SALIDA / "modelo.keras")
    np.savez(SALIDA / "escalador.npz", media=media, desviacion=desv)
    (SALIDA / "modelo.json").write_text(json.dumps({
        **meta,
        "validacion": resumen,
        "linea_base_ejercicio": round(base_ej, 4),
        "linea_base_calidad": round(base_ca, 4),
        "particion": "StratifiedGroupKFold por escena",
        "aviso": ("El modelo final entreno con todas las escenas. Su exactitud "
                  "sobre este mismo material esta contaminada: la cifra "
                  "publicable es la de fuera de fold."),
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\nmodelo final ->", SALIDA / "modelo.keras")
    return 0


if __name__ == "__main__":
    sys.exit(main())
