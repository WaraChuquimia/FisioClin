"""FisioClin — series, repeticiones y parametros biomecanicos, en Python.

Una prescripcion como "3 series de 12 repeticiones" significa: 12
repeticiones seguidas, un descanso, y ese bloque dos veces mas. Este
modulo recibe las filas de 10 Hz que arma `main.py` y devuelve:

- cuantas repeticiones van en la serie actual y cuantas salieron bien,
- el veredicto de cada repeticion (CORRECTA / INCORRECTA) con sus
  motivos,
- el veredicto de cada serie (BIEN_HECHA / MEJORABLE / MAL_HECHA /
  INCOMPLETA),
- los parametros biomecanicos de cada repeticion y de cada serie.

La maquina de estados y las reglas de calidad son las MISMAS que
`lib/fisioclin/evaluador.ts` (mismas constantes, mismo orden). Si se
cambia una hay que cambiar la otra, o el telefono y el servidor contaran
distinto.

Lo que es nuevo aqui y no existia en el telefono es el cierre de SERIE:
- la serie se cierra sola al llegar a las repeticiones prescritas;
- tambien se cierra si el paciente se queda quieto mas de
  `DESCANSO_CIERRA_SERIE_S` con la serie a medias (se asume que se tomo
  el descanso antes de tiempo) — asi una serie de 10/12 queda como
  INCOMPLETA y no se mezcla con la siguiente;
- y la app puede cerrarla a mano con el mensaje `cerrar_serie`.

Los umbrales del veredicto de serie (`CRITERIO_SERIE`) son una propuesta
razonable, no un dato medido: se validan con el fisioterapeuta en la
etapa 3.5 (objetivo 4) junto con el resto de metricas.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Optional

# ---- constantes medidas: identicas a evaluador.ts ----------------------
FRAMES_ESTABLE = 8        # ~0,8 s quieto para confirmar la posicion inicial
FRAMES_CONFIRMA = 3       # fotogramas para confirmar un cruce de umbral
DURACION_REP_MIN = 1.0
DURACION_REP_MAX = 15.0

#: Umbrales de las reglas de calidad (artrosis_06_calidad).
RAZON_DEJADO_CAER = 1.5
RAZON_BRUSCO = 0.55
DESVIO_TEMPO = 0.5
FACTOR_TRONCO = 2.0
ASIMETRIA_MAX = 0.5
#: Por debajo de esto, el lado contrario se movio casi igual que el
#: medido: en un ejercicio alternado (un lado a la vez) eso no es "buena
#: simetria", es la senal de que el paciente mueve los dos lados juntos
#: -- el patron de OTRO ejercicio, no del prescrito.
SIMETRIA_INESPERADA_MAX = 0.3

# ---- modo "sostenido": aguantar una posicion, sin banda calibrada ------
# Hoy, solo R10. A diferencia del ciclo alto/bajo normal, estos ejercicios
# no tienen cfg["umbrales"] (el dataset no trajo repeticiones suficientes
# para medir una banda, ver "aviso" en el catalogo) y por eso usan
# constantes fijas en vez de un umbral por ejercicio. Identico a
# evaluador.ts (SOSTENIDO).
SOSTENIDO_UMBRAL_INICIO_GRADOS = 15
SOSTENIDO_UMBRAL_FIN_GRADOS = 9
#: Dentro de esto, en una ventana movil de 3 s, se considera estable
#: (mismo valor que EXCURSION_RETENCION del pipeline de calibracion
#: offline -- artrosis_05_segmentos.py).
SOSTENIDO_OSCILACION_MAXIMA_GRADOS = 8
SOSTENIDO_VENTANA_OSCILACION_S = 3.0
#: Cuanto por debajo del tiempo prescrito (tempo_esperado, p. ej.
#: "30s hold") todavia se acepta como sostenido.
SOSTENIDO_TOLERANCIA_DURACION = 0.2

# ---- nuevo: cierre y veredicto de serie --------------------------------
#: Segundos sin completar repeticion, con la serie a medias, a partir de
#: los cuales se da la serie por terminada (el paciente se puso a
#: descansar). Por encima del DURACION_REP_MAX para no cortar una
#: repeticion lenta.
DESCANSO_CIERRA_SERIE_S = 20.0

#: Veredicto de la serie a partir del % de repeticiones CORRECTAS sobre
#: las PRESCRITAS (no sobre las hechas: 6 correctas de 6 hechas en una
#: serie de 12 no es una serie bien hecha).
CRITERIO_SERIE = {
    "BIEN_HECHA": 80.0,   # >= 80 % correctas y serie completa
    "MEJORABLE": 50.0,    # >= 50 %
}

#: Caida de ROM entre el primer y el ultimo tercio de la serie a partir
#: de la cual se avisa de fatiga.
CAIDA_ROM_FATIGA = 0.20

#: Angulos que se guardan en el instante del extremo de cada repeticion.
ANGULOS_REGISTRADOS = (
    "flex_cadera", "flex_rodilla", "flex_tobillo", "abd_cadera",
)


def duracion_prescrita(tempo: Optional[str]) -> Optional[float]:
    """'3-1-3' -> 7 s, '30s hold' -> 30 s. None si no se reconoce."""
    if not tempo:
        return None
    t = tempo.strip().lower()
    m = re.match(r"^(\d+)\s*-\s*(\d+)\s*-\s*(\d+)$", t)
    if m:
        return float(sum(int(g) for g in m.groups()))
    s = re.search(r"(\d+)\s*s", t)
    return float(s.group(1)) if s else None


def _num(v) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _r(v: Optional[float], dec: int = 1) -> Optional[float]:
    return None if v is None else round(float(v), dec)


def _media(xs: list[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def _tiempos_reales(historia: list, inicio: float, extremo: float, t_fin: float):
    """Los instantes REALES de una repeticion, sobre la historia (t, angulo).

    Antes la ida se contaba desde que el paciente se quedaba quieto en la
    partida (sumaba los segundos que esperaba antes de moverse) y la vuelta
    desde que llegaba al extremo (sumaba la pausa abajo). Con eso una
    sentadilla perfecta 3-1-3 salia "No frenaste la vuelta" y una que se
    dejaba caer salia CORRECTA.

    Devuelve (sale, llega_extremo, deja_extremo, vuelve):
      sale           ultimo instante todavia en la partida antes de ir al extremo
      llega_extremo  primer instante cerca del extremo
      deja_extremo   ultimo instante cerca del extremo
      vuelve         primer instante de vuelta en la partida
    "Cerca" = dentro del 15 % del recorrido (minimo 3 grados), para que el
    ruido del detector no mueva los instantes.
    """
    margen = max(3.0, 0.15 * abs(extremo - inicio))
    cerca_ext = [t for t, a in historia if abs(a - extremo) <= margen]
    if not cerca_ext:
        return historia[0][0], t_fin, t_fin, t_fin
    llega, deja = cerca_ext[0], cerca_ext[-1]
    sale = max((t for t, a in historia if t <= llega and abs(a - inicio) <= margen),
               default=historia[0][0])
    vuelve = min((t for t, a in historia if t >= deja and abs(a - inicio) <= margen),
                 default=t_fin)
    return sale, llega, deja, vuelve


@dataclass
class _Ciclo:
    activo: bool = False
    t_inicio: float = 0.0
    t_extremo: float = 0.0
    valor_inicio: float = 0.0
    valor_extremo: float = 0.0
    troncos: list[float] = field(default_factory=list)
    contra: list[float] = field(default_factory=list)
    velocidades: list[float] = field(default_factory=list)
    #: Fila de 10 Hz en el instante del extremo: de aqui salen los angulos
    #: de cadera, rodilla y tobillo "en la posicion de trabajo".
    fila_extremo: dict = field(default_factory=dict)
    #: Minimo y maximo de CADA articulacion durante la repeticion.
    extremos: dict = field(default_factory=dict)
    #: (t, angulo) de todo el ciclo: de aqui salen los tiempos reales de
    #: ida, pausa y vuelta (ver `_tiempos_reales`).
    historia: list = field(default_factory=list)

    def acumular(self, fila: dict):
        for k, v in (fila.get("angulos") or {}).items():
            v = _num(v)
            if v is None:
                continue
            lo, hi = self.extremos.get(k, (v, v))
            self.extremos[k] = (min(lo, v), max(hi, v))


class EvaluadorSeries:
    """Un ejercicio prescrito (p. ej. 3 x 12), evaluado a 10 Hz."""

    def __init__(self, cfg: dict, series: int, repeticiones: int,
                 rom_objetivo: Optional[float] = None):
        """`series` y `repeticiones` son las de la prescripcion del medico.
        No tienen valor por defecto a proposito: una rutina inventada
        (3 x 12) daria veredictos de serie sobre algo que nadie prescribio."""
        self.es_sostenido = cfg.get("tipo") == "sostenido" and not cfg.get("umbrales")
        # Los "sostenido" sin banda (R10) no necesitan umbrales: se evaluan
        # por tiempo y estabilidad, con constantes fijas (SOSTENIDO_*).
        if not self.es_sostenido and not cfg.get("umbrales"):
            raise ValueError(
                f"{cfg.get('id')} no tiene banda de referencia medida en el dataset: "
                f"{cfg.get('aviso', '')}")
        for nombre, v in (("series", series), ("repeticiones", repeticiones)):
            if isinstance(v, bool) or not isinstance(v, int) or v < 1:
                raise ValueError(f"'{nombre}' tiene que ser un entero >= 1 (vino {v!r})")

        self.cfg = cfg
        self.series_prescritas = int(series)
        self.reps_prescritas = int(repeticiones)
        # El ROM objetivo lo fija la prescripcion; si falta, la ficha.
        self.rom_objetivo = _num(rom_objetivo) if rom_objetivo is not None \
            else _num(cfg.get("rom_esperado_max"))

        self.serie = 1
        self.reps_serie = 0
        self.repeticiones: list[dict] = []
        self.series_cerradas: list[dict] = []
        self.terminado = False

        self.frames_estables = 0
        self.frames_totales = 0
        self.frames_descartados = 0
        self.inicio: Optional[float] = None
        self.t_ultimo = 0.0
        self.t_ultima_rep: Optional[float] = None
        self.ciclo = _Ciclo()
        self.racha = 0
        self.lado = ""
        #: Extremo de partida elegido por el paciente (True = alto); None
        #: hasta la primera calibracion.
        self.inicio_alto: Optional[bool] = None
        self.candidato_alto: Optional[bool] = None

        #: Estado del modo "sostenido" (ver SOSTENIDO_* arriba). Sin
        #: relacion con self.ciclo, que es del modo normal alto/bajo.
        self.sosteniendo = False
        self.inicio_sostenido: Optional[float] = None
        self.ciclo_sostenido = _Ciclo()
        self.racha_fin_sostenido = 0

    # ------------------------------------------------------------------
    # Entrada
    # ------------------------------------------------------------------
    def procesar(self, fila: dict) -> dict:
        """Una fila de 10 Hz de `main.py` -> estado para pintar en la app.

        La fila trae `t`, `fiable`, `angulo` (articulacion medida),
        `inclinacion_tronco`, `contra`, `lado`, `motivo`, y ademas los
        angulos completos en `angulos` (cadera, rodilla, tobillo...).
        """
        t = float(fila["t"])
        if self.inicio is None:
            self.inicio = t
        self.t_ultimo = t
        self.frames_totales += 1

        serie_cerrada = self._revisar_descanso(t)

        if self.terminado:
            return self._estado("TERMINADO", "Has completado todas las series", fila,
                                serie_cerrada=serie_cerrada)

        angulo = _num(fila.get("angulo")) if fila.get("fiable") else None
        if angulo is None:
            self.frames_descartados += 1
            self._reiniciar_ciclo()
            motivo = fila.get("motivo") or ""
            fase = "DATO_NO_FIABLE" if fila.get("hay_persona") else "SIN_PERSONA"
            return self._estado(fase, motivo or "Colocate frente a la camara, de cuerpo entero",
                                fila, serie_cerrada=serie_cerrada)

        self.lado = fila.get("lado") or self.lado
        estado = self._maquina_sostenido(t, angulo, fila) if self.es_sostenido \
            else self._maquina(t, angulo, fila)
        if serie_cerrada and not estado.get("serie_cerrada"):
            estado["serie_cerrada"] = serie_cerrada
        return estado

    def cerrar_serie(self) -> Optional[dict]:
        """Cierre manual (boton 'Terminar serie' de la app)."""
        if self.terminado or self.reps_serie == 0:
            return None
        return self._cerrar_serie(motivo_cierre="manual")

    def resumen(self) -> dict:
        """El informe completo de la sesion, para guardar en Supabase."""
        # Una serie a medias al terminar la sesion tambien cuenta.
        if not self.terminado and self.reps_serie > 0:
            self._cerrar_serie(motivo_cierre="fin_de_sesion")

        reps = self.repeticiones
        roms = [r["rom_grados"] for r in reps]
        cuenta = Counter(r["veredicto"] for r in reps)
        total_prescritas = self.series_prescritas * self.reps_prescritas
        series_bien = sum(1 for s in self.series_cerradas if s["veredicto"] == "BIEN_HECHA")

        return {
            "ejercicio": self.cfg["ejercicio"],
            "id_ejercicio": self.cfg["id"],
            "articulacion": self.cfg["articulacion_medida"],
            "lado_medido": self.lado,
            "prescripcion": f"{self.series_prescritas} x {self.reps_prescritas}",
            "duracion_seg": _r((self.t_ultimo - self.inicio) if self.inicio is not None else 0.0, 1),
            "series_prescritas": self.series_prescritas,
            "repeticiones_prescritas": self.reps_prescritas,
            "series_completadas": sum(1 for s in self.series_cerradas if s["completa"]),
            "series_bien_hechas": series_bien,
            "repeticiones_detectadas": len(reps),
            "cumplimiento_pct": _r(100.0 * len(reps) / max(total_prescritas, 1), 1),
            "correctas": cuenta.get("CORRECTA", 0),
            "incorrectas": cuenta.get("INCORRECTA", 0),
            "pct_correctas": _r(100.0 * cuenta.get("CORRECTA", 0) / len(reps), 1) if reps else None,
            "rom_medio": _r(_media(roms)),
            "rom_maximo": _r(max(roms)) if roms else None,
            "rom_objetivo": self.rom_objetivo,
            "sesion_bien_hecha": series_bien == self.series_prescritas,
            "pct_frames_descartados": _r(
                100.0 * self.frames_descartados / max(self.frames_totales, 1), 1),
            "medicion_goniometrica_valida": bool(self.cfg.get("medible_goniometricamente")),
            "series": self.series_cerradas,
            "repeticiones": reps,
        }

    # ------------------------------------------------------------------
    # Maquina de estados del ciclo (igual que evaluador.ts)
    # ------------------------------------------------------------------
    def _maquina(self, t: float, angulo: float, fila: dict) -> dict:
        u = self.cfg["umbrales"]
        alto = angulo >= u["alto"]
        bajo = angulo <= u["bajo"]
        # La partida es el extremo donde el paciente se coloco quieto LA
        # PRIMERA VEZ y queda fija toda la sesion (igual que evaluador.ts).
        # El `sentido` del catalogo salio de como empezaban los videos de
        # demostracion: en la sentadilla decia "empieza agachado", y a quien
        # empezaba de pie no se le contaba la ultima repeticion.
        partida_alta = self.inicio_alto
        if partida_alta is None and (alto or bajo):
            partida_alta = alto
            if self.candidato_alto != alto:
                self.frames_estables = 0   # cambio de extremo
            self.candidato_alto = alto
        desciende = partida_alta if partida_alta is not None \
            else self.cfg.get("sentido") == "desciende"
        # Si la partida es la ALTA, el movimiento baja hacia el extremo bajo.
        en_partida = alto if desciende else bajo
        en_extremo = bajo if desciende else alto

        if not self.ciclo.activo:
            if en_partida:
                self.frames_estables += 1
                if self.frames_estables >= FRAMES_ESTABLE:
                    if self.inicio_alto is None:
                        self.inicio_alto = desciende   # queda fija
                    self.ciclo = _Ciclo(activo=True, t_inicio=t, t_extremo=t,
                                        valor_inicio=angulo, valor_extremo=angulo,
                                        fila_extremo=dict(fila))
                    self.ciclo.acumular(fila)
                    self.ciclo.historia.append((t, angulo))
                    return self._estado("LISTO", "Empieza el movimiento", fila, angulo)
                return self._estado("CALIBRANDO", "Mantente en la posicion inicial", fila, angulo)
            self.frames_estables = 0
            return self._estado("COLOCATE", "Ponte en la posicion inicial", fila, angulo)

        c = self.ciclo
        tronco = _num(fila.get("inclinacion_tronco"))
        contra = _num(fila.get("contra"))
        vel = _num(fila.get("velocidad"))
        if tronco is not None:
            c.troncos.append(tronco)
        if contra is not None:
            c.contra.append(contra)
        if vel is not None:
            c.velocidades.append(abs(vel))
        c.acumular(fila)
        c.historia.append((t, angulo))

        mejor = angulo < c.valor_extremo if desciende else angulo > c.valor_extremo
        if mejor:
            c.valor_extremo = angulo
            c.t_extremo = t
            c.fila_extremo = dict(fila)

        recorrido = abs(c.valor_extremo - c.valor_inicio)
        progreso = min(1.0, recorrido / max(u["prominencia_minima"], 1e-6))

        # Vuelta a la partida con recorrido suficiente = repeticion.
        if en_partida and recorrido >= u["prominencia_minima"]:
            self.racha += 1
            if self.racha >= FRAMES_CONFIRMA:
                self.racha = 0
                rep = self._cerrar_repeticion(t)
                if rep is not None:
                    serie_cerrada = None
                    if self.reps_serie >= self.reps_prescritas:
                        serie_cerrada = self._cerrar_serie(motivo_cierre="completa")
                    fase = "TERMINADO" if self.terminado else \
                        "DESCANSO" if serie_cerrada else "REPETICION"
                    return self._estado(fase, _texto_repeticion(rep, serie_cerrada), fila, angulo,
                                        progreso=1.0, repeticion_nueva=rep,
                                        serie_cerrada=serie_cerrada)
        else:
            self.racha = 0

        fase = "VUELTA" if en_partida else "EXTREMO" if en_extremo else "MOVIMIENTO"
        return self._estado(fase, "Controla el movimiento", fila, angulo, progreso=progreso)

    def _cerrar_repeticion(self, t: float) -> Optional[dict]:
        c = self.ciclo
        # Tiempos del MOVIMIENTO, sin la espera antes de arrancar ni la pausa
        # en el extremo (ver `_tiempos_reales`).
        sale, llega, deja, vuelve = _tiempos_reales(
            c.historia or [(c.t_inicio, c.valor_inicio)], c.valor_inicio, c.valor_extremo, t)
        duracion = vuelve - sale
        if duracion < DURACION_REP_MIN or duracion > DURACION_REP_MAX:
            self._reiniciar_ciclo()
            return None
        c.t_inicio = sale

        ida = max(llega - sale, 1e-3)
        vuelta = max(vuelve - deja, 1e-3)
        pausa = max(deja - llega, 0.0)
        rom = abs(c.valor_extremo - c.valor_inicio)
        rom_contra = (max(c.contra) - min(c.contra)) if len(c.contra) > 5 else None

        rep: dict[str, Any] = {
            "n": len(self.repeticiones) + 1,
            "serie": self.serie,
            "n_en_serie": self.reps_serie + 1,
            "t_inicio_s": _r(c.t_inicio - (self.inicio or 0.0), 2),
            "duracion_s": _r(duracion, 2),
            # --- parametros biomecanicos de la articulacion medida ---
            "flex_min_grados": _r(min(c.valor_inicio, c.valor_extremo)),
            "flex_max_grados": _r(max(c.valor_inicio, c.valor_extremo)),
            "rom_grados": _r(rom),
            "duracion_ida_s": _r(ida, 2),
            "duracion_vuelta_s": _r(vuelta, 2),
            "pausa_extremo_s": _r(pausa, 2),
            "razon_ida_vuelta": _r(ida / vuelta, 2),
            "velocidad_media_gr_s": _r(rom / duracion),
            "velocidad_pico_gr_s": _r(max(c.velocidades)) if c.velocidades else None,
            "rom_tronco_grados": _r(max(c.troncos) - min(c.troncos)) if c.troncos else None,
            "inclinacion_tronco_max": _r(max(c.troncos)) if c.troncos else None,
            "rom_contralateral_grados": _r(rom_contra),
            "asimetria_rom": _r(abs(rom - rom_contra) / max(rom, 1e-6), 2)
            if rom_contra is not None else None,
            # --- todas las articulaciones ---
            "angulos_en_extremo": _angulos_de(c.fila_extremo),
            "rango_articular": {
                k: {"min": _r(lo), "max": _r(hi), "rom": _r(hi - lo)}
                for k, (lo, hi) in sorted(c.extremos.items())
            },
        }
        rep.update(self._evaluar(rep))

        self.repeticiones.append(rep)
        self.reps_serie += 1
        self.t_ultima_rep = t
        self._reiniciar_ciclo()
        return rep

    # ------------------------------------------------------------------
    # Maquina de estados "sostenido" (aguantar una posicion, sin banda
    # calibrada -- hoy, R10). Identica a evaluador.ts. No usa
    # cfg["umbrales"] ni self.ciclo (el del modo alto/bajo): detecta que
    # se aparto del neutro, mide cuanto dura y cuanto oscila, y cierra la
    # repeticion cuando vuelve al neutro (o se pierde el dato).
    # ------------------------------------------------------------------
    def _maquina_sostenido(self, t: float, angulo: float, fila: dict) -> dict:
        if not self.sosteniendo:
            if abs(angulo) >= SOSTENIDO_UMBRAL_INICIO_GRADOS:
                self.frames_estables += 1
                if self.frames_estables >= FRAMES_ESTABLE:
                    self.sosteniendo = True
                    self.inicio_sostenido = t
                    self.ciclo_sostenido = _Ciclo(activo=True, t_inicio=t,
                                                  valor_inicio=angulo, valor_extremo=angulo,
                                                  fila_extremo=dict(fila))
                    self.ciclo_sostenido.acumular(fila)
                    self.ciclo_sostenido.historia.append((t, angulo))
                    self.racha_fin_sostenido = 0
                    return self._estado("SOSTENIENDO", "Mantén la posición", fila, angulo,
                                        progreso=0.0)
                return self._estado("CALIBRANDO", "Mantente quieto en la posicion", fila, angulo)
            self.frames_estables = 0
            return self._estado("COLOCATE", "Ponte en la posicion inicial", fila, angulo)

        c = self.ciclo_sostenido
        tronco = _num(fila.get("inclinacion_tronco"))
        contra = _num(fila.get("contra"))
        if tronco is not None:
            c.troncos.append(tronco)
        if contra is not None:
            c.contra.append(contra)
        c.acumular(fila)
        c.historia.append((t, angulo))

        # Oscilacion en la ventana movil reciente (no en todo el sostenido:
        # un temblor de hace 10 s no importa si ahora esta quieto).
        ventana = [(ti, a) for ti, a in c.historia if t - ti <= SOSTENIDO_VENTANA_OSCILACION_S]
        angulos_ventana = [a for _, a in ventana]
        oscilacion_actual = (max(angulos_ventana) - min(angulos_ventana)
                             if len(angulos_ventana) > 1 else 0.0)

        duracion = t - (self.inicio_sostenido or t)
        prescrita = duracion_prescrita(self.cfg.get("tempo_esperado"))
        progreso = min(1.0, duracion / prescrita) if prescrita else 0.0

        # Volvio al neutro (con histeresis, para no cerrar por un temblor
        # que cruza el mismo numero que abrio la repeticion).
        if abs(angulo) < SOSTENIDO_UMBRAL_FIN_GRADOS:
            self.racha_fin_sostenido += 1
            if self.racha_fin_sostenido >= FRAMES_CONFIRMA:
                self.racha_fin_sostenido = 0
                rep = self._cerrar_sostenido(t)
                if rep is not None:
                    return self._estado("REPETICION", _texto_repeticion(rep, None), fila, angulo,
                                        progreso=1.0, repeticion_nueva=rep)
                return self._estado("COLOCATE", "Ponte en la posicion inicial", fila, angulo)
        else:
            self.racha_fin_sostenido = 0

        inestable = oscilacion_actual > SOSTENIDO_OSCILACION_MAXIMA_GRADOS
        return self._estado("SOSTENIENDO",
                            "Mas quieto, estas oscilando" if inestable else "Mantén la posición",
                            fila, angulo, progreso=progreso)

    def _cerrar_sostenido(self, t: float) -> Optional[dict]:
        c = self.ciclo_sostenido
        duracion = t - (self.inicio_sostenido or t)
        if duracion < DURACION_REP_MIN:
            # Demasiado corto para ser un intento real (p. ej. un tropiezo
            # al entrar en posicion): se descarta en silencio, igual que
            # un ciclo normal que no llega a DURACION_REP_MIN.
            self._reiniciar_ciclo()
            return None

        # Los ultimos FRAMES_CONFIRMA cuadros de la historia son los que
        # confirmaron la VUELTA al neutro (ya soltando), no parte del
        # sostenido: incluirlos en el rango mediria la transicion de
        # salida como si fuera temblor, inflando flex_min/rom_grados.
        tramo = c.historia[:-FRAMES_CONFIRMA] if len(c.historia) > FRAMES_CONFIRMA else c.historia
        angulos = [a for _, a in tramo] or [a for _, a in c.historia]
        flex_min, flex_max = min(angulos), max(angulos)
        rom = flex_max - flex_min
        rom_contra = (max(c.contra) - min(c.contra)) if len(c.contra) > 5 else None

        rep: dict[str, Any] = {
            "n": len(self.repeticiones) + 1,
            "serie": self.serie,
            "n_en_serie": self.reps_serie + 1,
            "t_inicio_s": _r((self.inicio_sostenido or t) - (self.inicio or 0.0), 2),
            "duracion_s": _r(duracion, 2),
            "flex_min_grados": _r(flex_min),
            "flex_max_grados": _r(flex_max),
            "rom_grados": _r(rom),
            # Ida/vuelta no aplican a un sostenido (no hay ciclo): se
            # dejan en la duracion completa para que ningun consumidor
            # del tipo divida por cero, pero _evaluar_sostenido no las usa.
            "duracion_ida_s": _r(duracion, 2),
            "duracion_vuelta_s": _r(duracion, 2),
            "razon_ida_vuelta": 1.0,
            "velocidad_media_gr_s": _r(rom / duracion) if duracion > 0 else 0.0,
            "velocidad_pico_gr_s": _r(max(c.velocidades)) if c.velocidades else None,
            "rom_tronco_grados": _r(max(c.troncos) - min(c.troncos)) if c.troncos else None,
            "inclinacion_tronco_max": _r(max(c.troncos)) if c.troncos else None,
            "rom_contralateral_grados": _r(rom_contra),
            "asimetria_rom": _r(abs(rom - rom_contra) / max(rom, 1e-6), 2)
            if rom_contra is not None else None,
            "angulos_en_extremo": _angulos_de(c.fila_extremo),
            "rango_articular": {
                k: {"min": _r(lo), "max": _r(hi), "rom": _r(hi - lo)}
                for k, (lo, hi) in sorted(c.extremos.items())
            },
        }
        rep.update(self._evaluar_sostenido(rep))

        self.repeticiones.append(rep)
        self.reps_serie += 1
        self.t_ultima_rep = t
        self._reiniciar_ciclo()
        return rep

    def _evaluar_sostenido(self, rep: dict) -> dict:
        """Reglas de calidad del modo sostenido: tiempo y estabilidad, no
        tempo de ida/vuelta (no aplica -- no hay ciclo). Reusa la regla de
        compensacion de tronco tal cual, porque "alineacion" si es parte
        del criterio clinico de un sostenido (ver criterio_ejecucion)."""
        motivos: list[str] = []

        prescrita = duracion_prescrita(self.cfg.get("tempo_esperado"))
        duracion_insuficiente = 1 if (prescrita and
                                      rep["duracion_s"] < prescrita * (1 - SOSTENIDO_TOLERANCIA_DURACION)) else 0
        if duracion_insuficiente:
            motivos.append(f"No aguantaste el tiempo prescrito ({prescrita:g} s)")

        oscilacion_excesiva = 1 if rep["rom_grados"] > SOSTENIDO_OSCILACION_MAXIMA_GRADOS else 0
        if oscilacion_excesiva:
            motivos.append("Perdiste el equilibrio o te moviste de mas")

        ref = _num(self.cfg.get("tronco_mediano_grados"))
        comp_tronco = 1 if (ref is not None and rep["rom_tronco_grados"] is not None
                            and rep["rom_tronco_grados"] > FACTOR_TRONCO * ref) else 0
        if comp_tronco:
            motivos.append("Estas compensando con el tronco")

        pct_rom = round(100.0 * rep["rom_grados"] / self.rom_objetivo) if self.rom_objetivo else None
        n = duracion_insuficiente + oscilacion_excesiva + comp_tronco

        return {
            "tempo_dejado_caer": 0,
            "tempo_brusco": 0,
            "duracion_fuera_de_tempo": 0,
            "compensacion_tronco": comp_tronco,
            "asimetria": 0,
            "simetria_inesperada": 0,
            "duracion_insuficiente": duracion_insuficiente,
            "oscilacion_excesiva": oscilacion_excesiva,
            "n_indicadores": n,
            "motivos": motivos,
            "veredicto": "CORRECTA" if n == 0 else "INCORRECTA",
            "bien_hecha": n == 0,
            "pct_rom_objetivo": pct_rom,
            "medicion_no_representativa": 0,
        }

    # ------------------------------------------------------------------
    # Reglas de una repeticion (las de artrosis_06_calidad / evaluador.ts)
    # ------------------------------------------------------------------
    def _evaluar(self, rep: dict) -> dict:
        motivos: list[str] = []

        razon = rep["razon_ida_vuelta"]
        dejado_caer = 1 if razon > RAZON_DEJADO_CAER else 0
        brusco = 1 if razon < RAZON_BRUSCO else 0
        if dejado_caer:
            motivos.append("No frenaste la vuelta")
        if brusco:
            motivos.append("El movimiento de ida fue brusco")

        prescrita = duracion_prescrita(self.cfg.get("tempo_esperado"))
        fuera_tempo = 1 if prescrita and abs(rep["duracion_s"] - prescrita) / prescrita > DESVIO_TEMPO else 0
        if fuera_tempo:
            motivos.append(f"Ritmo distinto del prescrito ({prescrita:g} s)")

        ref = _num(self.cfg.get("tronco_mediano_grados"))
        comp_tronco = 1 if (ref is not None and rep["rom_tronco_grados"] is not None
                            and rep["rom_tronco_grados"] > FACTOR_TRONCO * ref) else 0
        if comp_tronco:
            motivos.append("Estas compensando con el tronco")

        asim = 1 if (self.cfg.get("bilateral") and rep["asimetria_rom"] is not None
                     and rep["asimetria_rom"] > ASIMETRIA_MAX) else 0
        if asim:
            motivos.append("Un lado recorre mas que el otro")

        # El inverso de la regla de arriba: en un ejercicio ALTERNADO
        # (bilateral: false) el lado contrario deberia quedarse quieto. Si
        # se movio casi tanto como el medido, el paciente esta moviendo
        # los dos lados a la vez -- el patron de otro ejercicio bilateral,
        # no del prescrito.
        simetria_inesperada = 1 if (not self.cfg.get("bilateral") and rep["asimetria_rom"] is not None
                                     and rep["asimetria_rom"] < SIMETRIA_INESPERADA_MAX) else 0
        if simetria_inesperada:
            motivos.append("Pareces estar moviendo los dos lados a la vez")

        # Descriptivo, fuera del veredicto (igual que en el telefono).
        pct_rom = round(100.0 * rep["rom_grados"] / self.rom_objetivo) if self.rom_objetivo else None

        n = dejado_caer + brusco + fuera_tempo + comp_tronco + asim + simetria_inesperada
        no_repr = not self.cfg.get("medible_goniometricamente")
        veredicto = "CORRECTA" if (not no_repr and n == 0) else "INCORRECTA"

        return {
            "tempo_dejado_caer": dejado_caer,
            "tempo_brusco": brusco,
            "duracion_fuera_de_tempo": fuera_tempo,
            "compensacion_tronco": comp_tronco,
            "asimetria": asim,
            "simetria_inesperada": simetria_inesperada,
            "n_indicadores": n,
            "motivos": motivos,
            "veredicto": veredicto,
            "bien_hecha": veredicto == "CORRECTA",
            "pct_rom_objetivo": pct_rom,
            "medicion_no_representativa": 1 if no_repr else 0,
        }

    # ------------------------------------------------------------------
    # Series
    # ------------------------------------------------------------------
    def _revisar_descanso(self, t: float) -> Optional[dict]:
        """Serie a medias + mucho rato sin repeticion = el paciente descansa.

        Nunca en la ULTIMA serie: ahi no hay "siguiente" a la que pasar, y
        cerrarla daba la sesion por terminada y dejaba de contar todo lo que
        el paciente hiciera despues de pararse a respirar. La ultima serie
        solo se cierra al completar las repeticiones o con Finalizar."""
        if self.terminado or self.reps_serie == 0 or self.t_ultima_rep is None:
            return None
        if self.serie >= self.series_prescritas:
            return None
        if t - self.t_ultima_rep < DESCANSO_CIERRA_SERIE_S:
            return None
        return self._cerrar_serie(motivo_cierre="descanso")

    def _cerrar_serie(self, motivo_cierre: str) -> dict:
        reps = [r for r in self.repeticiones if r["serie"] == self.serie]
        resumen = resumir_serie(self.serie, reps, self.reps_prescritas, motivo_cierre)
        self.series_cerradas.append(resumen)

        self.serie += 1
        self.reps_serie = 0
        self.t_ultima_rep = None
        self._reiniciar_ciclo()
        if self.serie > self.series_prescritas:
            self.terminado = True
            self.serie = self.series_prescritas
        return resumen

    # ------------------------------------------------------------------
    def _reiniciar_ciclo(self):
        self.ciclo = _Ciclo()
        self.frames_estables = 0
        self.racha = 0
        # Si se perdio el dato a mitad de un sostenido (p. ej. salio del
        # encuadre al perder el equilibrio), el intento no se cuenta: no
        # hay forma honesta de saber cuanto habria durado.
        self.sosteniendo = False
        self.inicio_sostenido = None
        self.ciclo_sostenido = _Ciclo()
        self.racha_fin_sostenido = 0

    def _estado(self, fase: str, mensaje: str, fila: dict, angulo: Optional[float] = None,
                progreso: float = 0.0, repeticion_nueva: Optional[dict] = None,
                serie_cerrada: Optional[dict] = None) -> dict:
        correctas_serie = sum(1 for r in self.repeticiones
                              if r["serie"] == self.serie and r["veredicto"] == "CORRECTA")
        return {
            "fase": fase,
            "mensaje": mensaje,
            "angulo": _r(angulo),
            "angulos": _angulos_de(fila),
            "lado": fila.get("lado") or self.lado,
            "serie": self.serie,
            "series_prescritas": self.series_prescritas,
            "repeticiones_serie": self.reps_serie,
            "repeticiones_prescritas": self.reps_prescritas,
            "correctas_serie": correctas_serie,
            "repeticiones_totales": len(self.repeticiones),
            "correctas_totales": sum(1 for r in self.repeticiones if r["veredicto"] == "CORRECTA"),
            "progreso": round(progreso, 2),
            "terminado": self.terminado,
            "repeticion_nueva": repeticion_nueva,
            "serie_cerrada": serie_cerrada,
        }


def resumir_serie(n_serie: int, reps: list[dict], reps_prescritas: int,
                  motivo_cierre: str) -> dict:
    """Veredicto y parametros biomecanicos de una serie."""
    cuenta = Counter(r["veredicto"] for r in reps)
    correctas = cuenta.get("CORRECTA", 0)
    hechas = len(reps)
    completa = hechas >= reps_prescritas
    pct = 100.0 * correctas / max(reps_prescritas, 1)

    if not completa:
        veredicto = "INCOMPLETA"
    elif pct >= CRITERIO_SERIE["BIEN_HECHA"]:
        veredicto = "BIEN_HECHA"
    elif pct >= CRITERIO_SERIE["MEJORABLE"]:
        veredicto = "MEJORABLE"
    else:
        veredicto = "MAL_HECHA"

    roms = [r["rom_grados"] for r in reps]
    rom_medio = _media(roms)
    cv_rom = None
    if len(roms) >= 2 and rom_medio:
        var = sum((x - rom_medio) ** 2 for x in roms) / (len(roms) - 1)
        cv_rom = math.sqrt(var) / rom_medio

    # Fatiga: el ROM del ultimo tercio frente al del primero.
    caida_rom = None
    if len(roms) >= 6:
        k = len(roms) // 3
        ini, fin = _media(roms[:k]), _media(roms[-k:])
        if ini:
            caida_rom = (ini - fin) / ini

    troncos = [r["rom_tronco_grados"] for r in reps if r["rom_tronco_grados"] is not None]
    motivos = Counter(m for r in reps for m in r["motivos"])

    observaciones = []
    if not completa:
        observaciones.append(f"Hizo {hechas} de {reps_prescritas} repeticiones")
    if caida_rom is not None and caida_rom > CAIDA_ROM_FATIGA:
        observaciones.append(f"El rango cayo un {round(caida_rom * 100)} % al final de la serie (fatiga)")
    for m, veces in motivos.most_common(2):
        observaciones.append(f"{m} ({veces} de {hechas})")

    return {
        "serie": n_serie,
        "veredicto": veredicto,
        "bien_hecha": veredicto == "BIEN_HECHA",
        "completa": completa,
        "motivo_cierre": motivo_cierre,
        "repeticiones_prescritas": reps_prescritas,
        "repeticiones_hechas": hechas,
        "correctas": correctas,
        "incorrectas": cuenta.get("INCORRECTA", 0),
        "pct_correctas": _r(pct, 1),
        # --- parametros biomecanicos de la serie ---
        "rom_medio": _r(rom_medio),
        "rom_min": _r(min(roms)) if roms else None,
        "rom_max": _r(max(roms)) if roms else None,
        "cv_rom": _r(cv_rom, 3),
        "caida_rom_pct": _r(100.0 * caida_rom, 1) if caida_rom is not None else None,
        "duracion_media_rep_s": _r(_media([r["duracion_s"] for r in reps]), 2),
        "velocidad_media_gr_s": _r(_media([r["velocidad_media_gr_s"] for r in reps])),
        "rom_tronco_medio": _r(_media(troncos)),
        "angulos_medios_en_extremo": _medias_angulos(reps),
        "rom_medio_por_articulacion": _rom_medio_articulaciones(reps),
        "observaciones": observaciones,
    }


def _angulos_de(fila: dict) -> dict:
    """Los angulos biomecanicos de una fila, del lado medido y del otro."""
    a = fila.get("angulos") or {}
    return {k: _r(_num(v)) for k, v in a.items()}


def _medias_angulos(reps: list[dict]) -> dict:
    claves = {k for r in reps for k in (r.get("angulos_en_extremo") or {})}
    out = {}
    for k in sorted(claves):
        vals = [r["angulos_en_extremo"][k] for r in reps
                if r["angulos_en_extremo"].get(k) is not None]
        out[k] = _r(_media(vals))
    return out


def _rom_medio_articulaciones(reps: list[dict]) -> dict:
    claves = {k for r in reps for k in (r.get("rango_articular") or {})}
    out = {}
    for k in sorted(claves):
        vals = [r["rango_articular"][k]["rom"] for r in reps if k in r["rango_articular"]]
        out[k] = _r(_media(vals))
    return out


def _texto_repeticion(rep: dict, serie_cerrada: Optional[dict]) -> str:
    if serie_cerrada:
        s = serie_cerrada
        base = (f"Serie {s['serie']} terminada: {s['correctas']}/{s['repeticiones_prescritas']} "
                f"bien hechas")
        return f"{base}. Descansa" if s["veredicto"] != "INCOMPLETA" else base
    if rep["veredicto"] == "CORRECTA":
        return f"Repeticion {rep['n_en_serie']} correcta"
    if rep["motivos"]:
        return f"Repeticion {rep['n_en_serie']}: {rep['motivos'][0]}"
    return f"Repeticion {rep['n_en_serie']} registrada"
