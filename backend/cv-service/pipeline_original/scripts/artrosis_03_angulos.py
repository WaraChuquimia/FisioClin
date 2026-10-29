"""Etapa 3: angulos articulares.

Convierte los landmarks en la senal que usa todo lo que viene despues:
una serie temporal de angulos por articulacion, suavizada y con su
velocidad. Corre en segundos y se puede repetir tantas veces como haga
falta sin volver a tocar los videos.

El angulo de una articulacion es el que forman los dos segmentos que la
cruzan. Con el vertice en P2 y los extremos en P1 y P3:

    A = P1 - P2,   B = P3 - P2,   theta = arccos( (A . B) / (|A| |B|) )

Se calcula sobre las coordenadas **metricas** (`mundo`), no sobre las de
imagen: un angulo medido en pixeles es el angulo proyectado en la
pantalla, que cambia si se mueve el tripode.

Dos convenciones que conviene no mezclar:

* `<articulacion>` es el **angulo interior** en grados: 180 grados es el
  segmento recto (extension completa).
* `flex_<articulacion>` es la **flexion clinica**: 0 grados es extension
  completa. Es la convencion del goniometro y la que entiende un
  fisioterapeuta. `flex = 180 - interior`.

    python artrosis_03_angulos.py
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np
from scipy.signal import savgol_filter

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
ENTRADA = RAIZ / "02_landmarks"
SALIDA = RAIZ / "03_angulos"

# --- umbrales -------------------------------------------------------------
# Dos umbrales distintos a proposito. Todo este material esta grabado con
# una sola camara, y ahi un miembro tapa al otro: MediaPipe le baja la
# visibilidad al lado oculto por geometria, no por fallo. Exigirle al lado
# tapado lo mismo que al visible borraria la mitad del dataset.
# La admision NO se exige sobre los ocho puntos del nucleo sino sobre los
# CUATRO del lado que la camara ve mejor. Medido sobre las 21808 muestras:
# exigir los ocho admite el 61 % del material; exigir el lado visible
# admite el 92 %, y la mediana de ese lado es 0,926. Quien hunde el minimo
# de los ocho es el miembro tapado, que esta tapado por geometria.
VIS_ADMISION = 0.50      # min de hombro-cadera-rodilla del lado mejor visto -> ENTRA
VIS_GONIOMETRIA = 0.60   # min de los 3 puntos de la articulacion -> se ESCRIBE su angulo
# Una celda vacia es preferible a un angulo calculado sobre puntos adivinados.

# Prueba de plausibilidad del esqueleto reconstruido. El tronco de una
# persona no cambia de longitud dentro de su propio video: si la
# reconstruccion metrica devuelve un tronco muy distinto de la mediana de
# ese video, el esqueleto de ese fotograma esta degenerado y su angulo no
# vale. Medido en R04: en un primer plano el tronco cae a 0,359 m frente a
# 0,489 m del resto, y ahi aparecen flexiones de cadera de 178 grados.
# No lo detecta la visibilidad (sigue alta) ni el encuadre (el cuerpo esta
# dentro): hace falta esta comprobacion aparte.
#
# La referencia es la mediana de TODO el dataset, no la de cada video: la
# mediana de R04 esta contaminada por sus propios fotogramas degenerados.
# Se puede usar una referencia comun porque las medianas por video caen
# entre 0,445 y 0,530 m, incluidos los dos videos del otro sujeto.
DESVIO_TRONCO = 0.15     # fraccion de desvio respecto de la mediana global

VENTANA_SUAVIZADO = 7    # muestras (0,7 s a 10 Hz)
ORDEN_SUAVIZADO = 2
HUECO_MAXIMO = 3         # muestras que se interpolan; mas que eso parte la serie

NUCLEO = [11, 12, 23, 24, 25, 26, 27, 28]
LADO_IZQ = [11, 23, 25, 27]
LADO_DER = [12, 24, 26, 28]

# La admision se decide sobre hombro-cadera-rodilla, SIN el tobillo. El
# tobillo es el punto que MediaPipe pierde mas a menudo (mediana 0,27 en
# C02, 0,12 en el lado tapado de C01) y no interviene en el angulo de
# cadera, que es el objetivo principal de este dataset. Exigirlo para
# admitir el fotograma descartaba medio video por un punto que ese
# ejercicio no usa. Cada angulo tiene ademas su propia comprobacion sobre
# los tres puntos que si lo definen.
ADMISION_IZQ = [11, 23, 25]
ADMISION_DER = [12, 24, 26]

# vertice en el medio: (proximal, articulacion, distal)
ARTICULACIONES = {
    "cadera_der":  (12, 24, 26),
    "cadera_izq":  (11, 23, 25),
    "rodilla_der": (24, 26, 28),
    "rodilla_izq": (23, 25, 27),
    "tobillo_der": (26, 28, 32),
    "tobillo_izq": (25, 27, 31),
}


def angulo_frontal_cadera(pm, lado):
    """Abduccion de cadera: separacion del muslo respecto del plano sagital.

    El angulo hombro-cadera-rodilla es sagital y no describe una
    abduccion, que ocurre en el plano frontal. Cinco ejercicios del
    catalogo son abducciones o rotaciones y para ellos el angulo sagital
    mide otra cosa.

    Se define como el angulo que forma el muslo con el plano sagital:

        abduccion = arcsin( muslo . m ) / |muslo|

    donde `m` es el eje mediolateral de la pelvis, de una cadera a la
    otra. Vale 0 con la pierna en el plano sagital y 90 con la pierna
    completamente separada.

    Esta definicion se prefirio a proyectar el muslo sobre el plano
    frontal y medir el angulo alli: esa proyeccion se hace diminuta cuando
    la pierna apunta hacia adelante o hacia atras — que es la posicion
    neutra en cuadrupedia — y entonces su direccion es puro ruido. Medido:
    daba abducciones de 177 grados en C10 y C09, imposibles. La separacion
    respecto del plano sagital esta bien definida en cualquier postura.

    El eje mediolateral sale de la pelvis y no de la gravedad, asi que
    vale igual de pie, en decubito lateral o en cuadrupedia.
    """
    idx_cadera, idx_rodilla = (24, 26) if lado == "der" else (23, 25)
    m = pm[:, 23] - pm[:, 24]                   # de cadera derecha a izquierda
    m = m / np.linalg.norm(m, axis=-1, keepdims=True)
    muslo = pm[:, idx_rodilla] - pm[:, idx_cadera]
    norma = np.linalg.norm(muslo, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        comp = np.einsum("ij,ij->i", muslo, m) / norma
    if lado == "der":
        comp = -comp                            # alejarse de la linea media
    return np.degrees(np.arcsin(np.clip(comp, -1.0, 1.0)))


def angulo(p1, p2, p3):
    """Angulo interior en P2, en grados. Vectorizado sobre el tiempo."""
    a, b = p1 - p2, p3 - p2
    na = np.linalg.norm(a, axis=-1)
    nb = np.linalg.norm(b, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        cos = np.einsum("ij,ij->i", a, b) / (na * nb)
    return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def interpolar_huecos(v, maximo=HUECO_MAXIMO):
    """Rellena huecos cortos. Los largos se quedan como estan."""
    v = v.copy()
    falta = np.isnan(v)
    if not falta.any() or falta.all():
        return v
    idx = np.arange(len(v))
    lleno = np.interp(idx, idx[~falta], v[~falta])
    # Solo se aceptan los rellenos de rachas cortas.
    inicio = None
    for i in range(len(v) + 1):
        if i < len(v) and falta[i]:
            inicio = i if inicio is None else inicio
        elif inicio is not None:
            if i - inicio <= maximo and inicio > 0 and i < len(v):
                v[inicio:i] = lleno[inicio:i]
            inicio = None
    return v


def suavizar(v):
    """Savitzky-Golay: preserva los extremos mejor que una media movil.

    Importa porque los maximos y minimos de esta serie son justamente el
    ROM: aplanarlos seria subestimar el recorrido.
    """
    v = interpolar_huecos(v)
    salida = np.full_like(v, np.nan)
    valido = ~np.isnan(v)
    inicio = None
    for i in range(len(v) + 1):
        dentro = i < len(v) and valido[i]
        if dentro and inicio is None:
            inicio = i
        elif not dentro and inicio is not None:
            tramo = v[inicio:i]
            n = len(tramo)
            if n >= ORDEN_SUAVIZADO + 2:
                ventana = min(VENTANA_SUAVIZADO, n if n % 2 else n - 1)
                if ventana > ORDEN_SUAVIZADO:
                    tramo = savgol_filter(tramo, ventana, ORDEN_SUAVIZADO)
            # Savitzky-Golay puede sobrepasar el rango de los datos; un
            # angulo interior fuera de [0, 180] no existe.
            salida[inicio:i] = np.clip(tramo, 0.0, 180.0)
            inicio = None
    return salida


def tronco_referencia() -> float:
    """Mediana de la longitud de tronco sobre todo el dataset."""
    largos = []
    for ruta in sorted(ENTRADA.glob("*.npz")):
        pm = np.load(ruta, allow_pickle=True)["mundo"][:, :, :3]
        hombro = (pm[:, 11] + pm[:, 12]) / 2
        cadera = (pm[:, 23] + pm[:, 24]) / 2
        largos.append(np.linalg.norm(hombro - cadera, axis=-1))
    return float(np.nanmedian(np.concatenate(largos)))


def procesar(ruta: Path, tronco_ref: float) -> list[dict]:
    d = np.load(ruta, allow_pickle=True)
    lm, mundo = d["lm"], d["mundo"]
    frames, tiempos, escenas = d["frame"], d["t_seg"], d["escena"]
    vid, grupo = str(d["meta"][0]), str(d["meta"][1])

    vis = lm[:, :, 3]
    vis_nucleo = vis[:, NUCLEO]
    vis_min = np.nanmin(vis_nucleo, axis=1)
    vis_izq = np.nanmin(vis[:, ADMISION_IZQ], axis=1)
    vis_der = np.nanmin(vis[:, ADMISION_DER], axis=1)
    vis_lado = np.fmax(vis_izq, vis_der)
    admitido = np.nan_to_num(vis_lado, nan=-1.0) >= VIS_ADMISION

    pm = mundo[:, :, :3]
    pi = lm[:, :, :2]

    # tronco y su inclinacion respecto de la vertical del cuerpo
    hombro = (pm[:, 11] + pm[:, 12]) / 2
    cadera = (pm[:, 23] + pm[:, 24]) / 2
    tronco_v = hombro - cadera
    tronco_m = np.linalg.norm(tronco_v, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        cos = -tronco_v[:, 1] / tronco_m          # +y apunta hacia abajo
    inclinacion = np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))

    razon_tronco = tronco_m / tronco_ref
    plausible = np.abs(razon_tronco - 1.0) <= DESVIO_TRONCO

    columnas = {}
    for nombre, (a, b, c) in ARTICULACIONES.items():
        crudo = angulo(pm[:, a], pm[:, b], pm[:, c])
        # visibilidad de los tres puntos que definen ESTA articulacion
        vis_art = np.nanmin(vis[:, [a, b, c]], axis=1)
        util = (np.nan_to_num(vis_art, nan=-1.0) >= VIS_GONIOMETRIA) & plausible
        crudo = np.where(util, crudo, np.nan)

        # el mismo angulo en el plano de la imagen, para medir cuanto se
        # sale el movimiento del plano que ve la camara
        img = angulo(np.pad(pi[:, a], ((0, 0), (0, 1))),
                     np.pad(pi[:, b], ((0, 0), (0, 1))),
                     np.pad(pi[:, c], ((0, 0), (0, 1))))
        img = np.where(util, img, np.nan)

        suave = np.full_like(crudo, np.nan)
        velocidad = np.full_like(crudo, np.nan)
        for e in np.unique(escenas):          # nunca se suaviza a traves de un corte
            sel = escenas == e
            s = suavizar(crudo[sel])
            suave[sel] = s
            t = tiempos[sel]
            if len(t) > 2 and np.isfinite(s).sum() > 2:
                v = np.full_like(s, np.nan)
                fin = np.isfinite(s)
                if fin.sum() > 2:
                    v[fin] = np.gradient(s[fin], t[fin])
                velocidad[sel] = v
        columnas[nombre] = suave
        columnas["flex_" + nombre] = 180.0 - suave
        columnas["vel_" + nombre] = velocidad
        columnas["desalin_" + nombre] = np.abs(suave - img)

    # --- abduccion de cadera, plano frontal --------------------------
    for lado, (a, b, c) in (("der", (12, 24, 26)), ("izq", (11, 23, 25))):
        crudo = angulo_frontal_cadera(pm, lado)
        vis_art = np.nanmin(vis[:, [a, b, c]], axis=1)
        util = (np.nan_to_num(vis_art, nan=-1.0) >= VIS_GONIOMETRIA) & plausible
        crudo = np.where(util, crudo, np.nan)
        suave = np.full_like(crudo, np.nan)
        velocidad = np.full_like(crudo, np.nan)
        for e in np.unique(escenas):
            sel = escenas == e
            sv = suavizar(crudo[sel])
            suave[sel] = sv
            tt = tiempos[sel]
            fin_ = np.isfinite(sv)
            if fin_.sum() > 2:
                v = np.full_like(sv, np.nan)
                v[fin_] = np.gradient(sv[fin_], tt[fin_])
                velocidad[sel] = v
        columnas["abd_cadera_" + lado] = suave
        columnas["vel_abd_cadera_" + lado] = velocidad

    dentro = ((pi[:, NUCLEO, 0] > 0.01) & (pi[:, NUCLEO, 0] < 0.99)
              & (pi[:, NUCLEO, 1] > 0.01) & (pi[:, NUCLEO, 1] < 0.99)).all(axis=1)

    filas = []
    for i in range(len(frames)):
        if not admitido[i]:
            continue
        fila = {
            "id": vid, "grupo": grupo,
            "escena": "{}_E{:03d}".format(vid, int(escenas[i])),
            "frame": int(frames[i]), "t_seg": round(float(tiempos[i]), 2),
            "vis_min_nucleo": round(float(vis_min[i]), 3),
            "vis_media_nucleo": round(float(np.nanmean(vis_nucleo[i])), 3),
            "vis_lado_medido": round(float(vis_lado[i]), 3),
            "lado_medido": "izq" if vis_izq[i] >= vis_der[i] else "der",
            "cuerpo_completo": int(dentro[i]),
            "tronco_m": round(float(tronco_m[i]), 3),
            "razon_tronco": round(float(razon_tronco[i]), 3),
            "inclinacion_tronco": round(float(inclinacion[i]), 1),
        }
        for nombre, serie in columnas.items():
            v = serie[i]
            fila[nombre] = round(float(v), 1) if np.isfinite(v) else ""
        filas.append(fila)
    return filas


def main() -> int:
    archivos = sorted(ENTRADA.glob("*.npz"))
    if not archivos:
        print("No hay landmarks en", ENTRADA)
        return 1

    SALIDA.mkdir(parents=True, exist_ok=True)
    tronco_ref = tronco_referencia()
    print("tronco de referencia: {:.3f} m (mediana del dataset)".format(tronco_ref))

    todas, resumen = [], []
    for ruta in archivos:
        filas = procesar(ruta, tronco_ref)
        todas.extend(filas)
        d = np.load(ruta, allow_pickle=True)
        n_total = len(d["frame"])
        con_angulo = sum(1 for f in filas if f["cadera_der"] != "" or f["cadera_izq"] != "")
        resumen.append({
            "id": ruta.stem, "muestras": n_total, "admitidas": len(filas),
            "pct_admitidas": round(100.0 * len(filas) / max(n_total, 1), 1),
            "con_angulo_cadera": con_angulo,
            "pct_con_angulo": round(100.0 * con_angulo / max(len(filas), 1), 1),
        })
        print("{}  {}/{} admitidas ({} %), {} con angulo de cadera".format(
            ruta.stem, len(filas), n_total, resumen[-1]["pct_admitidas"], con_angulo), flush=True)

    destino = SALIDA / "frames_maestro.csv"
    with destino.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(todas[0].keys()))
        w.writeheader()
        w.writerows(todas)
    print("\n{} filas -> {}".format(len(todas), destino))

    destino2 = SALIDA / "resumen_angulos.csv"
    with destino2.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(resumen[0].keys()))
        w.writeheader()
        w.writerows(resumen)
    print("resumen ->", destino2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
