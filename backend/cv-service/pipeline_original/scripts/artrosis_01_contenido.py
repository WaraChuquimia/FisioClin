"""Etapa 1 del dataset de artrosis: que hay dentro de los videos.

Pasada de diagnostico, no de extraccion. Recorre los 20 videos y responde
las preguntas que la cabecera del archivo no contesta:

  * cuantos planos continuos (escenas) tiene cada video y donde cortan
  * en que fraccion del metraje hay una persona con pose estimable
  * cuantas personas se ven a la vez
  * si el cuerpo entra completo en el encuadre
  * desde que orientacion esta grabado (frontal / perfil)
  * en que postura esta el sujeto (de pie / tumbado)
  * cuanto se mueven los miembros inferiores: separa ejercicio de explicacion

Los landmarks de esta pasada NO se guardan como dato del dataset: se
muestrea a baja frecuencia y solo para diagnosticar. La extraccion buena
es la etapa siguiente.

    python artrosis_01_contenido.py [--videos C01,R05]
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("GLOG_minloglevel", "3")

import cv2
import numpy as np

AQUI = Path(__file__).parent
INDICE = AQUI / "dataset_artrosis/00_indice/videos.csv"
SALIDA = AQUI / "dataset_artrosis/01_contenido"

PASO_DIF = 3      # se decodifica 1 de cada 3 fotogramas para la senal de corte
PASO_POSE = 15    # se estima pose 2 veces por segundo
ANCHO_DIF = 320
ANCHO_POSE = 640

# Un corte de plano dispara una diferencia mucho mayor que cualquier
# movimiento humano. El umbral se fija por video sobre su propia mediana.
UMBRAL_CORTE_ABS = 18.0
UMBRAL_CORTE_REL = 6.0

NUCLEO = [11, 12, 23, 24, 25, 26, 27, 28]   # hombros, caderas, rodillas, tobillos
L_HOMBRO, R_HOMBRO, L_CADERA, R_CADERA = 11, 12, 23, 24
TOBILLOS_RODILLAS = [25, 26, 27, 28]
VIS_MIN = 0.5


def medio(p, a, b):
    return (p[a] + p[b]) / 2


def analizar_pose(lm, w, h):
    """Geometria de una pose en pixeles. Devuelve None si no es utilizable."""
    p = np.array([[l.x * w, l.y * h] for l in lm], dtype=np.float32)
    v = np.array([l.visibility for l in lm], dtype=np.float32)

    hombro, cadera = medio(p, L_HOMBRO, R_HOMBRO), medio(p, L_CADERA, R_CADERA)
    tronco = float(np.linalg.norm(hombro - cadera))
    if tronco < 1e-3:
        return None

    # Ancho de hombros contra largo de tronco: en perfil los hombros se
    # proyectan casi superpuestos, de frente ocupan medio tronco.
    ancho_hombros = float(np.linalg.norm(p[L_HOMBRO] - p[R_HOMBRO]))
    ancho_caderas = float(np.linalg.norm(p[L_CADERA] - p[R_CADERA]))

    # Inclinacion del tronco respecto de la vertical de la imagen:
    # ~0 grados de pie, ~90 grados tumbado.
    d = hombro - cadera
    incl = float(np.degrees(np.arctan2(abs(d[0]), abs(d[1]))))

    vis_nucleo = v[NUCLEO]
    xs, ys = p[NUCLEO, 0] / w, p[NUCLEO, 1] / h
    dentro = bool(xs.min() > 0.01 and xs.max() < 0.99 and ys.min() > 0.01 and ys.max() < 0.99)

    return {
        "vis_nucleo_min": round(float(vis_nucleo.min()), 3),
        "vis_nucleo_media": round(float(vis_nucleo.mean()), 3),
        "tronco_px": round(tronco, 1),
        "razon_hombros": round(ancho_hombros / tronco, 3),
        "razon_caderas": round(ancho_caderas / tronco, 3),
        "inclinacion_tronco": round(incl, 1),
        "cuerpo_completo": int(dentro and float(vis_nucleo.min()) > VIS_MIN),
        "alto_relativo": round(float(ys.max() - ys.min()), 3),
        # Dos medidas de movimiento, ambas en unidades de tronco:
        #  _abs  posicion del nucleo en la imagen (capta traslacion global)
        #  _rel  posicion del nucleo respecto de la pelvis (capta articulacion)
        # La relativa es la que distingue ejercicio de explicacion: ignora
        # paneos de camara y detecta un puente, donde los pies no se mueven
        # pero la pelvis sube respecto de los hombros.
        "_abs": (p[NUCLEO] / tronco).ravel(),
        "_rel": ((p[NUCLEO] - cadera) / tronco).ravel(),
    }


def procesar(fila, pose, caras, escritor_frames):
    ruta = Path(fila["ruta"])
    cap = cv2.VideoCapture(str(ruta))
    if not cap.isOpened():
        print("  " + fila["id"] + ": NO SE PUEDE ABRIR", flush=True)
        return []

    fps = float(fila["fps_nativo"])
    prev_dif = None
    difs = []
    muestras = []
    idx = 0

    while True:
        if not cap.grab():
            break
        if idx % PASO_DIF == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            h0, w0 = frame.shape[:2]
            chico = cv2.cvtColor(
                cv2.resize(frame, (ANCHO_DIF, int(ANCHO_DIF * h0 / w0))), cv2.COLOR_BGR2GRAY
            ).astype(np.int16)
            if prev_dif is not None:
                difs.append((idx, float(np.abs(chico - prev_dif).mean())))
            prev_dif = chico

            if idx % PASO_POSE == 0:
                escala = ANCHO_POSE / w0
                rgb = cv2.cvtColor(
                    cv2.resize(frame, (ANCHO_POSE, int(h0 * escala))), cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                res = pose.process(rgb)
                cara = caras.process(rgb)
                m = {
                    "id": fila["id"],
                    "frame": idx,
                    "t_seg": round(idx / fps, 2),
                    "n_caras": len(cara.detections) if cara.detections else 0,
                    "pose": int(res.pose_landmarks is not None),
                }
                if res.pose_landmarks:
                    g = analizar_pose(res.pose_landmarks.landmark, rgb.shape[1], rgb.shape[0])
                    if g:
                        m.update(g)
                muestras.append(m)
        idx += 1
    cap.release()

    # --- cortes de plano -------------------------------------------------
    valores = np.array([d for _, d in difs]) if difs else np.array([0.0])
    umbral = max(UMBRAL_CORTE_ABS, UMBRAL_CORTE_REL * float(np.median(valores)))
    cortes = [f for f, d in difs if d > umbral]

    escena, vistos = 1, 0
    for m in muestras:
        while vistos < len(cortes) and m["frame"] >= cortes[vistos]:
            vistos += 1
            escena += 1
        m["escena"] = fila["id"] + "_E" + str(escena).zfill(3)
        m["dif_umbral"] = round(umbral, 2)

    # --- energia de movimiento de miembros inferiores ---------------------
    previos = {"_abs": None, "_rel": None}
    for m in muestras:
        for clave, columna in (("_abs", "mov_nucleo"), ("_rel", "mov_articular")):
            actual = m.pop(clave, None)
            anterior = previos[clave]
            if actual is not None and anterior is not None and len(anterior) == len(actual):
                m[columna] = round(float(np.abs(actual - anterior).mean()), 4)
            if actual is not None:
                previos[clave] = actual

    for m in muestras:
        escritor_frames.writerow(m)
    print("  {}: {} muestras, {} escenas, umbral {:.1f}".format(
        fila["id"], len(muestras), escena, umbral), flush=True)
    return muestras


COLUMNAS_FRAME = [
    "id", "frame", "t_seg", "escena", "pose", "n_caras", "vis_nucleo_min",
    "vis_nucleo_media", "tronco_px", "razon_hombros", "razon_caderas",
    "inclinacion_tronco", "cuerpo_completo", "alto_relativo", "mov_nucleo", "mov_articular",
    "dif_umbral",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="", help="lista de ids separados por coma")
    args = ap.parse_args()

    import mediapipe as mp

    base = Path(os.environ["USERPROFILE"]) / (
        "OneDrive - Escuela Militar de Ingenieria/Desktop/catalogo_de_ejercicios")
    filas = list(csv.DictReader(INDICE.open(encoding="utf-8")))
    if args.videos:
        pedidos = {v.strip().upper() for v in args.videos.split(",")}
        filas = [f for f in filas if f["id"] in pedidos]
    for f in filas:
        f["ruta"] = str(base / f["carpeta"] / f["archivo"])

    SALIDA.mkdir(parents=True, exist_ok=True)
    destino = SALIDA / "frames_muestreados.csv"
    modo = "a" if (args.videos and destino.exists()) else "w"

    with destino.open(modo, newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNAS_FRAME, extrasaction="ignore")
        if modo == "w":
            w.writeheader()
        with mp.solutions.pose.Pose(
            static_image_mode=True, model_complexity=1, min_detection_confidence=0.5
        ) as pose, mp.solutions.face_detection.FaceDetection(
            model_selection=1, min_detection_confidence=0.5
        ) as caras:
            for i, fila in enumerate(filas, 1):
                print("[{}/{}] {} {}".format(i, len(filas), fila["id"], fila["archivo"][:50]),
                      flush=True)
                procesar(fila, pose, caras, w)
                fh.flush()
    print("listo ->", destino)


if __name__ == "__main__":
    sys.exit(main())
