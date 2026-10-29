"""Etapa 4: normaliza la ficha clinica y deja registro de cada correccion.

La ficha que llena el fisioterapeuta **no se modifica nunca**. Esta etapa
produce una version derivada, apta para que la consuma el pipeline, y un
registro de todo lo que se cambio y por que.

Se corrige solo lo objetivamente verificable:

  * **Definicion anatomica.** Una abduccion ocurre en el plano frontal. No
    es una opinion clinica, es la definicion del movimiento.
  * **Evidencia del video.** Si la ficha declara una postura y la camara
    midio el tronco en otra orientacion, manda la camara: describe el
    material que efectivamente se va a procesar.
  * **Medicion directa.** `alineado_con_camara` se estima comparando el
    angulo metrico con su proyeccion en la imagen. Es una magnitud medida.

NO se toca nada que sea juicio clinico: criterio de ejecucion, errores
esperables, compensaciones, rangos de ROM, tolerancias ni tempo.

Se anaden dos columnas que la ficha no tenia y el pipeline necesita:

  * `articulacion_medida` -- la articulacion cuyo angulo describe el
    movimiento, que no siempre es la articulacion objetivo. En el
    estiramiento del recto anterior el objetivo clinico es la cadera pero
    lo que se mueve y se mide es la rodilla. Las dos cosas son ciertas y
    hacen falta las dos.
  * `lado_dominante_medido` -- de que lado hay señal, medido.

    python artrosis_04_ficha.py
"""
from __future__ import annotations

import csv
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import numpy as np

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
FICHA = RAIZ / "referencia/ficha_clinica.csv"
ANGULOS = RAIZ / "03_angulos/frames_maestro.csv"
SALIDA = RAIZ / "referencia/ficha_normalizada.csv"
REGISTRO = RAIZ / "referencia/correcciones.csv"

PLANO_DEL_MOVIMIENTO = {
    "flexion": "sagital", "extension": "sagital",
    "abduccion": "frontal", "aduccion": "frontal",
    "rotacion": "transversal",
}
SINONIMO_TIPO = {"estatico": "sostenido", "isometrico": "sostenido"}
SINONIMO_POSTURA = {
    "decubito supino": "supino", "decubito prono": "prono",
    "decubito lateral": "decubito_lateral", "sentado": "sedente",
    "de pie": "bipedestacion",
}
# que orientacion de tronco implica cada postura
TRONCO_DE_POSTURA = {"supino": "horizontal", "prono": "horizontal",
                     "decubito_lateral": "horizontal", "cuadrupedia": "horizontal",
                     "sedente": "inclinada", "semisentado": "inclinada",
                     "bipedestacion": "vertical"}
# y la vuelta, para proponer una postura cuando la declarada no encaja
POSTURA_DE_TRONCO = {"vertical": "bipedestacion", "inclinada": "semisentado"}

# Posturas verificadas mirando un fotograma de la escena mas larga del
# video. Se listan aqui, con su evidencia, porque la geometria sola no
# distingue entre supino, prono, decubito lateral y cuadrupedia: las
# cuatro dan un tronco horizontal.
POSTURA_VERIFICADA = {
    "C05": ("supino", "t=111,5 s: tumbado boca arriba con las piernas sobre un cojin"),
    "R01": ("supino", "t=21,8 s: tumbada boca arriba, puente de gluteos"),
}

# alineado_con_camara a partir de la desalineacion medida, en grados
UMBRAL_ALINEADO = 12.0
UMBRAL_DESALINEADO = 20.0

# Un ejercicio es bilateral si las dos piernas recorren su angulo A LA VEZ.
# Se mide con la correlacion temporal entre los dos lados. Es objetivo y
# distingue el puente (+0,76) del estiramiento del recto anterior (-0,97),
# donde una pierna trabaja mientras la otra descansa.
SINCRONIA_BILATERAL = 0.6


def limpiar(t: str) -> str:
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    return " ".join(t.lower().split())


def a_clave(t: str) -> str:
    return limpiar(t).replace(" ", "_").replace("-", "_")


def medidas_por_video() -> dict:
    """Desalineacion, recorrido y sincronia entre lados, desde los angulos."""
    des = defaultdict(lambda: defaultdict(list))
    rom = defaultdict(lambda: defaultdict(list))
    pares = defaultdict(lambda: defaultdict(list))
    with ANGULOS.open(encoding="utf-8") as fh:
        for f in csv.DictReader(fh):
            for art in ("cadera", "rodilla"):
                for pref in ("flex_{}_{{}}".format(art), "abd_cadera_{}"):
                    if "abd" in pref and art != "cadera":
                        continue
                    u, v = f.get(pref.format("der"), ""), f.get(pref.format("izq"), "")
                    if u and v:
                        pares[f["id"]][pref].append((float(u), float(v)))
            for art in ("cadera", "rodilla", "tobillo"):
                for lado in ("der", "izq"):
                    v = f.get("flex_{}_{}".format(art, lado), "")
                    if v:
                        rom[f["id"]][(art, lado)].append(float(v))
                    d = f.get("desalin_{}_{}".format(art, lado), "")
                    if d:
                        des[f["id"]][art].append(float(d))
    salida = {}
    for vid in set(des) | set(rom) | set(pares):
        recorridos = {}
        for clave, vals in rom[vid].items():
            if len(vals) > 20:
                recorridos[clave] = float(np.percentile(vals, 95) - np.percentile(vals, 5))
        sincronias = {}
        for pref, vals in pares[vid].items():
            if len(vals) >= 30:
                a, b = zip(*vals)
                if np.std(a) > 1e-6 and np.std(b) > 1e-6:
                    sincronias[pref] = float(np.corrcoef(a, b)[0, 1])
        salida[vid] = {
            "desalin": {a: float(np.median(v)) for a, v in des[vid].items() if v},
            "rom": recorridos,
            "sincronia": sincronias,
        }
    return salida


def main() -> int:
    filas = list(csv.DictReader(FICHA.open(encoding="utf-8-sig")))
    medido = medidas_por_video()
    salida, correcciones = [], []

    def anotar(vid, columna, viejo, nuevo, motivo, evidencia):
        correcciones.append({"id": vid, "columna": columna, "valor_original": viejo,
                             "valor_corregido": nuevo, "motivo": motivo,
                             "evidencia": evidencia})

    for f in filas:
        vid = f["id"]
        m = medido.get(vid, {"desalin": {}, "rom": {}, "sincronia": {}})

        # --- movimiento y articulacion que se mide de verdad --------------
        texto = limpiar(f["angulo_a_medir"])
        movimientos = [k for k in PLANO_DEL_MOVIMIENTO if k in texto]
        movimiento = movimientos[0] if movimientos else ""
        art_objetivo = limpiar(f["articulacion_objetivo"])
        art_medida = next((a for a in ("rodilla", "cadera", "tobillo") if a in texto),
                          art_objetivo)
        if art_medida != art_objetivo:
            anotar(vid, "articulacion_medida", art_objetivo, art_medida,
                   "el angulo declarado describe otra articulacion",
                   "angulo_a_medir = " + f["angulo_a_medir"])

        # --- plano: definicion anatomica ---------------------------------
        plano = limpiar(f["plano_movimiento"])
        esperado = PLANO_DEL_MOVIMIENTO.get(movimiento, "")
        if esperado and plano != esperado:
            anotar(vid, "plano_movimiento", f["plano_movimiento"], esperado,
                   "definicion anatomica del movimiento",
                   "una {} ocurre en el plano {}".format(movimiento, esperado))
            plano = esperado

        # --- alineado_con_camara: medicion directa -----------------------
        d = m["desalin"].get(art_medida)
        alineado = limpiar(f["alineado_con_camara"])
        if d is not None:
            nuevo = ("si" if d < UMBRAL_ALINEADO
                     else "no" if d > UMBRAL_DESALINEADO else "parcial")
            if nuevo != alineado:
                anotar(vid, "alineado_con_camara", f["alineado_con_camara"], nuevo,
                       "desalineacion medida entre el angulo metrico y el proyectado",
                       "{:.1f} grados".format(d))
                alineado = nuevo

        # --- postura: evidencia del video --------------------------------
        postura = SINONIMO_POSTURA.get(limpiar(f["postura_declarada"]),
                                       a_clave(f["postura_declarada"]))
        tronco = limpiar(f["postura_medida"])
        if vid in POSTURA_VERIFICADA:
            propuesta, prueba = POSTURA_VERIFICADA[vid]
            if propuesta != postura:
                anotar(vid, "postura_declarada", f["postura_declarada"], propuesta,
                       "verificado mirando un fotograma del video", prueba)
                postura = propuesta
        if (vid not in POSTURA_VERIFICADA
                and tronco and TRONCO_DE_POSTURA.get(postura) not in (None, tronco)):
            propuesta = POSTURA_DE_TRONCO.get(tronco)
            if propuesta:
                anotar(vid, "postura_declarada", f["postura_declarada"], propuesta,
                       "el video muestra otra postura",
                       "tronco medido {}".format(tronco))
                postura = propuesta
            else:
                anotar(vid, "postura_declarada", f["postura_declarada"],
                       f["postura_declarada"],
                       "SIN CORREGIR: el video muestra tronco {} pero no se puede "
                       "deducir cual de las posturas horizontales es".format(tronco),
                       "tronco medido {}".format(tronco))

        # --- tipo --------------------------------------------------------
        tipo = limpiar(f["tipo"])
        if tipo in SINONIMO_TIPO:
            anotar(vid, "tipo", f["tipo"], SINONIMO_TIPO[tipo],
                   "sinonimo normalizado al vocabulario del dataset", "")
            tipo = SINONIMO_TIPO[tipo]

        # --- lado con señal, medido --------------------------------------
        roms = {lado: m["rom"].get((art_medida, lado)) for lado in ("der", "izq")}
        con_dato = {k: v for k, v in roms.items() if v is not None}
        if len(con_dato) == 2:
            mayor, menor = sorted(con_dato, key=lambda k: -con_dato[k])
            dominante = mayor if con_dato[mayor] > 1.5 * con_dato[menor] else "ambos"
        elif con_dato:
            dominante = next(iter(con_dato))
        else:
            dominante = ""

        # --- bilateral o alterno: medido, no declarado -------------------
        clave = ("abd_cadera_{}" if movimiento == "abduccion"
                 else "flex_{}_{{}}".format(art_medida))
        sincronia = m.get("sincronia", {}).get(clave)
        lado = limpiar(f["lado_trabajado"])
        if sincronia is not None:
            bilateral = sincronia >= SINCRONIA_BILATERAL
            if lado == "bilateral" and not bilateral:
                anotar(vid, "lado_trabajado", f["lado_trabajado"], "alterno",
                       "los dos lados no recorren su angulo a la vez",
                       "correlacion entre lados {:+.2f}".format(sincronia))
                lado = "alterno"
        else:
            bilateral = lado == "bilateral"

        salida.append({
            "id": vid, "grupo": f["grupo"],
            "ejercicio": a_clave(f["ejercicio"]),
            "articulacion_objetivo": art_objetivo,
            "articulacion_medida": art_medida,
            "movimiento": movimiento,
            "plano_movimiento": plano,
            "alineado_con_camara": alineado,
            "desalineacion_grados": round(d, 1) if d is not None else "",
            "tipo": tipo,
            "postura": postura,
            "lado_trabajado": lado,
            "bilateral_medido": int(bilateral),
            "sincronia_lados": round(sincronia, 2) if sincronia is not None else "",
            "lado_dominante_medido": dominante,
            "rom_der_medido": round(roms["der"], 1) if roms["der"] else "",
            "rom_izq_medido": round(roms["izq"], 1) if roms["izq"] else "",
            "rom_esperado_min_grados": f["rom_esperado_min_grados"],
            "rom_esperado_max_grados": f["rom_esperado_max_grados"],
            "tolerancia_rom_grados": f["tolerancia_rom_grados"],
            "tempo_esperado": f["tempo_esperado"],
            "criterio_ejecucion_correcta": f["criterio_ejecucion_correcta"],
            "errores_esperables": f["errores_esperables"],
            "compensaciones_a_vigilar": f["compensaciones_a_vigilar"],
            "validado_por": f["validado_por"],
            "fecha_validacion": f["fecha_validacion"],
        })

    for destino, datos in ((SALIDA, salida), (REGISTRO, correcciones)):
        if not datos:
            continue
        with destino.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(datos[0].keys()))
            w.writeheader()
            w.writerows(datos)
        print("{} filas -> {}".format(len(datos), destino))

    print("\nCorrecciones por columna:")
    cuenta = defaultdict(int)
    for c in correcciones:
        cuenta[c["columna"]] += 1
    for col, n in sorted(cuenta.items(), key=lambda kv: -kv[1]):
        print("  {:24} {}".format(col, n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
