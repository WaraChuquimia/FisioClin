"""Etapa 6: etiqueta de ejecucion por reglas.

Toma cada repeticion del dataset maestro y le adjunta indicadores
independientes y un veredicto. Un indicador por criterio, no una etiqueta
unica: una repeticion puede tener el tempo mal Y compensar con el tronco a
la vez, y decir solo "incorrecta" no le sirve ni al paciente ni al medico,
que necesitan saber **en que**.

## De donde sale cada criterio, que es lo que decide cuanto vale

| Indicador | Referencia | Circular? |
|---|---|---|
| `tempo_dejado_caer` | biomecanica: la vuelta no puede durar mucho menos que la ida | no |
| `tempo_brusco` | idem, al reves | no |
| `duracion_fuera_de_tempo` | `tempo_esperado` de la ficha clinica | **no** |
| `compensacion_tronco` | la mediana del propio ejercicio | **SI** |
| `asimetria` | comparacion entre los dos lados de la misma repeticion | no |

Las tres primeras y la quinta se sostienen solas. **La cuarta es
circular**: no hay un umbral clinico de cuanto puede moverse el tronco, asi
que se compara cada repeticion con la mediana de su propia clase. Acertarla
mide coherencia del sistema consigo mismo, no acuerdo con un
fisioterapeuta. Va marcada como tal y se puede desactivar.

## Por que el ROM no entra en el veredicto

`rom_esperado` de la ficha es un arco medido desde la posicion neutra;
`rom_grados` es el recorrido del ciclo detectado. Solo coinciden cuando el
ejercicio arranca en neutro. Aplicado tal cual, el criterio marcaba 147 de
157 repeticiones como rango insuficiente — es decir, casi todas las
demostraciones de un fisioterapeuta. Cuando una regla dice eso, la regla
esta mal.

El ROM se calcula y se guarda (`pct_arco_esperado`), pero **como columna
descriptiva**. Convertirlo en criterio pide que el fisioterapeuta aclare,
por ejercicio, si el `0-30` significa el arco recorrido o los limites
absolutos del movimiento.

    python artrosis_06_calidad.py
"""
from __future__ import annotations

import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

AQUI = Path(__file__).parent
RAIZ = AQUI / "dataset_artrosis"
REPS = RAIZ / "05_repeticiones/repeticiones.csv"
FICHA = RAIZ / "referencia/ficha_normalizada.csv"
SALIDA = RAIZ / "05_repeticiones/calidad.csv"
RESUMEN = RAIZ / "05_repeticiones/resumen_calidad.csv"

# --- umbrales -------------------------------------------------------------
RAZON_DEJADO_CAER = 1.5    # la ida dura 1,5 veces mas que la vuelta
RAZON_BRUSCO = 0.55        # o al reves
DESVIO_TEMPO = 0.5         # fraccion de desvio sobre la duracion prescrita
FACTOR_TRONCO = 2.0        # veces la mediana del ejercicio -- CIRCULAR
ASIMETRIA_MAX = 0.5        # diferencia relativa de ROM entre lados

INDICADORES = ["tempo_dejado_caer", "tempo_brusco", "duracion_fuera_de_tempo",
               "compensacion_tronco", "asimetria"]


def duracion_prescrita(tempo: str):
    """Segundos que deberia durar la repeticion, segun `tempo_esperado`.

    Acepta las dos formas que uso la ficha: `3-1-3` (ida-retencion-vuelta)
    y `30s hold`.
    """
    if not tempo:
        return None
    t = tempo.strip().lower()
    m = re.fullmatch(r"(\d+)\s*-\s*(\d+)\s*-\s*(\d+)", t)
    if m:
        return sum(int(x) for x in m.groups())
    m = re.search(r"(\d+)\s*s", t)
    return float(m.group(1)) if m else None


def num(fila, col):
    v = fila.get(col, "")
    return float(v) if v not in ("", None) else None


UMBRALES = {
    "RAZON_DEJADO_CAER": RAZON_DEJADO_CAER,
    "RAZON_BRUSCO": RAZON_BRUSCO,
    "DESVIO_TEMPO": DESVIO_TEMPO,
    "FACTOR_TRONCO": FACTOR_TRONCO,
    "ASIMETRIA_MAX": ASIMETRIA_MAX,
}


def evaluar(reps, ficha, umbrales=None):
    """Aplica los indicadores y el veredicto a cada repeticion.

    Esta separado de `main` para que el analisis de sensibilidad pueda
    reevaluar con otros umbrales **por el mismo camino de codigo**, y no
    con una reimplementacion que podria divergir.
    """
    u = dict(UMBRALES, **(umbrales or {}))

    tronco_por_ejercicio = defaultdict(list)
    for r in reps:
        v = num(r, "rom_tronco_grados")
        if v is not None:
            tronco_por_ejercicio[r["ejercicio"]].append(v)
    mediana_tronco = {k: float(np.median(v)) for k, v in tronco_por_ejercicio.items()}

    salida = []
    for r in reps:
        f = ficha[r["id"]]
        ind = {k: 0 for k in INDICADORES}
        motivos = []

        razon = num(r, "razon_ida_vuelta")
        if razon is not None:
            if razon > u["RAZON_DEJADO_CAER"]:
                ind["tempo_dejado_caer"] = 1
                motivos.append("vuelta sin control ({:.1f}x)".format(razon))
            elif razon < u["RAZON_BRUSCO"]:
                ind["tempo_brusco"] = 1
                motivos.append("ida brusca ({:.2f}x)".format(razon))

        prescrita = duracion_prescrita(f["tempo_esperado"])
        dur = num(r, "duracion_s")
        if prescrita and dur and abs(dur - prescrita) / prescrita > u["DESVIO_TEMPO"]:
            ind["duracion_fuera_de_tempo"] = 1
            motivos.append("dura {:.1f}s frente a {:.0f}s prescritos".format(dur, prescrita))

        tronco = num(r, "rom_tronco_grados")
        ref = mediana_tronco.get(r["ejercicio"])
        if tronco is not None and ref and tronco > u["FACTOR_TRONCO"] * ref:
            ind["compensacion_tronco"] = 1
            motivos.append("tronco {:.0f} grados sobre una mediana de {:.0f}".format(
                tronco, ref))

        asim = num(r, "asimetria_rom")
        # La asimetria solo es un error donde las dos piernas trabajan a la
        # vez. En un ejercicio alterno, que una pierna recorra mas que la
        # otra dentro de la misma repeticion es lo esperado.
        if (asim is not None and f["bilateral_medido"] == "1"
                and asim > u["ASIMETRIA_MAX"]):
            ind["asimetria"] = 1
            motivos.append("asimetria {:.0%} entre lados".format(asim))

        no_representativa = (f["movimiento"] == "rotacion"
                             or r["alineado_con_camara"] == "no")
        motivo_medicion = ("rotacion: con una sola camara se mide su sombra"
                           if f["movimiento"] == "rotacion" else
                           "movimiento fuera del plano de la camara"
                           if r["alineado_con_camara"] == "no" else "")

        n = sum(ind.values())
        veredicto = ("DUDOSA" if no_representativa else
                     "CORRECTA" if n == 0 else
                     "DUDOSA" if n == 1 else "INCORRECTA")

        esp_max = num(f, "rom_esperado_max_grados")
        esp_min = num(f, "rom_esperado_min_grados")
        arco = (esp_max - esp_min) if (esp_max is not None and esp_min is not None) else None
        rom = num(r, "rom_grados")

        salida.append({
            **r, **ind,
            "n_indicadores": n,
            "medicion_no_representativa": int(no_representativa),
            "motivo_medicion": motivo_medicion,
            "arco_esperado_grados": round(arco, 1) if arco else "",
            "pct_arco_esperado": round(100 * rom / arco, 0)
            if (arco and rom is not None) else "",
            "motivos": "; ".join(motivos),
            "veredicto": veredicto,
        })
    return salida


def main() -> int:
    reps = list(csv.DictReader(REPS.open(encoding="utf-8")))
    ficha = {f["id"]: f for f in csv.DictReader(FICHA.open(encoding="utf-8"))}
    salida = evaluar(reps, ficha)

    with SALIDA.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(salida[0].keys()))
        w.writeheader()
        w.writerows(salida)
    print("{} filas -> {}".format(len(salida), SALIDA))

    # --- resumen por ejercicio ---------------------------------------
    por = defaultdict(list)
    for x in salida:
        por[(x["id"], x["ejercicio"])].append(x)
    filas = []
    for (vid, ej), xs in sorted(por.items()):
        cuenta = defaultdict(int)
        for x in xs:
            cuenta[x["veredicto"]] += 1
        peor = max(INDICADORES, key=lambda k: sum(x[k] for x in xs))
        filas.append({
            "id": vid, "ejercicio": ej, "unidades": len(xs),
            "correcta": cuenta["CORRECTA"], "dudosa": cuenta["DUDOSA"],
            "incorrecta": cuenta["INCORRECTA"],
            "pct_correcta": round(100 * cuenta["CORRECTA"] / len(xs), 1),
            "indicador_mas_frecuente": peor if sum(x[peor] for x in xs) else "",
            "veces": sum(x[peor] for x in xs),
        })
    with RESUMEN.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    print("{} filas -> {}".format(len(filas), RESUMEN))

    total = defaultdict(int)
    for x in salida:
        total[x["veredicto"]] += 1
    print("\nVeredicto:", dict(total))
    print("Indicadores:", {k: sum(x[k] for x in salida) for k in INDICADORES})
    return 0


if __name__ == "__main__":
    sys.exit(main())
