/* ==================================================================
   FisioClin — tipos compartidos del evaluador de ejercicio
   ==================================================================

   Un solo lugar donde vive la forma de los datos que viajan entre el
   servicio de visión (Python + MediaPipe) y la app. Si cambias algo
   aquí, cámbialo también en backend/cv-service/main.py: son las dos
   mitades del mismo contrato.
   ================================================================== */

/** Las 14 features que entran al LSTM, en el orden exacto del entrenamiento. */
export const FEATURES = [
  'flex_cadera_medido',
  'flex_cadera_contra',
  'flex_rodilla_medido',
  'flex_rodilla_contra',
  'flex_tobillo_medido',
  'flex_tobillo_contra',
  'abd_cadera_medido',
  'abd_cadera_contra',
  'inclinacion_tronco',
  'vel_cadera_medido',
  'vel_rodilla_medido',
  'vel_abd_medido',
  'visibilidad',
  'contra_presente',
] as const;

export type Feature = (typeof FEATURES)[number];

/** Columnas del lado que trabaja. Si faltan estas, la ventana no sirve. */
export const COLUMNAS_PRINCIPALES = [0, 2, 4, 6, 8, 9, 10, 11, 12];
/** Columnas del lado contrario. Pueden faltar: `contra_presente` lo avisa. */
export const COLUMNAS_CONTRALATERALES = [1, 3, 5, 7];

export const HZ = 10;
export const PASOS_VENTANA = 30; // 3 s a 10 Hz
export const PASO_VENTANA = 10; // se predice cada 1 s

export type Veredicto = 'CORRECTA' | 'INCORRECTA';

export type Lado = 'izq' | 'der';

/** Fase del ciclo, para saber qué pintar en pantalla. */
export type Fase =
  | 'SIN_PERSONA'
  | 'DATO_NO_FIABLE'
  | 'COLOCATE'
  | 'CALIBRANDO'
  | 'LISTO'
  | 'MOVIMIENTO'
  | 'EXTREMO'
  | 'VUELTA'
  | 'REPETICION'
  /** Ejercicios "sostenido" sin banda calibrada (hoy, R10): aguantando
   *  la posición, fuera del ciclo alto/bajo normal. */
  | 'SOSTENIENDO';

/** Un punto del esqueleto, normalizado 0..1 sobre el encuadre. */
export type Punto = { x: number; y: number; v: number };

/**
 * Lo que el servicio de visión manda por cada fotograma procesado.
 * Llega a ~10 Hz. `features` ya viene en las unidades del entrenamiento
 * (grados y grados/s), sin escalar: el escalado lo hace la app.
 */
export type FotogramaCv = {
  /** Segundos desde que arrancó la sesión. */
  t: number;
  hay_persona: boolean;
  /** false si la pose no da para medir; `motivo` dice por qué. */
  fiable: boolean;
  motivo: string;
  lado: Lado | '';
  /** Ángulo de la articulación medida, en grados, ya suavizado. */
  angulo: number | null;
  /** Inclinación del tronco respecto a la vertical, en grados. */
  inclinacion_tronco: number | null;
  /** Mismo ángulo en el lado contrario, o null si no se ve. */
  contra: number | null;
  /** Las 14 features del modelo. `null` en las que no se pudieron medir. */
  features: (number | null)[];
};

/**
 * Sobre completo de un mensaje `fotograma`: 0, 1 o varias filas de la
 * rejilla de 10 Hz, más el esqueleto (que sigue el reloj de la cámara, no
 * el de la rejilla) y las banderas de calidad de captura.
 */
export type SobreFotogramaCv = {
  filas: FotogramaCv[];
  /** 17 landmarks de BlazePose para dibujar el esqueleto. Null sin persona. */
  landmarks: Punto[] | null;
  /**
   * true cuando el servicio tuvo que vaciar su rejilla: o porque el dato
   * dejó de ser fiable, o porque un hueco de red obligó a cortar en vez de
   * interpolar. La ventana deslizante del teléfono debe vaciarse también:
   * si no, mezcla muestras que ya no son contiguas.
   */
  reinicio: boolean;
  /** El mismo `t` que mandó el teléfono en este fotograma, para medir latencia. */
  t_captura: number;
  /** Fotogramas de cámara realmente usados en la sesión (acumulado). */
  muestras_reales: number;
  /** Filas de rejilla de 10 Hz emitidas en la sesión (acumulado). */
  filas_emitidas: number;
};

/** Salida de las dos cabezas del LSTM para una ventana de 3 s. */
export type Prediccion = {
  ejercicio: string;
  ejercicio_idx: number;
  p_ejercicio: number;
  calidad: Veredicto;
  p_calidad: number;
  probs_ejercicio: number[];
  probs_calidad: number[];
};

/** Una repetición cerrada, con su evaluación por reglas. */
export type Repeticion = {
  n: number;
  serie: number;
  t_inicio_s: number;
  duracion_s: number;
  flex_min_grados: number;
  flex_max_grados: number;
  rom_grados: number;
  duracion_ida_s: number;
  duracion_vuelta_s: number;
  razon_ida_vuelta: number;
  velocidad_media_gr_s: number;
  rom_tronco_grados: number | null;
  rom_contralateral_grados: number | null;
  asimetria_rom: number | null;
  /* indicadores de las reglas (0/1) */
  tempo_dejado_caer: number;
  tempo_brusco: number;
  duracion_fuera_de_tempo: number;
  compensacion_tronco: number;
  asimetria: number;
  /** El lado contrario se movió casi tanto como el medido en un ejercicio
   *  que se prescribe alternado (un lado a la vez): sugiere que está
   *  haciendo el movimiento bilateral de otro ejercicio, no el prescrito. */
  simetria_inesperada: number;
  /** Solo en ejercicios "sostenido" sin banda calibrada (evaluarSostenido):
   *  no aguantó el tiempo prescrito, u osciló más de la cuenta. undefined
   *  en los ejercicios normales (cíclicos). */
  duracion_insuficiente?: number;
  oscilacion_excesiva?: number;
  n_indicadores: number;
  motivos: string[];
  veredicto: Veredicto;
  pct_rom_objetivo: number | null;
  medicion_no_representativa: number;
  /** Guía de postura (guiaPostura.ts): similitud media con la postura
   *  objetivo durante la repetición y correcciones que aparecieron. */
  similitud_media?: number | null;
  correcciones_guia?: string[];
};

/** Lo que la pantalla pinta en este fotograma. */
export type EstadoSesion = {
  fase: Fase;
  mensaje: string;
  hay_persona: boolean;
  dato_fiable: boolean;
  motivo_no_fiable: string;
  angulo: number | null;
  lado: Lado | '';
  repeticiones: number;
  serie: number;
  /** 0..1 dentro de la repetición en curso. */
  progreso: number;
  /** Solo en el fotograma que cierra una repetición. */
  repeticion_nueva: Repeticion | null;
};

/** Ficha de un ejercicio del catálogo, tal como vive en el JSON. */
export type ConfigEjercicio = {
  id: string;
  ejercicio: string;
  grupo: 'cadera' | 'rodilla';
  tipo: string;
  postura: string;
  articulacion_objetivo: string;
  articulacion_medida: string;
  movimiento: string;
  plano: string;
  senal: 'flexion' | 'abduccion' | string;
  bilateral: boolean;
  lado_trabajado: string;
  medible_goniometricamente: boolean;
  rom_esperado_min: string;
  rom_esperado_max: string;
  tolerancia_rom: string;
  tempo_esperado: string;
  criterio_ejecucion: string;
  errores_esperables: string[];
  compensaciones: string[];
  /**
   * Hacia dónde va el movimiento desde la posición de partida. `null` en
   * los ejercicios sin banda calibrada — C09 y R03, que por eso no se
   * pueden contar; R10 también la tiene en `null`, pero es "sostenido"
   * (aguantar, no ciclar) y se evalúa aparte, sin necesitar `umbrales`.
   */
  sentido: 'desciende' | 'asciende' | string | null;
  umbrales: { bajo: number; alto: number; prominencia_minima: number } | null;
  tronco_mediano_grados: number | null;
  duracion_esperada_s?: { p25: number; mediana: number; p75: number };
  banda_observada?: Record<string, number> | null;
  aviso?: string;
};

/** Resumen de la sesión, listo para guardar en Supabase. */
export type ResumenSesion = {
  ejercicio: string;
  id_ejercicio: string;
  articulacion: string;
  lado_medido: Lado | '';
  duracion_seg: number;
  series_prescritas: number;
  repeticiones_prescritas: number;
  series_completadas: number;
  repeticiones_detectadas: number;
  cumplimiento_pct: number;
  rom_medio: number | null;
  rom_maximo: number | null;
  rom_objetivo: number | null;
  correctas: number;
  incorrectas: number;
  pct_correctas: number | null;
  medicion_goniometrica_valida: boolean;
  repeticiones: Repeticion[];
  /** Veredicto por serie, calculado en el servicio (evaluador_series.py).
   *  Falta si el servicio no respondió al pedir el informe. */
  series?: ResumenSerie[];
  series_bien_hechas?: number;
  /** Cómo terminó: tocó Finalizar, o salió de la pantalla sin finalizar.
   *  La base decide con esto y con el avance si es completa, incompleta o
   *  abandonada (guardar_sesion_rehabilitacion.sql). */
  fin?: 'finalizada' | 'abandonada';
};

/* ------------------------------------------------------------------
   Series evaluadas en el servicio (backend/cv-service/evaluador_series.py)
   ------------------------------------------------------------------ */
export type VeredictoSerie = 'BIEN_HECHA' | 'MEJORABLE' | 'MAL_HECHA' | 'INCOMPLETA';

export type ResumenSerie = {
  serie: number;
  veredicto: VeredictoSerie;
  bien_hecha: boolean;
  completa: boolean;
  motivo_cierre: 'completa' | 'descanso' | 'manual' | 'fin_de_sesion';
  repeticiones_prescritas: number;
  repeticiones_hechas: number;
  correctas: number;
  incorrectas: number;
  pct_correctas: number;
  rom_medio: number | null;
  rom_min: number | null;
  rom_max: number | null;
  /** Coeficiente de variación del ROM entre repeticiones (constancia). */
  cv_rom: number | null;
  /** Caída del ROM del último tercio frente al primero (fatiga), en %. */
  caida_rom_pct: number | null;
  duracion_media_rep_s: number | null;
  velocidad_media_gr_s: number | null;
  rom_tronco_medio: number | null;
  /** Ángulos medios de cadera, rodilla, tobillo y tronco en el extremo de cada repetición. */
  angulos_medios_en_extremo: Record<string, number | null>;
  /** ROM medio de cada articulación (cadera, rodilla, tobillo, tronco) en la serie. */
  rom_medio_por_articulacion: Record<string, number | null>;
  observaciones: string[];
};

/** Estado de la prescripción que manda el servicio en cada `fotograma`. */
export type SesionServidor = {
  fase: string;
  mensaje: string;
  angulo: number | null;
  angulos: Record<string, number | null>;
  serie: number;
  series_prescritas: number;
  repeticiones_serie: number;
  repeticiones_prescritas: number;
  correctas_serie: number;
  repeticiones_totales: number;
  correctas_totales: number;
  terminado: boolean;
  series_cerradas: ResumenSerie[];
};
