/* ==================================================================
   FisioClin — el entrenador que habla
   ==================================================================

   El paciente hace el ejercicio a 2–3 metros del teléfono: no puede leer
   la pantalla. La voz es lo que le dice si lo está haciendo bien.

   Tres niveles, para que no sea una voz que no se calla:

     ALTA   repetición cerrada, serie cerrada, sesión terminada.
            Siempre se dice; corta lo que se estuviera diciendo si era
            menos importante.
     MEDIA  corrección de postura mientras se mueve ("Mantén la espalda
            recta"). Solo si no se está diciendo otra cosa, y como mucho
            una cada `ESPACIO_CORRECCION_MS`; la misma frase no se repite
            antes de `REPETIR_MISMA_MS`.
     BAJA   ánimo e indicaciones de preparación. Solo en silencio.

   Usa expo-speech, que viene incluido en Expo Go.
   ================================================================== */

import * as Speech from 'expo-speech';

export const PRIORIDAD = { BAJA: 0, MEDIA: 1, ALTA: 2 } as const;
type Prioridad = (typeof PRIORIDAD)[keyof typeof PRIORIDAD];

/** Mínimo entre dos correcciones cualesquiera. */
const ESPACIO_CORRECCION_MS = 4000;
/** Mínimo para repetir exactamente la misma frase de corrección. */
const REPETIR_MISMA_MS = 9000;

/** Español latinoamericano; si el teléfono no tiene esa voz usa la que haya. */
const IDIOMA = 'es-US';

/** Un poco más lento que el habla normal: a 1.0 (el valor por defecto que
 *  usaba antes) la voz de Android suena apurada, como leyendo una lista.
 *  0.94 es el punto donde sigue sonando natural pero ya no atropella las
 *  frases cortas ("3 de 10. Bien hecha.") que es lo que más se repite. */
const VELOCIDAD = 0.94;

/**
 * Identificador de la mejor voz en español que tenga el teléfono, o
 * `undefined` si no se pudo averiguar (entonces se usa la del sistema).
 * `null` = todavía no se consultó. Se guarda una sola vez por sesión: no
 * tiene sentido volver a preguntarle al sistema operativo en cada frase.
 *
 * Por qué importa: en Android, la voz "compacta" que viene instalada de
 * fábrica (la que se usa si no se pide ninguna en particular) es la más
 * robótica de todas. Las voces "Enhanced" (de red, las que Google llama
 * "voces de alta calidad" en Ajustes > Accesibilidad > Síntesis de voz)
 * suenan notablemente más humanas. No todos los teléfonos las tienen
 * descargadas, por eso esto se pregunta en vivo en vez de asumir una.
 */
let vozElegidaPromesa: Promise<string | undefined> | null = null;

async function elegirVoz(): Promise<string | undefined> {
  try {
    const voces = await Speech.getAvailableVoicesAsync();
    const espanolas = voces.filter((v) => v.language?.toLowerCase().startsWith('es'));
    const mejor =
      espanolas.find(
        (v) => v.quality === Speech.VoiceQuality.Enhanced && v.language.toLowerCase() === 'es-us'
      ) ??
      espanolas.find((v) => v.quality === Speech.VoiceQuality.Enhanced) ??
      espanolas.find((v) => v.language.toLowerCase() === 'es-us') ??
      espanolas[0];
    return mejor?.identifier;
  } catch {
    // Sin lista de voces (web, o el teléfono no contestó): se usa la del
    // sistema para `IDIOMA`, que es el comportamiento de siempre.
    return undefined;
  }
}

export class Entrenador {
  private activo = true;
  private pendientes = 0;
  private prioridadActual: Prioridad = PRIORIDAD.BAJA;
  private ultimaVez = new Map<string, number>();
  private ultimaCorreccion = 0;
  /** undefined mientras se resuelve: la primera frase de la sesión puede
   *  salir con la voz por defecto si `elegirVoz()` no terminó a tiempo —
   *  no vale la pena bloquear la bienvenida por esto. */
  private voz: string | undefined;

  constructor() {
    // Se pide apenas se crea el entrenador (al entrar a la pantalla), no
    // en la primera frase: así para cuando el paciente termine de
    // colocarse (varios segundos) ya está lista.
    if (!vozElegidaPromesa) vozElegidaPromesa = elegirVoz();
    void vozElegidaPromesa.then((v) => {
      this.voz = v;
    });
  }

  setActivo(v: boolean) {
    this.activo = v;
    if (!v) this.callar();
  }

  get hablando() {
    return this.pendientes > 0;
  }

  callar() {
    this.pendientes = 0;
    void Speech.stop();
  }

  /**
   * @param clave       para no repetir la misma indicación seguido
   * @param espacioMs   cuánto tiempo debe pasar antes de volver a decir esta clave
   */
  decir(texto: string, prioridad: Prioridad, clave = texto, espacioMs = 0) {
    if (!this.activo || !texto) return;
    const ahora = Date.now();
    const antes = this.ultimaVez.get(clave);
    if (antes && ahora - antes < espacioMs) return;

    if (this.hablando) {
      // Si ya se está hablando, lo que no es ALTO se descarta.
      if (prioridad < PRIORIDAD.ALTA) return;
      // Algo ALTO interrumpe una corrección o un ánimo; dos ALTOS seguidos
      // (repetición + serie terminada) se encolan, no se pisan.
      if (this.prioridadActual < PRIORIDAD.ALTA) this.callar();
    }

    this.ultimaVez.set(clave, ahora);
    this.prioridadActual = prioridad;
    this.pendientes++;
    const fin = () => {
      this.pendientes = Math.max(0, this.pendientes - 1);
    };
    Speech.speak(texto, {
      language: IDIOMA,
      voice: this.voz,
      rate: VELOCIDAD,
      onDone: fin,
      onStopped: fin,
      onError: fin,
    });
  }

  /** Corrección de postura durante el movimiento, con su propio freno. */
  corregir(texto: string) {
    const ahora = Date.now();
    if (ahora - this.ultimaCorreccion < ESPACIO_CORRECCION_MS) return;
    if (this.hablando) return;
    this.ultimaCorreccion = ahora;
    this.decir(paraVoz(texto), PRIORIDAD.MEDIA, `corr:${texto}`, REPETIR_MISMA_MS);
  }
}

/** Texto de pantalla → texto para leer en voz alta: "(7 s)" se leería
 *  "siete ese"; se dice "de 7 segundos". */
function paraVoz(texto: string) {
  return texto.replace(/\s*\((\d+(?:[.,]\d+)?)\s*s\)/g, ', de $1 segundos');
}

/** Motivo de la regla (lo que se guarda y ve el médico) → lo que se le dice
 *  al paciente para corregir en la siguiente repetición. En tono de
 *  entrenador, no de reporte: "qué hacer ahora", no "qué saliste mal". */
const CONSEJO: Record<string, string> = {
  'No frenaste la vuelta': 'Frena un poco más al volver',
  'El movimiento de ida fue brusco': 'Empieza con más control, sin tirón',
  'Ritmo distinto del prescrito': 'Un poco más despacio, contando los segundos',
  'Estás compensando con el tronco': 'Mantén el tronco bien quieto',
  'Un lado recorre más que el otro': 'Mueve los dos lados por igual',
  'Pareces estar moviendo los dos lados a la vez': 'Este es de un lado a la vez, no los dos juntos',
  'No aguantaste el tiempo prescrito': 'Aguanta un poco más la próxima',
  'Perdiste el equilibrio o te moviste de mas': 'Busca un punto fijo para mirar, ayuda a no tambalear',
};

/** Consejo para el paciente a partir del motivo de una repetición
 *  incorrecta ("Estás compensando con el tronco (12°)" → "Mantén el
 *  tronco bien quieto"). */
export function consejoPara(motivo: string) {
  return CONSEJO[motivo.replace(/\s*\(.*\)$/, '')] ?? paraVoz(motivo);
}

/** "series" / "serie", "repeticiones" / "repetición". */
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/* ------------------------------------------------------------------
   Frases. En un solo sitio para poder ajustarlas con el fisioterapeuta.
   Tono de entrenador que acompaña, no de máquina que reporta: frases
   cortas, naturales al oído, que validan el esfuerzo antes de corregir.
   ------------------------------------------------------------------ */

export const frases = {
  /**
   * Lo primero que oye al abrir el ejercicio, antes de tocar Empezar: qué
   * ejercicio es, cuánto le toca, cómo se hace y dónde ponerse. Así puede
   * dejar el teléfono y colocarse sin leer la pantalla.
   */
  presentacion(op: {
    nombre: string;
    series: number;
    repeticiones: number;
    sostenido: boolean;
    comoHacerlo: string | null;
    camara: string | null;
    posicion: string | null;
  }) {
    const dosis = op.sostenido
      ? `Te toca ${plural(op.series, 'serie', 'series')} de ${plural(op.repeticiones, 'vez', 'veces')}, aguantando la posición.`
      : `Te toca hacer ${plural(op.series, 'serie', 'series')} de ${plural(op.repeticiones, 'repetición', 'repeticiones')}.`;
    return [
      `Vamos a hacer: ${op.nombre}.`,
      dosis,
      op.comoHacerlo ? `Cómo se hace: ${paraVoz(op.comoHacerlo).replace(/\.?$/, '.')}` : '',
      op.camara ?? '',
      op.posicion ? `Posición inicial: ${op.posicion}` : '',
      'Cuando estés en posición, toca Empezar.',
    ]
      .filter(Boolean)
      .join(' ');
  },

  /** Al tocar Empezar: la serie que arranca, el ritmo y qué cuenta como bien hecha. */
  comienzo(series: number, repeticiones: number, tempo?: string | null, criterio?: string | null) {
    return [
      `Comenzamos. Serie 1 de ${series}: ${plural(repeticiones, 'repetición', 'repeticiones')}.`,
      tempo ?? '',
      criterio ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  },

  empezar: 'Vamos. Colócate en la posición inicial.',
  pausa: 'Pausado. Cuando quieras, seguimos.',
  reanudar: 'Dale, seguimos.',
  sinPersona: 'No te veo bien. Ponte frente a la cámara, de cuerpo entero.',
  reposicionate: 'Muévete un poco, no se te ve bien la pierna.',
  colocate: 'Ponte en la posición inicial.',
  calibrando: 'Quédate quieto un momento.',
  listo: 'Perfecto. Cuando quieras, empieza.',
  animo: 'Así, muy bien.',

  repeticion(numero: number, total: number, bien: boolean, motivo?: string, pctRomObjetivo?: number | null) {
    if (bien) return `${numero} de ${total}. ¡Bien hecha!`;
    if (!motivo) return `${numero} de ${total}.`;
    // Caso más confuso para el paciente: llegó bien de recorrido pero
    // falló por otra razón (ritmo, tronco...). Si no se lo decimos
    // primero, siente que el esfuerzo de llegar no contó para nada.
    const reconocimiento = pctRomObjetivo != null && pctRomObjetivo >= 90 ? 'Buen recorrido. ' : '';
    return `${numero} de ${total}. ${reconocimiento}${consejoPara(motivo)}.`;
  },

  serie(n: number, correctas: number, prescritas: number, veredicto: string, quedan: number) {
    const cuantas = `${correctas} de ${prescritas} bien hechas`;
    const juicio =
      veredicto === 'BIEN_HECHA'
        ? '¡Excelente serie!'
        : veredicto === 'MEJORABLE'
          ? 'Buena serie, se puede mejorar un poco.'
          : veredicto === 'INCOMPLETA'
            ? 'Faltaron repeticiones, nada más.'
            : 'Vamos a cuidar la técnica en la siguiente.';
    const despues = quedan > 0 ? 'Descansa, y cuando estés listo seguimos con la otra.' : '';
    return `Serie ${n} terminada. ${cuantas}. ${juicio} ${despues}`.trim();
  },

  terminado: '¡Terminaste todas las series! Muy bien. Estoy guardando tu sesión.',

  /** Se cumplió la duración del catálogo (Editar Ejercicio → Duración,
   *  distinta por ejercicio). Solo avisa, no corta la sesión. */
  metaTiempo: 'Ya pasó el tiempo recomendado para este ejercicio.',

  /**
   * Retroalimentación al cerrar la sesión: que se acabó, cuántas hizo y
   * cuántas bien, qué mejorar la próxima vez, y la pregunta del dolor (la
   * barra 0-10 de la pantalla de cierre).
   */
  resumenFinal(op: { hechas: number; correctas: number; prescritas: number; consejo?: string | null }) {
    const { hechas, correctas, prescritas, consejo } = op;
    const dolor = 'Para terminar, marca en la pantalla cuánto te dolió, de cero a diez.';
    if (hechas === 0) {
      return `La sesión terminó. Esta vez no se contó ninguna repetición; revisa la posición frente a la cámara y vuelve a intentarlo. ${dolor}`;
    }
    const completa = prescritas > 0 && hechas >= prescritas;
    const inicio = completa
      ? '¡Sesión terminada! Completaste tu ejercicio de hoy.'
      : 'La sesión terminó. Quedó guardada hasta donde llegaste.';
    const cuantas = prescritas > 0 ? `Hiciste ${hechas} de ${prescritas} repeticiones` : `Hiciste ${hechas} repeticiones`;
    const pct = correctas / hechas;
    const juicio =
      correctas === hechas
        ? '¡y todas salieron correctas! Excelente trabajo.'
        : pct >= 0.7
          ? `y ${correctas} salieron correctas. ¡Muy bien!`
          : correctas === 0
            ? 'pero ninguna quedó correcta. No te preocupes, la técnica mejora con la práctica.'
            : `y ${correctas} salieron correctas. Vas mejorando.`;
    const mejorar = consejo && correctas < hechas ? `Para la próxima: ${consejo.replace(/\.?$/, '.')}` : '';
    return [inicio, `${cuantas}, ${juicio}`, mejorar, dolor].filter(Boolean).join(' ');
  },

  /** Respuesta al marcar el dolor en la escala 0-10. */
  dolor(nivel: number) {
    if (nivel === 0) return 'Cero, sin dolor. ¡Muy bien! Toca Continuar para terminar.';
    if (nivel <= 3) return `${nivel}, dolor leve. Es normal al hacer ejercicio. Toca Continuar para terminar.`;
    if (nivel <= 6)
      return `${nivel}, dolor moderado. Descansa un poco, y si sigue igual, coméntalo con tu médico. Toca Continuar para terminar.`;
    return `${nivel}, dolor fuerte. Descansa y no fuerces el movimiento. Tu médico verá este registro; si el dolor no baja, avísale. Toca Continuar para terminar.`;
  },
};
