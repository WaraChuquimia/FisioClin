"""Genera la plantilla de la ficha clinica de los 20 ejercicios.

La ficha es la unica entrada del dataset escrita a mano. Tiene dos mitades
y la separacion es deliberada:

  * las columnas MEDIDAS vienen del pipeline y llegan ya rellenas. Son
    evidencia: lo que la camara vio.
  * las columnas CLINICAS llegan vacias y las completa el fisioterapeuta.
    Son criterio: lo que ninguna medicion puede deducir.

Mezclar las dos mitades es como se cuelan valores inventados en un
dataset clinico. Por eso van separadas y con un prefijo distinto.

    python artrosis_ficha_plantilla.py            # crea la plantilla
    python artrosis_ficha_plantilla.py --forzar   # la regenera y PISA lo escrito
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
SALIDA = RAIZ / "referencia/ficha_clinica.csv"

# Lo que ya sabemos por medicion. No lo toca el fisioterapeuta: si algo de
# esto esta mal, se corrige el pipeline, no la ficha.
MEDIDAS = ["id", "grupo", "titulo_en_archivo", "duracion_s", "n_escenas",
           "vista_medida", "postura_medida", "pct_cuerpo_completo", "visibilidad_mediana"]

# Lo que solo puede decir un clinico. Vacio a proposito.
CLINICAS = [
    "ejercicio",                  # nombre clinico normalizado, sin erratas
    "articulacion_objetivo",      # cadera / rodilla / tobillo
    "articulaciones_secundarias",
    "postura_declarada",          # supino, decubito lateral, cuadrupedia, bipedestacion...
    "plano_movimiento",           # sagital / frontal / transversal
    "alineado_con_camara",        # si / parcial / no  -> decide si el angulo es goniometrico
    "tipo",                       # dinamico / sostenido
    "lado_trabajado",             # derecho / izquierdo / alterno / bilateral
    "angulo_a_medir",             # que terna articular describe el movimiento
    "criterio_ejecucion_correcta",
    "errores_esperables",
    "compensaciones_a_vigilar",
    "rom_esperado_min_grados",
    "rom_esperado_max_grados",
    "tolerancia_rom_grados",
    "tempo_esperado",
    "observaciones_clinicas",
    "validado_por",
    "fecha_validacion",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--forzar", action="store_true")
    args = ap.parse_args()

    if SALIDA.exists() and not args.forzar:
        print("Ya existe {}.".format(SALIDA))
        print("No se pisa: puede tener trabajo del fisioterapeuta. Usar --forzar para regenerar.")
        return 1

    indice = {r["id"]: r for r in csv.DictReader(
        (RAIZ / "00_indice/videos.csv").open(encoding="utf-8"))}
    contenido = {r["id"]: r for r in csv.DictReader(
        (RAIZ / "01_contenido/contenido.csv").open(encoding="utf-8"))}

    import numpy as np
    vis = {}
    for r in csv.DictReader((RAIZ / "01_contenido/frames_muestreados.csv").open(encoding="utf-8")):
        if r["vis_nucleo_min"]:
            vis.setdefault(r["id"], []).append(float(r["vis_nucleo_min"]))

    filas = []
    for vid in sorted(indice):
        c = contenido.get(vid, {})
        fila = {
            "id": vid,
            "grupo": indice[vid]["grupo"],
            "titulo_en_archivo": indice[vid]["titulo_crudo"],
            "duracion_s": indice[vid]["duracion_s"],
            "n_escenas": c.get("n_escenas", ""),
            "vista_medida": c.get("vista_dominante", ""),
            "postura_medida": c.get("postura_dominante", ""),
            "pct_cuerpo_completo": c.get("pct_cuerpo_completo", ""),
            "visibilidad_mediana": round(float(np.median(vis[vid])), 2) if vid in vis else "",
        }
        fila.update({k: "" for k in CLINICAS})
        filas.append(fila)

    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    with SALIDA.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=MEDIDAS + CLINICAS)
        w.writeheader()
        w.writerows(filas)
    print("{} ejercicios -> {}".format(len(filas), SALIDA))
    print("{} columnas medidas (rellenas) + {} clinicas (vacias)".format(
        len(MEDIDAS), len(CLINICAS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
