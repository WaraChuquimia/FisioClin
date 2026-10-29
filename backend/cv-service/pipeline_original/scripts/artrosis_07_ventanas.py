"""Etapa 7: construye el tensor que consume la red.

Convierte la serie de angulos en ventanas temporales de longitud fija.
Es la unica etapa cuyo producto es desechable: si manana cambia el diseno
de features o la longitud de ventana, se borra y se regenera en segundos
desde la etapa 3. El dataset maestro (`calidad.csv`) no se toca.

## Que entra como feature y que no

Entran **angulos y velocidades angulares**, que son invariantes a la talla
del sujeto, a su distancia a la camara y a donde este dentro del encuadre.
No entran las coordenadas crudas: con dos sujetos en todo el material,
cualquier feature que dependa del tamano del cuerpo se convierte en un
identificador de la persona, y la red aprende **quien** es en vez de **que
hace**.

Tampoco entra ninguna magnitud que participo en calcular la etiqueta —
ROM, duracion de la repeticion, razon ida/vuelta. Incluirlas seria fuga de
etiqueta: el modelo las leeria y acertaria sin haber aprendido nada.

## La canonizacion por lado

Cada video mide el lado que la camara ve, que no es el mismo en todos. Si
las features se guardan como derecha/izquierda, la red aprende de que lado
estaba el tripode. Por eso el vector se ordena como **lado medido /
contralateral**, no como derecha / izquierda.

## Lo que NO se hace aqui

**No se estandarizan las features.** La media y la desviacion tienen que
calcularse solo sobre el conjunto de entrenamiento, y la particion se
decide en la etapa siguiente. Estandarizar aqui, sobre todo el dataset,
seria fuga de informacion: sutil, pero real.

    python artrosis_07_ventanas.py
"""
from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
ANGULOS = RAIZ / "03_angulos/frames_maestro.csv"
SEGMENTOS = RAIZ / "04_segmentos/segmentos.csv"
CALIDAD = RAIZ / "05_repeticiones/calidad.csv"
FICHA = RAIZ / "referencia/ficha_normalizada.csv"
SALIDA = RAIZ / "06_ventanas"

HZ = 10.0
VENTANA_S = 3.0            # 30 muestras: cubre medio ciclo tipico (mediana 5,8 s)
PASO_S = 1.0               # 66 % de solapamiento
# Los huecos se cuentan SOLO sobre las features del lado medido y el
# tronco. Las del lado contralateral faltan por geometria — en plano
# lateral un miembro tapa al otro — y contarlas como huecos descartaba
# ventanas enteras por datos que nunca van a existir: tres clases se
# quedaban en cero. Cuando faltan, se rellenan con 0 y el canal
# `contra_presente` avisa de que son ausencia y no un angulo de 0 grados.
MAX_FALTANTE = 0.30        # fraccion de huecos tolerada, solo en las principales

NOMBRES_FEATURES = [
    "flex_cadera_medido", "flex_cadera_contra",
    "flex_rodilla_medido", "flex_rodilla_contra",
    "flex_tobillo_medido", "flex_tobillo_contra",
    "abd_cadera_medido", "abd_cadera_contra",
    "inclinacion_tronco",
    "vel_cadera_medido", "vel_rodilla_medido", "vel_abd_medido",
    "visibilidad", "contra_presente",
]
# indices de NOMBRES_FEATURES que dependen del lado contralateral
CONTRALATERALES = [1, 3, 5, 7]
PRINCIPALES = [0, 2, 4, 6, 8, 9, 10, 11, 12]
VEREDICTOS = ["CORRECTA", "DUDOSA", "INCORRECTA"]


def columnas(lado):
    """Las columnas de `frames_maestro` que forman el vector, en orden."""
    otro = "izq" if lado == "der" else "der"
    return [
        "flex_cadera_" + lado, "flex_cadera_" + otro,
        "flex_rodilla_" + lado, "flex_rodilla_" + otro,
        "flex_tobillo_" + lado, "flex_tobillo_" + otro,
        "abd_cadera_" + lado, "abd_cadera_" + otro,
        "inclinacion_tronco",
        "vel_cadera_" + lado, "vel_rodilla_" + lado, "vel_abd_cadera_" + lado,
        "vis_lado_medido",
    ]


def rellenar(m):
    """Arrastra el ultimo valor conocido hacia adelante y hacia atras.

    Solo se usa dentro de la ventana, y solo si los huecos son pocos: las
    ventanas con mas de MAX_FALTANTE de huecos se descartan enteras.
    """
    for j in range(m.shape[1]):
        col = m[:, j]
        idx = np.where(~np.isnan(col))[0]
        if not len(idx):
            col[:] = 0.0
            continue
        col[:idx[0]] = col[idx[0]]
        col[idx[-1] + 1:] = col[idx[-1]]
        for a, b in zip(idx, idx[1:]):
            if b > a + 1:
                col[a + 1:b] = np.interp(np.arange(a + 1, b), [a, b], [col[a], col[b]])
    return m


def main() -> int:
    ficha = {f["id"]: f for f in csv.DictReader(FICHA.open(encoding="utf-8"))}
    clases = sorted({f["ejercicio"] for f in ficha.values()})
    idx_clase = {c: i for i, c in enumerate(clases)}
    grupos = sorted({f["grupo"] for f in ficha.values()})

    por_video = defaultdict(list)
    with ANGULOS.open(encoding="utf-8") as fh:
        for f in csv.DictReader(fh):
            por_video[f["id"]].append(f)
    for v in por_video.values():
        v.sort(key=lambda f: int(f["frame"]))

    segmentos = list(csv.DictReader(SEGMENTOS.open(encoding="utf-8")))
    reps = list(csv.DictReader(CALIDAD.open(encoding="utf-8")))
    reps_por_seg = defaultdict(list)
    for r in reps:
        reps_por_seg[r["segmento_id"]].append(r)

    n_ventana = int(round(VENTANA_S * HZ))
    paso = int(round(PASO_S * HZ))

    X, y_ej, y_gr, y_cal, g_escena, meta = [], [], [], [], [], []
    descartadas = 0

    for seg in segmentos:
        vid, lado = seg["id"], seg["lado_medido"]
        cols = columnas(lado)
        t0, t1 = float(seg["t_inicio_s"]), float(seg["t_fin_s"])
        filas = [f for f in por_video[vid] if t0 <= float(f["t_seg"]) <= t1]
        if len(filas) < n_ventana:
            continue
        t = np.array([float(f["t_seg"]) for f in filas])
        m = np.array([[float(f[c]) if f.get(c) else np.nan for c in cols] for f in filas],
                     dtype=np.float64)

        for i in range(0, len(filas) - n_ventana + 1, paso):
            trozo = m[i:i + n_ventana].copy()
            if np.isnan(trozo[:, PRINCIPALES]).mean() > MAX_FALTANTE:
                descartadas += 1
                continue
            # el contralateral, cuando falta, es ausencia declarada
            presente = (~np.isnan(trozo[:, CONTRALATERALES])).all(axis=1).astype(np.float32)
            trozo[:, CONTRALATERALES] = np.nan_to_num(trozo[:, CONTRALATERALES], nan=0.0)
            trozo = np.hstack([trozo, presente[:, None]])
            ini, fin = float(t[i]), float(t[i + n_ventana - 1])

            # etiqueta de calidad: la de la repeticion con mas solape
            mejor, mejor_solape = None, 0.0
            for r in reps_por_seg[seg["segmento_id"]]:
                a, b = float(r["t_inicio_s"]), float(r["t_fin_s"])
                solape = min(b, fin) - max(a, ini)
                if solape > mejor_solape:
                    mejor, mejor_solape = r, solape
            cal = (VEREDICTOS.index(mejor["veredicto"])
                   if mejor and mejor_solape > 0.5 * (fin - ini) else -1)

            X.append(rellenar(trozo).astype(np.float32))
            y_ej.append(idx_clase[seg["ejercicio"]])
            y_gr.append(grupos.index(seg["grupo"]))
            y_cal.append(cal)
            g_escena.append(seg["escena"])
            meta.append((vid, seg["segmento_id"], round(ini, 2), lado))

    X = np.stack(X)
    SALIDA.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        SALIDA / "ventanas.npz",
        X=X,
        y_ejercicio=np.array(y_ej, dtype=np.int16),
        y_grupo=np.array(y_gr, dtype=np.int8),
        y_calidad=np.array(y_cal, dtype=np.int8),
        escena=np.array(g_escena),
        video=np.array([x[0] for x in meta]),
        segmento=np.array([x[1] for x in meta]),
        t_inicio=np.array([x[2] for x in meta], dtype=np.float32),
        lado=np.array([x[3] for x in meta]),
        features=np.array(NOMBRES_FEATURES),
    )
    (SALIDA / "clases.json").write_text(json.dumps({
        "ejercicios": clases, "grupos": grupos, "calidad": VEREDICTOS,
        "features": NOMBRES_FEATURES,
        "hz": HZ, "ventana_s": VENTANA_S, "paso_s": PASO_S,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    print("X {}  ventanas de {} muestras x {} features".format(
        X.shape, n_ventana, len(NOMBRES_FEATURES)))
    print("descartadas por huecos: {}".format(descartadas))
    print("escenas distintas: {}".format(len(set(g_escena))))
    print("clases presentes: {} de {}".format(len(set(y_ej)), len(clases)))
    con = sum(1 for c in y_cal if c >= 0)
    print("con etiqueta de calidad: {} ({:.0f} %)".format(con, 100 * con / len(y_cal)))

    filas = []
    for c, i in sorted(idx_clase.items(), key=lambda kv: kv[1]):
        n = sum(1 for y in y_ej if y == i)
        filas.append({"ejercicio": c, "indice": i, "ventanas": n,
                      "escenas": len({e for e, y in zip(g_escena, y_ej) if y == i})})
    destino = SALIDA / "resumen_ventanas.csv"
    with destino.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    print("resumen ->", destino)
    return 0


if __name__ == "__main__":
    sys.exit(main())
