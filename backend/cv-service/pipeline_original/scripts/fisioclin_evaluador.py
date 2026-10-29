"""FisioClin — evaluador de ejercicio en vivo. Modulo para la app.

Es el unico archivo que la app necesita importar. Recibe fotogramas de la
camara y devuelve, en cada uno, el estado que hay que pintar en pantalla; y
cada vez que se completa una repeticion, su evaluacion.

    from fisioclin_evaluador import EvaluadorEjercicio

    ev = EvaluadorEjercicio("C01", series=3, repeticiones=10)
    while camara_abierta:
        estado = ev.procesar(frame_bgr)
        pintar(estado)               # estado.mensaje, .fase, .repeticiones...
        if estado.repeticion_nueva:
            enviar(estado.repeticion_nueva)
    guardar_en_bd(ev.resumen())

## Tres decisiones que vienen del dataset y conviene no cambiar a ciegas

**El ejercicio lo prescribe el medico, no lo adivina la red.** La app sabe
que ejercicio toca, asi que la red no tiene que clasificarlo. Su unico
papel es *verificar* que el paciente hace el prescrito, y es opcional
(`verificar_con_red=True`). Esto evita el problema medido en la etapa 10:
las features en vivo no reproducen exactamente las del entrenamiento — el
suavizado del dataset es no causal — y la clasificacion se degrada. Las
reglas, que son las que evaluan, no tienen ese problema.

**La evaluacion la hacen las reglas, no la red.** Quedo demostrado en la
etapa 8: la cabeza de calidad de la red (0,462) queda por debajo de su
propia linea base (0,642), porque aprende a reproducir reglas que ya se
calculan exacto desde los mismos angulos.

**El sentido del ciclo depende del ejercicio.** Un puente de gluteos
EMPIEZA arriba — la cadera parte flexionada y el movimiento la extiende —
y una elevacion de rodilla empieza abajo. Un contador con un umbral fijo
en un solo sentido detecta la mitad del catalogo. El sentido de cada
ejercicio esta medido y vive en `configuracion_ejercicios.json`.

## Lo que este modulo NO hace

* **No diagnostica ni prescribe.** Mide y reporta; la decision clinica es
  del profesional.
* **No detecta varias personas.** MediaPipe Pose sigue a una sola. Si en
  el encuadre hay mas de una, seguira a la que detecte primero. Un
  detector multipersona es trabajo aparte.
* **No compara sesiones grabadas con la camara en sitios distintos.**
  Medido en la etapa 9: para varios ejercicios la dispersion del ROM entre
  tomas es de hasta 28 grados frente a 3 dentro de una toma. Fijar la
  camara es un requisito, no una recomendacion.
"""
from __future__ import annotations

import json
import math
import os
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("GLOG_minloglevel", "3")

import cv2
import mediapipe as mp
import numpy as np

import artrosis_03_angulos as GEO
import artrosis_06_calidad as REGLAS
from pose import extraer_landmarks

AQUI = Path(__file__).parent
CONFIG = AQUI / "dataset_artrosis/07_modelo/configuracion_ejercicios.json"
MODELO_DIR = AQUI / "dataset_artrosis/07_modelo"

HZ_OBJETIVO = 10.0
FRAMES_ESTABLE = 8       # ~0,8 s quieto para confirmar la posicion inicial
FRAMES_CONFIRMA = 3      # fotogramas para confirmar un cruce de umbral
MAX_HISTORIAL = 300      # 30 s de angulos en memoria
DURACION_REP = (1.0, 15.0)


@dataclass
class Estado:
    """Lo que la app pinta en pantalla en este fotograma."""
    fase: str                       # SIN_PERSONA, CALIBRANDO, LISTO, EN_MOVIMIENTO...
    mensaje: str                    # texto para el paciente, ya redactado
    hay_persona: bool = False
    dato_fiable: bool = False
    motivo_no_fiable: str = ""
    angulo: Optional[float] = None  # grados de flexion de la articulacion medida
    lado: str = ""
    landmarks: Optional[dict] = None  # puntos normalizados, para dibujar el esqueleto
    repeticiones: int = 0
    serie: int = 1
    repeticion_nueva: Optional[dict] = None   # solo en el frame que la completa
    progreso: float = 0.0           # 0..1 dentro de la repeticion en curso


@dataclass
class _Ciclo:
    """Estado interno del ciclo en curso."""
    activo: bool = False
    t_inicio: float = 0.0
    t_extremo: float = 0.0
    valor_inicio: float = 0.0
    valor_extremo: float = 0.0
    troncos: list = field(default_factory=list)
    contra: list = field(default_factory=list)


class EvaluadorEjercicio:
    """Un ejercicio prescrito, evaluado en vivo."""

    def __init__(self, id_ejercicio: str, series: int = 1, repeticiones: int = 10,
                 complejidad_pose: int = 1, verificar_con_red: bool = False,
                 rom_objetivo: Optional[float] = None, espejo: bool = False):
        doc = json.loads(CONFIG.read_text(encoding="utf-8"))
        if id_ejercicio not in doc["ejercicios"]:
            raise ValueError("Ejercicio desconocido: {}. Disponibles: {}".format(
                id_ejercicio, ", ".join(sorted(doc["ejercicios"]))))
        self.cfg = doc["ejercicios"][id_ejercicio]
        if not self.cfg.get("umbrales"):
            raise ValueError(
                "{} no tiene banda de referencia medida en el dataset: {}".format(
                    id_ejercicio, self.cfg.get("aviso", "")))

        self.series_prescritas = series
        self.reps_prescritas = repeticiones
        # El ROM objetivo lo fija la prescripcion del paciente. Si no se da,
        # se usa el de la ficha clinica; si tampoco, no se evalua el rango.
        self.rom_objetivo = rom_objetivo or self._num(self.cfg["rom_esperado_max"])

        self.pose = mp.solutions.pose.Pose(
            static_image_mode=False, model_complexity=complejidad_pose,
            smooth_landmarks=True, min_detection_confidence=0.5,
            min_tracking_confidence=0.5)

        self.espejo = espejo
        self.verificar_con_red = verificar_con_red
        self.red = None
        if verificar_con_red:
            self._cargar_red()

        self.serie = 1
        self.repeticiones = []          # todas las completadas
        self.reps_serie = 0
        self.historial = deque(maxlen=MAX_HISTORIAL)
        self.tronco_ref = None
        self.frames_estables = 0
        self.frames_totales = 0
        self.frames_descartados = 0
        self.inicio = time.time()
        self._ciclo = _Ciclo()
        self._pendiente = None
        self._racha = 0
        self._suave = None
        self._lado = None

    # ---------------------------------------------------------------
    # API publica
    # ---------------------------------------------------------------
    def procesar(self, frame_bgr) -> Estado:
        """Un fotograma de la camara. Llamar a ~10 Hz."""
        self.frames_totales += 1
        h, w = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(cv2.resize(frame_bgr, (640, int(h * 640 / w))),
                           cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        res = self.pose.process(rgb)

        if not res.pose_landmarks:
            self._reiniciar_ciclo()
            return Estado("SIN_PERSONA", "Colocate frente a la camara, de cuerpo entero")

        puntos = extraer_landmarks(res.pose_landmarks.landmark, self.espejo)

        lm = np.array([[l.x, l.y, l.z, l.visibility]
                       for l in res.pose_landmarks.landmark], np.float32)
        mundo = np.array([[l.x, l.y, l.z, l.visibility]
                          for l in res.pose_world_landmarks.landmark], np.float32)

        medida = self._medir(lm, mundo)
        if medida is None:
            self.frames_descartados += 1
            self._reiniciar_ciclo()
            return Estado("DATO_NO_FIABLE", self._motivo, hay_persona=True,
                          motivo_no_fiable=self._motivo, landmarks=puntos,
                          repeticiones=self.reps_serie, serie=self.serie)

        angulo, tronco, contra, lado = medida
        self.historial.append((time.time(), angulo))
        return self._maquina_de_estados(angulo, tronco, contra, lado, puntos)

    def resumen(self) -> dict:
        """Lo que se guarda en la base de datos al terminar la sesion."""
        reps = self.repeticiones
        roms = [r["rom_grados"] for r in reps]
        veredictos = [r["veredicto"] for r in reps]
        return {
            "ejercicio": self.cfg["ejercicio"],
            "id_ejercicio": self.cfg["id"],
            "articulacion": self.cfg["articulacion_medida"],
            "lado_medido": self._lado or "",
            "duracion_seg": round(time.time() - self.inicio, 1),
            "series_prescritas": self.series_prescritas,
            "repeticiones_prescritas": self.reps_prescritas,
            "series_completadas": self.serie - 1 + (1 if self.reps_serie else 0),
            "repeticiones_detectadas": len(reps),
            "cumplimiento_pct": round(
                100 * len(reps) / max(self.series_prescritas * self.reps_prescritas, 1), 1),
            "rom_medio": round(float(np.mean(roms)), 1) if roms else None,
            "rom_maximo": round(float(np.max(roms)), 1) if roms else None,
            "rom_objetivo": self.rom_objetivo,
            "correctas": veredictos.count("CORRECTA"),
            "dudosas": veredictos.count("DUDOSA"),
            "incorrectas": veredictos.count("INCORRECTA"),
            "pct_correctas": round(100 * veredictos.count("CORRECTA") / len(reps), 1)
            if reps else None,
            "frames_totales": self.frames_totales,
            "frames_descartados": self.frames_descartados,
            "medicion_goniometrica_valida": self.cfg["medible_goniometricamente"],
            "repeticiones": reps,
        }

    def cerrar(self):
        self.pose.close()

    # ---------------------------------------------------------------
    # Medicion: mismo codigo que produjo el dataset
    # ---------------------------------------------------------------
    def _medir(self, lm, mundo):
        vis = lm[:, 3]
        izq = float(np.nanmin(vis[GEO.ADMISION_IZQ]))
        der = float(np.nanmin(vis[GEO.ADMISION_DER]))
        lado = "izq" if izq >= der else "der"
        if max(izq, der) < GEO.VIS_ADMISION:
            self._motivo = "Reposicionate: no se ven bien hombro, cadera y rodilla"
            return None

        pm = mundo[None, :, :3]
        hombro = (pm[:, 11] + pm[:, 12]) / 2
        cadera = (pm[:, 23] + pm[:, 24]) / 2
        tronco_m = float(np.linalg.norm(hombro - cadera))
        # El esqueleto reconstruido tiene que tener proporciones humanas: si
        # el tronco cambia de longitud, la reconstruccion esta degenerada y
        # su angulo no vale. Ver etapa 3.
        self.tronco_ref = tronco_m if self.tronco_ref is None else \
            0.98 * self.tronco_ref + 0.02 * tronco_m
        if abs(tronco_m / self.tronco_ref - 1.0) > GEO.DESVIO_TRONCO:
            self._motivo = "Acercate o alejate: no se te ve el cuerpo completo"
            return None

        art = self.cfg["articulacion_medida"]
        otro = "izq" if lado == "der" else "der"
        if self.cfg["senal"] == "abduccion":
            angulo = float(GEO.angulo_frontal_cadera(pm, lado)[0])
            contra = float(GEO.angulo_frontal_cadera(pm, otro)[0])
        else:
            a, b, c = GEO.ARTICULACIONES["{}_{}".format(art, lado)]
            if float(np.nanmin(vis[[a, b, c]])) < GEO.VIS_GONIOMETRIA:
                self._motivo = "No se ve bien la pierna que trabaja"
                return None
            angulo = 180.0 - float(GEO.angulo(pm[:, a], pm[:, b], pm[:, c])[0])
            a2, b2, c2 = GEO.ARTICULACIONES["{}_{}".format(art, otro)]
            contra = 180.0 - float(GEO.angulo(pm[:, a2], pm[:, b2], pm[:, c2])[0]) \
                if float(np.nanmin(vis[[a2, b2, c2]])) >= GEO.VIS_GONIOMETRIA else None

        d = hombro - cadera
        inclinacion = float(np.degrees(np.arccos(np.clip(-d[0, 1] / tronco_m, -1, 1))))

        # Suavizado causal: solo mira hacia atras. El del dataset es
        # centrado y aqui no se puede usar.
        self._suave = angulo if self._suave is None else 0.6 * self._suave + 0.4 * angulo
        self._lado = lado
        return self._suave, inclinacion, contra, lado

    # ---------------------------------------------------------------
    # Maquina de estados del ciclo
    # ---------------------------------------------------------------
    def _maquina_de_estados(self, angulo, tronco, contra, lado, landmarks=None) -> Estado:
        u = self.cfg["umbrales"]
        desciende = self.cfg["sentido"] == "desciende"
        # En un ejercicio que desciende, la posicion de partida es la ALTA.
        en_partida = angulo >= u["alto"] if desciende else angulo <= u["bajo"]
        en_extremo = angulo <= u["bajo"] if desciende else angulo >= u["alto"]

        base = dict(hay_persona=True, dato_fiable=True, angulo=round(angulo, 1),
                    lado=lado, landmarks=landmarks,
                    repeticiones=self.reps_serie, serie=self.serie)

        if not self._ciclo.activo:
            if en_partida:
                self.frames_estables += 1
                if self.frames_estables >= FRAMES_ESTABLE:
                    self._ciclo = _Ciclo(activo=True, t_inicio=time.time(),
                                         valor_inicio=angulo, valor_extremo=angulo,
                                         t_extremo=time.time())
                    return Estado("LISTO", "Empieza el movimiento", **base)
                return Estado("CALIBRANDO", "Mantente en la posicion inicial", **base)
            self.frames_estables = 0
            return Estado("COLOCATE", self._texto_posicion_inicial(), **base)

        # ciclo en curso: se registra el extremo alcanzado
        self._ciclo.troncos.append(tronco)
        if contra is not None:
            self._ciclo.contra.append(contra)
        mejor = (angulo < self._ciclo.valor_extremo if desciende
                 else angulo > self._ciclo.valor_extremo)
        if mejor:
            self._ciclo.valor_extremo = angulo
            self._ciclo.t_extremo = time.time()

        recorrido = abs(self._ciclo.valor_extremo - self._ciclo.valor_inicio)
        progreso = min(1.0, recorrido / max(u["prominencia_minima"], 1e-6))

        # vuelta a la partida con recorrido suficiente = repeticion
        if en_partida and recorrido >= u["prominencia_minima"]:
            self._racha += 1
            if self._racha >= FRAMES_CONFIRMA:
                rep = self._cerrar_repeticion(angulo)
                self._racha = 0
                if rep:
                    base["repeticiones"] = self.reps_serie
                    return Estado("REPETICION", self._texto_repeticion(rep),
                                  repeticion_nueva=rep, progreso=1.0, **base)
        else:
            self._racha = 0

        fase = "VUELTA" if en_partida else ("EXTREMO" if en_extremo else "MOVIMIENTO")
        return Estado(fase, "Controla el movimiento", progreso=progreso, **base)

    def _cerrar_repeticion(self, angulo_final) -> Optional[dict]:
        c = self._ciclo
        ahora = time.time()
        duracion = ahora - c.t_inicio
        if not (DURACION_REP[0] <= duracion <= DURACION_REP[1]):
            self._reiniciar_ciclo()
            return None

        ida = max(c.t_extremo - c.t_inicio, 1e-3)
        vuelta = max(ahora - c.t_extremo, 1e-3)
        rom = abs(c.valor_extremo - c.valor_inicio)
        rom_contra = (max(c.contra) - min(c.contra)) if len(c.contra) > 5 else None

        rep = {
            "n": len(self.repeticiones) + 1,
            "serie": self.serie,
            "t_inicio_s": round(c.t_inicio - self.inicio, 2),
            "duracion_s": round(duracion, 2),
            "flex_min_grados": round(min(c.valor_inicio, c.valor_extremo), 1),
            "flex_max_grados": round(max(c.valor_inicio, c.valor_extremo), 1),
            "rom_grados": round(rom, 1),
            "duracion_ida_s": round(ida, 2),
            "duracion_vuelta_s": round(vuelta, 2),
            "razon_ida_vuelta": round(ida / vuelta, 2),
            "velocidad_media_gr_s": round(rom / duracion, 1),
            "rom_tronco_grados": round(max(c.troncos) - min(c.troncos), 1)
            if c.troncos else None,
            "rom_contralateral_grados": round(rom_contra, 1) if rom_contra else None,
            "asimetria_rom": round(abs(rom - rom_contra) / max(rom, 1e-6), 2)
            if rom_contra else None,
        }
        rep.update(self._evaluar(rep))
        self.repeticiones.append(rep)
        self.reps_serie += 1
        if self.reps_serie >= self.reps_prescritas:
            self.serie += 1
            self.reps_serie = 0
        self._reiniciar_ciclo()
        return rep

    # ---------------------------------------------------------------
    # Reglas: los mismos indicadores que la etapa 6
    # ---------------------------------------------------------------
    def _evaluar(self, rep) -> dict:
        u = REGLAS.UMBRALES
        ind, motivos = {}, []

        razon = rep["razon_ida_vuelta"]
        ind["tempo_dejado_caer"] = int(razon > u["RAZON_DEJADO_CAER"])
        ind["tempo_brusco"] = int(razon < u["RAZON_BRUSCO"])
        if ind["tempo_dejado_caer"]:
            motivos.append("No frenaste la vuelta")
        if ind["tempo_brusco"]:
            motivos.append("El movimiento de ida fue brusco")

        prescrita = REGLAS.duracion_prescrita(self.cfg["tempo_esperado"] or "")
        ind["duracion_fuera_de_tempo"] = int(
            bool(prescrita) and abs(rep["duracion_s"] - prescrita) / prescrita
            > u["DESVIO_TEMPO"])
        if ind["duracion_fuera_de_tempo"]:
            motivos.append("Ritmo distinto del prescrito ({} s)".format(prescrita))

        ref = self.cfg.get("tronco_mediano_grados")
        ind["compensacion_tronco"] = int(
            ref is not None and rep["rom_tronco_grados"] is not None
            and rep["rom_tronco_grados"] > u["FACTOR_TRONCO"] * ref)
        if ind["compensacion_tronco"]:
            motivos.append("Estas compensando con el tronco")

        ind["asimetria"] = int(
            self.cfg["bilateral"] and rep["asimetria_rom"] is not None
            and rep["asimetria_rom"] > u["ASIMETRIA_MAX"])
        if ind["asimetria"]:
            motivos.append("Un lado recorre mas que el otro")

        # El rango se compara contra la PRESCRIPCION del paciente, no contra
        # la banda del catalogo. Es descriptivo: no entra en el veredicto
        # mientras no se aclare si el arco de la ficha es recorrido o
        # limites absolutos (ver documentacion/06_calidad.md).
        pct = (round(100 * rep["rom_grados"] / self.rom_objetivo)
               if self.rom_objetivo else None)

        n = sum(ind.values())
        no_representativa = not self.cfg["medible_goniometricamente"]
        veredicto = ("DUDOSA" if no_representativa else
                     "CORRECTA" if n == 0 else
                     "DUDOSA" if n == 1 else "INCORRECTA")
        return {**ind, "n_indicadores": n, "motivos": motivos,
                "veredicto": veredicto,
                "pct_rom_objetivo": pct,
                "medicion_no_representativa": int(no_representativa)}

    # ---------------------------------------------------------------
    def _reiniciar_ciclo(self):
        self._ciclo = _Ciclo()
        self.frames_estables = 0
        self._racha = 0

    def _texto_posicion_inicial(self):
        postura = {"supino": "boca arriba", "prono": "boca abajo",
                   "decubito_lateral": "de lado", "cuadrupedia": "a cuatro patas",
                   "sedente": "sentado", "semisentado": "semisentado",
                   "bipedestacion": "de pie"}.get(self.cfg["postura"], "")
        return "Ponte {} en la posicion inicial".format(postura) if postura \
            else "Ponte en la posicion inicial"

    def _texto_repeticion(self, rep):
        if rep["veredicto"] == "CORRECTA":
            return "Repeticion {} correcta".format(rep["n"])
        if rep["motivos"]:
            return "Repeticion {}: {}".format(rep["n"], rep["motivos"][0])
        return "Repeticion {} registrada".format(rep["n"])

    def _num(self, v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def _cargar_red(self):
        from tensorflow import keras
        self.red = keras.models.load_model(MODELO_DIR / "modelo.keras")
        esc = np.load(MODELO_DIR / "escalador.npz")
        self.red_media, self.red_desv = esc["media"], esc["desviacion"]


def ejercicios_disponibles() -> list:
    """Los ejercicios que la app puede ofrecer, con su ficha resumida."""
    doc = json.loads(CONFIG.read_text(encoding="utf-8"))
    return [{
        "id": e["id"], "nombre": e["ejercicio"], "grupo": e["grupo"],
        "articulacion": e["articulacion_objetivo"], "postura": e["postura"],
        "tipo": e["tipo"], "criterio": e["criterio_ejecucion"],
        "listo_para_uso": bool(e.get("umbrales")),
        "medicion_goniometrica_valida": e["medible_goniometricamente"],
    } for e in doc["ejercicios"].values()]
