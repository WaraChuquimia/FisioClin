/* ==================================================================
   FisioClin — la ventana deslizante que alimenta al LSTM
   ==================================================================

   El modelo no mira fotogramas sueltos: mira 3 segundos seguidos (30
   fotogramas a 10 Hz) y se le pregunta cada segundo. Esta clase junta
   los fotogramas que van llegando del servicio de visión y avisa cuando
   hay una ventana completa y utilizable.

   «Utilizable» tiene un criterio medido, no inventado: en el
   entrenamiento se descartaban las ventanas con más del 30 % de huecos
   en las columnas del lado que trabaja. Se respeta aquí para que la app
   no le dé al modelo material que nunca vio.
   ================================================================== */

import ESCALADOR from '@/ml/fisioclin_escalador.json';

import {
  COLUMNAS_PRINCIPALES,
  FEATURES,
  PASO_VENTANA,
  PASOS_VENTANA,
} from './tipos';

/** Tolerancia de huecos por columna principal, igual que en el dataset. */
const MAX_FALTANTE = 0.3;

const NF = FEATURES.length;

/** Valor neutro de cada feature: la media del entrenamiento. */
const MEDIA = Float32Array.from(ESCALADOR.media);

export class VentanaDeslizante {
  /** Buffer circular [30 x 14]. NaN marca «no medido». */
  private buf = new Float32Array(PASOS_VENTANA * NF).fill(NaN);
  /** Dónde se escribe el próximo fotograma. */
  private cursor = 0;
  /** Cuántos fotogramas entraron en total. */
  private vistos = 0;
  /** Fotogramas desde la última ventana entregada. */
  private desdeUltima = 0;

  /**
   * Mete un fotograma.
   *
   * @param features  14 valores en grados / grados-s, o null donde no se midió
   * @returns una ventana [30 x 14] rellenada y lista para `predecir`, o
   *          null si todavía no toca (no hay 30 fotogramas, no pasó 1 s,
   *          o la ventana tiene demasiados huecos)
   */
  push(features: (number | null | undefined)[]): Float32Array | null {
    if (features.length !== NF) {
      throw new Error(`Se esperaban ${NF} features, llegaron ${features.length}`);
    }

    const off = this.cursor * NF;
    for (let j = 0; j < NF; j++) {
      const v = features[j];
      this.buf[off + j] = v === null || v === undefined || !Number.isFinite(v) ? NaN : v;
    }

    this.cursor = (this.cursor + 1) % PASOS_VENTANA;
    this.vistos++;
    this.desdeUltima++;

    if (this.vistos < PASOS_VENTANA) return null;
    if (this.desdeUltima < PASO_VENTANA) return null;
    this.desdeUltima = 0;

    return this.materializar();
  }

  /** Vacía el buffer. Llamar al cambiar de ejercicio o al perder a la persona. */
  reiniciar(): void {
    this.buf.fill(NaN);
    this.cursor = 0;
    this.vistos = 0;
    this.desdeUltima = 0;
  }

  /** Fracción 0..1 de fotogramas acumulados hacia la primera ventana. */
  get llenado(): number {
    return Math.min(1, this.vistos / PASOS_VENTANA);
  }

  /**
   * Desenrolla el buffer circular a orden cronológico y rellena huecos.
   * Devuelve null si alguna columna principal supera MAX_FALTANTE.
   */
  private materializar(): Float32Array | null {
    const out = new Float32Array(PASOS_VENTANA * NF);
    for (let t = 0; t < PASOS_VENTANA; t++) {
      const src = ((this.cursor + t) % PASOS_VENTANA) * NF;
      out.set(this.buf.subarray(src, src + NF), t * NF);
    }

    for (const j of COLUMNAS_PRINCIPALES) {
      let huecos = 0;
      for (let t = 0; t < PASOS_VENTANA; t++) if (Number.isNaN(out[t * NF + j])) huecos++;
      if (huecos / PASOS_VENTANA > MAX_FALTANTE) return null;
    }

    rellenar(out);
    return out;
  }
}

/**
 * Tapa los huecos de cada columna: primero arrastrando el último valor
 * bueno hacia adelante, luego el primero hacia atrás, y si la columna
 * entera está vacía la pone en la media del entrenamiento — que tras
 * escalar vale 0, la suposición más neutra disponible.
 *
 * Se modifica la matriz en sitio.
 */
export function rellenar(m: Float32Array): void {
  const pasos = m.length / NF;

  for (let j = 0; j < NF; j++) {
    let ultimo = NaN;
    for (let t = 0; t < pasos; t++) {
      const i = t * NF + j;
      if (Number.isNaN(m[i])) m[i] = ultimo;
      else ultimo = m[i];
    }

    // Los huecos del principio no tenían nada detrás: se rellenan desde el frente.
    let siguiente = NaN;
    for (let t = pasos - 1; t >= 0; t--) {
      const i = t * NF + j;
      if (Number.isNaN(m[i])) m[i] = siguiente;
      else siguiente = m[i];
    }

    for (let t = 0; t < pasos; t++) {
      const i = t * NF + j;
      if (Number.isNaN(m[i])) m[i] = MEDIA[j];
    }
  }
}
