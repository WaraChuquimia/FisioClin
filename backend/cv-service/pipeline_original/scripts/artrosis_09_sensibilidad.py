"""Etapa 9b: sensibilidad de la etiqueta y repetibilidad de la medicion.

Dos analisis que no necesitan entrenar nada.

## Sensibilidad a los umbrales

La etiqueta de ejecucion sale de cinco constantes que yo elegi. Si mover
una un 20 % cambia el veredicto de media docena de repeticiones, la
etiqueta es robusta; si cambia el de la mitad, las conclusiones dependen de
un numero arbitrario y hay que decirlo.

Se reevalua llamando a `artrosis_06_calidad.evaluar` con los umbrales
movidos, o sea **por el mismo camino de codigo** que produjo la etiqueta
original.

## Repetibilidad de la medicion

Sin goniometro no se puede medir el error absoluto de los angulos. Lo que
si se puede medir es la **repetibilidad**: cuanto varia el ROM entre
repeticiones del mismo ejercicio, y cuanto de esa variacion es entre tomas
distintas en vez de dentro de la misma toma.

Si la dispersion entre escenas es mucho mayor que dentro de una escena, la
medicion depende del plano de camara mas que del movimiento, y eso limita
lo que se puede afirmar.

    python artrosis_09_sensibilidad.py
"""
from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

import artrosis_06_calidad as C

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
SALIDA = RAIZ / "07_modelo"

VARIACION = 0.20   # se mueve cada umbral un 20 % arriba y abajo


def sensibilidad(reps, ficha):
    base = C.evaluar(reps, ficha)
    veredicto_base = [r["veredicto"] for r in base]
    filas = []
    for nombre, valor in C.UMBRALES.items():
        for signo, etiqueta in ((1 - VARIACION, "-20 %"), (1 + VARIACION, "+20 %")):
            nuevo = C.evaluar(reps, ficha, {nombre: valor * signo})
            cambian = sum(1 for a, b in zip(veredicto_base, nuevo)
                          if a != b["veredicto"])
            filas.append({
                "umbral": nombre, "valor_base": valor,
                "variacion": etiqueta, "valor_nuevo": round(valor * signo, 3),
                "veredictos_cambiados": cambian,
                "pct_cambiado": round(100 * cambian / len(base), 1),
            })
            print("  {:24} {} -> {:>6}: {:3} de {} veredictos ({:.1f} %)".format(
                nombre, etiqueta, round(valor * signo, 3), cambian, len(base),
                100 * cambian / len(base)))
    return filas


def repetibilidad(reps):
    """Dispersion del ROM dentro de una escena frente a entre escenas."""
    por_clase = defaultdict(lambda: defaultdict(list))
    for r in reps:
        v = r.get("rom_grados")
        if v:
            por_clase[r["ejercicio"]][r["escena"]].append(float(v))

    filas = []
    for clase, escenas in sorted(por_clase.items()):
        todos = [v for vs in escenas.values() for v in vs]
        if len(todos) < 3:
            continue
        # dispersion dentro de cada escena, y de las medias entre escenas
        dentro = [np.std(v, ddof=1) for v in escenas.values() if len(v) > 1]
        medias = [np.mean(v) for v in escenas.values() if len(v) > 1]
        cv_total = float(np.std(todos, ddof=1) / max(np.mean(todos), 1e-9))
        filas.append({
            "ejercicio": clase, "repeticiones": len(todos),
            "escenas": len(escenas),
            "rom_medio": round(float(np.mean(todos)), 1),
            "cv_total": round(cv_total, 3),
            "desv_dentro_de_escena": round(float(np.mean(dentro)), 1) if dentro else "",
            "desv_entre_escenas": round(float(np.std(medias, ddof=1)), 1)
            if len(medias) > 1 else "",
        })
    return filas


def main() -> int:
    reps = list(csv.DictReader((RAIZ / "05_repeticiones/repeticiones.csv")
                               .open(encoding="utf-8")))
    ficha = {f["id"]: f for f in csv.DictReader(
        (RAIZ / "referencia/ficha_normalizada.csv").open(encoding="utf-8"))}

    print("SENSIBILIDAD A LOS UMBRALES (variacion del {:.0%})".format(VARIACION))
    filas_s = sensibilidad(reps, ficha)

    print("\nREPETIBILIDAD DEL ROM")
    filas_r = repetibilidad(reps)
    for f in filas_r:
        print("  {:34} {:>3} reps en {:>2} escenas  ROM {:>5}  CV {:.2f}  "
              "dentro {:>4}  entre {:>4}".format(
                  f["ejercicio"][:34], f["repeticiones"], f["escenas"],
                  f["rom_medio"], f["cv_total"],
                  f["desv_dentro_de_escena"], f["desv_entre_escenas"]))

    SALIDA.mkdir(parents=True, exist_ok=True)
    for destino, filas in ((SALIDA / "sensibilidad_umbrales.csv", filas_s),
                           (SALIDA / "repetibilidad_rom.csv", filas_r)):
        with destino.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
            w.writeheader()
            w.writerows(filas)
        print("\n{} filas -> {}".format(len(filas), destino))

    peor = max(filas_s, key=lambda f: f["pct_cambiado"])
    print("\nUmbral mas influyente: {} ({}) cambia el {:.1f} % de los veredictos".format(
        peor["umbral"], peor["variacion"], peor["pct_cambiado"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
