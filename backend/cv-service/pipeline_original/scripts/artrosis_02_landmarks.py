"""Etapa 2: extraccion de landmarks con MediaPipe Pose.

Esta es la unica etapa cara del pipeline y la unica que vuelve a tocar los
videos. Todo lo posterior trabaja sobre lo que sale de aqui.

Decisiones que quedan fijadas en esta etapa:

* **Remuestreo a 10 Hz.** Fija la cadencia del dataset. Un ciclo de
  ejercicio de rehabilitacion dura entre 2 y 6 s, o sea entre 0,17 y
  0,5 Hz: a 10 Hz caen entre 20 y 60 muestras por repeticion, de sobra
  para describir la forma del movimiento. Y asi una ventana de N muestras
  dura lo mismo aunque manana entre material grabado a otra velocidad.
  Sin esto la red aprenderia la velocidad de la camara.

* **Se guardan las dos representaciones que da MediaPipe.**
  `lm` son coordenadas normalizadas de imagen (utiles para encuadre,
  oclusion y para dibujar sobre el video); `mundo` son coordenadas
  metricas centradas en la cadera, que es donde hay que calcular los
  angulos porque no las deforma la perspectiva. Cual se usa para que se
  decide en la etapa 3, no aqui.

* **El seguimiento se reinicia en cada corte de plano.** MediaPipe en modo
  video arrastra la pose anterior para suavizar; a traves de un corte eso
  inventa una transicion que no existe. Los cortes se detectan sobre la
  misma rejilla de 10 Hz con el criterio de la etapa 1.

* **No se filtra nada.** Ni por visibilidad, ni por encuadre, ni por
  postura. Se guarda todo lo que MediaPipe devuelve y se anota su calidad.
  Descartar aqui seria irreversible; descartar en la etapa 3 no lo es.

    python artrosis_02_landmarks.py                      # los 20, en orden
    python artrosis_02_landmarks.py --worker 0 --workers 4
    python artrosis_02_landmarks.py --videos C01 --rehacer
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("GLOG_minloglevel", "3")

import cv2
import numpy as np

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
INDICE = RAIZ / "00_indice/videos.csv"
SALIDA = RAIZ / "02_landmarks"

HZ_DESTINO = 10.0
ANCHO_PROCESO = 640
COMPLEJIDAD = 2          # el modelo pesado: los angulos son el producto de esto
CONFIANZA_DETECCION = 0.5
CONFIANZA_SEGUIMIENTO = 0.5

ANCHO_DIF = 320
UMBRAL_CORTE_ABS = 18.0
UMBRAL_CORTE_REL = 6.0

N_LANDMARKS = 33
NUCLEO = [11, 12, 23, 24, 25, 26, 27, 28]

BASE_VIDEOS = Path(os.environ["USERPROFILE"]) / (
    "OneDrive - Escuela Militar de Ingenieria/Desktop/catalogo_de_ejercicios")


def a_matriz(landmarks, mundo=False):
    if landmarks is None:
        return np.full((N_LANDMARKS, 4), np.nan, dtype=np.float32)
    return np.array([[l.x, l.y, l.z, l.visibility] for l in landmarks.landmark],
                    dtype=np.float32)


def procesar(fila, mp) -> dict:
    ruta = BASE_VIDEOS / fila["carpeta"] / fila["archivo"]
    fps = float(fila["fps_nativo"])
    paso = max(1, int(round(fps / HZ_DESTINO)))

    cap = cv2.VideoCapture(str(ruta))
    if not cap.isOpened():
        raise RuntimeError("no se puede abrir " + str(ruta))

    # --- primera vuelta: cortes de plano sobre la rejilla de 10 Hz -------
    difs, idx, prev = [], 0, None
    while True:
        if not cap.grab():
            break
        if idx % paso == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            h0, w0 = frame.shape[:2]
            chico = cv2.cvtColor(cv2.resize(frame, (ANCHO_DIF, int(ANCHO_DIF * h0 / w0))),
                                 cv2.COLOR_BGR2GRAY).astype(np.int16)
            if prev is not None:
                difs.append((idx, float(np.abs(chico - prev).mean())))
            prev = chico
        idx += 1
    cap.release()

    valores = np.array([d for _, d in difs]) if difs else np.array([0.0])
    umbral = max(UMBRAL_CORTE_ABS, UMBRAL_CORTE_REL * float(np.median(valores)))
    cortes = {f for f, d in difs if d > umbral}

    # --- segunda vuelta: pose ------------------------------------------
    cap = cv2.VideoCapture(str(ruta))
    pose = mp.solutions.pose.Pose(
        static_image_mode=False, model_complexity=COMPLEJIDAD,
        min_detection_confidence=CONFIANZA_DETECCION,
        min_tracking_confidence=CONFIANZA_SEGUIMIENTO)

    frames, tiempos, escenas, lms, mundos = [], [], [], [], []
    escena, idx = 1, 0
    try:
        while True:
            if not cap.grab():
                break
            if idx % paso == 0:
                ok, frame = cap.retrieve()
                if not ok:
                    break
                if idx in cortes:
                    # Reiniciar el estimador: sin esto arrastra la pose del
                    # plano anterior a traves del corte.
                    pose.close()
                    pose = mp.solutions.pose.Pose(
                        static_image_mode=False, model_complexity=COMPLEJIDAD,
                        min_detection_confidence=CONFIANZA_DETECCION,
                        min_tracking_confidence=CONFIANZA_SEGUIMIENTO)
                    escena += 1
                h0, w0 = frame.shape[:2]
                rgb = cv2.cvtColor(
                    cv2.resize(frame, (ANCHO_PROCESO, int(h0 * ANCHO_PROCESO / w0))),
                    cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                res = pose.process(rgb)
                frames.append(idx)
                tiempos.append(idx / fps)
                escenas.append(escena)
                lms.append(a_matriz(res.pose_landmarks))
                mundos.append(a_matriz(res.pose_world_landmarks))
            idx += 1
    finally:
        pose.close()
        cap.release()

    lm = np.stack(lms) if lms else np.zeros((0, N_LANDMARKS, 4), dtype=np.float32)
    mundo = np.stack(mundos) if mundos else np.zeros((0, N_LANDMARKS, 4), dtype=np.float32)
    con_pose = ~np.isnan(lm[:, 0, 0])

    destino = SALIDA / (fila["id"] + ".npz")
    np.savez_compressed(
        destino,
        lm=lm, mundo=mundo,
        frame=np.array(frames, dtype=np.int32),
        t_seg=np.array(tiempos, dtype=np.float32),
        escena=np.array(escenas, dtype=np.int16),
        meta=np.array([fila["id"], fila["grupo"], str(HZ_DESTINO), str(fps),
                       str(COMPLEJIDAD), str(ANCHO_PROCESO), str(round(umbral, 2))]),
    )

    vis_nucleo = lm[con_pose][:, NUCLEO, 3] if con_pose.any() else np.zeros((0, len(NUCLEO)))
    return {
        "id": fila["id"], "grupo": fila["grupo"],
        "muestras": len(frames),
        "hz": HZ_DESTINO,
        "escenas": escena,
        "cortes": len(cortes),
        "con_pose": int(con_pose.sum()),
        "pct_pose": round(100.0 * con_pose.sum() / max(len(frames), 1), 1),
        "vis_nucleo_p50": round(float(np.median(vis_nucleo.min(axis=1))), 3)
        if len(vis_nucleo) else "",
        "vis_nucleo_p05": round(float(np.percentile(vis_nucleo.min(axis=1), 5)), 3)
        if len(vis_nucleo) else "",
        "mb": round(destino.stat().st_size / 1e6, 2),
    }


def consolidar() -> int:
    """Rehace el registro desde los .npz.

    Se deriva de los datos y no de los logs de las corridas: asi no depende
    de en que proceso ni en que orden se extrajo cada video.
    """
    filas = []
    for ruta in sorted(SALIDA.glob("*.npz")):
        d = np.load(ruta, allow_pickle=True)
        lm = d["lm"]
        con_pose = ~np.isnan(lm[:, 0, 0])
        v = lm[con_pose][:, NUCLEO, 3]
        filas.append({
            "id": ruta.stem, "grupo": str(d["meta"][1]),
            "muestras": len(lm), "hz": str(d["meta"][2]),
            "escenas": int(d["escena"].max()) if len(d["escena"]) else 0,
            "con_pose": int(con_pose.sum()),
            "pct_pose": round(100.0 * con_pose.sum() / max(len(lm), 1), 1),
            "vis_nucleo_p50": round(float(np.median(v.min(axis=1))), 3) if len(v) else "",
            "vis_nucleo_p05": round(float(np.percentile(v.min(axis=1), 5)), 3) if len(v) else "",
            "mb": round(ruta.stat().st_size / 1e6, 2),
        })
    destino = SALIDA / "registro.csv"
    with destino.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    print("{} videos -> {}".format(len(filas), destino))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="")
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--rehacer", action="store_true")
    ap.add_argument("--consolidar", action="store_true",
                    help="rehace registro.csv leyendo los .npz, sin reprocesar video")
    args = ap.parse_args()

    if args.consolidar:
        return consolidar()

    import mediapipe as mp

    filas = list(csv.DictReader(INDICE.open(encoding="utf-8")))
    if args.videos:
        pedidos = {v.strip().upper() for v in args.videos.split(",")}
        filas = [f for f in filas if f["id"] in pedidos]
    filas = [f for i, f in enumerate(filas) if i % args.workers == args.worker]

    SALIDA.mkdir(parents=True, exist_ok=True)
    registro = []
    for i, fila in enumerate(filas, 1):
        destino = SALIDA / (fila["id"] + ".npz")
        if destino.exists() and not args.rehacer:
            print("[{}/{}] {} ya existe, se salta".format(i, len(filas), fila["id"]), flush=True)
            continue
        t0 = time.time()
        info = procesar(fila, mp)
        info["segundos_proceso"] = round(time.time() - t0, 1)
        registro.append(info)
        print("[{}/{}] {} {} muestras, {} escenas, {} % pose, {} MB, {} s".format(
            i, len(filas), info["id"], info["muestras"], info["escenas"],
            info["pct_pose"], info["mb"], info["segundos_proceso"]), flush=True)

    if registro:
        destino = SALIDA / "registro_worker{}.csv".format(args.worker)
        with destino.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(registro[0].keys()))
            w.writeheader()
            w.writerows(registro)
        print("registro ->", destino)
    return 0


if __name__ == "__main__":
    sys.exit(main())
