"""Etapa 1b: agrega el muestreo por fotograma a escena y a video.

Lee `01_contenido/frames_muestreados.csv` y escribe:

  * `escenas.csv`   -- un plano continuo por fila, con su clasificacion
  * `contenido.csv` -- un video por fila, con el veredicto de material util

La decision movimiento / quietud se toma **por muestra**, no por escena.
Una escena de 25 s puede empezar con el fisioterapeuta explicando y
terminar con el ejercicio: clasificar el plano entero por su mediana
borraria el ejercicio completo. La escena sigue siendo la unidad de
agrupamiento para train/test, pero no la unidad de decision.

    python artrosis_01_resumen.py --explorar   # distribuciones, para calibrar
    python artrosis_01_resumen.py              # escribe los CSV
"""
from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path

import numpy as np

AQUI = Path(__file__).parent
DIR = AQUI / "dataset_artrosis/01_contenido"
FRAMES = DIR / "frames_muestreados.csv"
INDICE = AQUI / "dataset_artrosis/00_indice/videos.csv"

SEG_POR_MUESTRA = 0.5     # el muestreo de la etapa 1 es de 2 Hz

# --- umbrales de clasificacion --------------------------------------------
# PROVISIONALES, calibrados con --explorar sobre este material y verificados
# mirando fotogramas. No son constantes universales.
VISTA_FRONTAL = 0.45      # razon ancho_hombros / largo_tronco por encima -> frontal
VISTA_PERFIL = 0.25       # por debajo -> perfil
POSTURA_DE_PIE = 25.0     # inclinacion de tronco en grados por debajo -> vertical
POSTURA_TUMBADO = 60.0    # por encima -> horizontal
# Un movimiento terapeutico es lento: a 2 Hz desplaza tan poco entre
# muestras que la velocidad instantanea no lo distingue de la quietud
# (verificado en C01, un puente de 111 s que la velocidad marcaba quieto).
# Lo que si lo distingue es la EXCURSION: cuanto recorre una senal postural
# dentro de una ventana de varios segundos.
VENTANA_EXCURSION = 6.0   # segundos
SENALES_EXCURSION = ("inclinacion_tronco", "alto_relativo", "razon_hombros")
UMBRAL_EXCURSION = 1.0    # en unidades del percentil 75 de cada senal
PCT_MOV_ESCENA = 40.0     # % de muestras en movimiento para llamar MOVIMIENTO a la escena
PCT_MOV_MIXTA = 10.0      # por debajo de esto la escena es quieta
POSE_MINIMA = 60.0        # % de muestras con pose para considerar la escena
ESCENA_MINIMA_S = 2.0     # una escena mas corta que esto no sirve para nada

NUMERICAS = ("t_seg", "vis_nucleo_min", "vis_nucleo_media", "razon_hombros",
             "razon_caderas", "inclinacion_tronco", "alto_relativo", "mov_nucleo", "mov_articular")
ENTERAS = ("frame", "pose", "n_caras", "cuerpo_completo")


def leer():
    filas = list(csv.DictReader(FRAMES.open(encoding="utf-8")))
    for f in filas:
        for k in NUMERICAS:
            f[k] = float(f[k]) if f.get(k) not in (None, "") else np.nan
        for k in ENTERAS:
            f[k] = int(float(f[k])) if f.get(k) not in (None, "") else 0
    return filas


def med(valores):
    v = np.array([x for x in valores if not np.isnan(x)], dtype=float)
    return float(np.median(v)) if v.size else np.nan


def pct(n, total):
    return round(100.0 * n / total, 1) if total else 0.0


def marcar_movimiento(filas):
    """Anota cada muestra como en movimiento o quieta, por excursion.

    Para cada senal postural se mide su recorrido (p95 - p5) dentro de una
    ventana centrada en la muestra, **sin cruzar el corte de plano**: a
    traves de un corte la senal salta por montaje, no por movimiento.
    Cada senal se lleva a su propia escala dividiendo por su percentil 75,
    y se toma la mayor: basta que UNA parte del cuerpo recorra un arco para
    que haya ejercicio, y segun el ejercicio esa parte es el tronco, la
    altura del cuerpo o su rotacion.
    """
    porescena = defaultdict(list)
    for f in filas:
        porescena[f["escena"]].append(f)

    crudas = {c: [] for c in SENALES_EXCURSION}
    for ms in porescena.values():
        ms.sort(key=lambda m: m["frame"])
        t = np.array([m["t_seg"] for m in ms])
        for col in SENALES_EXCURSION:
            v = np.array([m[col] for m in ms], dtype=float)
            for i, m in enumerate(ms):
                sel = (np.abs(t - t[i]) <= VENTANA_EXCURSION / 2) & ~np.isnan(v)
                r = float(np.percentile(v[sel], 95) - np.percentile(v[sel], 5))                     if sel.sum() >= 3 else np.nan
                m.setdefault("_exc", {})[col] = r
                if not np.isnan(r):
                    crudas[col].append(r)

    escala = {c: (float(np.percentile(v, 75)) or 1.0) for c, v in crudas.items() if v}
    for f in filas:
        exc = f.pop("_exc", {})
        valores = [exc[c] / escala[c] for c in SENALES_EXCURSION
                   if c in escala and not np.isnan(exc.get(c, np.nan))]
        if not f["pose"] or not valores:
            f["excursion"] = np.nan
            f["en_movimiento"] = None
        else:
            f["excursion"] = round(max(valores), 3)
            f["en_movimiento"] = f["excursion"] >= UMBRAL_EXCURSION


def etiqueta_vista(r):
    if np.isnan(r):
        return ""
    return "frontal" if r >= VISTA_FRONTAL else ("perfil" if r <= VISTA_PERFIL else "oblicua")


def etiqueta_postura(i):
    if np.isnan(i):
        return ""
    return "vertical" if i <= POSTURA_DE_PIE else (
        "horizontal" if i >= POSTURA_TUMBADO else "inclinada")


def clasificar_escena(pct_pose, dur, pct_mov, postura):
    """Cuatro clases. La distincion importante es la ultima.

    Una retencion de estiramiento tiene tan poco movimiento como una
    explicacion frente a camara. Lo que las separa no es la energia sino
    la postura: nadie explica a camara tumbado en la colchoneta.
    """
    if pct_pose < POSE_MINIMA:
        return "SIN_PERSONA"
    if dur < ESCENA_MINIMA_S:
        return "PLANO_MUY_CORTO"
    if pct_mov >= PCT_MOV_ESCENA:
        return "MOVIMIENTO"
    if pct_mov >= PCT_MOV_MIXTA:
        return "MIXTA"
    return "QUIETO_DE_PIE" if postura == "vertical" else "QUIETO_EN_POSICION"


def resumir_escenas(filas):
    porescena = defaultdict(list)
    for f in filas:
        porescena[(f["id"], f["escena"])].append(f)

    escenas = []
    for (vid, esc), ms in sorted(porescena.items()):
        ms.sort(key=lambda m: m["frame"])
        dur = round(ms[-1]["t_seg"] - ms[0]["t_seg"] + SEG_POR_MUESTRA, 2)
        conpose = [m for m in ms if m["pose"]]
        decididas = [m for m in ms if m["en_movimiento"] is not None]
        n_mov = sum(1 for m in decididas if m["en_movimiento"])
        pct_mov = pct(n_mov, len(decididas))
        pct_pose = pct(len(conpose), len(ms))
        vista = med([m["razon_hombros"] for m in conpose])
        incl = med([m["inclinacion_tronco"] for m in conpose])
        postura = etiqueta_postura(incl)
        escenas.append({
            "id": vid, "escena": esc,
            "t_inicio_s": ms[0]["t_seg"], "t_fin_s": ms[-1]["t_seg"], "duracion_s": dur,
            "muestras": len(ms), "muestras_decididas": len(decididas),
            "pct_pose": pct_pose,
            "pct_cuerpo_completo": pct(sum(m["cuerpo_completo"] for m in ms), len(ms)),
            "vis_nucleo_media": round(med([m["vis_nucleo_media"] for m in conpose]), 3)
            if conpose else "",
            "razon_hombros": round(vista, 3) if not np.isnan(vista) else "",
            "vista_estimada": etiqueta_vista(vista),
            "inclinacion_tronco": round(incl, 1) if not np.isnan(incl) else "",
            "postura_estimada": postura,
            "excursion_mediana": round(med([m["excursion"] for m in decididas]), 3)
            if decididas else "",
            "mov_articular_mediana": round(med([m["mov_articular"] for m in decididas]), 4)
            if decididas else "",
            "pct_muestras_movimiento": pct_mov,
            "segundos_movimiento": round(n_mov * SEG_POR_MUESTRA, 1),
            "caras_max": max(m["n_caras"] for m in ms),
            "clase": clasificar_escena(pct_pose, dur, pct_mov, postura),
        })
    return escenas


def resumir_videos(escenas):
    idx = {r["id"]: r for r in csv.DictReader(INDICE.open(encoding="utf-8"))}
    porvideo = defaultdict(list)
    for e in escenas:
        porvideo[e["id"]].append(e)

    videos = []
    for vid in sorted(porvideo):
        es = porvideo[vid]
        dur_total = float(idx[vid]["duracion_s"])
        muestras_tot = sum(e["muestras"] for e in es)
        seg_mov = sum(e["segundos_movimiento"] for e in es)
        # El material aprovechable incluye las retenciones: quietud en una
        # postura que no es la de explicar a camara.
        seg_sostenido = sum(e["duracion_s"] for e in es if e["clase"] == "QUIETO_EN_POSICION")
        vistas, posturas = defaultdict(float), defaultdict(float)
        # La orientacion y la postura son propiedades del plano, no del
        # movimiento: se ponderan por la duracion de toda escena con
        # persona. Restringirlas a las escenas con movimiento dejaba sin
        # vista a los ejercicios que el detector de movimiento no ve.
        for e in es:
            if e["clase"] not in ("SIN_PERSONA", "PLANO_MUY_CORTO"):
                vistas[e["vista_estimada"]] += e["duracion_s"]
                posturas[e["postura_estimada"]] += e["duracion_s"]
        videos.append({
            "id": vid, "grupo": idx[vid]["grupo"], "titulo": idx[vid]["titulo_crudo"],
            "duracion_s": dur_total,
            "n_escenas": len(es),
            "duracion_media_escena_s": round(sum(e["duracion_s"] for e in es) / len(es), 1),
            "pct_pose": round(sum(e["pct_pose"] * e["muestras"] for e in es)
                              / max(muestras_tot, 1), 1),
            "pct_cuerpo_completo": round(sum(e["pct_cuerpo_completo"] * e["muestras"] for e in es)
                                         / max(muestras_tot, 1), 1),
            "segundos_movimiento": round(seg_mov, 1),
            "pct_movimiento": round(100 * seg_mov / dur_total, 1),
            "segundos_retencion": round(seg_sostenido, 1),
            "escenas_movimiento": sum(1 for e in es if e["clase"] == "MOVIMIENTO"),
            "escenas_mixtas": sum(1 for e in es if e["clase"] == "MIXTA"),
            "escenas_quieto_de_pie": sum(1 for e in es if e["clase"] == "QUIETO_DE_PIE"),
            "escenas_sin_persona": sum(1 for e in es if e["clase"] == "SIN_PERSONA"),
            "vista_dominante": max(vistas, key=vistas.get) if vistas else "",
            "postura_dominante": max(posturas, key=posturas.get) if posturas else "",
            "caras_max": max(e["caras_max"] for e in es),
            "escenas_2_caras": sum(1 for e in es if e["caras_max"] >= 2),
        })
    return videos


def explorar(filas):
    conpose = [f for f in filas if f["pose"]]
    print("muestras:", len(filas), " con pose:", len(conpose),
          "({:.1f} %)".format(100 * len(conpose) / len(filas)))
    for col in ("razon_hombros", "inclinacion_tronco", "mov_articular", "mov_nucleo",
                "vis_nucleo_min", "alto_relativo"):
        v = np.array([f[col] for f in conpose if not np.isnan(f[col])])
        if v.size:
            print("{:20} p5={:6.3f} p25={:6.3f} p50={:6.3f} p75={:6.3f} p95={:6.3f}".format(
                col, *np.percentile(v, [5, 25, 50, 75, 95])))
    caras = defaultdict(int)
    for f in filas:
        caras[f["n_caras"]] += 1
    print("caras por muestra:", dict(sorted(caras.items())))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--explorar", action="store_true")
    args = ap.parse_args()

    filas = leer()
    marcar_movimiento(filas)
    if args.explorar:
        explorar(filas)
        return

    escenas = resumir_escenas(filas)
    videos = resumir_videos(escenas)
    for nombre, salida in (("escenas.csv", escenas), ("contenido.csv", videos)):
        destino = DIR / nombre
        with destino.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(salida[0].keys()))
            w.writeheader()
            w.writerows(salida)
        print(len(salida), "->", destino)


if __name__ == "__main__":
    main()
