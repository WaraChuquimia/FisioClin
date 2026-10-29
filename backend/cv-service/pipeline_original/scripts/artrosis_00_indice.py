"""Etapa 0 del dataset de artrosis: inventario tecnico de los videos crudos.

Recorre las dos carpetas del catalogo, lee las propiedades de cada archivo
y escribe `dataset_artrosis/00_indice/videos.csv`. Es la unica puerta de
entrada al dataset: todas las etapas siguientes referencian el `id` que se
asigna aqui, nunca el nombre del archivo.

No modifica ni copia los videos.
"""
from __future__ import annotations

import csv
import hashlib
import os
import re
import unicodedata
from pathlib import Path

import cv2

BASE = Path(os.environ["USERPROFILE"]) / (
    "OneDrive - Escuela Militar de Ingenieria/Desktop/catalogo_de_ejercicios"
)
CARPETAS = {"cadera": "C", "RODILLA": "R"}
SALIDA = Path(__file__).parent / "dataset_artrosis/00_indice/videos.csv"

COLUMNAS = [
    "id", "grupo", "archivo", "carpeta", "ancho", "alto", "resolucion",
    "fps_nativo", "n_frames", "duracion_s", "codec", "tamano_mb", "mbits_por_s",
    "huella", "n_ejercicio_declarado", "titulo_crudo", "incidencias",
]


def huella(ruta: Path, bloque: int = 1 << 20) -> str:
    """Firma corta y estable: tamano + primer y ultimo megabyte."""
    h = hashlib.sha1()
    tam = ruta.stat().st_size
    h.update(str(tam).encode())
    with ruta.open("rb") as f:
        h.update(f.read(bloque))
        if tam > 2 * bloque:
            f.seek(-bloque, os.SEEK_END)
            h.update(f.read(bloque))
    return h.hexdigest()[:16]


def limpiar(texto: str) -> str:
    sin_tildes = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", sin_tildes).strip()


def numero_declarado(nombre: str) -> int | None:
    m = re.search(r"ejercicio[\s._-]*(\d+)", nombre, flags=re.IGNORECASE)
    return int(m.group(1)) if m else None


def titulo(nombre: str) -> str:
    """Lo que queda del nombre despues de quitar la parte administrativa."""
    base = Path(nombre).stem
    base = re.sub(r"[-_.\s]*(cadera|rodilla)?[-_.\s]*ejercicio[\s._-]*\d+\s*$", "",
                  base, flags=re.IGNORECASE)
    base = re.sub(r"[-_.\s]*(cadera|rodilla)[-_.\s]*$", "", base, flags=re.IGNORECASE)
    return limpiar(base).upper()


def inspeccionar(ruta: Path) -> dict:
    cap = cv2.VideoCapture(str(ruta))
    if not cap.isOpened():
        return {"incidencias": "no_se_puede_abrir"}
    ancho = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    alto = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fourcc = int(cap.get(cv2.CAP_PROP_FOURCC))
    cap.release()
    codec = "".join(chr((fourcc >> 8 * i) & 0xFF) for i in range(4)).strip()
    return {
        "ancho": ancho, "alto": alto, "resolucion": f"{ancho}x{alto}",
        "fps_nativo": round(fps, 3), "n_frames": n,
        "duracion_s": round(n / fps, 2) if fps else "",
        "codec": codec, "incidencias": "",
    }


def main() -> None:
    filas: list[dict] = []
    for carpeta, prefijo in CARPETAS.items():
        directorio = BASE / carpeta
        archivos = sorted(p for p in directorio.iterdir() if p.suffix.lower() == ".mp4")
        pendientes, ocupados = [], {}
        for ruta in archivos:  # el numero del nombre manda si no hay choque
            n = numero_declarado(ruta.name)
            if n and 1 <= n <= 99 and n not in ocupados:
                ocupados[n] = ruta
            else:
                pendientes.append(ruta)
        libre = (n for n in range(1, 100) if n not in ocupados)
        for ruta in pendientes:
            ocupados[next(libre)] = ruta

        for n in sorted(ocupados):
            ruta = ocupados[n]
            datos = inspeccionar(ruta)
            incidencias = [datos.get("incidencias", "")]
            declarado = numero_declarado(ruta.name)
            if declarado != n:
                incidencias.append(f"numero_del_nombre={declarado}_reasignado")
            if datos.get("fps_nativo") and abs(datos["fps_nativo"] - 30) > 0.5:
                incidencias.append("fps_no_estandar")
            filas.append({
                "id": f"{prefijo}{n:02d}",
                "grupo": "cadera" if prefijo == "C" else "rodilla",
                "archivo": ruta.name,
                "carpeta": carpeta,
                "tamano_mb": round(ruta.stat().st_size / 1e6, 1),
                "mbits_por_s": round(ruta.stat().st_size * 8 / 1e6 / datos["duracion_s"], 1)
                if datos.get("duracion_s") else "",
                "huella": huella(ruta),
                "n_ejercicio_declarado": declarado if declarado else "",
                "titulo_crudo": titulo(ruta.name),
                **datos,
                "incidencias": ";".join(x for x in incidencias if x),
            })

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    with SALIDA.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNAS, extrasaction="ignore")
        w.writeheader()
        w.writerows(filas)
    print(f"{len(filas)} videos -> {SALIDA}")

    # Duplicados por contenido: dos ids con la misma huella son el mismo video.
    vistas: dict[str, str] = {}
    for fila in filas:
        if fila["huella"] in vistas:
            print(f"  AVISO duplicado: {fila['id']} == {vistas[fila['huella']]}")
        vistas[fila["huella"]] = fila["id"]


if __name__ == "__main__":
    main()
