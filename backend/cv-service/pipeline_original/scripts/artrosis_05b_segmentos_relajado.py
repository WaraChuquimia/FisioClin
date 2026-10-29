"""Etapa 5b: igual que artrosis_05_segmentos.py, con dos umbrales relajados
para intentar rescatar C09 y R10 (ver dataset/04_segmentos/segmentos_descartados.csv
de la corrida original: sus descartes caen a milesimas del umbral, no son
ruido de fondo como R03).

DURACION_MIN_TANDA 4.0 -> 3.0 s: C09 perdio tandas de 3.6 s y 1.9 s;
relajar a 3.0 s rescata la primera sin aceptar nada por debajo de lo que
ya se discutio como "no es una repeticion" (DURACION_REP sigue exigiendo
>= 1.0 s por repeticion individual, eso no se toca).

HUECO_MAX_TANDA 1.0 -> 2.0 s: R10 perdio tandas de 0.9 s y 1.9 s, casi
seguro por cortes de deteccion durante el equilibrio en un pie (la pierna
levantada se pierde de vista un instante). Tolerar un hueco mas largo
dentro de la MISMA tanda no inventa dato: solo deja de cortar una tanda
real en dos pedazos por un fotograma perdido.

R03 NO se toca aqui a proposito: sus descartes son "sin excursion
suficiente" con picos de 4-7 grados, por debajo del piso de ruido de 8
grados que el script original fija como limite de lo medible. Relajar ESE
umbral admitiria ruido de deteccion como si fuera movimiento real.

    python artrosis_05b_segmentos_relajado.py

Aqui se resuelve lo que la etapa 1 dejo abierto. Alli quedo demostrado que
ninguna senal derivada de la postura global separa ejercicio de quietud en
las 20 clases: la velocidad instantanea no distingue un puente lento de
estar tumbado, y la excursion postural es ciega a una abduccion en
cuadrupedia, donde el tronco no se mueve.

La senal que si lo consigue es la que produjo la etapa 3: **el angulo de
la articulacion que ese ejercicio mueve**, que la ficha clinica declara
ejercicio por ejercicio. Un ejercicio esta ocurriendo cuando ese angulo
recorre un arco y vuelve; no cuando el cuerpo se desplaza.

Dos regimenes, porque son dos cosas distintas:

* **dinamico** -- el angulo oscila. La tanda es el tramo donde oscila y la
  repeticion es un ciclo valle-pico-valle.
* **sostenido** -- el angulo se queda quieto lejos de la posicion neutra.
  No hay repeticiones: hay retenciones, y lo que se mide es cuanto duran y
  cuanto oscilan.

    python artrosis_05_segmentos.py
"""
from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.signal import find_peaks

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
ANGULOS = RAIZ / "03_angulos/frames_maestro.csv"
FICHA = RAIZ / "referencia/ficha_normalizada.csv"
DIR_SEG = RAIZ / "04_segmentos_relajado"
DIR_REP = RAIZ / "05_repeticiones_relajado"

HZ = 10.0
VENTANA_EXCURSION = 6.0    # s. Ventana en la que se mide si el angulo recorre algo
# Umbral de excursion para declarar que se esta ejercitando. Es absoluto
# con un techo relativo: un movimiento cuyo recorrido total es de 20 grados
# no puede mostrar 15 dentro de una ventana de 6 s, y un umbral fijo lo
# borraba entero. R03 (elevacion lateral tumbado) se perdia asi: su maxima
# excursion en ventana es de 13,7 grados y se quedaba sin una sola tanda.
EXCURSION_TANDA = 15.0     # grados
EXCURSION_FRACCION = 0.40  # o esta fraccion del recorrido de la escena
EXCURSION_MINIMA = 8.0     # suelo: por debajo no se distingue del ruido
DURACION_MIN_TANDA = 3.0   # s. Relajado de 4.0 (ver docstring: rescate de C09)
HUECO_MAX_TANDA = 2.0      # s sin senal que se toleran dentro de una tanda (relajado de 1.0: rescate de R10)

# Una repeticion tiene que destacar sobre el ruido del propio tramo y no
# puede solaparse con la siguiente.
PROMINENCIA_MIN = 10.0     # grados, suelo absoluto
PROMINENCIA_REL = 0.25     # o esta fraccion del recorrido de la ESCENA, la mayor
SEPARACION_MIN = 1.0       # s entre picos consecutivos
DURACION_REP = (1.0, 15.0)  # s. Fuera de esto no es una repeticion

# Retenciones de los ejercicios sostenidos
EXCURSION_RETENCION = 8.0  # grados. Por encima, no se esta sosteniendo
DURACION_MIN_RETENCION = 4.0


def leer_ficha() -> dict:
    return {f["id"]: f for f in csv.DictReader(FICHA.open(encoding="utf-8"))}


def leer_angulos() -> dict:
    por = defaultdict(list)
    with ANGULOS.open(encoding="utf-8") as fh:
        for f in csv.DictReader(fh):
            por[f["id"]].append(f)
    return por


def serie(filas, columna):
    return np.array([float(f[columna]) if f[columna] else np.nan for f in filas])


def excursion_movil(v, t, ventana=VENTANA_EXCURSION):
    """Recorrido (p95 - p5) del angulo dentro de una ventana centrada."""
    salida = np.full(len(v), np.nan)
    for i in range(len(v)):
        sel = (np.abs(t - t[i]) <= ventana / 2) & ~np.isnan(v)
        if sel.sum() >= 5:
            salida[i] = np.percentile(v[sel], 95) - np.percentile(v[sel], 5)
    return salida


def tramos(mascara, t, hueco_max=HUECO_MAX_TANDA):
    """Tramos contiguos de la mascara, tolerando huecos cortos."""
    idx = np.where(mascara)[0]
    if not len(idx):
        return []
    grupos, actual = [], [idx[0]]
    for a, b in zip(idx, idx[1:]):
        if t[b] - t[a] <= hueco_max:
            actual.append(b)
        else:
            grupos.append(actual)
            actual = [b]
    grupos.append(actual)
    return [(g[0], g[-1]) for g in grupos]


MUESTRAS_MIN_LADO = 20


def columnas_objetivo(movimiento, art, lado):
    """Que columna describe ESTE movimiento.

    Una abduccion no se ve en el angulo hombro-cadera-rodilla, que es
    sagital: se mide con la separacion del muslo respecto del plano
    sagital que calcula la etapa 3.
    """
    if movimiento == "abduccion":
        return "abd_cadera_" + lado, "vel_abd_cadera_" + lado
    return "flex_{}_{}".format(art, lado), "vel_{}_{}".format(art, lado)


def lado_de_escena(filas, art, movimiento=""):
    """El lado que MAS SE MUEVE, no el que mejor se ve.

    Elegir el lado con mas muestras parece razonable y es un error: en los
    ejercicios de piernas alternas la camara suele ver mejor la pierna de
    apoyo, que es justamente la que no trabaja. En C09 eso hacia que el
    detector midiera la pierna quieta y encontrara una sola repeticion en
    todo el video.
    """
    mejor, mejor_rec = None, -1.0
    for lado in ("der", "izq"):
        col = columnas_objetivo(movimiento, art, lado)[0]
        v = np.array([float(f[col]) for f in filas if f[col]])
        if len(v) < MUESTRAS_MIN_LADO:
            continue
        rec = float(np.percentile(v, 95) - np.percentile(v, 5))
        if rec > mejor_rec:
            mejor, mejor_rec = lado, rec
    if mejor:
        return mejor
    # ningun lado tiene muestras suficientes: se acepta el que tenga alguna
    cuenta = {l: sum(1 for f in filas if f[columnas_objetivo(movimiento, art, l)[0]])
              for l in ("der", "izq")}
    return max(cuenta, key=cuenta.get) if max(cuenta.values()) else None


def repeticiones_de_escena(ang, t, vel, tronco, contra):
    """Ciclos valle-pico-valle sobre la ESCENA entera.

    No se buscan dentro de cada tanda a proposito. La tanda es un recorte
    hecho con una ventana movil de excursion, y sus bordes caen a media
    repeticion; como `find_peaks` exige un valle a cada lado del pico, la
    primera y la ultima repeticion de cada tanda se perdian. Con tandas de
    una o dos repeticiones eso significaba perderlas casi todas: 52
    repeticiones en los 20 videos, y cuatro clases dinamicas con cero.

    La escena es un plano continuo, que es la unidad natural del
    movimiento. Cada repeticion se asigna despues a la tanda donde cae su
    pico.
    """
    fin = ~np.isnan(ang)
    if fin.sum() < 10:
        return []
    a, tt = ang[fin], t[fin]
    recorrido = float(np.percentile(a, 95) - np.percentile(a, 5))
    prominencia = max(PROMINENCIA_MIN, PROMINENCIA_REL * recorrido)
    separacion = max(1, int(SEPARACION_MIN * HZ))

    picos, _ = find_peaks(a, prominence=prominencia, distance=separacion)
    valles, _ = find_peaks(-a, prominence=prominencia, distance=separacion)

    # Una repeticion es una excursion y su vuelta, sin importar el sentido.
    # En un puente o en una extension de cadera en cuadrupedia el ciclo
    # empieza ARRIBA: la cadera parte flexionada y el movimiento la lleva a
    # la extension; el ciclo es pico-valle-pico. En una elevacion de rodilla
    # es al reves. Exigir valle-pico-valle solo detectaba la mitad de los
    # ejercicios del catalogo.
    extremos = sorted([(int(i), "max") for i in picos]
                      + [(int(i), "min") for i in valles])
    # los extremos tienen que alternar: si se repite el tipo, gana el mas extremo
    alternos = []
    for idx, tipo in extremos:
        if alternos and alternos[-1][1] == tipo:
            previo = alternos[-1][0]
            mejor = (max if tipo == "max" else min)((previo, idx), key=lambda k: a[k])
            alternos[-1] = (mejor, tipo)
        else:
            alternos.append((idx, tipo))
    if len(alternos) < 3:
        return []

    salida = []
    for (i0, tipo0), (p, _tipo1), (i1, _tipo2) in zip(alternos, alternos[1:], alternos[2:]):
        dur = float(tt[i1] - tt[i0])
        if not (DURACION_REP[0] <= dur <= DURACION_REP[1]):
            continue
        tramo = a[i0:i1 + 1]
        subida = float(tt[p] - tt[i0])
        bajada = float(tt[i1] - tt[p])
        v = vel[fin][i0:i1 + 1]
        v = v[np.isfinite(v)]
        tr = tronco[fin][i0:i1 + 1]
        tr = tr[np.isfinite(tr)]
        co = contra[fin][i0:i1 + 1] if contra is not None else np.array([])
        co = co[np.isfinite(co)]
        rom = float(tramo.max() - tramo.min())
        rom_contra = float(co.max() - co.min()) if len(co) > 5 else None
        salida.append({
            "t_inicio_s": round(float(tt[i0]), 2),
            "t_pico_s": round(float(tt[p]), 2),
            "_pico": float(tt[p]),
            "_inicio": float(tt[i0]),
            "_fin": float(tt[i1]),
            "sentido": "desciende" if tipo0 == "max" else "asciende",
            "t_fin_s": round(float(tt[i1]), 2),
            "duracion_s": round(dur, 2),
            "flex_min_grados": round(float(tramo.min()), 1),
            "flex_max_grados": round(float(tramo.max()), 1),
            "rom_grados": round(rom, 1),
            "duracion_ida_s": round(subida, 2),
            "duracion_vuelta_s": round(bajada, 2),
            "razon_ida_vuelta": round(subida / bajada, 2) if bajada > 0 else "",
            "velocidad_media_gr_s": round(float(np.abs(v).mean()), 1) if len(v) else "",
            "velocidad_pico_gr_s": round(float(np.abs(v).max()), 1) if len(v) else "",
            "rom_tronco_grados": round(float(tr.max() - tr.min()), 1) if len(tr) else "",
            "rom_contralateral_grados": round(rom_contra, 1) if rom_contra else "",
            "asimetria_rom": round(abs(rom - rom_contra) / max(rom, 1e-6), 2)
            if rom_contra else "",
        })
    return salida


def retenciones_de_tanda(ang, t, tronco):
    """Tramos sostenidos: el angulo se queda quieto lejos de lo neutro."""
    fin = ~np.isnan(ang)
    if fin.sum() < 10:
        return []
    a, tt = ang[fin], t[fin]
    exc = excursion_movil(a, tt, ventana=3.0)
    quieto = np.nan_to_num(exc, nan=1e9) < EXCURSION_RETENCION
    salida = []
    for i0, i1 in tramos(quieto, tt, hueco_max=0.5):
        dur = float(tt[i1] - tt[i0])
        if dur < DURACION_MIN_RETENCION:
            continue
        tramo = a[i0:i1 + 1]
        tr = tronco[fin][i0:i1 + 1]
        tr = tr[np.isfinite(tr)]
        salida.append({
            "t_inicio_s": round(float(tt[i0]), 2),
            "t_pico_s": round(float(tt[i0 + int(np.argmax(tramo))]), 2),
            "t_fin_s": round(float(tt[i1]), 2),
            "duracion_s": round(dur, 2),
            "flex_min_grados": round(float(tramo.min()), 1),
            "flex_max_grados": round(float(tramo.max()), 1),
            "rom_grados": round(float(tramo.max() - tramo.min()), 1),
            "flex_sostenida_grados": round(float(np.median(tramo)), 1),
            "oscilacion_grados": round(float(np.percentile(tramo, 95)
                                             - np.percentile(tramo, 5)), 1),
            "rom_tronco_grados": round(float(tr.max() - tr.min()), 1) if len(tr) else "",
        })
    return salida


def main() -> int:
    ficha = leer_ficha()
    angulos = leer_angulos()
    segmentos, descartados, repeticiones = [], [], []

    for vid in sorted(angulos):
        info = ficha.get(vid)
        if not info:
            continue
        art = info["articulacion_medida"]
        sostenido = info["tipo"] == "sostenido"
        n_seg = 0

        porescena = defaultdict(list)
        for f in angulos[vid]:
            porescena[f["escena"]].append(f)

        for escena, filas in sorted(porescena.items()):
            filas.sort(key=lambda f: int(f["frame"]))
            lado = lado_de_escena(filas, art, info["movimiento"])
            if lado is None:
                descartados.append({"id": vid, "escena": escena, "motivo":
                                    "sin senal de " + info["movimiento"]
                                    + " de " + art})
                continue
            otro = "izq" if lado == "der" else "der"
            col_ang, col_vel = columnas_objetivo(info["movimiento"], art, lado)
            col_contra = columnas_objetivo(info["movimiento"], art, otro)[0]
            t = serie(filas, "t_seg")
            ang = serie(filas, col_ang)
            vel = serie(filas, col_vel)
            contra = serie(filas, col_contra)
            tronco = serie(filas, "inclinacion_tronco")

            exc = excursion_movil(ang, t)
            if sostenido:
                activo = ~np.isnan(ang)
            else:
                finita = ang[~np.isnan(ang)]
                recorrido = (float(np.percentile(finita, 95) - np.percentile(finita, 5))
                             if len(finita) > 10 else 0.0)
                umbral = max(EXCURSION_MINIMA,
                             min(EXCURSION_TANDA, EXCURSION_FRACCION * recorrido))
                activo = np.nan_to_num(exc, nan=-1.0) >= umbral

            # Las repeticiones se buscan sobre la escena entera y despues
            # se reparten entre las tandas por el instante de su pico.
            unidades_escena = ([] if sostenido else
                               repeticiones_de_escena(ang, t, vel, tronco, contra))

            hallados = tramos(activo, t)
            if not hallados:
                descartados.append({
                    "id": vid, "escena": escena,
                    "motivo": "sin excursion suficiente (max {:.1f} grados)".format(
                        float(np.nanmax(exc)) if np.isfinite(exc).any() else 0.0)})
                continue

            for i0, i1 in hallados:
                dur = float(t[i1] - t[i0])
                if dur < DURACION_MIN_TANDA:
                    descartados.append({"id": vid, "escena": escena,
                                        "motivo": "tanda de {:.1f} s".format(dur)})
                    continue
                n_seg += 1
                seg_id = "{}_S{:02d}".format(vid, n_seg)
                sub = slice(i0, i1 + 1)
                if sostenido:
                    unidades = retenciones_de_tanda(ang[sub], t[sub], tronco[sub])
                else:
                    # Se asigna por solapamiento, no por el instante del pico:
                    # en un ejercicio con retencion arriba el pico cae en una
                    # meseta, la excursion movil alli es baja y el pico queda
                    # fuera de la tanda que el mismo movimiento genero.
                    unidades = [u for u in unidades_escena
                                if min(u["_fin"], t[i1]) - max(u["_inicio"], t[i0])
                                > 0.5 * (u["_fin"] - u["_inicio"])]
                a = ang[sub][~np.isnan(ang[sub])]
                segmentos.append({
                    "segmento_id": seg_id, "id": vid, "escena": escena,
                    "ejercicio": info["ejercicio"], "grupo": info["grupo"],
                    "articulacion_medida": art, "lado_medido": lado,
                    "senal": col_ang,
                    "tipo": info["tipo"],
                    "t_inicio_s": round(float(t[i0]), 2),
                    "t_fin_s": round(float(t[i1]), 2),
                    "duracion_s": round(dur, 2),
                    "muestras": int(i1 - i0 + 1),
                    "flex_p5": round(float(np.percentile(a, 5)), 1) if len(a) else "",
                    "flex_p95": round(float(np.percentile(a, 95)), 1) if len(a) else "",
                    "recorrido_grados": round(float(np.percentile(a, 95)
                                                    - np.percentile(a, 5)), 1)
                    if len(a) else "",
                    "unidades": len(unidades),
                })
                for k, u in enumerate(unidades, 1):
                    u = {c: v for c, v in u.items() if not c.startswith("_")}
                    repeticiones.append({
                        "repeticion_id": "{}_R{:02d}".format(seg_id, k),
                        "segmento_id": seg_id, "id": vid, "escena": escena,
                        "ejercicio": info["ejercicio"], "grupo": info["grupo"],
                        "tipo": info["tipo"], "articulacion_medida": art,
                        "lado_medido": lado, "movimiento": info["movimiento"],
                        "alineado_con_camara": info["alineado_con_camara"],
                        **u,
                    })

    DIR_SEG.mkdir(parents=True, exist_ok=True)
    DIR_REP.mkdir(parents=True, exist_ok=True)
    for destino, datos in ((DIR_SEG / "segmentos.csv", segmentos),
                           (DIR_SEG / "segmentos_descartados.csv", descartados),
                           (DIR_REP / "repeticiones.csv", repeticiones)):
        if not datos:
            continue
        campos = sorted({k for d in datos for k in d},
                        key=lambda k: min(list(d).index(k) for d in datos if k in d))
        with destino.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=campos)
            w.writeheader()
            w.writerows(datos)
        print("{} filas -> {}".format(len(datos), destino))
    return 0


if __name__ == "__main__":
    sys.exit(main())
