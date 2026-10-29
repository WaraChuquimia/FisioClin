/* ==================================================================
   FisioClin — guía de postura en vivo
   ==================================================================

   Puerto a la app de `probar_modelo.py` (motor autónomo de escritorio):
   la postura OBJETIVO de cada ejercicio, el % de similitud contra ella,
   las correcciones en vivo y el color del esqueleto según la similitud.

   Lo que NO se portó, a propósito:
   - El conteo de repeticiones por umbrales de rodilla (`rep_down/rep_up`):
     la app ya cuenta con `evaluador.ts`, con bandas medidas sobre el
     dataset por ejercicio y articulación. Las del script son a mano y
     siempre miran la rodilla, así que en ejercicios de cadera no cuentan.
   - Mostrar el ejercicio que "reconoce" el LSTM: el ejercicio ya viene
     prescrito y la cabeza de ejercicio acierta ~59 %. Se registra por
     dentro (ver `AcumuladorGuia`) y se guarda en la sesión, pero no se le
     muestra al paciente.

   Convención de ángulos (¡distinta a la del script!):
   - El script usa el ángulo INTERNO en 2D sobre píxeles: 180° = segmento
     estirado. Las metas `obj_cad`/`obj_rod` de abajo están en esa escala,
     copiadas tal cual.
   - El servicio de visión manda FLEXIÓN en 3D (world landmarks):
     0° = estirado, como un goniómetro. flexión = 180 − ángulo interno.
     `metaDe()` hace la conversión; la similitud no cambia porque solo usa
     diferencias (|(180−a) − (180−b)| = |a − b|).
   - El tronco del script (`atan2` sobre píxeles) da ~180° con la persona
     de pie, así que su regla "tronco > 35°" saltaba SIEMPRE. Aquí se usa la
     inclinación del servicio (0° = vertical) comparada con la postura
     normal del ejercicio (`tronco_mediano_grados` del catálogo), porque en
     un ejercicio acostado el tronco horizontal no es un error.
   ================================================================== */

/** Metas en ángulo interno (180° = estirado), copiadas de probar_modelo.py. */
type MetaScript = { obj_cad: number; obj_rod: number };

const METAS_BIOMECANICAS: Record<string, MetaScript> = {
  sentadilla_profunda: { obj_cad: 85.0, obj_rod: 75.0 },
  sentadilla_con_peso_muerto: { obj_cad: 95.0, obj_rod: 90.0 },
  sentadilla_bulgara: { obj_cad: 90.0, obj_rod: 85.0 },
  puente_de_gluteos: { obj_cad: 165.0, obj_rod: 90.0 },
  hip_thrust: { obj_cad: 170.0, obj_rod: 85.0 },
  clamshell: { obj_cad: 110.0, obj_rod: 90.0 },
  abduccion_de_cadera_en_decubito: { obj_cad: 170.0, obj_rod: 175.0 },
  elevacion_lateral_de_pierna: { obj_cad: 165.0, obj_rod: 175.0 },
  flexion_de_rodilla_al_pecho: { obj_cad: 65.0, obj_rod: 55.0 },
  extension_flexion_de_rodilla: { obj_cad: 100.0, obj_rod: 90.0 },
  extension_de_rodilla_con_cojin: { obj_cad: 140.0, obj_rod: 170.0 },
  extension_de_rodilla_en_prono: { obj_cad: 175.0, obj_rod: 85.0 },
  rotacion_de_cadera: { obj_cad: 135.0, obj_rod: 90.0 },
  dead_bug: { obj_cad: 90.0, obj_rod: 90.0 },
};
const META_DEFAULT: MetaScript = { obj_cad: 100.0, obj_rod: 90.0 };

export type MetaPostura = {
  /** Ángulo interno objetivo (escala del script), para dibujar el muñeco. */
  internoCadera: number;
  internoRodilla: number;
  /** Mismas metas en flexión (escala del servicio de visión). */
  flexCadera: number;
  flexRodilla: number;
  /** false si el ejercicio no estaba en el script y se usó la meta genérica. */
  especifica: boolean;
};

/** Meta del ejercicio por su nombre del catálogo ('dead_bug', 'clamshell'…). */
export function metaDe(nombreEjercicio: string | undefined): MetaPostura {
  const m = (nombreEjercicio && METAS_BIOMECANICAS[nombreEjercicio]) || null;
  const meta = m ?? META_DEFAULT;
  return {
    internoCadera: meta.obj_cad,
    internoRodilla: meta.obj_rod,
    flexCadera: 180 - meta.obj_cad,
    flexRodilla: 180 - meta.obj_rod,
    especifica: m != null,
  };
}

/** % de parecido con la postura objetivo (fórmula del script: 100 − 0,85·error medio). */
export function similitud(flexCadera: number, flexRodilla: number, meta: MetaPostura): number {
  const errRod = Math.abs(flexRodilla - meta.flexRodilla);
  const errCad = Math.abs(flexCadera - meta.flexCadera);
  const desviacion = (errRod + errCad) / 2;
  return Math.max(0, Math.min(100, Math.round(100 - desviacion * 0.85)));
}

/** Umbral de inclinación extra del tronco (grados) antes de pedir alinearlo. */
const TOLERANCIA_TRONCO = 35;

export const TEXTO_EXCELENTE = 'Excelente ejecución y simetría';

/**
 * Correcciones en vivo, mismas reglas que el script (en su escala de
 * ángulo interno) salvo la del tronco, corregida (ver cabecera).
 * `enMovimiento` = el paciente está bajando/subiendo, lo que en el script
 * era `fase == "down"`.
 */
export function correcciones(p: {
  flexRodilla: number;
  inclinacionTronco: number | null;
  troncoEsperado: number | null;
  enMovimiento: boolean;
  meta: MetaPostura;
}): string[] {
  const salida: string[] = [];
  const rodInterno = 180 - p.flexRodilla;

  if (rodInterno > p.meta.internoRodilla + 20 && p.enMovimiento) {
    salida.push('Flexiona más la articulación');
  } else if (rodInterno < p.meta.internoRodilla - 25) {
    salida.push('Flexión excesiva, recupera la postura');
  }

  if (p.inclinacionTronco != null) {
    const desvio = Math.abs(p.inclinacionTronco - (p.troncoEsperado ?? 0));
    if (desvio > TOLERANCIA_TRONCO) salida.push('Mantén la espalda alineada');
  }

  if (salida.length === 0) salida.push(TEXTO_EXCELENTE);
  return salida;
}

/** Mismos cortes que el script: ≥75 verde, ≥50 ámbar, si no rojo. */
export function colorPorSimilitud(s: number | null): string | null {
  if (s == null) return null;
  if (s >= 75) return '#1E8A4C';
  if (s >= 50) return '#C98A12';
  return '#C0392B';
}

export type EstadoGuia = {
  /** null mientras no haya dato fiable. */
  similitud: number | null;
  correcciones: string[];
};

export const GUIA_INICIAL: EstadoGuia = { similitud: null, correcciones: [] };

/**
 * Lo que el script guardaba al final (`similitud_promedio`,
 * `ejercicio_predominante`), acumulado durante la sesión.
 */
function masVotado(votos: Map<string, number>): [string | null, number] {
  let ganador: string | null = null;
  let n = 0;
  for (const [k, v] of votos) {
    if (v > n) {
      ganador = k;
      n = v;
    }
  }
  return [ganador, n];
}

export class AcumuladorGuia {
  private sumaSimilitud = 0;
  private nSimilitud = 0;
  private votosLstm = new Map<string, number>();
  private votosCalidad = new Map<string, number>();
  private ventanasLstm = 0;
  private conteoCorrecciones = new Map<string, number>();
  /** Lo mismo, pero solo desde que cerró la última repetición. */
  private repSuma = 0;
  private repN = 0;
  private repCorrecciones = new Set<string>();

  agregarSimilitud(s: number, correccionesActivas: string[] = []) {
    this.sumaSimilitud += s;
    this.nSimilitud += 1;
    this.repSuma += s;
    this.repN += 1;
    for (const c of correccionesActivas) {
      if (c === TEXTO_EXCELENTE) continue;
      this.conteoCorrecciones.set(c, (this.conteoCorrecciones.get(c) ?? 0) + 1);
      this.repCorrecciones.add(c);
    }
  }

  /** Ejercicio y calidad que da el LSTM en una ventana de 3 s. */
  agregarPrediccion(ejercicio: string, calidad?: string) {
    this.votosLstm.set(ejercicio, (this.votosLstm.get(ejercicio) ?? 0) + 1);
    if (calidad) this.votosCalidad.set(calidad, (this.votosCalidad.get(calidad) ?? 0) + 1);
    this.ventanasLstm += 1;
  }

  /** Cierra una repetición: su similitud media y las correcciones que hubo
   *  durante ella. Se guardan en `repeticiones_ejercicio`. */
  cerrarRepeticion() {
    const r = {
      similitud_media: this.repN ? Math.round(this.repSuma / this.repN) : null,
      correcciones_guia: [...this.repCorrecciones],
    };
    this.repSuma = 0;
    this.repN = 0;
    this.repCorrecciones.clear();
    return r;
  }

  reiniciar() {
    this.sumaSimilitud = 0;
    this.nSimilitud = 0;
    this.votosLstm.clear();
    this.votosCalidad.clear();
    this.ventanasLstm = 0;
    this.conteoCorrecciones.clear();
    this.cerrarRepeticion();
  }

  resumen() {
    const [predominante, votos] = masVotado(this.votosLstm);
    const [calidad] = masVotado(this.votosCalidad);
    const frecuentes = [...this.conteoCorrecciones.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => c);
    return {
      similitud_promedio: this.nSimilitud ? Math.round(this.sumaSimilitud / this.nSimilitud) : null,
      muestras_similitud: this.nSimilitud,
      lstm_predominante: predominante,
      lstm_pct_ventanas: this.ventanasLstm ? Math.round((votos / this.ventanasLstm) * 100) : null,
      lstm_ventanas: this.ventanasLstm,
      /** La "calidad_final" del script: lo que más dijo la cabeza de calidad. */
      lstm_calidad_predominante: calidad,
      correcciones_frecuentes: frecuentes,
    };
  }
}

/** Grado de movilidad según el % del ROM meta alcanzado en la repetición. */
export function movilidadDe(pctRomObjetivo: number | null | undefined) {
  if (pctRomObjetivo == null) return null;
  if (pctRomObjetivo >= 90) return { texto: 'NORMAL', nivel: 4 };
  if (pctRomObjetivo >= 70) return { texto: 'LEVE', nivel: 3 };
  if (pctRomObjetivo >= 40) return { texto: 'MODERADA', nivel: 2 };
  return { texto: 'SEVERA', nivel: 1 };
}

export type ResumenGuia = ReturnType<AcumuladorGuia['resumen']>;
