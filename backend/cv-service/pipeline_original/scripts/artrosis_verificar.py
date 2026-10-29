"""Verificacion de integridad y de entorno del dataset de artrosis.

Contesta tres preguntas antes de cualquier corrida larga:

  1. Estan los 20 videos donde dice el indice, y son los mismos de siempre?
     (OneDrive puede tener el archivo solo en la nube, y entonces la
     primera lectura tarda minutos o falla en mitad del proceso.)
  2. Que version de cada libreria produjo los datos que hay en disco?
  3. Que etapas del pipeline estan al dia y cuales faltan?

    python artrosis_verificar.py            # revisa y reporta
    python artrosis_verificar.py --sellar   # ademas graba el entorno
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
INDICE = RAIZ / "00_indice/videos.csv"
ENTORNO = RAIZ / "documentacion/entorno.json"

BASE_VIDEOS = Path(os.environ["USERPROFILE"]) / (
    "OneDrive - Escuela Militar de Ingenieria/Desktop/catalogo_de_ejercicios")

ETAPAS = [
    ("0  indice",       "00_indice/videos.csv"),
    ("1  contenido",    "01_contenido/frames_muestreados.csv"),
    ("1b escenas",      "01_contenido/escenas.csv"),
    ("2  landmarks",    "02_landmarks"),
    ("3  angulos",      "03_angulos/frames_maestro.csv"),
    ("4  segmentos",    "04_segmentos/segmentos.csv"),
    ("5  repeticiones", "05_repeticiones/repeticiones.csv"),
    ("6  ventanas",     "06_ventanas/ventanas.npz"),
    ("-  ficha clinica", "referencia/ficha_clinica.csv"),
]


def huella(ruta: Path, bloque: int = 1 << 20) -> str:
    """Misma firma que usa la etapa 0: tamano + primer y ultimo megabyte."""
    h = hashlib.sha1()
    tam = ruta.stat().st_size
    h.update(str(tam).encode())
    with ruta.open("rb") as f:
        h.update(f.read(bloque))
        if tam > 2 * bloque:
            f.seek(-bloque, os.SEEK_END)
            h.update(f.read(bloque))
    return h.hexdigest()[:16]


def verificar_videos() -> int:
    filas = list(csv.DictReader(INDICE.open(encoding="utf-8")))
    problemas = 0
    print("VIDEOS ({} en el indice)".format(len(filas)))
    for f in filas:
        ruta = BASE_VIDEOS / f["carpeta"] / f["archivo"]
        if not ruta.exists():
            print("  {}  FALTA: {}".format(f["id"], ruta))
            problemas += 1
            continue
        actual = huella(ruta)
        if actual != f["huella"]:
            print("  {}  CAMBIO: huella {} != {} del indice".format(
                f["id"], actual, f["huella"]))
            problemas += 1
    print("  sin novedad" if not problemas else "  {} problema(s)".format(problemas))
    return problemas


def estado_etapas() -> None:
    print("\nETAPAS")
    for nombre, rel in ETAPAS:
        ruta = RAIZ / rel
        if not ruta.exists():
            print("  {:18} pendiente".format(nombre))
        elif ruta.is_dir():
            n = len(list(ruta.iterdir()))
            print("  {:18} {}".format(nombre, "{} archivos".format(n) if n else "vacia"))
        else:
            marca = datetime.fromtimestamp(ruta.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
            print("  {:18} {:>10.1f} KB  {}".format(nombre, ruta.stat().st_size / 1024, marca))


def entorno() -> dict:
    import cv2
    import mediapipe as mp
    import numpy as np
    return {
        "fecha": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "python": sys.version.split()[0],
        "plataforma": platform.platform(),
        "opencv": cv2.__version__,
        "mediapipe": mp.__version__,
        "numpy": np.__version__,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sellar", action="store_true",
                    help="graba el entorno actual en documentacion/entorno.json")
    args = ap.parse_args()

    problemas = verificar_videos()
    estado_etapas()

    actual = entorno()
    print("\nENTORNO")
    for k, v in actual.items():
        print("  {:12} {}".format(k, v))
    if ENTORNO.exists():
        previo = json.loads(ENTORNO.read_text(encoding="utf-8"))
        difs = [k for k in ("python", "opencv", "mediapipe", "numpy")
                if previo.get(k) != actual.get(k)]
        if difs:
            print("  CAMBIO respecto del sello ({}): {}".format(previo.get("fecha"),
                                                                ", ".join(difs)))
            print("  Los datos en disco se produjeron con las versiones anteriores.")
    if args.sellar:
        ENTORNO.parent.mkdir(parents=True, exist_ok=True)
        ENTORNO.write_text(json.dumps(actual, indent=2, ensure_ascii=False), encoding="utf-8")
        print("  sellado ->", ENTORNO)
    return 1 if problemas else 0


if __name__ == "__main__":
    sys.exit(main())
