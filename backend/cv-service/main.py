"""FisioClin — servicio de vision para la app de Expo.

    uvicorn main:app --host 0.0.0.0 --port 8000

Por que existe: aqui se mide. El telefono graba VIDEO en un WebView con
MediaPipe para web (components/CamaraPose.tsx) y manda solo los 33 puntos
del cuerpo (mensaje `pose`, ~15 por segundo). Este servicio calcula los
angulos, las 14 features del modelo y, con la prescripcion del medico,
las series y repeticiones (evaluador_series.py). Tambien acepta imagenes
JPEG (`frame`) y videos subidos (/analizar-video); para eso si corre
MediaPipe aqui.

## El reloj de 10 Hz

El modelo mira ventanas de 30 muestras y las trata como 3 segundos. Un
telefono sacando fotos con `takePictureAsync` da entre 4 y 8 por segundo,
y de forma irregular. Si se le pasaran esos fotogramas tal cual, 30
muestras serian 5 o 6 segundos de movimiento y el LSTM veria algo que
nunca vio en el entrenamiento.

Por eso el servicio no responde "una fila por fotograma": mantiene una
rejilla fija de 10 Hz, interpola las medidas sobre ella y devuelve las
filas que hayan quedado completas. A veces son 0 filas, a veces 2. El
telefono simplemente empuja las que lleguen.

## Latencia

Las velocidades se calculan con diferencia centrada, igual que el
`np.gradient` del dataset. Eso obliga a conocer la muestra siguiente, asi
que cada fila sale con 100 ms de retraso. Es el precio de que las
features se parezcan a las del entrenamiento.
"""
from __future__ import annotations

import base64
import json
import os
import time
from typing import Any, Optional

import cv2
import mediapipe as mp
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import geometria as GEO
import ocr_carnet
from evaluador_series import EvaluadorSeries

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("GLOG_minloglevel", "3")

AQUI = os.path.dirname(os.path.abspath(__file__))
CLASES = json.load(open(os.path.join(AQUI, "fisioclin_clases.json"), encoding="utf-8"))
CATALOGO = json.load(open(os.path.join(AQUI, "configuracion_ejercicios.json"), encoding="utf-8"))["ejercicios"]

HZ = 10.0
DT = 1.0 / HZ
NOMBRES_FEATURES = CLASES["features"]

#: Hueco maximo, en segundos, que el remuestreador rellena interpolando
#: entre dos muestras reales. Mas alla de esto, dos muestras separadas por
#: un corte de red ya no describen el mismo movimiento: mejor reiniciar la
#: rejilla y avisar a la app (flag `reinicio`) que inventar filas de golpe.
MAX_HUECO_S = 0.4

#: Peso de la muestra nueva en el suavizado causal. 1.0 lo desactiva.
#:
#: El dataset se suavizo con Savitzky-Golay, que mira hacia adelante y
#: hacia atras; en vivo solo se puede mirar hacia atras. Sin ningun
#: suavizado las velocidades salen dominadas por el ruido del detector
#: (la desviacion de `vel_rodilla` en el entrenamiento es 54 grados/s,
#: derivar la senal cruda a 10 Hz da bastante mas). Este EMA es el mismo
#: que usa el evaluador de escritorio.
SUAVIZADO_ALFA = 0.4

#: Calibracion de la visibilidad que manda el TELEFONO (MediaPipe para
#: web, mensaje `pose`). Ese modelo la reporta sistematicamente mas baja
#: que el de Python sobre la MISMA imagen: en los 712 cuadros del video de
#: la sentadilla, rodilla 0,82 contra 0,90 de media. Se suma aqui, una
#: sola vez, para que los umbrales de geometria.py (0,5 para admitir un
#: lado, 0,6 para medir un angulo) sigan siendo los mismos para todos.
#: Medido en ese video: filas con angulo 525 -> 533 (Python: 576), y las
#: mismas 3 repeticiones con ROM a 2-5 grados de las de Python.
CORRECCION_VIS_TELEFONO = 0.1

#: Landmarks que se devuelven para dibujar el esqueleto en la app.
ESQUELETO = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]

#: Postura esperada de cada ejercicio (`configuracion_ejercicios.json`,
#: campo "postura"), contra la inclinacion del tronco que de verdad se
#: mide. Sin esto, el servicio solo mira el angulo de UNA articulacion: un
#: paciente de pie haciendo cualquier cosa puede, por casualidad, mover esa
#: articulacion dentro del rango y "contar" como si estuviera haciendo un
#: ejercicio tumbado que nunca hizo. No se reintenta la clasificacion por
#: red (la cabeza de ejercicio del LSTM se midio poco fiable incluso con
#: features perfectas, ver LEEME.md "La cabeza de ejercicio NO esta
#: lista") sino la unica distincion de postura que SI se puede leer de
#: forma fiable con una sola camara: de pie/semisentado deja el tronco
#: cerca de la vertical de la imagen; tumbado o a cuatro patas lo deja
#: cerca de la horizontal.
#:
#: Deja una zona ambigua (25-80 grados) sin rechazar nada: una sentadilla
#: profunda o un peso muerto de pie inclinan bastante el tronco hacia
#: adelante y no por eso es "tumbarse". Los umbrales son una propuesta
#: razonada, no se midieron contra video real (no habia uno a mano) — si
#: alguna repeticion de pie buena sale rechazada como "Postura incorrecta"
#: en R07/R08 (las que mas inclinan el tronco), subir TRONCO_MAX_DE_PIE.
POSTURAS_VERTICALES = {"bipedestacion", "semisentado", "sedente"}
TRONCO_MAX_DE_PIE = 80.0   # grados desde la vertical; por encima, "de pie" ya no es creible
TRONCO_MIN_TUMBADO = 25.0  # grados desde la vertical; por debajo, "tumbado" ya no es creible

TEXTO_POSTURA = {
    "supino": "boca arriba",
    "prono": "boca abajo",
    "decubito_lateral": "de lado",
    "cuadrupedia": "a cuatro patas",
    "sedente": "sentado",
    "semisentado": "semisentado",
    "bipedestacion": "de pie",
}

app = FastAPI(title="FisioClin CV")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)
app.include_router(ocr_carnet.router)


# ==================================================================
# Rejilla de 10 Hz
# ==================================================================
CLAVES = (
    "flex_cadera_izq", "flex_cadera_der",
    "flex_rodilla_izq", "flex_rodilla_der",
    "flex_tobillo_izq", "flex_tobillo_der",
    "abd_cadera_izq", "abd_cadera_der",
    "inclinacion_tronco",
    "vis_izq", "vis_der",
)

#: Angulos de los que salen las tres features de velocidad, por lado.
DERIVADOS = ("flex_cadera", "flex_rodilla", "abd_cadera")


class Remuestreador:
    """Lleva las medidas irregulares de la camara a una rejilla de 10 Hz."""

    def __init__(self):
        self.anterior: Optional[tuple[float, dict]] = None
        self.t_rejilla: Optional[float] = None
        self.buffer: list[dict] = []   # filas de rejilla pendientes de derivar
        #: Estado del EMA causal, en las UNIDADES DE LA REJILLA (dt fijo =
        #: DT). Ver `_suavizar_fila`.
        self.suave: dict[str, float] = {}
        #: Se pone en True dentro de `agregar()` cuando el hueco entre dos
        #: muestras obligo a reiniciar la rejilla en vez de interpolar. El
        #: llamador lo lee justo despues de llamar y lo manda a la app para
        #: que tambien vacie su ventana deslizante.
        self.hubo_reinicio_por_hueco = False

    def agregar(self, t: float, medida: dict) -> list[dict]:
        """Devuelve las filas de rejilla que han quedado listas (0, 1 o mas)."""
        self.hubo_reinicio_por_hueco = False

        if self.anterior is not None and (t - self.anterior[0]) > MAX_HUECO_S:
            # Un hueco asi (p. ej. un corte de wifi de 2 s) haria que el
            # bucle de abajo emita decenas de filas de golpe, todas
            # interpoladas entre dos muestras que ya no describen el mismo
            # movimiento. Mejor cortar limpio.
            self.reiniciar()
            self.hubo_reinicio_por_hueco = True

        if self.anterior is None:
            self.anterior = (t, medida)
            self.t_rejilla = t
            return []

        t0, m0 = self.anterior
        listas = []
        while self.t_rejilla is not None and self.t_rejilla <= t:
            fila = _interpolar(t0, m0, t, medida, self.t_rejilla)
            fila["t"] = round(self.t_rejilla, 3)
            self._suavizar_fila(fila)
            self.buffer.append(fila)
            del self.buffer[:-3]   # solo hacen falta tres para derivar
            self.t_rejilla += DT
            # Se puede derivar la fila del medio en cuanto hay tres.
            if len(self.buffer) == 3:
                listas.append(self._derivar())
        self.anterior = (t, medida)
        return listas

    def _suavizar_fila(self, fila: dict):
        """EMA causal sobre la fila YA REMUESTREADA, con `dt` fijo (=DT).

        El dataset se suavizo con Savitzky-Golay a 10 Hz, que es no causal
        y no desfasa. Si este EMA se aplica antes del remuestreo (en tiempo
        de camara, como antes) su constante de tiempo depende del fps del
        telefono: a 2 fps el retraso efectivo llega a 0,75 s, muy por
        encima de lo que vio el modelo en el entrenamiento. Aplicado aqui,
        sobre la rejilla, el retraso es siempre el mismo sea cual sea el
        fps de la camara.
        """
        if SUAVIZADO_ALFA >= 1.0:
            return
        for k in CLAVES:
            if k.startswith("vis_"):
                continue
            v = fila.get(k)
            if v is None:
                self.suave.pop(k, None)  # tras un hueco se empieza de cero
                continue
            previo = self.suave.get(k)
            nuevo = v if previo is None else (1 - SUAVIZADO_ALFA) * previo + SUAVIZADO_ALFA * v
            self.suave[k] = nuevo
            fila[k] = nuevo

    def _derivar(self) -> dict:
        prev, actual, sig = self.buffer[-3], self.buffer[-2], self.buffer[-1]
        for base in DERIVADOS:
            for lado in ("izq", "der"):
                a, b = prev.get(f"{base}_{lado}"), sig.get(f"{base}_{lado}")
                # Diferencia centrada = np.gradient en los puntos interiores.
                actual[f"vel_{base}_{lado}"] = None if a is None or b is None else (b - a) / (2 * DT)
        return actual

    def reiniciar(self):
        self.anterior = None
        self.t_rejilla = None
        self.buffer.clear()
        self.suave.clear()


def _interpolar(t0: float, m0: dict, t1: float, m1: dict, t: float) -> dict:
    """Mezcla linealmente dos medidas. Un hueco en cualquiera de las dos
    deja hueco: inventar un valor entre 'no se veia' y 'se veia' seria
    peor que decir que no se sabe."""
    if t1 <= t0:
        w = 1.0
    else:
        w = min(1.0, max(0.0, (t - t0) / (t1 - t0)))
    out: dict[str, Any] = {}
    for k in CLAVES:
        a, b = m0.get(k), m1.get(k)
        out[k] = None if a is None or b is None else a + (b - a) * w
    # El lado no se interpola: se toma el de la medida mas cercana.
    out["lado"] = m1.get("lado") if w >= 0.5 else m0.get("lado")
    out["fiable"] = bool(m0.get("fiable")) and bool(m1.get("fiable"))
    out["motivo"] = m1.get("motivo") or m0.get("motivo") or ""
    return out


# ==================================================================
# Medicion de un fotograma
# ==================================================================
class Medidor:
    """Una sesion: una instancia de MediaPipe y su estado de suavizado.

    MediaPipe Pose guarda estado de seguimiento entre fotogramas y no es
    seguro compartirlo entre conexiones, asi que hay un Medidor por
    WebSocket.
    """

    def __init__(self, id_ejercicio: str, complejidad: int = 1):
        self.cfg = CATALOGO.get(id_ejercicio)
        if self.cfg is None:
            raise ValueError(f"Ejercicio desconocido: {id_ejercicio}")
        #: MediaPipe solo se carga si llegan IMAGENES (videos subidos,
        #: probar_modelo.py). La app manda la pose ya calculada en el
        #: telefono (`medir_puntos`) y no lo necesita.
        self.complejidad = complejidad
        self._pose = None
        self.tronco_ref: Optional[float] = None
        self.selector_lado = GEO.SelectorLado()
        self.remuestreador = Remuestreador()
        #: Contadores para el HUD de calidad de captura (Fase 1.4): cuantos
        #: fotogramas de camara realmente utilizables entraron, contra
        #: cuantas filas de rejilla de 10 Hz salieron. La diferencia es lo
        #: que el remuestreador tuvo que inventar por interpolacion.
        self.n_muestras_reales = 0
        self.n_filas_emitidas = 0

    def cerrar(self):
        if self._pose is not None:
            self._pose.close()

    @property
    def pose(self):
        if self._pose is None:
            self._pose = mp.solutions.pose.Pose(
                static_image_mode=False,
                model_complexity=self.complejidad,
                smooth_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
        return self._pose

    def medir(self, bgr) -> dict:
        """Un fotograma -> medidas crudas (o el motivo de por que no)."""
        h, w = bgr.shape[:2]
        chico = cv2.resize(bgr, (640, max(1, int(h * 640 / w))))
        rgb = cv2.cvtColor(chico, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        res = self.pose.process(rgb)

        if not res.pose_landmarks or not res.pose_world_landmarks:
            return self.sin_persona()

        vis = np.array([l.visibility for l in res.pose_landmarks.landmark], np.float32)
        xy = np.array([[l.x, l.y] for l in res.pose_landmarks.landmark], np.float32)
        pm = np.array([[l.x, l.y, l.z] for l in res.pose_world_landmarks.landmark],
                      np.float32)[None, :, :]
        return self.medir_puntos(vis, xy, pm)

    def sin_persona(self) -> dict:
        self.remuestreador.reiniciar()
        self.selector_lado.reiniciar()
        return {"hay_persona": False, "fiable": False,
                "motivo": "Colocate frente a la camara, de cuerpo entero"}

    def medir_puntos(self, vis: np.ndarray, xy: np.ndarray, pm: np.ndarray) -> dict:
        """La pose ya detectada (aqui o en el telefono) -> medidas crudas.

        vis: (33,) visibilidad; xy: (33, 2) coordenadas de imagen 0..1;
        pm: (1, 33, 3) world landmarks en metros. Mismo formato que da
        MediaPipe Pose en Python y PoseLandmarker en el navegador.
        """
        # Se calculan en cuanto hay persona, no solo en el camino feliz: es
        # justo cuando la pose es marginal ("Reposicionate", "Acercate")
        # que el paciente mas necesita ver el esqueleto para corregirse.
        landmarks = [
            {"x": round(float(xy[i, 0]), 4), "y": round(float(xy[i, 1]), 4),
             "v": round(float(vis[i]), 2)}
            for i in ESQUELETO
        ]

        lado, vis_lado = self.selector_lado.actualizar(vis)
        if vis_lado < GEO.VIS_ADMISION:
            return {"hay_persona": True, "fiable": False, "lado": lado,
                    "motivo": "Reposicionate: no se ven bien hombro, cadera y rodilla",
                    "landmarks": landmarks}

        inclinacion, tronco_m = GEO.inclinacion_tronco(pm)

        # El esqueleto reconstruido tiene que tener proporciones humanas: si
        # el tronco cambia de largo, la reconstruccion esta degenerada y su
        # angulo no vale (etapa 3 del dataset).
        self.tronco_ref = tronco_m if self.tronco_ref is None else \
            0.98 * self.tronco_ref + 0.02 * tronco_m
        if self.tronco_ref > 1e-6 and abs(tronco_m / self.tronco_ref - 1.0) > GEO.DESVIO_TRONCO:
            return {"hay_persona": True, "fiable": False, "lado": lado,
                    "motivo": "Acercate o alejate: no se te ve el cuerpo completo",
                    "landmarks": landmarks}

        postura = self.cfg.get("postura")
        if postura and np.isfinite(inclinacion):
            de_pie_esperado = postura in POSTURAS_VERTICALES
            texto = TEXTO_POSTURA.get(postura, postura)
            if de_pie_esperado and inclinacion > TRONCO_MAX_DE_PIE:
                return {"hay_persona": True, "fiable": False, "lado": lado,
                        "motivo": f"Postura incorrecta: este ejercicio se hace {texto}",
                        "landmarks": landmarks}
            if not de_pie_esperado and inclinacion < TRONCO_MIN_TUMBADO:
                return {"hay_persona": True, "fiable": False, "lado": lado,
                        "motivo": f"Postura incorrecta: este ejercicio se hace {texto}",
                        "landmarks": landmarks}

        m: dict[str, Any] = {"hay_persona": True, "fiable": True, "lado": lado, "motivo": ""}
        for art in ("cadera", "rodilla", "tobillo"):
            for l in ("izq", "der"):
                m[f"flex_{art}_{l}"] = GEO.flexion(pm, vis, f"{art}_{l}")
        for l in ("izq", "der"):
            a = float(GEO.angulo_frontal_cadera(pm, l)[0])
            m[f"abd_cadera_{l}"] = None if not np.isfinite(a) else a
        m["inclinacion_tronco"] = None if not np.isfinite(inclinacion) else inclinacion
        m["vis_izq"] = float(np.nanmin(vis[GEO.ADMISION_IZQ]))
        m["vis_der"] = float(np.nanmin(vis[GEO.ADMISION_DER]))
        m["landmarks"] = landmarks
        return m


def construir_features(fila: dict, cfg: dict) -> list[Optional[float]]:
    """Las 14 columnas del modelo, en el orden de fisioclin_clases.json."""
    lado = fila.get("lado") or "izq"
    otro = "der" if lado == "izq" else "izq"
    g = fila.get

    # `contra_presente` marca si el lado contrario se pudo medir. Se decide
    # con la flexion de cadera contralateral, que es la que necesita menos
    # puntos visibles: si esa falta, ninguna de las otras contralaterales hay.
    contra = 0.0 if g(f"flex_cadera_{otro}") is None else 1.0

    return [
        g(f"flex_cadera_{lado}"),
        g(f"flex_cadera_{otro}"),
        g(f"flex_rodilla_{lado}"),
        g(f"flex_rodilla_{otro}"),
        g(f"flex_tobillo_{lado}"),
        g(f"flex_tobillo_{otro}"),
        g(f"abd_cadera_{lado}"),
        g(f"abd_cadera_{otro}"),
        g("inclinacion_tronco"),
        g(f"vel_flex_cadera_{lado}"),
        g(f"vel_flex_rodilla_{lado}"),
        g(f"vel_abd_cadera_{lado}"),
        g(f"vis_{lado}"),
        contra,
    ]


def angulo_medido(fila: dict, cfg: dict) -> tuple[Optional[float], Optional[float]]:
    """(angulo de la articulacion que evalua este ejercicio, su contralateral)."""
    lado = fila.get("lado") or "izq"
    otro = "der" if lado == "izq" else "izq"
    if cfg.get("senal") == "abduccion":
        return fila.get(f"abd_cadera_{lado}"), fila.get(f"abd_cadera_{otro}")
    art = cfg["articulacion_medida"]
    return fila.get(f"flex_{art}_{lado}"), fila.get(f"flex_{art}_{otro}")


def velocidad_medida(fila: dict, cfg: dict) -> Optional[float]:
    """Velocidad angular (grados/s) de la articulacion que evalua el ejercicio."""
    lado = fila.get("lado") or "izq"
    if cfg.get("senal") == "abduccion":
        return fila.get(f"vel_abd_cadera_{lado}")
    return fila.get(f"vel_flex_{cfg['articulacion_medida']}_{lado}")


def angulos_biomecanicos(fila: dict) -> dict:
    """Todos los angulos de la fila para el informe: flexion de cadera,
    rodilla y tobillo y abduccion de cadera (los dos lados) e inclinacion
    del tronco. Flexion en convencion goniometrica: 0 = segmento estirado."""
    return {k: limpiar(fila.get(k)) for k in CLAVES if not k.startswith("vis_")}


def limpiar(v):
    """NaN/inf -> None, para que el JSON sea valido."""
    if v is None:
        return None
    f = float(v)
    return None if not np.isfinite(f) else round(f, 3)


# ==================================================================
# Un fotograma de principio a fin (lo usan el WebSocket y /analizar-video)
# ==================================================================
def procesar_imagen(medidor: Medidor, evaluador: Optional[EvaluadorSeries],
                    bgr, t: float) -> dict:
    """Imagen BGR -> sobre `fotograma` con las filas de 10 Hz y, si hay
    prescripcion, el estado de la serie en `sesion`."""
    return procesar_medida(medidor, evaluador, medidor.medir(bgr), t)


def leer_pose(msg: dict) -> Optional[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Mensaje `pose` del telefono -> (vis, xy, pm) como los da MediaPipe.

    `lm`: 33 x [x, y, visibilidad] de imagen (0..1); `mundo`: 33 x [x, y, z]
    en metros. null/vacio = no hay persona. Cualquier forma rara se trata
    como "no hay persona", nunca como una medida.
    """
    lm, mundo = msg.get("lm"), msg.get("mundo")
    if not lm or not mundo:
        return None
    try:
        a = np.asarray(lm, np.float32)
        w = np.asarray(mundo, np.float32)
    except (TypeError, ValueError):
        return None
    if a.shape != (33, 3) or w.shape != (33, 3):
        return None
    if not (np.isfinite(a).all() and np.isfinite(w).all()):
        return None
    vis = np.minimum(a[:, 2] + CORRECCION_VIS_TELEFONO, 1.0)
    return vis, a[:, :2], w[None, :, :]


def procesar_pose(medidor: Medidor, evaluador: Optional[EvaluadorSeries],
                  msg: dict, t: float) -> dict:
    """Pose calculada en el telefono -> el mismo sobre que una imagen."""
    puntos = leer_pose(msg)
    medida = medidor.sin_persona() if puntos is None else medidor.medir_puntos(*puntos)
    return procesar_medida(medidor, evaluador, medida, t)


def procesar_medida(medidor: Medidor, evaluador: Optional[EvaluadorSeries],
                    medida: dict, t: float) -> dict:
    """Medida cruda -> filas de 10 Hz, estado de la serie y sobre de respuesta."""
    landmarks = medida.pop("landmarks", None)

    filas = []
    reinicio = False
    if medida["fiable"]:
        medidor.n_muestras_reales += 1
        nuevas = medidor.remuestreador.agregar(t, medida)
        medidor.n_filas_emitidas += len(nuevas)
        reinicio = medidor.remuestreador.hubo_reinicio_por_hueco
        for rejilla in nuevas:
            ang, contra = angulo_medido(rejilla, medidor.cfg)
            filas.append({
                "t": rejilla["t"],
                "hay_persona": True,
                "fiable": bool(rejilla.get("fiable")) and ang is not None,
                "motivo": rejilla.get("motivo", ""),
                "lado": rejilla.get("lado", ""),
                "angulo": limpiar(ang),
                "inclinacion_tronco": limpiar(rejilla.get("inclinacion_tronco")),
                "contra": limpiar(contra),
                "velocidad": limpiar(velocidad_medida(rejilla, medidor.cfg)),
                "angulos": angulos_biomecanicos(rejilla),
                "features": [limpiar(v) for v in
                             construir_features(rejilla, medidor.cfg)],
            })
    else:
        # Sin medida fiable no hay rejilla que avanzar, pero la app
        # necesita saberlo para pintar el aviso. `reinicio = True`
        # aqui es lo que le dice al telefono que vacie tambien su
        # ventana deslizante: sin esto conserva muestras que ya no
        # son contiguas con lo que vendra despues (Capa 1c).
        medidor.remuestreador.reiniciar()
        reinicio = True
        filas.append({
            "t": t,
            "hay_persona": bool(medida.get("hay_persona")),
            "fiable": False,
            "motivo": medida.get("motivo", ""),
            "lado": medida.get("lado", ""),
            "angulo": None,
            "inclinacion_tronco": None,
            "contra": None,
            "velocidad": None,
            "angulos": {},
            "features": [None] * len(NOMBRES_FEATURES),
        })

    # Las series se evaluan con las MISMAS filas que recibe el telefono.
    # Un mensaje puede traer dos filas, y en cada una puede cerrarse una
    # repeticion: se mandan todas las nuevas, no solo la ultima.
    sesion = None
    if evaluador is not None:
        reps_nuevas, series_cerradas = [], []
        for fila in filas:
            sesion = evaluador.procesar(fila)
            if sesion["repeticion_nueva"]:
                reps_nuevas.append(sesion["repeticion_nueva"])
            if sesion["serie_cerrada"]:
                series_cerradas.append(sesion["serie_cerrada"])
        if sesion is not None:
            sesion = {**sesion, "repeticiones_nuevas": reps_nuevas,
                      "series_cerradas": series_cerradas}

    # `landmarks` y `reinicio` van en el sobre del mensaje, no dentro
    # de una fila: el dibujo del esqueleto sigue el reloj de la
    # camara, la rejilla de evaluacion sigue el de 10 Hz. Atarlos a
    # `filas[-1]` hacia desaparecer el esqueleto justo cuando la
    # rejilla no tenia nada que emitir (el primer fotograma de la
    # sesion, y el primero tras cada reinicio).
    return {
        "tipo": "fotograma",
        "filas": filas,
        "landmarks": landmarks,
        "reinicio": reinicio,
        "t_captura": t,
        "muestras_reales": medidor.n_muestras_reales,
        "filas_emitidas": medidor.n_filas_emitidas,
        "sesion": sesion,
    }


def crear_evaluador(msg: dict, cfg: dict) -> Optional[EvaluadorSeries]:
    """Con la prescripcion del medico (`series` y `repeticiones`) se
    evaluan series. Sin ninguna de las dos el servicio solo mide, como
    antes. Con una sola es un error: no se completa con un valor inventado."""
    series, reps = msg.get("series"), msg.get("repeticiones")
    if series is None and reps is None:
        return None
    if series is None or reps is None:
        raise ValueError("La prescripcion tiene que traer 'series' y 'repeticiones'")
    return EvaluadorSeries(cfg, series, reps, msg.get("rom_objetivo"))


# ==================================================================
# WebSocket
# ==================================================================
@app.websocket("/ws")
async def ws(sock: WebSocket):
    """Protocolo (JSON por texto):

    app -> servicio
      {"tipo": "inicio", "ejercicio": "C01", "series": 3, "repeticiones": 12,
       "rom_objetivo": 35}          # series/repeticiones opcionales
      {"tipo": "pose", "t": 1.23, "lm": [[x, y, vis] x 33], "mundo": [[x, y, z] x 33]}
      {"tipo": "frame", "t": 1.23, "jpg": "<base64>"}   # alternativa: imagen
      {"tipo": "cerrar_serie"}      # boton "Terminar serie"
      {"tipo": "fin"}               # pide el informe final

    servicio -> app
      {"tipo": "listo", ...}
      {"tipo": "fotograma", "filas": [...], "sesion": {...} | null, ...}
      {"tipo": "serie_cerrada", "serie": {...} | null}
      {"tipo": "resumen", "resumen": {...} | null}
      {"tipo": "error", "detalle": "..."}
    """
    await sock.accept()
    medidor: Optional[Medidor] = None
    evaluador: Optional[EvaluadorSeries] = None

    try:
        while True:
            msg = json.loads(await sock.receive_text())
            tipo = msg.get("tipo")

            if tipo == "inicio":
                if medidor:
                    medidor.cerrar()
                medidor, evaluador = None, None
                try:
                    medidor = Medidor(msg["ejercicio"], msg.get("complejidad", 1))
                    evaluador = crear_evaluador(msg, medidor.cfg)
                except (ValueError, KeyError) as e:
                    await sock.send_text(json.dumps({"tipo": "error", "detalle": str(e)}))
                    continue
                await sock.send_text(json.dumps({
                    "tipo": "listo",
                    "ejercicio": medidor.cfg["ejercicio"],
                    "articulacion": medidor.cfg["articulacion_medida"],
                    "hz": HZ,
                    "series": evaluador.series_prescritas if evaluador else None,
                    "repeticiones": evaluador.reps_prescritas if evaluador else None,
                }))
                continue

            if tipo == "cerrar_serie":
                cerrada = evaluador.cerrar_serie() if evaluador else None
                await sock.send_text(json.dumps({"tipo": "serie_cerrada", "serie": cerrada}))
                continue

            if tipo == "fin":
                await sock.send_text(json.dumps({
                    "tipo": "resumen",
                    "resumen": evaluador.resumen() if evaluador else None,
                }))
                continue

            if tipo not in ("frame", "pose"):
                continue

            if medidor is None:
                await sock.send_text(json.dumps({
                    "tipo": "error", "detalle": "Manda primero un mensaje 'inicio'"}))
                continue

            # La app manda la pose ya detectada en el telefono (video en
            # vivo con MediaPipe en un WebView): ~2 KB en vez de un JPEG, y
            # aqui no hace falta correr MediaPipe.
            if tipo == "pose":
                t = float(msg.get("t", time.time()))
                await sock.send_text(json.dumps(procesar_pose(medidor, evaluador, msg, t)))
                continue

            datos = np.frombuffer(base64.b64decode(msg["jpg"]), np.uint8)
            bgr = cv2.imdecode(datos, cv2.IMREAD_COLOR)
            if bgr is None:
                await sock.send_text(json.dumps({
                    "tipo": "error", "detalle": "JPEG ilegible"}))
                continue

            t = float(msg.get("t", time.time()))
            await sock.send_text(json.dumps(procesar_imagen(medidor, evaluador, bgr, t)))

    except WebSocketDisconnect:
        pass
    finally:
        if medidor:
            medidor.cerrar()


# ==================================================================
# REST
# ==================================================================
@app.get("/ejercicios")
def ejercicios():
    """El catalogo, para elegir el id en la app."""
    return [
        {"id": k, "ejercicio": v["ejercicio"], "grupo": v["grupo"],
         "articulacion": v["articulacion_medida"], "postura": v["postura"],
         "tempo": v["tempo_esperado"], "listo": bool(v.get("umbrales"))}
        for k, v in sorted(CATALOGO.items())
    ]


@app.post("/analizar-video")
async def analizar_video(
    video: UploadFile = File(...),
    ejercicio: str = Form(...),
    series: int = Form(...),        # de la prescripcion: obligatorios
    repeticiones: int = Form(...),
    rom_objetivo: Optional[float] = Form(None),
):
    """Sube un video grabado y devuelve el informe: series, repeticiones
    bien hechas y parametros biomecanicos. Recorre el mismo camino que el
    WebSocket, a 10 fotogramas por segundo de video."""
    import asyncio
    import tempfile

    if ejercicio not in CATALOGO:
        raise HTTPException(404, f"Ejercicio desconocido: {ejercicio}")
    try:
        evaluador = EvaluadorSeries(CATALOGO[ejercicio], series, repeticiones, rom_objetivo)
    except ValueError as e:
        raise HTTPException(422, str(e))

    sufijo = os.path.splitext(video.filename or "")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=sufijo, delete=False) as tmp:
        tmp.write(await video.read())
        ruta = tmp.name
    try:
        # MediaPipe tarda: fuera del bucle de eventos, para no congelar los
        # WebSocket de otros pacientes mientras se analiza.
        return await asyncio.to_thread(analizar_archivo, ruta, ejercicio, evaluador)
    finally:
        try:
            os.remove(ruta)
        except OSError:
            pass


def analizar_archivo(ruta: str, ejercicio: str, evaluador: EvaluadorSeries) -> dict:
    cap = cv2.VideoCapture(ruta)
    if not cap.isOpened():
        raise HTTPException(422, "No se pudo abrir el video")
    medidor = Medidor(ejercicio)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    paso = max(1, int(round(fps / HZ)))
    traza, i = [], 0
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            if i % paso == 0:
                sobre = procesar_imagen(medidor, evaluador, bgr, i / fps)
                traza.extend({"t": f["t"], "angulo": f["angulo"]} for f in sobre["filas"])
            i += 1
    finally:
        cap.release()
        medidor.cerrar()
    return {
        "resumen": evaluador.resumen(),
        "duracion_video_s": round(i / fps, 1),
        "serie_angulos": traza,
    }


@app.get("/salud")
def salud():
    return {
        "ok": True,
        "hz": HZ,
        "features": NOMBRES_FEATURES,
        "ejercicios_listos": sorted(k for k, v in CATALOGO.items() if v.get("umbrales")),
        "ejercicios_sin_umbrales": sorted(k for k, v in CATALOGO.items() if not v.get("umbrales")),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
