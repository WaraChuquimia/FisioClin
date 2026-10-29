"""Geometria de la pose: los mismos angulos que produjeron el dataset.

Puerto literal de `artrosis_03_angulos.py` (etapa 3). Si cambias una
constante de aqui, las features dejan de ser las que vio el modelo en el
entrenamiento y el escalador `media/desviacion` deja de valer.

Todo trabaja sobre `pose_world_landmarks` de MediaPipe: coordenadas en
metros con origen en el centro de la cadera. Los indices son los de
BlazePose (33 puntos).
"""
from __future__ import annotations

from typing import Optional

import numpy as np

# --- indices BlazePose ---------------------------------------------
HOMBRO_IZQ, HOMBRO_DER = 11, 12
CADERA_IZQ, CADERA_DER = 23, 24

#: Puntos que definen cada angulo articular: (proximal, vertice, distal).
ARTICULACIONES = {
    "cadera_der": (12, 24, 26),
    "cadera_izq": (11, 23, 25),
    "rodilla_der": (24, 26, 28),
    "rodilla_izq": (23, 25, 27),
    "tobillo_der": (26, 28, 32),
    "tobillo_izq": (25, 27, 31),
}

#: Hombro, cadera y rodilla de cada lado. Si no se ven, no hay medida.
ADMISION_IZQ = [11, 23, 25]
ADMISION_DER = [12, 24, 26]

NUCLEO = [11, 12, 23, 24, 25, 26, 27, 28]

VIS_ADMISION = 0.5      # visibilidad minima para admitir un lado
VIS_GONIOMETRIA = 0.6   # visibilidad minima para medir un angulo concreto
DESVIO_TRONCO = 0.15    # cuanto puede variar el largo del tronco reconstruido


def angulo(p1, p2, p3):
    """Angulo en grados en el vertice p2, para arrays (N, 3)."""
    a, b = p1 - p2, p3 - p2
    na = np.linalg.norm(a, axis=-1)
    nb = np.linalg.norm(b, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        cos = np.einsum("ij,ij->i", a, b) / (na * nb)
    return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def angulo_frontal_cadera(pm, lado: str):
    """Abduccion de cadera: cuanto se separa el muslo del eje medio-lateral.

    Positivo = el muslo se aleja de la linea media. El signo del lado
    derecho se invierte para que ambos lados midan lo mismo hacia fuera.
    """
    idx_cadera, idx_rodilla = (24, 26) if lado == "der" else (23, 25)
    m = pm[:, CADERA_IZQ] - pm[:, CADERA_DER]
    m = m / np.linalg.norm(m, axis=-1, keepdims=True)
    muslo = pm[:, idx_rodilla] - pm[:, idx_cadera]
    norma = np.linalg.norm(muslo, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        comp = np.einsum("ij,ij->i", muslo, m) / norma
    if lado == "der":
        comp = -comp
    return np.degrees(np.arcsin(np.clip(comp, -1.0, 1.0)))


def flexion(pm, vis, nombre: str):
    """Flexion de una articulacion, en grados. None si no se ve bien.

    El dataset guarda `180 - angulo_interno`: 0 grados es el segmento
    extendido, que es como lo lee un goniometro.
    """
    if nombre not in ARTICULACIONES:
        return None
    a, b, c = ARTICULACIONES[nombre]
    if float(np.nanmin(vis[[a, b, c]])) < VIS_GONIOMETRIA:
        return None
    return 180.0 - float(angulo(pm[:, a], pm[:, b], pm[:, c])[0])


def inclinacion_tronco(pm) -> tuple[float, float]:
    """(inclinacion en grados respecto a la vertical, largo del tronco en m)."""
    hombro = (pm[:, HOMBRO_IZQ] + pm[:, HOMBRO_DER]) / 2
    cadera = (pm[:, CADERA_IZQ] + pm[:, CADERA_DER]) / 2
    d = hombro - cadera
    largo = float(np.linalg.norm(d))
    if largo < 1e-6:
        return float("nan"), largo
    # En MediaPipe la Y crece hacia abajo, de ahi el signo.
    cos = np.clip(-d[0, 1] / largo, -1.0, 1.0)
    return float(np.degrees(np.arccos(cos))), largo


def lado_visible(vis) -> tuple[str, float]:
    """Elige el lado que mejor se ve y devuelve (lado, su visibilidad minima).

    Decision cruda, sin histeresis: la usa `SelectorLado` como entrada, y
    la conservan los tests que comparan fotograma a fotograma.
    """
    izq = float(np.nanmin(vis[ADMISION_IZQ]))
    der = float(np.nanmin(vis[ADMISION_DER]))
    return ("izq", izq) if izq >= der else ("der", der)


#: Cuanto tiene que ganar el otro lado, en visibilidad minima, para que
#: valga la pena cambiarse (evita oscilar por ruido de deteccion).
UMBRAL_CAMBIO_LADO = 0.1
#: Fotogramas seguidos que tiene que sostenerse esa ventaja antes de
#: confirmar el cambio.
FRAMES_CONFIRMACION_LADO = 5


class SelectorLado:
    """Elige el lado con histeresis.

    `lado_visible()` decide en cada fotograma sin memoria: en un ejercicio
    bilateral como el puente de gluteos, donde izquierda y derecha se ven
    casi igual, `izq >= der` oscila por puro ruido de visibilidad. Como
    `construir_features()` usa el lado para ordenar 8 de las 14 columnas,
    cada oscilacion permuta esas columnas a mitad de ventana. Este selector
    exige que el otro lado gane por `UMBRAL_CAMBIO_LADO` durante
    `FRAMES_CONFIRMACION_LADO` fotogramas seguidos antes de cambiar.
    """

    def __init__(self):
        self.lado: Optional[str] = None
        self.candidato: Optional[str] = None
        self.racha = 0

    def actualizar(self, vis) -> tuple[str, float]:
        izq = float(np.nanmin(vis[ADMISION_IZQ]))
        der = float(np.nanmin(vis[ADMISION_DER]))

        if self.lado is None:
            self.lado = "izq" if izq >= der else "der"
            return self.lado, (izq if self.lado == "izq" else der)

        vis_actual = izq if self.lado == "izq" else der
        vis_otro = der if self.lado == "izq" else izq
        otro = "der" if self.lado == "izq" else "izq"

        if vis_otro - vis_actual >= UMBRAL_CAMBIO_LADO:
            self.racha = self.racha + 1 if self.candidato == otro else 1
            self.candidato = otro
            if self.racha >= FRAMES_CONFIRMACION_LADO:
                self.lado = otro
                self.candidato = None
                self.racha = 0
        else:
            self.candidato = None
            self.racha = 0

        return self.lado, (izq if self.lado == "izq" else der)

    def reiniciar(self):
        self.lado = None
        self.candidato = None
        self.racha = 0
