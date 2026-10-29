/* ==================================================================
   FisioClin — contador de repeticiones y evaluación por reglas
   ==================================================================

   Puerto a TypeScript de `fisioclin_evaluador.py`. Corre entero en el
   teléfono: solo necesita el ángulo de la articulación medida, la
   inclinación del tronco y el ángulo contralateral, que llegan del
   servicio de visión a ~10 Hz.

   Tres decisiones que vienen del dataset y conviene no cambiar a ciegas
   (son las mismas que documenta el módulo de Python):

   **El ejercicio lo prescribe el médico, no lo adivina la red.** La app
   ya sabe qué toca, así que la red solo VERIFICA. Ver `modelo.ts`.

   **La evaluación la hacen las reglas, no la red.** La cabeza de calidad
   quedó en 0,462 contra una línea base de 0,642: aprende a reproducir
   reglas que aquí se calculan exactas desde los mismos ángulos.

   **El sentido del ciclo depende del ejercicio.** Un puente de glúteos
   EMPIEZA arriba y una elevación de rodilla empieza abajo. Un contador
   con un umbral fijo en un solo sentido detecta la mitad del catálogo.
   El sentido de cada ejercicio está medido y vive en
   `configuracion_ejercicios.json`.

   Lo que este módulo NO hace: no diagnostica ni prescribe, no detecta
   varias personas, y no compara sesiones grabadas con la cámara en
   sitios distintos — la dispersión del ROM entre tomas llega a 28° frente
   a 3° dentro de una toma, así que fijar la cámara es requisito.
   ================================================================== */

import CATALOGO from '@/ml/configuracion_ejercicios.json';

import type {
  ConfigEjercicio,
  EstadoSesion,
  Lado,
  Repeticion,
  ResumenSesion,
  Veredicto,
} from './tipos';

/* ---- constantes medidas, no ajustables a ojo ---------------------- */
const FRAMES_ESTABLE = 8; // ~0,8 s quieto para confirmar la posición inicial
const FRAMES_CONFIRMA = 3; // fotogramas para confirmar un cruce de umbral
const DURACION_REP_MIN = 1.0;
const DURACION_REP_MAX = 15.0;

/** Umbrales de las reglas de calidad (artrosis_06_calidad). */
const REGLAS = {
  RAZON_DEJADO_CAER: 1.5,
  RAZON_BRUSCO: 0.55,
  DESVIO_TEMPO: 0.5,
  FACTOR_TRONCO: 2.0,
  ASIMETRIA_MAX: 0.5,
  /** Por debajo de esto, el lado contrario se movió casi igual que el
   *  medido: en un ejercicio alternado (un lado a la vez) eso no es
   *  "buena simetría", es la señal de que el paciente está moviendo los
   *  dos lados juntos — el patrón de OTRO ejercicio, no del prescrito. */
  SIMETRIA_INESPERADA_MAX: 0.3,
} as const;

/**
 * Constantes del modo "sostenido" (aguantar una posición — hoy, R10):
 * a diferencia del ciclo alto/bajo normal, estos ejercicios no tienen
 * `cfg.umbrales` calibrado (el dataset no trajo repeticiones suficientes
 * para medir una banda, ver `aviso` en el catálogo) y por eso usan
 * constantes fijas en vez de un umbral por ejercicio.
 */
const SOSTENIDO = {
  /** Grados de distancia del neutro para contar que "empezó a sostener". */
  UMBRAL_INICIO_GRADOS: 15,
  /** Zona de histéresis para decidir que SOLTÓ la posición (más estricta
   *  que el umbral de inicio, para no cerrar la repetición por un
   *  temblor que cruza el mismo número por casualidad). */
  UMBRAL_FIN_GRADOS: 9,
  /** Dentro de esto, en una ventana móvil de 3 s, se considera estable
   *  (mismo valor que `EXCURSION_RETENCION` del pipeline de calibración
   *  offline — artrosis_05_segmentos.py). */
  OSCILACION_MAXIMA_GRADOS: 8,
  VENTANA_OSCILACION_S: 3,
  /** Cuánto por debajo del tiempo prescrito (`tempo_esperado`, p. ej.
   *  "30s hold") todavía se acepta como sostenido. */
  TOLERANCIA_DURACION: 0.2,
} as const;

/* El JSON viene del dataset, no de TypeScript: el cast es inevitable.
   `ConfigEjercicio` es la forma que se espera y `verificar_paridad.py`
   comprueba que el archivo sigue teniéndola. */
const EJERCICIOS = (CATALOGO as unknown as { ejercicios: Record<string, ConfigEjercicio> })
  .ejercicios;

/** Los ejercicios que la app puede ofrecer hoy, con su ficha resumida. */
export function ejerciciosDisponibles() {
  return Object.values(EJERCICIOS).map((e) => ({
    id: e.id,
    nombre: e.ejercicio,
    grupo: e.grupo,
    articulacion: e.articulacion_objetivo,
    postura: e.postura,
    tipo: e.tipo,
    criterio: e.criterio_ejecucion,
    /** false = sin banda de referencia medida y no es "sostenido": no se
     *  puede contar repeticiones (hoy, C09 y R03). Los "sostenido" (R10)
     *  no necesitan banda calibrada — se evalúan por tiempo y estabilidad. */
    listo_para_uso: Boolean(e.umbrales) || e.tipo === 'sostenido',
    medicion_goniometrica_valida: e.medible_goniometricamente,
  }));
}

export function fichaEjercicio(id: string): ConfigEjercicio | undefined {
  return EJERCICIOS[id];
}

/**
 * Convierte un tempo prescrito ("3-1-3", "5s") a segundos.
 * Devuelve null si no se reconoce, y entonces no se evalúa el ritmo.
 */
export function duracionPrescrita(tempo: string | null | undefined): number | null {
  if (!tempo) return null;
  const t = tempo.trim().toLowerCase();
  const m = /^(\d+)\s*-\s*(\d+)\s*-\s*(\d+)$/.exec(t);
  if (m) return Number(m[1]) + Number(m[2]) + Number(m[3]);
  const s = /(\d+)\s*s/.exec(t);
  return s ? Number(s[1]) : null;
}

type Opciones = {
  /** Series y repeticiones las prescribe el médico: no hay valor por defecto. */
  series: number;
  repeticiones: number;
  /** ROM objetivo de la prescripción. Si falta, se usa el de la ficha. */
  romObjetivo?: number | null;
};

type Ciclo = {
  activo: boolean;
  tInicio: number;
  tExtremo: number;
  valorInicio: number;
  valorExtremo: number;
  troncos: number[];
  contra: number[];
  /** [t, ángulo] de todo el ciclo: de aquí salen los tiempos reales. */
  historia: [number, number][];
};

/**
 * Los instantes REALES de una repetición (mismo cálculo que
 * `_tiempos_reales` en evaluador_series.py).
 *
 * Antes la ida se contaba desde que el paciente se quedaba quieto en la
 * partida (sumaba los segundos que esperaba antes de moverse) y la vuelta
 * desde que llegaba al extremo (sumaba la pausa abajo). Con eso una
 * sentadilla perfecta 3-1-3 salía "No frenaste la vuelta" y una que se
 * dejaba caer salía CORRECTA.
 *
 * "Cerca" = dentro del 15 % del recorrido (mínimo 3°), para que el ruido del
 * detector no mueva los instantes.
 */
function tiemposReales(historia: [number, number][], inicio: number, extremo: number, tFin: number) {
  const margen = Math.max(3, 0.15 * Math.abs(extremo - inicio));
  const cercaExt = historia.filter(([, a]) => Math.abs(a - extremo) <= margen).map(([t]) => t);
  if (!cercaExt.length) return { sale: historia[0][0], llega: tFin, deja: tFin, vuelve: tFin };
  const llega = cercaExt[0];
  const deja = cercaExt[cercaExt.length - 1];
  let sale = historia[0][0];
  for (const [t, a] of historia) if (t <= llega && Math.abs(a - inicio) <= margen) sale = t;
  let vuelve = tFin;
  for (const [t, a] of historia) {
    if (t >= deja && Math.abs(a - inicio) <= margen) {
      vuelve = t;
      break;
    }
  }
  return { sale, llega, deja, vuelve };
}

/** Las métricas geométricas de una repetición, antes de pasarlas por las reglas. */
type RepMedida = Pick<
  Repeticion,
  | 'n'
  | 'serie'
  | 't_inicio_s'
  | 'duracion_s'
  | 'flex_min_grados'
  | 'flex_max_grados'
  | 'rom_grados'
  | 'duracion_ida_s'
  | 'duracion_vuelta_s'
  | 'razon_ida_vuelta'
  | 'velocidad_media_gr_s'
  | 'rom_tronco_grados'
  | 'rom_contralateral_grados'
  | 'asimetria_rom'
>;

/** Lo que añaden las reglas a una repetición medida. */
type RepEvaluada = Omit<Repeticion, keyof RepMedida>;

const cicloVacio = (): Ciclo => ({
  activo: false,
  tInicio: 0,
  tExtremo: 0,
  valorInicio: 0,
  valorExtremo: 0,
  troncos: [],
  contra: [],
  historia: [],
});

const POSTURAS: Record<string, string> = {
  supino: 'boca arriba',
  prono: 'boca abajo',
  decubito_lateral: 'de lado',
  cuadrupedia: 'a cuatro patas',
  sedente: 'sentado',
  semisentado: 'semisentado',
  bipedestacion: 'de pie',
};

/** Un ejercicio prescrito, evaluado en vivo. */
export class EvaluadorEjercicio {
  readonly cfg: ConfigEjercicio;
  readonly seriesPrescritas: number;
  readonly repsPrescritas: number;
  readonly romObjetivo: number | null;

  private serie = 1;
  private repeticiones: Repeticion[] = [];
  private repsSerie = 0;
  private framesEstables = 0;
  private framesTotales = 0;
  private framesDescartados = 0;
  private inicio = 0;
  private ciclo = cicloVacio();
  private racha = 0;
  private lado: Lado | '' = '';
  /** Extremo de partida elegido por el paciente (true = alto); null hasta la primera calibración. */
  private inicioAlto: boolean | null = null;
  private candidatoAlto: boolean | null = null;

  /** Estado del modo "sostenido" (ver SOSTENIDO arriba). Sin relación con
   *  `ciclo`, que es del modo normal alto/bajo. */
  private readonly esSostenido: boolean;
  private sosteniendo = false;
  private inicioSostenido = 0;
  private historiaSostenido: [number, number][] = [];
  private troncoSostenido: number[] = [];
  private contraSostenido: number[] = [];
  private rachaFinSostenido = 0;

  constructor(idEjercicio: string, opciones: Opciones) {
    const cfg = EJERCICIOS[idEjercicio];
    if (!cfg) {
      throw new Error(
        `Ejercicio desconocido: ${idEjercicio}. Disponibles: ${Object.keys(EJERCICIOS).sort().join(', ')}`
      );
    }
    this.esSostenido = cfg.tipo === 'sostenido' && !cfg.umbrales;
    // Los "sostenido" sin banda (R10) no necesitan umbrales: se evalúan
    // por tiempo y estabilidad, con constantes fijas (SOSTENIDO arriba).
    if (!this.esSostenido && !cfg.umbrales) {
      throw new Error(
        `${idEjercicio} no tiene banda de referencia medida en el dataset: ${cfg.aviso ?? ''}`
      );
    }

    if (!esEnteroPositivo(opciones.series) || !esEnteroPositivo(opciones.repeticiones)) {
      throw new Error('La prescripción no tiene series y repeticiones válidas');
    }

    this.cfg = cfg;
    this.seriesPrescritas = opciones.series;
    this.repsPrescritas = opciones.repeticiones;
    // El ROM objetivo lo fija la prescripción del paciente. Si no se da, se
    // usa el de la ficha clínica; si tampoco, no se evalúa el rango.
    this.romObjetivo = opciones.romObjetivo ?? numero(cfg.rom_esperado_max);
  }

  /**
   * Un fotograma medido. Llamar a ~10 Hz, con el reloj de la sesión.
   *
   * @param t        segundos desde el arranque de la sesión
   * @param angulo   articulación medida, en grados, ya suavizada; null si no es fiable
   * @param tronco   inclinación del tronco en grados
   * @param contra   mismo ángulo en el lado contrario, o null
   */
  procesar(
    t: number,
    angulo: number | null,
    tronco: number | null,
    contra: number | null,
    lado: Lado | '',
    motivoNoFiable = ''
  ): EstadoSesion {
    if (this.inicio === 0) this.inicio = t;
    this.framesTotales++;

    if (angulo === null || !Number.isFinite(angulo)) {
      this.framesDescartados++;
      this.reiniciarCiclo();
      return {
        fase: motivoNoFiable ? 'DATO_NO_FIABLE' : 'SIN_PERSONA',
        mensaje: motivoNoFiable || 'Colócate frente a la cámara, de cuerpo entero',
        hay_persona: Boolean(motivoNoFiable),
        dato_fiable: false,
        motivo_no_fiable: motivoNoFiable,
        angulo: null,
        lado,
        repeticiones: this.repsSerie,
        serie: this.serie,
        progreso: 0,
        repeticion_nueva: null,
      };
    }

    this.lado = lado || this.lado;
    return this.esSostenido
      ? this.maquinaDeEstadosSostenido(t, angulo, tronco, contra, lado)
      : this.maquinaDeEstados(t, angulo, tronco, contra, lado);
  }

  /** Lo que se guarda al terminar la sesión. */
  resumen(tFinal: number): ResumenSesion {
    const reps = this.repeticiones;
    const roms = reps.map((r) => r.rom_grados);
    const cuenta = (v: Veredicto) => reps.filter((r) => r.veredicto === v).length;

    return {
      ejercicio: this.cfg.ejercicio,
      id_ejercicio: this.cfg.id,
      articulacion: this.cfg.articulacion_medida,
      lado_medido: this.lado,
      duracion_seg: redondear(tFinal - this.inicio, 1),
      series_prescritas: this.seriesPrescritas,
      repeticiones_prescritas: this.repsPrescritas,
      series_completadas: this.serie - 1 + (this.repsSerie ? 1 : 0),
      repeticiones_detectadas: reps.length,
      cumplimiento_pct: redondear(
        (100 * reps.length) / Math.max(this.seriesPrescritas * this.repsPrescritas, 1),
        1
      ),
      rom_medio: roms.length ? redondear(roms.reduce((a, b) => a + b, 0) / roms.length, 1) : null,
      rom_maximo: roms.length ? redondear(Math.max(...roms), 1) : null,
      rom_objetivo: this.romObjetivo,
      correctas: cuenta('CORRECTA'),
      incorrectas: cuenta('INCORRECTA'),
      pct_correctas: reps.length ? redondear((100 * cuenta('CORRECTA')) / reps.length, 1) : null,
      medicion_goniometrica_valida: this.cfg.medible_goniometricamente,
      repeticiones: reps,
    };
  }

  get repeticionesTotales(): number {
    return this.repeticiones.length;
  }

  get calidadFrames(): { totales: number; descartados: number } {
    return { totales: this.framesTotales, descartados: this.framesDescartados };
  }

  /* ---------------------------------------------------------------
     Máquina de estados del ciclo
     --------------------------------------------------------------- */
  private maquinaDeEstados(
    t: number,
    angulo: number,
    tronco: number | null,
    contra: number | null,
    lado: Lado | ''
  ): EstadoSesion {
    const u = this.cfg.umbrales!;
    const alto = angulo >= u.alto;
    const bajo = angulo <= u.bajo;
    // La partida es el extremo donde el paciente se colocó quieto LA PRIMERA
    // VEZ, y queda fija toda la sesión. Antes se tomaba del `sentido` del
    // catálogo, que salió de cómo EMPEZABAN los videos de demostración: en
    // la sentadilla decía "empieza agachado", así que a un paciente que
    // empezaba de pie se le contaba medio ciclo corrido y no se le contaba
    // la última repetición. Mismo cambio en evaluador_series.py.
    let partidaAlta = this.inicioAlto;
    if (partidaAlta === null && (alto || bajo)) {
      partidaAlta = alto;
      if (this.candidatoAlto !== alto) this.framesEstables = 0; // cambió de extremo
      this.candidatoAlto = alto;
    }
    const desciende = partidaAlta ?? this.cfg.sentido === 'desciende';
    // Si la partida es la ALTA, el movimiento baja hacia el extremo bajo.
    const enPartida = desciende ? alto : bajo;
    const enExtremo = desciende ? bajo : alto;

    const base = {
      hay_persona: true,
      dato_fiable: true,
      motivo_no_fiable: '',
      angulo: redondear(angulo, 1),
      lado,
      repeticiones: this.repsSerie,
      serie: this.serie,
      repeticion_nueva: null as Repeticion | null,
    };

    if (!this.ciclo.activo) {
      if (enPartida) {
        this.framesEstables++;
        if (this.framesEstables >= FRAMES_ESTABLE) {
          if (this.inicioAlto === null) this.inicioAlto = desciende; // queda fija
          this.ciclo = {
            ...cicloVacio(),
            activo: true,
            tInicio: t,
            tExtremo: t,
            valorInicio: angulo,
            valorExtremo: angulo,
            historia: [[t, angulo]],
          };
          return { ...base, fase: 'LISTO', mensaje: 'Empieza el movimiento', progreso: 0 };
        }
        return {
          ...base,
          fase: 'CALIBRANDO',
          mensaje: 'Mantente en la posición inicial',
          progreso: 0,
        };
      }
      this.framesEstables = 0;
      return { ...base, fase: 'COLOCATE', mensaje: this.textoPosicionInicial(), progreso: 0 };
    }

    // Ciclo en curso: se registra el extremo alcanzado.
    if (tronco !== null && Number.isFinite(tronco)) this.ciclo.troncos.push(tronco);
    if (contra !== null && Number.isFinite(contra)) this.ciclo.contra.push(contra);
    this.ciclo.historia.push([t, angulo]);

    const mejor = desciende
      ? angulo < this.ciclo.valorExtremo
      : angulo > this.ciclo.valorExtremo;
    if (mejor) {
      this.ciclo.valorExtremo = angulo;
      this.ciclo.tExtremo = t;
    }

    const recorrido = Math.abs(this.ciclo.valorExtremo - this.ciclo.valorInicio);
    const progreso = Math.min(1, recorrido / Math.max(u.prominencia_minima, 1e-6));

    // Vuelta a la partida con recorrido suficiente = repetición.
    if (enPartida && recorrido >= u.prominencia_minima) {
      this.racha++;
      if (this.racha >= FRAMES_CONFIRMA) {
        const rep = this.cerrarRepeticion(t);
        this.racha = 0;
        if (rep) {
          return {
            ...base,
            fase: 'REPETICION',
            mensaje: textoRepeticion(rep),
            repeticiones: this.repsSerie,
            serie: this.serie,
            progreso: 1,
            repeticion_nueva: rep,
          };
        }
      }
    } else {
      this.racha = 0;
    }

    const fase = enPartida ? 'VUELTA' : enExtremo ? 'EXTREMO' : 'MOVIMIENTO';
    return { ...base, fase, mensaje: 'Controla el movimiento', progreso };
  }

  private cerrarRepeticion(t: number): Repeticion | null {
    const c = this.ciclo;
    // Tiempos del MOVIMIENTO, sin la espera antes de arrancar ni la pausa
    // en el extremo (ver `tiemposReales`).
    const { sale, llega, deja, vuelve } = tiemposReales(
      c.historia.length ? c.historia : [[c.tInicio, c.valorInicio]],
      c.valorInicio,
      c.valorExtremo,
      t
    );
    const duracion = vuelve - sale;
    if (duracion < DURACION_REP_MIN || duracion > DURACION_REP_MAX) {
      this.reiniciarCiclo();
      return null;
    }
    c.tInicio = sale;

    const ida = Math.max(llega - sale, 1e-3);
    const vuelta = Math.max(vuelve - deja, 1e-3);
    const rom = Math.abs(c.valorExtremo - c.valorInicio);
    const romContra =
      c.contra.length > 5 ? Math.max(...c.contra) - Math.min(...c.contra) : null;

    const parcial: RepMedida = {
      n: this.repeticiones.length + 1,
      serie: this.serie,
      t_inicio_s: redondear(c.tInicio - this.inicio, 2),
      duracion_s: redondear(duracion, 2),
      flex_min_grados: redondear(Math.min(c.valorInicio, c.valorExtremo), 1),
      flex_max_grados: redondear(Math.max(c.valorInicio, c.valorExtremo), 1),
      rom_grados: redondear(rom, 1),
      duracion_ida_s: redondear(ida, 2),
      duracion_vuelta_s: redondear(vuelta, 2),
      razon_ida_vuelta: redondear(ida / vuelta, 2),
      velocidad_media_gr_s: redondear(rom / duracion, 1),
      rom_tronco_grados: c.troncos.length
        ? redondear(Math.max(...c.troncos) - Math.min(...c.troncos), 1)
        : null,
      rom_contralateral_grados: romContra !== null ? redondear(romContra, 1) : null,
      asimetria_rom:
        romContra !== null ? redondear(Math.abs(rom - romContra) / Math.max(rom, 1e-6), 2) : null,
    };

    const rep: Repeticion = { ...parcial, ...this.evaluar(parcial) };
    this.repeticiones.push(rep);
    this.repsSerie++;
    if (this.repsSerie >= this.repsPrescritas) {
      this.serie++;
      this.repsSerie = 0;
    }
    this.reiniciarCiclo();
    return rep;
  }

  /* ---------------------------------------------------------------
     Máquina de estados "sostenido" (aguantar una posición, sin banda
     calibrada — hoy, R10). No usa cfg.umbrales ni el ciclo alto/bajo:
     detecta que se apartó del neutro, mide cuánto dura y cuánto oscila,
     y cierra la repetición cuando vuelve al neutro (o se pierde el dato).
     --------------------------------------------------------------- */
  private maquinaDeEstadosSostenido(
    t: number,
    angulo: number,
    tronco: number | null,
    contra: number | null,
    lado: Lado | ''
  ): EstadoSesion {
    const base = {
      hay_persona: true,
      dato_fiable: true,
      motivo_no_fiable: '',
      angulo: redondear(angulo, 1),
      lado,
      repeticiones: this.repsSerie,
      serie: this.serie,
      repeticion_nueva: null as Repeticion | null,
    };

    if (!this.sosteniendo) {
      if (Math.abs(angulo) >= SOSTENIDO.UMBRAL_INICIO_GRADOS) {
        this.framesEstables++;
        if (this.framesEstables >= FRAMES_ESTABLE) {
          this.sosteniendo = true;
          this.inicioSostenido = t;
          this.historiaSostenido = [[t, angulo]];
          this.troncoSostenido = [];
          this.contraSostenido = [];
          this.rachaFinSostenido = 0;
          return { ...base, fase: 'SOSTENIENDO', mensaje: 'Mantén la posición', progreso: 0 };
        }
        return { ...base, fase: 'CALIBRANDO', mensaje: 'Mantente quieto en la posición', progreso: 0 };
      }
      this.framesEstables = 0;
      return { ...base, fase: 'COLOCATE', mensaje: this.textoPosicionInicial(), progreso: 0 };
    }

    // Sosteniendo: acumular y medir oscilación reciente (ventana móvil).
    this.historiaSostenido.push([t, angulo]);
    if (tronco !== null && Number.isFinite(tronco)) this.troncoSostenido.push(tronco);
    if (contra !== null && Number.isFinite(contra)) this.contraSostenido.push(contra);

    const ventana = this.historiaSostenido.filter(
      ([ti]) => t - ti <= SOSTENIDO.VENTANA_OSCILACION_S
    );
    const angulosVentana = ventana.map(([, a]) => a);
    const oscilacionActual =
      angulosVentana.length > 1
        ? Math.max(...angulosVentana) - Math.min(...angulosVentana)
        : 0;

    const duracion = t - this.inicioSostenido;
    const prescrita = duracionPrescrita(this.cfg.tempo_esperado);
    const progreso = prescrita ? Math.min(1, duracion / prescrita) : 0;

    // Volvió al neutro (con histéresis, para no cerrar por un temblor que
    // cruza el mismo número que abrió la repetición).
    if (Math.abs(angulo) < SOSTENIDO.UMBRAL_FIN_GRADOS) {
      this.rachaFinSostenido++;
      if (this.rachaFinSostenido >= FRAMES_CONFIRMA) {
        const rep = this.cerrarSostenido(t);
        this.rachaFinSostenido = 0;
        if (rep) {
          return {
            ...base,
            fase: 'REPETICION',
            mensaje: textoRepeticion(rep),
            repeticiones: this.repsSerie,
            serie: this.serie,
            progreso: 1,
            repeticion_nueva: rep,
          };
        }
        return { ...base, fase: 'COLOCATE', mensaje: this.textoPosicionInicial(), progreso: 0 };
      }
    } else {
      this.rachaFinSostenido = 0;
    }

    const inestable = oscilacionActual > SOSTENIDO.OSCILACION_MAXIMA_GRADOS;
    return {
      ...base,
      fase: 'SOSTENIENDO',
      mensaje: inestable ? 'Más quieto, estás oscilando' : 'Mantén la posición',
      progreso,
    };
  }

  private cerrarSostenido(t: number): Repeticion | null {
    const duracion = t - this.inicioSostenido;
    if (duracion < DURACION_REP_MIN) {
      // Demasiado corto para ser un intento real (p. ej. un tropiezo al
      // entrar en posición): se descarta en silencio, igual que un ciclo
      // normal que no llega a DURACION_REP_MIN.
      this.sosteniendo = false;
      return null;
    }
    // Los últimos FRAMES_CONFIRMA cuadros de la historia son los que
    // confirmaron la VUELTA al neutro (ya soltando), no parte del
    // sostenido: incluirlos en el rango mediría la transición de salida
    // como si fuera temblor, inflando flex_min/rom_grados.
    const tramo =
      this.historiaSostenido.length > FRAMES_CONFIRMA
        ? this.historiaSostenido.slice(0, -FRAMES_CONFIRMA)
        : this.historiaSostenido;
    const angulos = tramo.map(([, a]) => a);
    const flexMin = Math.min(...angulos);
    const flexMax = Math.max(...angulos);
    const romContra =
      this.contraSostenido.length > 5
        ? Math.max(...this.contraSostenido) - Math.min(...this.contraSostenido)
        : null;
    const rom = flexMax - flexMin;

    const parcial: RepMedida = {
      n: this.repeticiones.length + 1,
      serie: this.serie,
      t_inicio_s: redondear(this.inicioSostenido - this.inicio, 2),
      duracion_s: redondear(duracion, 2),
      flex_min_grados: redondear(flexMin, 1),
      flex_max_grados: redondear(flexMax, 1),
      rom_grados: redondear(rom, 1),
      // Ida/vuelta no aplican a un sostenido (no hay ciclo): se dejan en
      // la duración completa para que ningún consumidor del tipo divida
      // por cero, pero `evaluarSostenido` no las usa para el veredicto.
      duracion_ida_s: redondear(duracion, 2),
      duracion_vuelta_s: redondear(duracion, 2),
      razon_ida_vuelta: 1,
      velocidad_media_gr_s: redondear(rom / duracion, 1),
      rom_tronco_grados: this.troncoSostenido.length
        ? redondear(Math.max(...this.troncoSostenido) - Math.min(...this.troncoSostenido), 1)
        : null,
      rom_contralateral_grados: romContra !== null ? redondear(romContra, 1) : null,
      asimetria_rom:
        romContra !== null ? redondear(Math.abs(rom - romContra) / Math.max(rom, 1e-6), 2) : null,
    };

    const rep: Repeticion = { ...parcial, ...this.evaluarSostenido(parcial) };
    this.repeticiones.push(rep);
    this.repsSerie++;
    if (this.repsSerie >= this.repsPrescritas) {
      this.serie++;
      this.repsSerie = 0;
    }
    this.sosteniendo = false;
    this.historiaSostenido = [];
    this.troncoSostenido = [];
    this.contraSostenido = [];
    return rep;
  }

  /** Reglas de calidad del modo "sostenido": tiempo y estabilidad, no
   *  tempo de ida/vuelta (no aplica — no hay ciclo). Reusa la regla de
   *  compensación de tronco tal cual, porque "alineación" sí es parte
   *  del criterio clínico de un sostenido (ver `criterio_ejecucion`). */
  private evaluarSostenido(rep: RepMedida): RepEvaluada {
    const motivos: string[] = [];

    const prescrita = duracionPrescrita(this.cfg.tempo_esperado);
    const duracion_insuficiente =
      prescrita && rep.duracion_s < prescrita * (1 - SOSTENIDO.TOLERANCIA_DURACION) ? 1 : 0;
    if (duracion_insuficiente) {
      motivos.push(`No aguantaste el tiempo prescrito (${prescrita} s)`);
    }

    const oscilacion_excesiva = rep.rom_grados > SOSTENIDO.OSCILACION_MAXIMA_GRADOS ? 1 : 0;
    if (oscilacion_excesiva) motivos.push('Perdiste el equilibrio o te moviste de más');

    const ref = this.cfg.tronco_mediano_grados;
    const compensacion_tronco =
      ref != null && rep.rom_tronco_grados !== null && rep.rom_tronco_grados > REGLAS.FACTOR_TRONCO * ref
        ? 1
        : 0;
    if (compensacion_tronco) motivos.push('Estás compensando con el tronco');

    const pct_rom_objetivo = this.romObjetivo
      ? Math.round((100 * rep.rom_grados) / this.romObjetivo)
      : null;

    const n_indicadores = duracion_insuficiente + oscilacion_excesiva + compensacion_tronco;
    const veredicto: Veredicto = n_indicadores === 0 ? 'CORRECTA' : 'INCORRECTA';

    return {
      tempo_dejado_caer: 0,
      tempo_brusco: 0,
      duracion_fuera_de_tempo: 0,
      compensacion_tronco,
      asimetria: 0,
      simetria_inesperada: 0,
      duracion_insuficiente,
      oscilacion_excesiva,
      n_indicadores,
      motivos,
      veredicto,
      pct_rom_objetivo,
      medicion_no_representativa: 0,
    };
  }

  /* ---------------------------------------------------------------
     Reglas: los mismos indicadores que la etapa 6 del dataset
     --------------------------------------------------------------- */
  private evaluar(rep: RepMedida): RepEvaluada {
    const motivos: string[] = [];

    const razon = rep.razon_ida_vuelta;
    const tempo_dejado_caer = razon > REGLAS.RAZON_DEJADO_CAER ? 1 : 0;
    const tempo_brusco = razon < REGLAS.RAZON_BRUSCO ? 1 : 0;
    if (tempo_dejado_caer) motivos.push('No frenaste la vuelta');
    if (tempo_brusco) motivos.push('El movimiento de ida fue brusco');

    const prescrita = duracionPrescrita(this.cfg.tempo_esperado);
    const duracion_fuera_de_tempo =
      prescrita && Math.abs(rep.duracion_s - prescrita) / prescrita > REGLAS.DESVIO_TEMPO ? 1 : 0;
    if (duracion_fuera_de_tempo) motivos.push(`Ritmo distinto del prescrito (${prescrita} s)`);

    const ref = this.cfg.tronco_mediano_grados;
    const compensacion_tronco =
      ref != null &&
      rep.rom_tronco_grados !== null &&
      rep.rom_tronco_grados > REGLAS.FACTOR_TRONCO * ref
        ? 1
        : 0;
    if (compensacion_tronco) motivos.push('Estás compensando con el tronco');

    const asimetria =
      this.cfg.bilateral && rep.asimetria_rom !== null && rep.asimetria_rom > REGLAS.ASIMETRIA_MAX
        ? 1
        : 0;
    if (asimetria) motivos.push('Un lado recorre más que el otro');

    // El inverso de la regla de arriba: en un ejercicio que se prescribe
    // ALTERNADO (bilateral: false), el lado contrario debería quedarse
    // quieto. Si se movió casi tanto como el medido, el paciente está
    // moviendo los dos lados a la vez — eso no es "hacerlo bien", es
    // estar haciendo el movimiento de un ejercicio bilateral distinto.
    const simetria_inesperada =
      !this.cfg.bilateral && rep.asimetria_rom !== null && rep.asimetria_rom < REGLAS.SIMETRIA_INESPERADA_MAX
        ? 1
        : 0;
    if (simetria_inesperada) motivos.push('Pareces estar moviendo los dos lados a la vez');

    // El rango se compara contra la PRESCRIPCIÓN del paciente, no contra la
    // banda del catálogo. Es descriptivo: no entra en el veredicto mientras
    // no se aclare si el arco de la ficha es recorrido o límites absolutos.
    const pct_rom_objetivo = this.romObjetivo
      ? Math.round((100 * rep.rom_grados) / this.romObjetivo)
      : null;

    const n_indicadores =
      tempo_dejado_caer + tempo_brusco + duracion_fuera_de_tempo + compensacion_tronco + asimetria +
      simetria_inesperada;
    const noRepresentativa = !this.cfg.medible_goniometricamente;
    const veredicto: Veredicto =
      !noRepresentativa && n_indicadores === 0 ? 'CORRECTA' : 'INCORRECTA';

    return {
      tempo_dejado_caer,
      tempo_brusco,
      duracion_fuera_de_tempo,
      compensacion_tronco,
      asimetria,
      simetria_inesperada,
      n_indicadores,
      motivos,
      veredicto,
      pct_rom_objetivo,
      medicion_no_representativa: noRepresentativa ? 1 : 0,
    };
  }

  private reiniciarCiclo(): void {
    this.ciclo = cicloVacio();
    this.framesEstables = 0;
    this.racha = 0;
    // Si se perdió el dato a mitad de un sostenido (p. ej. salió del
    // encuadre al perder el equilibrio), el intento no se cuenta: no hay
    // forma honesta de saber cuánto habría durado.
    this.sosteniendo = false;
    this.historiaSostenido = [];
    this.troncoSostenido = [];
    this.contraSostenido = [];
    this.rachaFinSostenido = 0;
  }

  private textoPosicionInicial(): string {
    const postura = POSTURAS[this.cfg.postura];
    return postura ? `Ponte ${postura} en la posición inicial` : 'Ponte en la posición inicial';
  }
}

function textoRepeticion(rep: Repeticion): string {
  if (rep.veredicto === 'CORRECTA') return `Repetición ${rep.n} correcta`;
  if (rep.motivos.length) return `Repetición ${rep.n}: ${rep.motivos[0]}`;
  return `Repetición ${rep.n} registrada`;
}

function redondear(v: number, dec: number): number {
  const f = 10 ** dec;
  return Math.round(v * f) / f;
}

/** true si `v` sirve como número de series o repeticiones (1, 2, 3…). */
export function esEnteroPositivo(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function numero(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
