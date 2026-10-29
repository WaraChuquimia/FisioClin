"""Validacion de la ficha clinica contra el vocabulario y contra lo medido.

La ficha es la unica entrada escrita a mano del dataset, y todo lo que
viene despues depende de ella: que angulo se mide, si ese angulo es
goniometrico, si el ejercicio tiene repeticiones o retenciones. Un error
aqui se propaga en silencio hasta el informe final.

Tres familias de comprobacion:

  1. VOCABULARIO   -- que los valores esten entre los permitidos
  2. COHERENCIA    -- que la ficha no se contradiga consigo misma
                      (un movimiento de abduccion no ocurre en el plano
                      sagital)
  3. CONTRASTE     -- que la ficha no contradiga lo que midio la camara
                      (una postura declarada de pie no encaja con un
                      tronco horizontal en el video)

Un aviso de contraste NO significa que el fisioterapeuta se equivoque:
puede estar describiendo el ejercicio como se hace en clinica mientras el
video muestra otra variante. Significa que ficha y material dicen cosas
distintas, y que hay que decidir cual manda antes de seguir.

    python artrosis_ficha_validar.py
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

VOCABULARIO = {
    "articulacion_objetivo": {"cadera", "rodilla", "tobillo"},
    "plano_movimiento": {"sagital", "frontal", "transversal"},
    "alineado_con_camara": {"si", "parcial", "no"},
    "tipo": {"dinamico", "sostenido"},
    "lado_trabajado": {"derecho", "izquierdo", "alterno", "bilateral"},
    "postura_declarada": {"supino", "prono", "decubito_lateral", "cuadrupedia",
                          "sedente", "bipedestacion", "semisentado"},
}

# sinonimos que se aceptan y se normalizan sin molestar a nadie
SINONIMOS = {
    "tipo": {"estatico": "sostenido", "isometrico": "sostenido"},
    "postura_declarada": {
        "decubito supino": "supino", "decubito prono": "prono",
        "decubito lateral": "decubito_lateral", "sentado": "sedente",
        "de pie": "bipedestacion", "semisentado": "semisentado",
    },
}

# que plano corresponde a cada movimiento, por definicion anatomica
PLANO_DEL_MOVIMIENTO = {
    "flexion": "sagital", "extension": "sagital",
    "abduccion": "frontal", "aduccion": "frontal",
    "rotacion": "transversal",
}

# que inclinacion de tronco cabe esperar de cada postura
POSTURA_ESPERADA = {
    "supino": "horizontal", "prono": "horizontal",
    "decubito_lateral": "horizontal", "cuadrupedia": "horizontal",
    "sedente": "inclinada", "semisentado": "inclinada",
    "bipedestacion": "vertical",
}


def limpiar(t: str) -> str:
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    return " ".join(t.lower().split())


def normalizar(columna: str, valor: str) -> str:
    v = limpiar(valor)
    return SINONIMOS.get(columna, {}).get(v, v)


def desalineacion_medida() -> dict:
    """Mediana de |angulo metrico - angulo proyectado| por video."""
    por = defaultdict(lambda: defaultdict(list))
    with ANGULOS.open(encoding="utf-8") as fh:
        for f in csv.DictReader(fh):
            lado = f["lado_medido"]
            for art in ("cadera", "rodilla"):
                v = f.get("desalin_{}_{}".format(art, lado), "")
                if v:
                    por[f["id"]][art].append(float(v))
    return {vid: {a: float(np.median(v)) for a, v in d.items() if v}
            for vid, d in por.items()}


def main() -> int:
    filas = list(csv.DictReader(FICHA.open(encoding="utf-8-sig")))
    desalin = desalineacion_medida() if ANGULOS.exists() else {}
    avisos = defaultdict(list)

    for f in filas:
        vid = f["id"]

        # --- 1. vocabulario ---------------------------------------------
        for col, permitidos in VOCABULARIO.items():
            v = normalizar(col, f.get(col, ""))
            if not v:
                avisos["VACIO"].append("{}  {} sin llenar".format(vid, col))
            elif v not in permitidos:
                avisos["VOCABULARIO"].append(
                    "{}  {} = '{}' no esta entre {}".format(
                        vid, col, f[col], sorted(permitidos)))

        # --- 2. coherencia interna --------------------------------------
        movimiento = limpiar(f.get("angulo_a_medir", ""))
        planos = {p for clave, p in PLANO_DEL_MOVIMIENTO.items() if clave in movimiento}
        declarado = normalizar("plano_movimiento", f.get("plano_movimiento", ""))
        if planos and declarado and declarado not in planos:
            avisos["COHERENCIA"].append(
                "{}  '{}' ocurre en plano {}, pero la ficha declara {}".format(
                    vid, f["angulo_a_medir"], "/".join(sorted(planos)), declarado))

        art = normalizar("articulacion_objetivo", f.get("articulacion_objetivo", ""))
        if art and art not in movimiento and movimiento:
            avisos["COHERENCIA"].append(
                "{}  articulacion objetivo '{}' no aparece en angulo_a_medir '{}'".format(
                    vid, art, f["angulo_a_medir"]))

        # --- 3. contraste con lo medido ---------------------------------
        postura = normalizar("postura_declarada", f.get("postura_declarada", ""))
        esperada = POSTURA_ESPERADA.get(postura)
        medida = limpiar(f.get("postura_medida", ""))
        if esperada and medida and esperada != medida:
            avisos["CONTRASTE"].append(
                "{}  declara '{}' (tronco {}), la camara midio tronco {}".format(
                    vid, f["postura_declarada"], esperada, medida))

        alineado = normalizar("alineado_con_camara", f.get("alineado_con_camara", ""))
        d = desalin.get(vid, {}).get(art)
        if alineado and d is not None:
            if alineado == "no" and d < 12:
                avisos["CONTRASTE"].append(
                    "{}  declara alineado_con_camara = no, pero la desalineacion "
                    "medida es de solo {:.1f} grados".format(vid, d))
            if alineado == "si" and d > 20:
                avisos["CONTRASTE"].append(
                    "{}  declara alineado_con_camara = si, pero la desalineacion "
                    "medida es de {:.1f} grados".format(vid, d))

    orden = ["VACIO", "VOCABULARIO", "COHERENCIA", "CONTRASTE"]
    total = sum(len(avisos[k]) for k in orden)
    for clave in orden:
        if avisos[clave]:
            print("\n{} ({})".format(clave, len(avisos[clave])))
            for linea in avisos[clave]:
                print("  " + linea)
    print("\n{} filas revisadas, {} avisos.".format(len(filas), total))
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
