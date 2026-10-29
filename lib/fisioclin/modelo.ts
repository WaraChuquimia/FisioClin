/* ==================================================================
   FisioClin — el LSTM, en JavaScript puro
   ==================================================================

   Expo Go no puede cargar un .tflite: eso necesita un módulo nativo y
   por tanto un development build. Pero el modelo es diminuto —
   LSTM(32) → LSTM(16) → Densa(16) → dos cabezas, unos 9.800 pesos — así
   que en vez de arrastrar TensorFlow se reescribió el paso hacia
   adelante aquí. Son ~270.000 multiplicaciones por ventana, menos de
   3 ms en Hermes, y solo corre una vez por segundo.

   Los pesos salieron de `fisioclin_lstm (4).tflite` con des-cuantización
   int8 por canal. Comprobado contra el intérprete de TFLite sobre
   entradas aleatorias: error máximo 1,6e-4 en las probabilidades, que es
   el propio ruido de la cuantización.

   ADVERTENCIA — la cabeza de ejercicio no está lista para usarse como
   filtro, y esto está medido, no supuesto.

   Se pasó el vídeo del catálogo del puente de glúteos por dos caminos:
   por este código, y por el pipeline original del dataset (savgol no
   causal incluido, o sea features idénticas a las del entrenamiento).
   Los dos caminos coinciden entre sí — buena señal para el puerto — y
   los dos se equivocan igual:

       por el pipeline del dataset : 97,2 % "elevacion_de_pierna_recta"
       por este código, en vivo    :  100 % "elevacion_de_pierna_recta"
       P(puente_de_gluteos)        : media 0,032, máximo 0,041
                                     (el prior uniforme es 0,05)

   Es decir: sobre ese ejercicio la red no reconoce el correcto ni
   teniendo las features perfectas. `verificarEjercicio` avisaría de
   "ejercicio equivocado" a un paciente que lo está haciendo bien, así
   que viene apagada por defecto en `useEvaluadorFisioclin`. Enciéndela
   cuando hayas medido, ejercicio por ejercicio, en cuáles acierta.

   La cabeza de CALIDAD tiene el mismo problema documentado desde el
   entrenamiento: 0,462 contra una línea base de 0,642. Quien evalúa es
   `evaluador.ts`, con las reglas calculadas exactas sobre los ángulos.
   Eso sí funciona y no depende de la red.
   ================================================================== */

import CLASES from '@/ml/fisioclin_clases.json';
import ESCALADOR from '@/ml/fisioclin_escalador.json';
import PESOS from '@/ml/fisioclin_lstm_pesos.json';
import VECTOR from '@/ml/fisioclin_vector_prueba.json';

import { FEATURES, PASOS_VENTANA, type Prediccion, type Veredicto } from './tipos';

/* ------------------------------------------------------------------
   Comprobaciones de coherencia. Si alguien regenera el modelo y cambia
   el orden de las features, se entera aquí y no con predicciones raras.
   ------------------------------------------------------------------ */
if (ESCALADOR.features.join('|') !== FEATURES.join('|')) {
  throw new Error(
    'El orden de features del escalador no coincide con tipos.ts. ' +
      'Vuelve a exportar el modelo o corrige FEATURES.'
  );
}

const MEDIA = Float32Array.from(ESCALADOR.media);
const DESV = Float32Array.from(ESCALADOR.desviacion);

export const EJERCICIOS: string[] = CLASES.ejercicios;
export const CALIDADES = CLASES.calidad as Veredicto[];

/* ------------------------------------------------------------------
   Álgebra mínima. Todo plano en Float32Array: nada de arrays de arrays,
   que en Hermes cuestan caro.
   ------------------------------------------------------------------ */

type Capa = { unidades: number; entrada: number; W: Float32Array; U: Float32Array; b: Float32Array };
type Densa = { filas: number; cols: number; W: Float32Array; b: Float32Array };

function capa(p: { unidades: number; entrada: number; W: number[]; U: number[]; b: number[] }): Capa {
  return {
    unidades: p.unidades,
    entrada: p.entrada,
    W: Float32Array.from(p.W), // [4u x entrada], por filas
    U: Float32Array.from(p.U), // [4u x u], por filas
    b: Float32Array.from(p.b), // [4u]
  };
}

function densa(p: { W: number[]; b: number[] }, filas: number, cols: number): Densa {
  return { filas, cols, W: Float32Array.from(p.W), b: Float32Array.from(p.b) };
}

const LSTM1 = capa(PESOS.lstm1);
const LSTM2 = capa(PESOS.lstm2);
const DENSA = densa(PESOS.densa, PESOS.densa.unidades, PESOS.densa.entrada);
const CABEZA_EJ = densa(PESOS.cabeza_ejercicio, PESOS.cabeza_ejercicio.clases, DENSA.filas);
const CABEZA_CAL = densa(PESOS.cabeza_calidad, PESOS.cabeza_calidad.clases, DENSA.filas);

const sigmoide = (x: number) => 1 / (1 + Math.exp(-x));

/** out = W·x + b, con W guardada por filas. */
function afin(m: Densa, x: Float32Array, out: Float32Array): Float32Array {
  const { W, b, filas, cols } = m;
  for (let i = 0; i < filas; i++) {
    let s = b[i];
    const base = i * cols;
    for (let j = 0; j < cols; j++) s += W[base + j] * x[j];
    out[i] = s;
  }
  return out;
}

function softmax(z: Float32Array): number[] {
  let max = -Infinity;
  for (let i = 0; i < z.length; i++) if (z[i] > max) max = z[i];
  let suma = 0;
  const out = new Array<number>(z.length);
  for (let i = 0; i < z.length; i++) {
    const e = Math.exp(z[i] - max);
    out[i] = e;
    suma += e;
  }
  for (let i = 0; i < z.length; i++) out[i] /= suma;
  return out;
}

/**
 * Una capa LSTM sobre la secuencia completa.
 *
 * Compuertas en el orden de Keras: i, f, g, o — cada bloque de
 * `unidades` filas consecutivas de W, U y b.
 *
 * @param seq  secuencia plana [pasos x entrada]
 * @param devolverSecuencia  true para alimentar otra LSTM, false para quedarse
 *                           solo con el último estado oculto
 */
function lstm(c: Capa, seq: Float32Array, pasos: number, devolverSecuencia: boolean): Float32Array {
  const u = c.unidades;
  const ent = c.entrada;
  const h = new Float32Array(u);
  const cel = new Float32Array(u);
  const z = new Float32Array(4 * u);
  const salida = devolverSecuencia ? new Float32Array(pasos * u) : h;

  for (let t = 0; t < pasos; t++) {
    const off = t * ent;

    // z = W·x_t + U·h_{t-1} + b
    for (let k = 0; k < 4 * u; k++) {
      let s = c.b[k];
      const bw = k * ent;
      for (let j = 0; j < ent; j++) s += c.W[bw + j] * seq[off + j];
      const bu = k * u;
      for (let j = 0; j < u; j++) s += c.U[bu + j] * h[j];
      z[k] = s;
    }

    for (let j = 0; j < u; j++) {
      const i = sigmoide(z[j]);
      const f = sigmoide(z[u + j]);
      const g = Math.tanh(z[2 * u + j]);
      const o = sigmoide(z[3 * u + j]);
      const nueva = f * cel[j] + i * g;
      cel[j] = nueva;
      h[j] = o * Math.tanh(nueva);
    }

    if (devolverSecuencia) salida.set(h, t * u);
  }

  return salida;
}

/**
 * Escala una ventana cruda a la distribución del entrenamiento.
 *
 * @param ventana  [30 x 14] plana, en grados y grados/s
 * @returns la misma ventana escalada, en un buffer nuevo
 */
export function escalar(ventana: Float32Array): Float32Array {
  const n = FEATURES.length;
  const out = new Float32Array(ventana.length);
  for (let t = 0; t < ventana.length / n; t++) {
    const off = t * n;
    for (let j = 0; j < n; j++) {
      // Una desviación de 0 significaría una feature constante; no ocurre
      // en este escalador, pero dividir por 0 daría NaN y envenenaría todo.
      out[off + j] = DESV[j] > 1e-9 ? (ventana[off + j] - MEDIA[j]) / DESV[j] : 0;
    }
  }
  return out;
}

/**
 * Corre el modelo sobre una ventana de 3 s.
 *
 * @param ventana  [30 x 14] plana y SIN escalar (se escala aquí dentro)
 */
export function predecir(ventana: Float32Array): Prediccion {
  const esperado = PASOS_VENTANA * FEATURES.length;
  if (ventana.length !== esperado) {
    throw new Error(`La ventana debe medir ${esperado} (30x14), llegó ${ventana.length}`);
  }

  const x = escalar(ventana);
  const s1 = lstm(LSTM1, x, PASOS_VENTANA, true);
  const h2 = lstm(LSTM2, s1, PASOS_VENTANA, false);

  const d = afin(DENSA, h2, new Float32Array(DENSA.filas));
  for (let i = 0; i < d.length; i++) if (d[i] < 0) d[i] = 0; // ReLU

  const probsEj = softmax(afin(CABEZA_EJ, d, new Float32Array(CABEZA_EJ.filas)));
  const probsCal = softmax(afin(CABEZA_CAL, d, new Float32Array(CABEZA_CAL.filas)));

  const iEj = argmax(probsEj);
  const iCal = argmax(probsCal);

  return {
    ejercicio: EJERCICIOS[iEj],
    ejercicio_idx: iEj,
    p_ejercicio: probsEj[iEj],
    calidad: CALIDADES[iCal],
    p_calidad: probsCal[iCal],
    probs_ejercicio: probsEj,
    probs_calidad: probsCal,
  };
}

/**
 * La misma predicción, pero SOLO entre los ejercicios prescritos al
 * paciente. La red conoce 20 ejercicios; si el médico le recetó 2, no tiene
 * sentido que "reconozca" uno de los otros 18. Las probabilidades de los no
 * prescritos se ponen en 0 y las demás se reescalan para que sumen 1.
 *
 * @param permitidos  nombres como en fisioclin_clases.json ('sentadilla_profunda'…).
 *                    Vacío = sin restricción (la predicción tal cual).
 */
export function restringirAPrescritos(p: Prediccion, permitidos: string[]): Prediccion {
  const idx = permitidos.map((n) => EJERCICIOS.indexOf(n)).filter((i) => i >= 0);
  if (!idx.length) return p;
  const total = idx.reduce((a, i) => a + p.probs_ejercicio[i], 0);
  const probs = p.probs_ejercicio.map((_, i) =>
    idx.includes(i) ? (total > 0 ? p.probs_ejercicio[i] / total : 1 / idx.length) : 0
  );
  const iEj = argmax(probs);
  return { ...p, ejercicio: EJERCICIOS[iEj], ejercicio_idx: iEj, p_ejercicio: probs[iEj], probs_ejercicio: probs };
}

/**
 * ¿El paciente está haciendo el ejercicio que le prescribieron?
 *
 * Devuelve la probabilidad que el modelo le da al ejercicio esperado, no
 * al que él cree ver — que es la pregunta útil.
 *
 * NO la uses todavía para bloquear ni para regañar al paciente: en el
 * único ejercicio medido hasta ahora la red se equivoca incluso con las
 * features del entrenamiento (ver la cabecera del archivo). Sirve para
 * instrumentar y decidir, ejercicio por ejercicio, dónde vale.
 *
 * @param esperado  nombre del ejercicio, como aparece en fisioclin_clases.json
 * @param minimo    probabilidad por debajo de la cual se considera que no coincide.
 *                  0,25 = cinco veces el prior uniforme de 20 clases.
 */
export function verificarEjercicio(
  p: Prediccion,
  esperado: string,
  minimo = 0.25
): { coincide: boolean; probabilidad: number } {
  const idx = EJERCICIOS.indexOf(esperado);
  if (idx < 0) throw new Error(`Ejercicio desconocido para el modelo: ${esperado}`);
  const prob = p.probs_ejercicio[idx];
  return { coincide: prob >= minimo, probabilidad: prob };
}

function argmax(v: number[]): number {
  let mejor = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[mejor]) mejor = i;
  return mejor;
}

/**
 * Comprueba, en el teléfono, que este código reproduce el .tflite.
 *
 * `verificar_paridad.py` ya comprueba que los pesos exportados son los
 * del modelo entrenado, pero lo hace en CPython. Esto cubre lo otro: que
 * Hermes calcule igual. `Math.tanh` y `Math.exp` no están obligados por
 * la norma a dar el mismo bit en todos los motores, y este modelo
 * encadena 60 pasos de LSTM, así que conviene medirlo y no suponerlo.
 *
 * Llamar una vez al arrancar la pantalla de rehabilitación, en __DEV__.
 */
export function autoprueba(): { ok: boolean; error: number; detalle: string } {
  const ventana = Float32Array.from(VECTOR.ventana);
  const p = predecir(ventana);

  let peor = 0;
  for (let i = 0; i < VECTOR.ejercicio.length; i++) {
    peor = Math.max(peor, Math.abs(p.probs_ejercicio[i] - VECTOR.ejercicio[i]));
  }
  for (let i = 0; i < VECTOR.calidad.length; i++) {
    peor = Math.max(peor, Math.abs(p.probs_calidad[i] - VECTOR.calidad[i]));
  }

  const mismoArgmax =
    argmax(p.probs_ejercicio) === argmax(VECTOR.ejercicio) &&
    argmax(p.probs_calidad) === argmax(VECTOR.calidad);
  const ok = peor <= VECTOR.tolerancia && mismoArgmax;

  return {
    ok,
    error: peor,
    detalle: ok
      ? `LSTM correcto (error ${peor.toExponential(2)})`
      : `El LSTM en JS no coincide con el modelo entrenado: error ${peor.toExponential(2)}, ` +
        `tolerancia ${VECTOR.tolerancia}. Vuelve a exportar los pesos.`,
  };
}
