/* ==================================================================
   FisioClin — posición inicial de cada ejercicio
   ==================================================================

   Lo que se le dice al paciente (en pantalla y en voz) antes de empezar:
   cómo colocarse, cómo se hace el movimiento y cómo ponerse respecto a la
   cámara.

   Importa para contar bien: el evaluador toma como "partida" el extremo del
   movimiento donde el paciente se queda quieto la primera vez
   (evaluador.ts / evaluador_series.py). Si empieza donde se le indica
   aquí, las repeticiones se cuentan desde ahí y la última no se pierde.

   La orientación a la cámara sale del plano del movimiento en el catálogo:
   flexión/extensión (plano sagital) se ve de COSTADO; abrir y cerrar las
   piernas (plano frontal) se ve de FRENTE.

   Textos a revisar con el fisioterapeuta: son la indicación clínica que
   escucha el paciente.
   ================================================================== */

import { fichaEjercicio } from './evaluador';

type Posicion = {
  /** Una línea para la pantalla. */
  corta: string;
  /** Lo que se dice en voz: cómo colocarse y desde dónde empieza. */
  completa: string;
};

/** Cómo se hace el movimiento, dicho en voz al presentar el ejercicio.
 *  Se usa cuando el médico no escribió una descripción propia en la base. */
const MOVIMIENTOS: Record<string, string> = {
  C01: 'Aprieta los glúteos y sube la cadera hasta que hombros, cadera y rodillas queden en línea recta. Aguanta un segundo arriba y baja despacio.',
  C02: 'Sin separar los pies, abre la rodilla de arriba como una almeja, sin girar la cadera hacia atrás. Aguanta un segundo y cierra despacio.',
  C03: 'Sube la pierna de arriba bien estirada, con la punta del pie mirando al frente y sin girar el cuerpo. Aguanta un segundo y bájala despacio.',
  C04: 'Deja caer las dos rodillas juntas hacia un lado, sin despegar la espalda del suelo, y vuelve al centro con control.',
  C05: 'Estira la rodilla levantando el talón, sin despegar el muslo del cojín. Aguanta un segundo arriba y baja despacio. Alterna las piernas.',
  C06: 'Lleva una rodilla hacia el pecho, doblándola, sin que la cadera se gire. Vuelve a estirarla despacio y repite con la otra pierna.',
  C07: 'Dobla una rodilla y lleva el talón hacia el glúteo, sin que duela. Mantén el estiramiento treinta segundos y cambia de pierna.',
  C08: 'Estira un brazo hacia atrás y la pierna contraria hacia adelante, despacio, sin despegar la espalda baja del suelo. Vuelve al centro y cambia de lado.',
  C09: 'Sube una pierna hacia atrás hasta la altura de la cadera, sin girar la cadera ni arquear la espalda. Bájala despacio y cambia de pierna.',
  C10: 'Con la rodilla doblada, abre una pierna hacia el costado sin girar el tronco. Bájala despacio y cambia de lado.',
  R01: 'Desliza el talón hacia la cadera doblando la rodilla todo lo que puedas sin dolor, y vuelve a estirarla por completo. Alterna las piernas.',
  R02: 'Con la rodilla bien estirada, sube la pierna hasta la altura de la otra rodilla. Aguanta un segundo y bájala despacio. Alterna las piernas.',
  R03: 'Sube la pierna de arriba estirada hacia el techo, sin echar el cuerpo hacia atrás. Bájala despacio.',
  R04: 'Empuja con los talones y sube la cadera hasta que el tronco y los muslos queden en línea recta. Aguanta un segundo y baja despacio.',
  R05: 'Dobla una rodilla llevando el talón hacia el glúteo, con el muslo quieto. Bájala despacio y cambia de pierna.',
  R06: 'Sube una rodilla hacia el pecho manteniéndote erguido. Bájala con control y cambia de pierna.',
  R07: 'Echa la cadera hacia atrás y dobla las rodillas como para sentarte, con la espalda recta y las rodillas sobre los pies. Vuelve a subir despacio.',
  R08: 'Baja doblando las rodillas todo lo que puedas con control, sin que las rodillas se vayan hacia adentro. Sube despacio.',
  R09: 'Baja doblando la rodilla de adelante, con el tronco recto y la rodilla firme. Sube despacio. Luego cambia de pierna.',
  R10: 'Levanta un pie del suelo y mantén el equilibrio sobre la otra pierna treinta segundos, quieto y derecho. Luego cambia de pierna.',
};

const POSICIONES: Record<string, Posicion> = {
  C01: {
    corta: 'Boca arriba, rodillas dobladas, cadera apoyada en el suelo',
    completa:
      'Acuéstate boca arriba con las rodillas dobladas, los pies apoyados en el suelo y los brazos a los lados. Empieza con la cadera apoyada en el suelo.',
  },
  C02: {
    corta: 'De lado, caderas y rodillas dobladas, rodillas juntas',
    completa:
      'Acuéstate de lado con las caderas y las rodillas dobladas, un pie sobre el otro. Empieza con las rodillas juntas.',
  },
  C03: {
    corta: 'De lado, piernas estiradas una sobre otra',
    completa:
      'Acuéstate de lado con las dos piernas estiradas, una sobre la otra. Empieza con la pierna de arriba apoyada sobre la de abajo.',
  },
  C04: {
    corta: 'Boca arriba, rodillas dobladas y juntas mirando al techo',
    completa:
      'Acuéstate boca arriba con las rodillas dobladas y los pies apoyados. Empieza con las rodillas juntas, mirando al techo.',
  },
  C05: {
    corta: 'Boca arriba, cojín bajo la rodilla, talón apoyado',
    completa:
      'Acuéstate boca arriba con un cojín debajo de la rodilla. Empieza con la rodilla doblada sobre el cojín y el talón apoyado.',
  },
  C06: {
    corta: 'Boca arriba, piernas estiradas y apoyadas',
    completa: 'Acuéstate boca arriba con las piernas estiradas. Empieza con las dos piernas apoyadas en el suelo.',
  },
  C07: {
    corta: 'Boca abajo, piernas estiradas',
    completa: 'Acuéstate boca abajo con las piernas estiradas. Empieza con la pierna estirada y apoyada.',
  },
  C08: {
    corta: 'Boca arriba, brazos al techo, caderas y rodillas a 90°',
    completa:
      'Acuéstate boca arriba con los brazos hacia el techo y las caderas y rodillas dobladas en ángulo recto. Empieza en esa posición, con la espalda baja pegada al suelo.',
  },
  C09: {
    corta: 'A cuatro patas, manos bajo hombros, rodillas bajo cadera',
    completa: 'Ponte a cuatro patas, con las manos debajo de los hombros y las rodillas debajo de la cadera.',
  },
  C10: {
    corta: 'A cuatro patas, las dos rodillas apoyadas',
    completa:
      'Ponte a cuatro patas, con las manos debajo de los hombros y las rodillas debajo de la cadera. Empieza con las dos rodillas apoyadas.',
  },
  R01: {
    corta: 'Boca arriba, rodilla estirada',
    completa: 'Acuéstate boca arriba con las piernas estiradas. Empieza con la rodilla estirada.',
  },
  R02: {
    corta: 'Boca arriba, una pierna doblada y la otra estirada en el suelo',
    completa:
      'Acuéstate boca arriba con una pierna doblada y el pie apoyado, y la otra estirada. Empieza con la pierna estirada apoyada en el suelo.',
  },
  R03: {
    corta: 'De lado, piernas estiradas una sobre otra',
    completa: 'Acuéstate de lado con las piernas estiradas, una sobre la otra.',
  },
  R04: {
    corta: 'Espalda apoyada en un banco, rodillas dobladas, cadera abajo',
    completa:
      'Apoya la parte alta de la espalda en un banco o sofá, con las rodillas dobladas y los pies apoyados. Empieza con la cadera abajo.',
  },
  R05: {
    corta: 'De pie, apoyándote en una silla, piernas estiradas',
    completa:
      'Ponte de pie apoyándote en una silla o en la pared. Empieza de pie, con las dos rodillas estiradas.',
  },
  R06: {
    corta: 'De pie, erguido, piernas estiradas',
    completa:
      'Ponte de pie, erguido, apoyándote en una silla si lo necesitas. Empieza de pie con las dos piernas estiradas.',
  },
  R07: {
    corta: 'De pie, pies al ancho de la cadera',
    completa: 'Ponte de pie con los pies separados al ancho de la cadera. Empieza de pie, erguido.',
  },
  R08: {
    corta: 'De pie, pies al ancho de los hombros, brazos al frente',
    completa:
      'Ponte de pie con los pies separados al ancho de los hombros y los brazos al frente. Empieza de pie, erguido.',
  },
  R09: {
    corta: 'De pie, de espaldas a una silla, empeine de atrás apoyado',
    completa:
      'Ponte de pie delante de una silla, dándole la espalda, y apoya el empeine del pie de atrás en ella. Empieza de pie, erguido.',
  },
  R10: {
    corta: 'De pie, cerca de una pared para apoyarte',
    completa: 'Ponte de pie cerca de una pared, para apoyarte si lo necesitas.',
  },
};

/** Cómo ponerse respecto a la cámara, según el plano del movimiento. */
function orientacionCamara(codigo: string): string {
  const plano = fichaEjercicio(codigo)?.plano;
  if (plano === 'sagital') return 'Colócate de costado a la cámara, que te vea de la cabeza a los pies.';
  if (plano === 'frontal') return 'Colócate de frente a la cámara, que te vea de la cabeza a los pies.';
  return 'Que la cámara te vea de la cabeza a los pies.';
}

/**
 * El ritmo que se evalúa, dicho para el paciente. La ficha dice "3-1-3":
 * 3 s de ida, 1 s quieto en el extremo, 3 s de vuelta. Si no se le dice,
 * hace el movimiento a su ritmo normal (1-2 s) y la regla de tempo la
 * marca como incorrecta aunque la técnica esté bien.
 */
function textoTempo(codigo: string): string | null {
  const tempo = fichaEjercicio(codigo)?.tempo_esperado?.trim().toLowerCase() ?? '';
  const m = /^(\d+)\s*-\s*(\d+)\s*-\s*(\d+)$/.exec(tempo);
  if (m) {
    const [, ida, pausa, vuelta] = m;
    return `Hazlo despacio: ${ida} segundos para ir, ${pausa} quieto, y ${vuelta} para volver.`;
  }
  const s = /(\d+)\s*s/.exec(tempo);
  return s ? `Mantén la posición ${s[1]} segundos.` : null;
}

/**
 * Qué decide que la repetición cuente como bien hecha — el
 * `criterio_ejecucion` que fijó el fisioterapeuta en la ficha clínica
 * (p. ej. "control de profundidad;alineación de rodilla" para R08), dicho
 * ANTES de empezar. Sin esto, el paciente solo sabe dónde ponerse, no qué
 * se le está evaluando — y "llegué hasta abajo" no es lo mismo que "lo
 * hice al ritmo que pide la ficha", que es lo que de verdad decide
 * correcta/incorrecta (evaluador.ts).
 */
function textoCriterio(codigo: string): string | null {
  const criterio = fichaEjercicio(codigo)?.criterio_ejecucion?.trim();
  if (!criterio) return null;
  const partes = criterio
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!partes.length) return null;
  return `Para que cuente como bien hecha: ${partes.join(', y ')}.`;
}

/** Posición inicial del ejercicio prescrito; null si el código no está en la tabla. */
export function posicionInicial(codigo: string):
  | (Posicion & { camara: string; tempo: string | null; criterio: string | null; movimiento: string | null })
  | null {
  const p = POSICIONES[codigo];
  return p
    ? {
        ...p,
        camara: orientacionCamara(codigo),
        tempo: textoTempo(codigo),
        criterio: textoCriterio(codigo),
        movimiento: MOVIMIENTOS[codigo] ?? null,
      }
    : null;
}
