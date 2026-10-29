"""FisioClin — calibra `banda_observada` y `umbrales` de un ejercicio del
catálogo a partir de un video de referencia.

## Por qué existe este script

El script original que calibró los otros 17 ejercicios del catálogo
(`catalogo_*.py`, documentado en memoria de sesiones previas) no está en
este repositorio ni se encontró en el equipo — probablemente se perdió en
el reset del 22-sep-2026. Esto es una reconstrucción, no una recuperación.

- La fórmula `banda_observada -> umbrales` SÍ se recuperó EXACTA, comparando
  los 17 ejercicios que ya están calibrados (ajuste perfecto a la décima
  contra C01, C02, C04, C07, C10, R01):

      margen = 0.30 * (flex_max_p75 - flex_min_p25)
      umbrales.alto = flex_max_p75 - margen
      umbrales.bajo = flex_min_p25 + margen
      umbrales.prominencia_minima = max(10.0, 0.35 * rom_mediano)

- El paso de detectar repeticiones en el video es nuevo. La primera versión
  usaba un detector de picos propio (zig-zag) y, al validarlo contra el
  video de C01, contó 18 repeticiones donde el dataset documenta 7 — las
  oscilaciones que encontraba eran reales (se revisaron fotogramas del
  video), pero más grandes que lo que el pipeline original consideraba
  "una repetición". Un detector casero no tiene forma de replicar ese
  criterio exacto.

  Por eso esta versión, en cambio, reutiliza la MISMA máquina de estados
  que cuenta repeticiones en vivo (`evaluador_series.EvaluadorSeries`):
  exige ~0,8 s quieto para confirmar un extremo (`FRAMES_ESTABLE`) y
  descarta repeticiones de menos de 1 s o más de 15 s
  (`DURACION_REP_MIN/MAX`) — exactamente el filtro de estabilidad que le
  faltaba al detector casero. Se arranca con umbrales provisionales
  (percentiles 35/65 del ángulo crudo) solo para que la máquina tenga algo
  con qué empezar; las repeticiones que confirma con ese arranque son las
  que alimentan la fórmula de arriba para sacar los umbrales finales.

**Aun así, validar antes de confiar**: corre `--verificar` sobre el video
de un ejercicio YA calibrado y compara contra lo guardado. Si la cantidad
de repeticiones y la banda salen razonablemente parecidas, el método sirve
para los ejercicios sin calibrar. Si no, no uses el resultado para
C09/R03 sin que alguien lo revise primero.

## Uso

    python calibrar_ejercicio.py "ruta/al/video.mp4" C09
    python calibrar_ejercicio.py "ruta/al/video.mp4" C01 --verificar
    python calibrar_ejercicio.py "ruta/al/video.mp4" C09 --guardar-filas filas_c09.json
    python calibrar_ejercicio.py "ruta/al/video.mp4" C09 --cargar-filas filas_c09.json --inicio 12 --fin 95

`--guardar-filas` / `--cargar-filas` evitan repetir MediaPipe (varios
minutos por video) al ajustar `--inicio`/`--fin` o reintentar. Sin
`--verificar`, imprime el bloque listo para pegar en
`configuracion_ejercicios.json` (las DOS copias: esta carpeta y `ml/`) —
no lo escribe solo: pisar el catálogo sin que un humano revise los
números primero es justo el tipo de error que no se nota hasta una sesión
con un paciente real.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics

import cv2
import numpy as np
from scipy.signal import savgol_filter

from evaluador_series import EvaluadorSeries
from main import CATALOGO, HZ, Medidor, procesar_imagen

AQUI = os.path.dirname(os.path.abspath(__file__))

#: El dataset original se suavizó con Savitzky-Golay (mira adelante Y atrás),
#: distinto del EMA causal que usa el servicio en vivo (solo mira atrás, ver
#: `main.SUAVIZADO_ALFA`). Al calibrar offline no hay restricción de tiempo
#: real, así que conviene usar el mismo suavizado nativo del dataset: picos
#: menos agudos, banda más fiel a lo que se midió originalmente.
SAVGOL_VENTANA = 15   # ~1,5 s a 10 Hz; impar, como exige savgol_filter
SAVGOL_ORDEN = 3


def suavizar_savgol(filas: list[dict]) -> None:
    """Reemplaza `fila['angulo']` por su versión Savitzky-Golay, en los
    tramos fiables (sin cruzar huecos de 'no fiable'). Muta `filas` in-place."""
    i = 0
    n = len(filas)
    while i < n:
        if not filas[i].get("fiable") or filas[i].get("angulo") is None:
            i += 1
            continue
        j = i
        while j < n and filas[j].get("fiable") and filas[j].get("angulo") is not None:
            j += 1
        tramo = np.array([filas[k]["angulo"] for k in range(i, j)], dtype=np.float64)
        if len(tramo) >= SAVGOL_VENTANA:
            ventana = SAVGOL_VENTANA if SAVGOL_VENTANA % 2 == 1 else SAVGOL_VENTANA + 1
            suave = savgol_filter(tramo, window_length=ventana, polyorder=SAVGOL_ORDEN)
            for k, v in zip(range(i, j), suave):
                filas[k]["angulo"] = float(v)
        i = j


def trazar_filas(ruta_video: str, id_ejercicio: str) -> list[dict]:
    """Recorre el video a ~10 fps (igual que /analizar-video) y devuelve
    las filas completas (ángulo, ángulos, inclinación de tronco, lado…)
    que arma `main.procesar_imagen`, listas para alimentar EvaluadorSeries."""
    medidor = Medidor(id_ejercicio)
    cap = cv2.VideoCapture(ruta_video)
    if not cap.isOpened():
        raise SystemExit(f"No se pudo abrir el video: {ruta_video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    paso = max(1, int(round(fps / HZ)))
    filas: list[dict] = []
    i = 0
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            if i % paso == 0:
                sobre = procesar_imagen(medidor, None, bgr, i / fps)
                filas.extend(sobre["filas"])
                if total and i % (paso * 100) == 0:
                    print(f"  {i}/{total} fotogramas…", flush=True)
            i += 1
    finally:
        cap.release()
        medidor.cerrar()
    return filas


def percentil(valores: list[float], p: float) -> float:
    return float(np.percentile(np.asarray(valores, dtype=np.float64), p))


def reps_con_maquina(cfg: dict, filas: list[dict], umbrales: dict) -> list[dict]:
    """Corre la máquina de estados REAL (la que cuenta en vivo) sobre las
    filas, con estos `umbrales`, y devuelve las repeticiones que confirmó.
    `series`/`repeticiones` en 9999: no queremos que cierre la "serie" a
    medio video, solo que acumule todas las repeticiones que encuentre."""
    cfg2 = {**cfg, "umbrales": umbrales}
    ev = EvaluadorSeries(cfg2, series=9999, repeticiones=9999)
    for fila in filas:
        ev.procesar(fila)
    return ev.repeticiones


def calibrar(id_ejercicio: str, filas: list[dict]) -> dict:
    cfg = CATALOGO[id_ejercicio]
    suavizar_savgol(filas)
    angulos = [f["angulo"] for f in filas if f.get("fiable") and f.get("angulo") is not None]
    if len(angulos) < 30:
        raise SystemExit("Muy pocas muestras fiables: revisa encuadre/visibilidad en el video.")

    # Arranque: umbrales provisionales, solo para darle a la máquina de
    # estados algo con qué decidir "llegó" / "volvió". Percentiles del
    # ángulo crudo (sin filtrar por repetición todavía); si el primer
    # intento es muy ajustado y no confirma nada, se abre el percentil.
    reps: list[dict] = []
    for lo_p, hi_p in ((35, 65), (25, 75), (15, 85)):
        p_lo, p_hi = percentil(angulos, lo_p), percentil(angulos, hi_p)
        umbrales_arranque = {
            "alto": round(p_hi, 1), "bajo": round(p_lo, 1),
            "prominencia_minima": round(max(5.0, 0.3 * (p_hi - p_lo)), 1),
        }
        reps = reps_con_maquina(cfg, filas, umbrales_arranque)
        print(f"Arranque (percentiles {lo_p}/{hi_p} del ángulo crudo): "
              f"{len(reps)} repeticiones confirmadas.")
        if len(reps) >= 2:
            break
    if len(reps) < 2:
        raise SystemExit(
            f"Solo {len(reps)} repeticiones confirmadas aun abriendo el percentil de arranque — "
            f"insuficiente. Revisa el video (¿se ve el movimiento completo?) o recorta "
            f"con --inicio/--fin a la parte donde el ejercicio es más claro.")

    def banda_y_umbrales(reps: list[dict]) -> tuple[dict, dict]:
        mins = [r["flex_min_grados"] for r in reps]
        maxs = [r["flex_max_grados"] for r in reps]
        roms = [r["rom_grados"] for r in reps]
        flex_min_p25 = percentil(mins, 25)
        flex_max_p75 = percentil(maxs, 75)
        rom_mediano = statistics.median(roms)
        margen = 0.30 * (flex_max_p75 - flex_min_p25)
        banda = {
            "flex_min_p25": round(flex_min_p25, 1),
            "flex_max_p75": round(flex_max_p75, 1),
            "rom_mediano": round(rom_mediano, 1),
            "rom_p25": round(percentil(roms, 25), 1),
            "rom_p75": round(percentil(roms, 75), 1),
        }
        umbrales = {
            "alto": round(flex_max_p75 - margen, 1),
            "bajo": round(flex_min_p25 + margen, 1),
            "prominencia_minima": round(max(10.0, 0.35 * rom_mediano), 1),
        }
        return banda, umbrales

    banda, umbrales = banda_y_umbrales(reps)

    # Segunda pasada: ya con umbrales calculados (no los de arranque a
    # ciegas), para una lectura más estable. Si cambia poco, es señal de
    # que convergió; si cambia mucho, el arranque estaba lejos.
    reps2 = reps_con_maquina(cfg, filas, umbrales)
    print(f"Segunda pasada (umbrales ya calculados): {len(reps2)} repeticiones confirmadas.")
    if len(reps2) >= 2:
        banda2, umbrales2 = banda_y_umbrales(reps2)
        if abs(umbrales2["alto"] - umbrales["alto"]) > 2 or abs(umbrales2["bajo"] - umbrales["bajo"]) > 2:
            print("  (cambió más de 2° respecto a la primera pasada — usando la segunda.)")
        banda, umbrales, reps = banda2, umbrales2, reps2

    return {
        "id": id_ejercicio,
        "ejercicio": cfg.get("ejercicio"),
        "repeticiones_observadas": len(reps),
        "banda_observada": banda,
        "umbrales": umbrales,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("ejercicio", help="Id del catálogo, p. ej. C09")
    ap.add_argument("--verificar", action="store_true",
                     help="Compara contra la banda ya guardada en vez de proponer una nueva.")
    ap.add_argument("--guardar-filas", metavar="RUTA.json",
                     help="Guarda las filas medidas, para no repetir MediaPipe al ajustar parámetros.")
    ap.add_argument("--cargar-filas", metavar="RUTA.json",
                     help="Usa filas ya guardadas con --guardar-filas en vez de leer el video.")
    ap.add_argument("--inicio", type=float, default=None, metavar="SEG",
                     help="Recorta: ignora todo antes de este segundo del video.")
    ap.add_argument("--fin", type=float, default=None, metavar="SEG",
                     help="Recorta: ignora todo después de este segundo del video.")
    args = ap.parse_args()

    if args.ejercicio not in CATALOGO:
        raise SystemExit(f"Ejercicio desconocido: {args.ejercicio}")

    if args.cargar_filas:
        with open(args.cargar_filas, encoding="utf-8") as f:
            filas = json.load(f)
        print(f"{len(filas)} filas cargadas de {args.cargar_filas}.")
    else:
        print(f"Midiendo {args.video} para {args.ejercicio}…")
        filas = trazar_filas(args.video, args.ejercicio)
        print(f"{len(filas)} filas.")
        if args.guardar_filas:
            with open(args.guardar_filas, "w", encoding="utf-8") as f:
                json.dump(filas, f)
            print(f"Filas guardadas en {args.guardar_filas}.")

    if args.inicio is not None or args.fin is not None:
        ini = int((args.inicio or 0) * HZ)
        fin = int(args.fin * HZ) if args.fin is not None else len(filas)
        antes = len(filas)
        filas = filas[ini:fin]
        print(f"Recortado de {antes} a {len(filas)} filas "
              f"({args.inicio or 0:.0f}s–{args.fin if args.fin is not None else antes / HZ:.0f}s aprox.).")

    resultado = calibrar(args.ejercicio, filas)
    print(f"\n{resultado['repeticiones_observadas']} repeticiones en el resultado final.")

    if args.verificar:
        cfg = CATALOGO[args.ejercicio]
        print("\n-- Calculado ahora --")
        print(json.dumps({"banda_observada": resultado["banda_observada"],
                           "umbrales": resultado["umbrales"]}, indent=2, ensure_ascii=False))
        print("\n-- Ya guardado en configuracion_ejercicios.json --")
        print(json.dumps({"banda_observada": cfg.get("banda_observada"),
                           "umbrales": cfg.get("umbrales")}, indent=2, ensure_ascii=False))
        return

    print("\nPara pegar en configuracion_ejercicios.json (las DOS copias: "
          "backend/cv-service/ y ml/) dentro de la ficha de "
          f"\"{args.ejercicio}\":\n")
    print(json.dumps({"banda_observada": resultado["banda_observada"],
                       "umbrales": resultado["umbrales"],
                       "repeticiones_observadas": resultado["repeticiones_observadas"]},
                      indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
