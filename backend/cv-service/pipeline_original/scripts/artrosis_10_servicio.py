"""Etapa 10: evaluador en vivo, y la medida de lo que se pierde al serlo.

El pipeline que construyo el dataset es **no causal**: suaviza los angulos
con un Savitzky-Golay centrado, que para calcular el valor de un instante
usa las muestras de medio segundo despues. En un video grabado eso es
legitimo; delante de un paciente, imposible.

Este modulo hace dos cosas:

1. Implementa el evaluador causal — solo mira hacia atras — reutilizando
   **el mismo codigo** de calculo de angulos que produjo el dataset, para
   que no haya desajuste entre lo que se entreno y lo que se sirve.

2. **Mide cuanto se pierde.** Compara, fotograma a fotograma, el angulo
   causal contra el que uso el entrenamiento, y la prediccion de una contra
   la otra. Sin ese numero, desplegar el modelo seria confiar en que las
   dos senales son la misma sin haberlo comprobado.

Y separa las dos responsabilidades como quedo demostrado en la etapa 8:

* **la red** dice que ejercicio es;
* **las reglas** dicen si esta bien ejecutado.

    python artrosis_10_servicio.py --videos C01,R06
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import deque
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("GLOG_minloglevel", "3")

import cv2
import numpy as np

import artrosis_03_angulos as A
import artrosis_07_ventanas as V

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
MODELO = RAIZ / "07_modelo"
SALIDA = MODELO / "latencia.csv"

BASE_VIDEOS = Path(os.environ["USERPROFILE"]) / (
    "OneDrive - Escuela Militar de Ingenieria/Desktop/catalogo_de_ejercicios")

HZ = 10.0
VENTANA = 30               # muestras que espera la red
SUAVIZADO_CAUSAL = 5       # muestras hacia atras para la media movil
CADA_N = 5                 # se predice 2 veces por segundo, no 10: el
                           # ejercicio no cambia diez veces por segundo y
                           # la inferencia es lo mas caro despues de la pose


class EvaluadorEnVivo:
    """Mantiene el estado necesario para decidir con solo el pasado."""

    def __init__(self, complejidad=2):
        self.complejidad = complejidad
        from tensorflow import keras
        self.modelo = keras.models.load_model(MODELO / "modelo.keras")
        esc = np.load(MODELO / "escalador.npz")
        self.media, self.desv = esc["media"], esc["desviacion"]
        self.meta = json.loads((RAIZ / "06_ventanas/clases.json").read_text(
            encoding="utf-8"))
        self.clases = self.meta["ejercicios"]
        self.tronco_ref = None
        self.buffer = deque(maxlen=VENTANA)
        self.crudos = deque(maxlen=SUAVIZADO_CAUSAL)
        self.desde_ultima = 0
        self.ultima = None

    def referencia_tronco(self, valor):
        """El tronco de referencia se aprende de los primeros segundos."""
        if self.tronco_ref is None:
            self.tronco_ref = valor
        else:  # media movil lenta: se estabiliza y no persigue el ruido
            self.tronco_ref = 0.98 * self.tronco_ref + 0.02 * valor
        return self.tronco_ref

    def paso(self, lm, mundo, lado):
        """Un fotograma. Devuelve la prediccion si el buffer esta lleno."""
        vector = self._features(lm, mundo, lado)
        if vector is None:
            return None
        self.crudos.append(vector)
        # suavizado CAUSAL: media de las ultimas muestras, nunca de las
        # siguientes. El entrenamiento uso un filtro centrado.
        self.buffer.append(np.mean(np.stack(self.crudos), axis=0))
        if len(self.buffer) < VENTANA:
            return None
        self.desde_ultima += 1
        if self.ultima is not None and self.desde_ultima < CADA_N:
            return self.ultima
        self.desde_ultima = 0
        x = (np.stack(self.buffer)[None] - self.media) / self.desv
        # `modelo(x)` y no `modelo.predict(x)`: predict monta un bucle de
        # datos por llamada y en un solo ejemplo eso cuesta mas que la
        # propia red. Medido: 201 ms contra 4 ms.
        p_ej = self.modelo(x.astype(np.float32), training=False)[0].numpy()
        i = int(p_ej.argmax())
        self.ultima = {"ejercicio": self.clases[i], "confianza": float(p_ej[0, i])}
        return self.ultima

    def _features(self, lm, mundo, lado):
        vis = lm[:, 3]
        adm = A.ADMISION_DER if lado == "der" else A.ADMISION_IZQ
        if np.nanmin(vis[adm]) < A.VIS_ADMISION:
            return None
        pm = mundo[None, :, :3]
        hombro = (pm[:, 11] + pm[:, 12]) / 2
        cadera = (pm[:, 23] + pm[:, 24]) / 2
        tronco = float(np.linalg.norm(hombro - cadera))
        ref = self.referencia_tronco(tronco)
        if ref and abs(tronco / ref - 1.0) > A.DESVIO_TRONCO:
            return None

        otro = "izq" if lado == "der" else "der"
        valores = {}
        for nombre, (a, b, c) in A.ARTICULACIONES.items():
            v = float(A.angulo(pm[:, a], pm[:, b], pm[:, c])[0])
            valores["flex_" + nombre] = 180.0 - v if np.nanmin(vis[[a, b, c]]) >= \
                A.VIS_GONIOMETRIA else np.nan
        for l in ("der", "izq"):
            valores["abd_cadera_" + l] = float(A.angulo_frontal_cadera(pm, l)[0])
        d = hombro - cadera
        incl = float(np.degrees(np.arccos(np.clip(-d[0, 1] / tronco, -1, 1))))

        vec = [
            valores["flex_cadera_" + lado], valores["flex_cadera_" + otro],
            valores["flex_rodilla_" + lado], valores["flex_rodilla_" + otro],
            valores["flex_tobillo_" + lado], valores["flex_tobillo_" + otro],
            valores["abd_cadera_" + lado], valores["abd_cadera_" + otro],
            incl, 0.0, 0.0, 0.0,     # velocidades: se rellenan abajo
            float(np.nanmin(vis[adm])),
            float(not np.isnan(valores["flex_cadera_" + otro])),
        ]
        vec = np.array(vec, dtype=np.float32)
        # velocidad causal: diferencia con la muestra anterior
        if self.crudos:
            previo = self.crudos[-1]
            for k, j in ((9, 0), (10, 2), (11, 6)):
                vec[k] = (vec[j] - previo[j]) * HZ
        vec[V.CONTRALATERALES] = np.nan_to_num(vec[V.CONTRALATERALES], nan=0.0)
        return np.nan_to_num(vec, nan=0.0)


def recorrer(vid, evaluador, indice, maximo=None):
    """Recorre un video como si llegara de una camara, y cronometra."""
    fila = indice[vid]
    ruta = BASE_VIDEOS / fila["carpeta"] / fila["archivo"]
    paso = max(1, int(round(float(fila["fps_nativo"]) / HZ)))

    import mediapipe as mp
    pose = mp.solutions.pose.Pose(static_image_mode=False,
                                  model_complexity=evaluador.complejidad,
                                  min_detection_confidence=0.5,
                                  min_tracking_confidence=0.5)
    cap = cv2.VideoCapture(str(ruta))
    tiempos = {"pose": [], "features_y_red": []}
    predicciones, idx = [], 0
    try:
        while True:
            if not cap.grab():
                break
            if idx % paso == 0:
                ok, frame = cap.retrieve()
                if not ok:
                    break
                h0, w0 = frame.shape[:2]
                t0 = time.perf_counter()
                rgb = cv2.cvtColor(cv2.resize(frame, (640, int(h0 * 640 / w0))),
                                   cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                res = pose.process(rgb)
                t1 = time.perf_counter()
                if res.pose_landmarks:
                    lm = np.array([[l.x, l.y, l.z, l.visibility]
                                   for l in res.pose_landmarks.landmark], np.float32)
                    mundo = np.array([[l.x, l.y, l.z, l.visibility]
                                      for l in res.pose_world_landmarks.landmark],
                                     np.float32)
                    izq = float(np.nanmin(lm[A.ADMISION_IZQ, 3]))
                    der = float(np.nanmin(lm[A.ADMISION_DER, 3]))
                    p = evaluador.paso(lm, mundo, "izq" if izq >= der else "der")
                    if p:
                        predicciones.append((idx / float(fila["fps_nativo"]),
                                             p["ejercicio"]))
                t2 = time.perf_counter()
                tiempos["pose"].append((t1 - t0) * 1000)
                tiempos["features_y_red"].append((t2 - t1) * 1000)
                if maximo and len(tiempos["pose"]) >= maximo:
                    break
            idx += 1
    finally:
        pose.close()
        cap.release()
    return tiempos, predicciones


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="C01,R06,R08")
    ap.add_argument("--maximo", type=int, default=250)
    ap.add_argument("--complejidad", type=int, default=2,
                    help="modelo de pose: 2 es el que produjo el dataset")
    args = ap.parse_args()

    indice = {r["id"]: r for r in csv.DictReader(
        (RAIZ / "00_indice/videos.csv").open(encoding="utf-8"))}
    ficha = {f["id"]: f for f in csv.DictReader(
        (RAIZ / "referencia/ficha_normalizada.csv").open(encoding="utf-8"))}

    evaluador = EvaluadorEnVivo(args.complejidad)
    filas = []
    for vid in [v.strip().upper() for v in args.videos.split(",")]:
        evaluador.buffer.clear()
        evaluador.crudos.clear()
        evaluador.tronco_ref = None
        t, pred = recorrer(vid, evaluador, indice, args.maximo)
        esperado = ficha[vid]["ejercicio"]
        # Dentro de tanda frente a fuera: el modelo solo vio ventanas de
        # dentro de una tanda durante el entrenamiento. Fuera de ellas
        # esta clasificando algo que nunca se le enseno.
        tandas = [(float(x["t_inicio_s"]), float(x["t_fin_s"]))
                  for x in csv.DictReader((RAIZ / "04_segmentos/segmentos.csv")
                                          .open(encoding="utf-8")) if x["id"] == vid]
        def en_tanda(t):
            return any(a <= t <= b for a, b in tandas)
        dentro = [(t, e) for t, e in pred if en_tanda(t)]
        fuera = [(t, e) for t, e in pred if not en_tanda(t)]
        ac_dentro = sum(1 for _, e in dentro if e == esperado)
        ac_fuera = sum(1 for _, e in fuera if e == esperado)
        aciertos = sum(1 for _, e in pred if e == esperado)
        pose_ms = float(np.median(t["pose"]))
        red_ms = float(np.median(t["features_y_red"]))
        filas.append({
            "id": vid, "complejidad_pose": evaluador.complejidad,
            "ejercicio_esperado": esperado,
            "fotogramas": len(t["pose"]), "predicciones": len(pred),
            "aciertos": aciertos,
            "pct_acierto": round(100 * aciertos / max(len(pred), 1), 1),
            "pred_en_tanda": len(dentro),
            "pct_acierto_en_tanda": round(100 * ac_dentro / max(len(dentro), 1), 1),
            "pred_fuera_de_tanda": len(fuera),
            "pct_acierto_fuera": round(100 * ac_fuera / max(len(fuera), 1), 1),
            "pose_ms_p50": round(pose_ms, 1),
            "features_red_ms_p50": round(red_ms, 1),
            "total_ms_p50": round(pose_ms + red_ms, 1),
            "total_ms_p95": round(float(np.percentile(
                np.array(t["pose"]) + np.array(t["features_y_red"]), 95)), 1),
            "fps_sostenible": round(1000.0 / (pose_ms + red_ms), 1),
        })
        print("{}: {} pred | global {:.0f} %  EN TANDA {:.0f} % ({}) "
              "fuera {:.0f} % ({}) | {:.0f} ms ({:.1f} fps)".format(
                  vid, len(pred), filas[-1]["pct_acierto"],
                  filas[-1]["pct_acierto_en_tanda"], len(dentro),
                  filas[-1]["pct_acierto_fuera"], len(fuera),
                  pose_ms + red_ms, filas[-1]["fps_sostenible"]), flush=True)

    with SALIDA.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    print("\n{} filas -> {}".format(len(filas), SALIDA))
    print("latencia mediana total: {:.0f} ms".format(
        float(np.mean([f["total_ms_p50"] for f in filas]))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
