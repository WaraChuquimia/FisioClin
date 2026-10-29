"""FisioClin — lectura OCR del carnet de identidad.

Por que vive aqui y no en el telefono: es el mismo motivo que la pose.
Los motores de OCR decentes (ML Kit, Tesseract) son modulos nativos, y
Expo Go no los carga. El telefono manda el JPEG y este modulo devuelve
los bloques de texto; quien los interpreta es
`lib/carnet/ciBoliviaParser.ts`, en la app.

Que se reparte asi a proposito: el parser es TypeScript puro y se puede
probar con texto a mano, sin camara y sin servidor.

## Motor

Se usa RapidOCR (PP-OCRv4 exportado a ONNX) porque se instala con pip y
no pide binarios del sistema, a diferencia de Tesseract en Windows:

    pip install rapidocr-onnxruntime

Son unos 15 MB de modelos, corre en CPU y tarda entre 0,3 y 1 s por
cedula. Se carga de forma perezosa para que el servicio arranque igual
aunque el paquete no este instalado; en ese caso /ocr/carnet responde
503 y te dice que instalar.
"""
from __future__ import annotations

import base64
import binascii
import logging

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger("fisioclin.ocr")

router = APIRouter(tags=["carnet"])

#: Ancho al que se lleva la imagen antes de leerla. Una cedula fotografiada
#: de lejos deja los caracteres en 8-10 px de alto y el OCR se los come;
#: por debajo de este ancho conviene ampliar.
ANCHO_OBJETIVO = 1600

#: Por debajo de esta confianza el bloque se descarta. El parser trabaja
#: con mayusculas y expresiones regulares, asi que un bloque basura no
#: suele hacer dano, pero ensucia el texto y puede disparar el regex del
#: numero suelto con cualquier cifra perdida.
CONFIANZA_MINIMA = 0.45

#: Tope de entrada. Una foto de 12 MP en base64 son ~8 MB; mas que eso
#: es un cliente que se ha equivocado.
MAX_BYTES = 12 * 1024 * 1024

_motor = None
_motor_fallido: str | None = None


def _cargar_motor():
    """Instancia RapidOCR una sola vez, la primera vez que se pide."""
    global _motor, _motor_fallido
    if _motor is not None:
        return _motor
    if _motor_fallido is not None:
        raise HTTPException(status_code=503, detail=_motor_fallido)
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        _motor_fallido = (
            "Falta el motor de OCR. Instalalo con: "
            "pip install rapidocr-onnxruntime"
        )
        raise HTTPException(status_code=503, detail=_motor_fallido)
    log.info("[ocr] cargando RapidOCR (la primera vez tarda unos segundos)")
    _motor = RapidOCR()
    return _motor


def _decodificar(jpg_base64: str) -> np.ndarray:
    """base64 -> imagen BGR, con los errores del cliente como 400."""
    dato = jpg_base64.strip()
    # La app puede mandar el prefijo data:image/jpeg;base64,....
    if dato.startswith("data:"):
        _, _, dato = dato.partition(",")
    if len(dato) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Imagen demasiado grande.")
    try:
        crudo = base64.b64decode(dato, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="base64 invalido.")

    bgr = cv2.imdecode(np.frombuffer(crudo, np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="No es una imagen legible.")
    return bgr


def _preparar(bgr: np.ndarray) -> np.ndarray:
    """Amplia si la foto viene pequena. Nada mas.

    Se probo binarizar y ecualizar: con PP-OCRv4 empeora, porque el
    modelo ya se entreno con fotos naturales y el umbralizado le quita
    el gradiente que usa para separar caracteres.
    """
    alto, ancho = bgr.shape[:2]
    if ancho >= ANCHO_OBJETIVO:
        return bgr
    escala = ANCHO_OBJETIVO / float(ancho)
    return cv2.resize(
        bgr, (ANCHO_OBJETIVO, int(round(alto * escala))), interpolation=cv2.INTER_CUBIC
    )


class PeticionCarnet(BaseModel):
    #: JPEG en base64, con o sin prefijo data:.
    jpg: str


class RespuestaCarnet(BaseModel):
    bloques: list[str]
    n: int


@router.post("/ocr/carnet", response_model=RespuestaCarnet)
def ocr_carnet(pet: PeticionCarnet) -> RespuestaCarnet:
    """Devuelve los bloques de texto de una foto de cedula.

    No interpreta nada: el orden es el que da el motor, de arriba abajo.
    Si no reconoce nada devuelve una lista vacia y un 200 — que la foto
    saliera borrosa no es un error del servicio.
    """
    motor = _cargar_motor()
    imagen = _preparar(_decodificar(pet.jpg))

    resultado, _ = motor(imagen)
    if not resultado:
        return RespuestaCarnet(bloques=[], n=0)

    bloques = [
        str(texto).strip()
        for _caja, texto, confianza in resultado
        if float(confianza) >= CONFIANZA_MINIMA and str(texto).strip()
    ]
    log.info("[ocr] %d bloques sobre %d detectados", len(bloques), len(resultado))
    return RespuestaCarnet(bloques=bloques, n=len(bloques))
