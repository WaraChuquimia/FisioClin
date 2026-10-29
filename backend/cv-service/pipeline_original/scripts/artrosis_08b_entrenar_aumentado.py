"""Etapa 8b: igual que artrosis_08_entrenar.py, con aumento de datos.

Copia de artrosis_08_entrenar.py (mismo particionado, misma red, mismos
hiperparametros) con UN solo cambio: antes de ajustar cada fold, las
ventanas de ENTRENAMIENTO (nunca las de prueba) se multiplican con
variaciones sinteticas fisiologicamente plausibles. El objetivo es medir
si el techo real de este dataset (2 sujetos, uno de ellos en solo 2
clases, documentado en dataset/documentacion/08_modelo.md) se mueve con
mas variedad de datos o si es un limite de MATERIAL, no de cantidad de
pasadas de entrenamiento.

Que se aumenta y por que, canal por canal (ver NOMBRES_FEATURES):
  - Angulos e inclinacion de tronco (indices 0-8): ruido gaussiano de
    ~1 grado (el orden de magnitud del ruido de deteccion de MediaPipe,
    ya documentado en geometria.py) + un escalado de amplitud +-5% por
    ventana (simula que otro cuerpo tiene un poco mas o menos ROM en el
    mismo ejercicio, sin inventar un rango irreal).
  - Velocidades (indices 9-11): ruido proporcional del 5%, coherente con
    venir de derivar los angulos ya ruidosos.
  - Deformacion temporal: cada ventana se remuestrea a un ritmo entre
    90% y 110% y se recorta/rellena de vuelta a 30 pasos -- la misma
    repeticion, un poco mas rapida o mas lenta.
  - NO se tocan `visibilidad` ni `contra_presente` (indices 12-13): son
    señales de si hay dato, no mediciones con ruido fisico; alterarlas
    inventaria huecos o presencia que no pasaron.
  - NO se hace espejo izquierda/derecha: el vector YA esta canonizado
    como lado medido / contralateral (artrosis_07_ventanas.py), asi que
    espejar no cambia el dato -- seria aumento falso.

    python artrosis_08b_entrenar_aumentado.py [--folds 5] [--semillas 3] [--veces 3]
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
SALIDA = RAIZ / "07_modelo_aumentado"

EPOCAS = 80
PACIENCIA = 15
LOTE = 32
APRENDIZAJE = 1e-3

#: Indices de NOMBRES_FEATURES (artrosis_07_ventanas.py). 0-8 angulos e
#: inclinacion de tronco, 9-11 velocidades, 12-13 visibilidad/presencia.
CANALES_ANGULO = list(range(0, 9))
CANALES_VELOCIDAD = [9, 10, 11]

RUIDO_ANGULO_GRADOS = 1.0
RUIDO_VELOCIDAD_FRAC = 0.05
ESCALA_AMPLITUD = (0.95, 1.05)
ESCALA_TIEMPO = (0.90, 1.10)


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
    w = np.zeros(len(y), dtype=np.float32)
    valido = np.ones(len(y), bool) if mascara is None else mascara
    cuenta = Counter(y[valido].tolist())
    n = valido.sum()
    for i in np.where(valido)[0]:
        w[i] = n / (len(cuenta) * cuenta[y[i]])
    return w


def escalar(train, test):
    plano = train.reshape(-1, train.shape[-1])
    media = plano.mean(axis=0)
    desv = plano.std(axis=0)
    desv[desv < 1e-6] = 1.0
    return (train - media) / desv, (test - media) / desv, media, desv


def voto_por_tanda(segmentos, y_real, y_pred):
    votos = defaultdict(list)
    reales = {}
    for s, r, p in zip(segmentos, y_real, y_pred):
        votos[s].append(p)
        reales[s] = r
    aciertos = sum(1 for s, v in votos.items()
                   if Counter(v).most_common(1)[0][0] == reales[s])
    return aciertos / len(votos), len(votos)


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
    """`X` son SOLO ventanas de entrenamiento. Devuelve X seguido de
    `veces` copias aumentadas (el original nunca se descarta)."""
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--semillas", type=int, default=3)
    ap.add_argument("--veces", type=int, default=3,
                     help="Cuantas copias aumentadas por ventana de entrenamiento (ademas del original).")
    args = ap.parse_args()

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
    print("ventanas {}  clases {}  escenas {}  (x{} aumento = {} de entrenamiento por fold)".format(
        len(X), len(clases), len(set(escena.tolist())), args.veces + 1, "~"))
    print("linea base ejercicio (clase mayoritaria): {:.3f}".format(base_ej))
    print("linea base calidad:                       {:.3f}\n".format(base_ca))

    SALIDA.mkdir(parents=True, exist_ok=True)
    filas, matriz_total = [], np.zeros((len(clases), len(clases)), dtype=int)

    for semilla in range(args.semillas):
        keras.utils.set_random_seed(1000 + semilla)
        rng_aumento = np.random.default_rng(5000 + semilla)
        gkf = StratifiedGroupKFold(n_splits=args.folds, shuffle=True,
                                   random_state=1000 + semilla)
        for fold, (tr, te) in enumerate(gkf.split(X, y_ej, groups=escena), 1):
            # Aumentar SOLO el entrenamiento; prueba queda intacta y nunca
            # se escala con estadisticos que vieron una ventana aumentada
            # de la que ya vio el original (misma ventana, no fuga nueva:
            # las copias aumentadas de una ventana de train ya eran de
            # train).
            X_tr_aum = aumentar(X[tr], args.veces, rng_aumento)
            y_ej_aum = np.tile(y_ej[tr], args.veces + 1)
            y_ca_aum = np.tile(y_ca_seguro[tr], args.veces + 1)
            con_cal_aum = np.tile(con_calidad[tr], args.veces + 1)

            Xtr, Xte, _, _ = escalar(X_tr_aum, X[te])
            w_ej = pesos_por_clase(y_ej_aum)
            w_ca = pesos_por_clase(y_ca_aum, con_cal_aum)

            modelo = construir(X.shape[1], X.shape[2], len(clases), n_cal)
            parada = keras.callbacks.EarlyStopping(
                monitor="val_loss", patience=PACIENCIA, restore_best_weights=True)
            hist = modelo.fit(
                Xtr, [y_ej_aum, y_ca_aum],
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
                "ventanas_entrenamiento": len(X_tr_aum), "ventanas_prueba": len(te),
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
                  "({} tandas)  calidad {:.3f}  [{} epocas, {} ventanas train]".format(
                      semilla, fold, exact, f1, tanda, n_tandas, exact_ca,
                      len(hist.history["loss"]), len(X_tr_aum)), flush=True)

    def med(col):
        v = [f[col] for f in filas if not np.isnan(f[col])]
        return float(np.mean(v)), float(np.std(v))

    print("\n--- fuera de fold, {} corridas (con aumento x{}) ---".format(len(filas), args.veces + 1))
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

    (SALIDA / "resumen.json").write_text(json.dumps({
        "aumento_veces": args.veces,
        "validacion": resumen,
        "linea_base_ejercicio": round(base_ej, 4),
        "linea_base_calidad": round(base_ca, 4),
        "particion": "StratifiedGroupKFold por escena, aumento solo en entrenamiento",
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\nmetricas ->", SALIDA / "metricas_validacion.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
