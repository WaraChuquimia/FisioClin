"""Pasa un video por todo el pipeline y mira si las features tienen sentido.

    python tests/probar_con_video.py "ruta/al/video.mp4" C01

Es la prueba que de verdad importa. `verificar_paridad.py` comprueba que
la aritmetica del modelo esta bien copiada; esta comprueba lo otro: que
las features que arma el servicio se parezcan a las que vio el modelo
durante el entrenamiento.

La senal a mirar es el z-score. Cada feature se escala con la media y la
desviacion del entrenamiento, asi que si el pipeline mide bien, los
valores en vivo deberian quedar en torno a ±2. Un |z| medio de 8 no es
"un poco distinto": es una feature en otras unidades, o con otro signo, o
calculada sobre el punto equivocado.

Tambien simula el ritmo irregular de la camara del telefono
(`takePictureAsync` a ~6 fps con jitter), no los fotogramas perfectos del
video, para que el remuestreador a 10 Hz este de verdad haciendo su
trabajo.
"""
from __future__ import annotations

import json
import os
import sys

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("GLOG_minloglevel", "3")

import cv2
import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
SERVICIO = os.path.dirname(AQUI)
APP_ML = os.path.join(os.path.dirname(os.path.dirname(SERVICIO)), "ml")
sys.path.insert(0, SERVICIO)

import main as SERV  # noqa: E402

#: Ritmo que da un telefono de gama media sacando fotos en bucle.
FPS_SIMULADO = 6.0
JITTER = 0.25  # +-25 % de variacion entre foto y foto


def cargar_modelo():
    """El mismo LSTM que corre en el telefono, leido del JSON de la app."""
    pesos = json.load(open(os.path.join(APP_ML, "fisioclin_lstm_pesos.json"), encoding="utf-8"))
    esc = json.load(open(os.path.join(APP_ML, "fisioclin_escalador.json"), encoding="utf-8"))
    clases = json.load(open(os.path.join(APP_ML, "fisioclin_clases.json"), encoding="utf-8"))
    return pesos, esc, clases


def predecir(pesos, esc, ventana):
    sys.path.insert(0, AQUI)
    from verificar_paridad import predecir_desde_json
    return predecir_desde_json(pesos, esc, ventana)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    ruta = sys.argv[1]
    id_ejercicio = sys.argv[2] if len(sys.argv) > 2 else "C01"

    if not os.path.exists(ruta):
        print(f"No encuentro el video: {ruta}")
        return 2

    pesos, esc, clases = cargar_modelo()
    media = np.array(esc["media"], np.float32)
    desv = np.array(esc["desviacion"], np.float32)
    nombres = clases["features"]

    medidor = SERV.Medidor(id_ejercicio)
    cap = cv2.VideoCapture(ruta)
    fps_video = cap.get(cv2.CAP_PROP_FPS) or 30.0

    rng = np.random.default_rng(0)
    filas, descartados, total = [], 0, 0
    t_sim = 0.0
    proxima_captura = 0.0
    i = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t_video = i / fps_video
        i += 1
        # Solo se "fotografia" cuando toca, imitando el bucle de la app.
        if t_video < proxima_captura:
            continue
        paso = (1.0 / FPS_SIMULADO) * (1.0 + rng.uniform(-JITTER, JITTER))
        proxima_captura = t_video + paso
        t_sim = t_video

        total += 1
        medida = medidor.medir(frame)
        if not medida.get("fiable"):
            descartados += 1
            medidor.remuestreador.reiniciar()
            continue
        medida.pop("landmarks", None)
        for rejilla in medidor.remuestreador.agregar(t_sim, medida):
            filas.append(SERV.construir_features(rejilla, medidor.cfg))

    cap.release()
    medidor.cerrar()

    print(f"video              : {os.path.basename(ruta)}")
    print(f"ejercicio esperado : {medidor.cfg['ejercicio']} ({id_ejercicio})")
    print(f"fotogramas usados  : {total}  ({descartados} sin pose fiable)")
    print(f"filas de rejilla   : {len(filas)}  ({len(filas) / SERV.HZ:.1f} s a 10 Hz)")

    if len(filas) < 30:
        print("\nNo hay ni una ventana de 3 s utilizable. Revisa el encuadre del video.")
        return 1

    m = np.array([[np.nan if v is None else v for v in f] for f in filas], np.float64)

    print("\n  feature                 media      z medio   |z| max   huecos")
    print("  " + "-" * 62)
    peor_z = 0.0
    for j, nombre in enumerate(nombres):
        col = m[:, j]
        huecos = int(np.isnan(col).sum())
        val = np.nanmean(col) if huecos < len(col) else np.nan
        z = (col - media[j]) / desv[j]
        z_med = np.nanmean(z) if huecos < len(col) else np.nan
        z_max = np.nanmax(np.abs(z)) if huecos < len(col) else np.nan
        if np.isfinite(z_max):
            peor_z = max(peor_z, float(np.nanmean(np.abs(z))))
        print(f"  {nombre:<22} {val:>8.2f}   {z_med:>8.2f}  {z_max:>8.2f}   {huecos:>4}/{len(col)}")

    # Ventanas de 3 s cada 1 s, igual que en la app.
    relleno = m.copy()
    for j in range(relleno.shape[1]):
        col = relleno[:, j]
        if np.all(np.isnan(col)):
            col[:] = media[j]
        else:
            idx = np.where(~np.isnan(col))[0]
            col[:] = np.interp(np.arange(len(col)), idx, col[idx])

    votos: dict[str, int] = {}
    calidades: dict[str, int] = {}
    for inicio in range(0, len(relleno) - 30 + 1, 10):
        ventana = relleno[inicio:inicio + 30].astype(np.float32)
        p_ej, p_cal = predecir(pesos, esc, ventana)
        votos[clases["ejercicios"][int(p_ej.argmax())]] = \
            votos.get(clases["ejercicios"][int(p_ej.argmax())], 0) + 1
        calidades[clases["calidad"][int(p_cal.argmax())]] = \
            calidades.get(clases["calidad"][int(p_cal.argmax())], 0) + 1

    n = sum(votos.values())
    print(f"\n  {n} ventanas evaluadas por el LSTM")
    print("  ejercicio que ve la red:")
    for k, v in sorted(votos.items(), key=lambda kv: -kv[1])[:5]:
        marca = "  <- prescrito" if k == medidor.cfg["ejercicio"] else ""
        print(f"    {100 * v / n:5.1f} %  {k}{marca}")
    print("  calidad:", {k: f"{100 * v / n:.0f} %" for k, v in calidades.items()})

    acierto = votos.get(medidor.cfg["ejercicio"], 0) / n
    print(f"\n  |z| medio global   : {peor_z:.2f}")
    print(f"  ventanas que aciertan el ejercicio: {100 * acierto:.1f} %")

    if peor_z > 4:
        print("\nFALLA: las features caen lejos de la distribucion de entrenamiento.")
        print("Casi siempre significa que un angulo se esta midiendo en otras")
        print("unidades, con otro signo, o sobre los puntos equivocados.")
        return 1

    print("\nOK: las features viven donde el modelo espera.")
    if acierto < 0.5:
        print()
        print("El porcentaje de acierto de arriba NO es el criterio de esta prueba,")
        print("y que sea bajo no quiere decir que el pipeline este mal. La cabeza de")
        print("ejercicio de la red falla tambien con las features del entrenamiento")
        print("(medido en el puente de gluteos: P del correcto = 0,03, por debajo")
        print("del prior de 0,05). Lo que esta prueba certifica es el |z|: que los")
        print("angulos se midan como en el dataset. Quien evalua es evaluador.ts.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
