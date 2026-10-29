"""Etapa 9: evaluacion.

Tres preguntas que las metricas de la etapa 8 no contestan:

1. **Serviria de algo mas material?** Curva de aprendizaje: se entrena con
   fracciones crecientes de las escenas de entrenamiento y se mira si la
   exactitud fuera de fold sigue subiendo. Si la curva ya esta plana, mas
   videos del mismo tipo no ayudan y el problema es otro. Si sigue
   subiendo, la captura complementaria esta justificada con un numero.

2. **Aportan algo las decisiones de diseno?** Ablacion: se reentrena
   quitando grupos de features. Si quitar la abduccion no cambia nada,
   anadirla fue trabajo perdido; si baja la exactitud, estaba haciendo
   falta.

3. **Dependen las conclusiones de mis umbrales?** No se toca la red: se
   recalcula la etiqueta de ejecucion moviendo cada constante un 20 % y se
   mide cuantas repeticiones cambian de veredicto.

    python artrosis_09_evaluar.py [--saltar-curva] [--saltar-ablacion]
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
from sklearn.metrics import f1_score
from sklearn.model_selection import StratifiedGroupKFold

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
ENTRADA = RAIZ / "06_ventanas"
SALIDA = RAIZ / "07_modelo"

FRACCIONES = [0.25, 0.50, 0.75, 1.00]
ABLACIONES = {
    "completo": None,
    "sin_abduccion": [6, 7, 11],
    "sin_velocidades": [9, 10, 11],
    "solo_angulos": [9, 10, 11, 12, 13],
}


def cargar():
    d = np.load(ENTRADA / "ventanas.npz", allow_pickle=True)
    meta = json.loads((ENTRADA / "clases.json").read_text(encoding="utf-8"))
    return d, meta


def entrenar_y_medir(X, y, escena, segmento, tr, te, semilla):
    """Una corrida: escala con el train, entrena y devuelve las metricas."""
    from tensorflow import keras
    import artrosis_08_entrenar as E

    keras.utils.set_random_seed(semilla)
    Xtr, Xte, _, _ = E.escalar(X[tr], X[te])
    modelo = E.construir(X.shape[1], X.shape[2], int(y.max()) + 1, 3)
    parada = keras.callbacks.EarlyStopping(monitor="val_loss", patience=E.PACIENCIA,
                                           restore_best_weights=True)
    ceros = np.zeros(len(tr), dtype=np.int32)
    modelo.fit(Xtr, [y[tr], ceros], sample_weight=[E.pesos_por_clase(y[tr]), ceros * 0.0],
               validation_data=(Xte, [y[te], np.zeros(len(te), dtype=np.int32)]),
               epochs=E.EPOCAS, batch_size=E.LOTE, verbose=0, callbacks=[parada])
    pred = modelo.predict(Xte, verbose=0)[0].argmax(axis=1)
    tanda, _ = E.voto_por_tanda(segmento[te], y[te], pred)
    return {
        "exactitud_ventana": float((pred == y[te]).mean()),
        "f1_macro": float(f1_score(y[te], pred, average="macro", zero_division=0)),
        "exactitud_tanda": float(tanda),
    }


def curva_de_aprendizaje(X, y, escena, segmento, folds=5):
    filas = []
    gkf = StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=1000)
    for fold, (tr, te) in enumerate(gkf.split(X, y, groups=escena), 1):
        escenas_tr = sorted(set(escena[tr].tolist()))
        rng = np.random.default_rng(1000 + fold)
        orden = rng.permutation(escenas_tr)
        for frac in FRACCIONES:
            n = max(2, int(round(frac * len(orden))))
            elegidas = set(orden[:n].tolist())
            sub = np.array([i for i in tr if escena[i] in elegidas])
            # una clase sin ejemplos no se puede aprender: se anota
            faltan = len(set(y[te].tolist()) - set(y[sub].tolist()))
            m = entrenar_y_medir(X, y, escena, segmento, sub, te, 1000 + fold)
            filas.append({"fold": fold, "fraccion": frac, "escenas": n,
                          "ventanas": len(sub), "clases_sin_ejemplo": faltan,
                          **{k: round(v, 4) for k, v in m.items()}})
            print("  fold {} frac {:.0%}: {} escenas, {} ventanas -> ventana {:.3f} "
                  "tanda {:.3f}".format(fold, frac, n, len(sub),
                                        m["exactitud_ventana"], m["exactitud_tanda"]),
                  flush=True)
    return filas


def ablacion(X, y, escena, segmento, nombres, folds=5):
    filas = []
    gkf = StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=1000)
    particiones = list(gkf.split(X, y, groups=escena))
    for etiqueta, quitar in ABLACIONES.items():
        cols = [i for i in range(X.shape[2]) if not quitar or i not in quitar]
        Xa = X[:, :, cols]
        for fold, (tr, te) in enumerate(particiones, 1):
            m = entrenar_y_medir(Xa, y, escena, segmento, tr, te, 1000 + fold)
            filas.append({"variante": etiqueta, "fold": fold,
                          "features": len(cols),
                          "quitadas": ";".join(nombres[i] for i in (quitar or [])),
                          **{k: round(v, 4) for k, v in m.items()}})
        ult = [f for f in filas if f["variante"] == etiqueta]
        print("  {:16} {} features -> ventana {:.3f} +- {:.3f}  tanda {:.3f}".format(
            etiqueta, len(cols),
            float(np.mean([f["exactitud_ventana"] for f in ult])),
            float(np.std([f["exactitud_ventana"] for f in ult])),
            float(np.mean([f["exactitud_tanda"] for f in ult]))), flush=True)
    return filas


def escribir(destino, filas):
    if not filas:
        return
    with destino.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    print("{} filas -> {}".format(len(filas), destino))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--saltar-curva", action="store_true")
    ap.add_argument("--saltar-ablacion", action="store_true")
    args = ap.parse_args()

    d, meta = cargar()
    X = d["X"].astype(np.float32)
    y = d["y_ejercicio"].astype(np.int32)
    escena, segmento = d["escena"], d["segmento"]
    nombres = meta["features"]
    SALIDA.mkdir(parents=True, exist_ok=True)

    if not args.saltar_curva:
        print("CURVA DE APRENDIZAJE")
        escribir(SALIDA / "curva_aprendizaje.csv",
                 curva_de_aprendizaje(X, y, escena, segmento))
    if not args.saltar_ablacion:
        print("\nABLACION DE FEATURES")
        escribir(SALIDA / "ablacion.csv",
                 ablacion(X, y, escena, segmento, nombres))
    return 0


if __name__ == "__main__":
    sys.exit(main())
