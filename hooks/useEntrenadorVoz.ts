/* ==================================================================
   FisioClin — conecta la sesión en vivo con el entrenador de voz
   ==================================================================

   Escucha lo que ya calcula la pantalla (fase del evaluador, repeticiones,
   series cerradas por el Python, corrección de postura) y decide qué
   decir. No calcula nada nuevo: la voz dice lo mismo que la pantalla.
   ================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';

import { TEXTO_EXCELENTE } from '@/lib/fisioclin/guiaPostura';
import type { EstadoSesion, Repeticion, ResumenSerie } from '@/lib/fisioclin/tipos';
import { Entrenador, frases, PRIORIDAD } from '@/lib/fisioclin/voz';

type Opciones = {
  /** Interruptor "Instrucciones de voz" del Perfil. */
  activa: boolean;
  grabando: boolean;
  empezado: boolean;
  estado: EstadoSesion;
  repeticiones: Repeticion[];
  seriesCerradas: ResumenSerie[];
  terminado: boolean;
  /** Correcciones de la guía de postura en este momento. */
  correcciones: string[];
  seriesPrescritas: number;
  repsPrescritas: number;
  /** Posición inicial del ejercicio prescrito (lib/fisioclin/posiciones.ts). */
  posicion?: { completa: string; camara: string; tempo?: string | null; criterio?: string | null } | null;
  /** Presentación del ejercicio (frases.presentacion): se dice una vez al
   *  abrir la pantalla, antes de Empezar. null = todavía no hay datos. */
  presentacion?: string | null;
  /** Cronómetro de la sesión (segundos desde que empezó). */
  segundos?: number;
  /** Duración del catálogo ("Editar Ejercicio" → Duración, en el panel del
   *  médico): distinta por ejercicio. null = ese ejercicio no trae una. */
  duracionObjetivo?: number | null;
  /** true en los "sostenido" sin banda calibrada (hoy, R10): cambia qué
   *  significa pct_rom_objetivo (ver el comentario donde se usa). */
  esSostenido?: boolean;
};

/** Fases en las que tiene sentido corregir la postura. */
const EN_MOVIMIENTO = new Set(['MOVIMIENTO', 'EXTREMO', 'VUELTA']);

/** Cada cuánto, como mucho, se anima al paciente cuando todo va bien. */
const ANIMO_CADA_MS = 20000;

export function useEntrenadorVoz(op: Opciones) {
  const { activa, grabando, empezado, estado, repeticiones, seriesCerradas, terminado, correcciones } = op;
  const [entrenador] = useState(() => new Entrenador());

  useEffect(() => {
    entrenador.setActivo(activa);
  }, [activa, entrenador]);

  // Al salir de la pantalla no puede quedar hablando.
  useEffect(() => () => entrenador.callar(), [entrenador]);

  /* ── Presentación: qué ejercicio, cuánto, cómo se hace (una vez) ── */
  const presentado = useRef(false);
  useEffect(() => {
    if (!activa || presentado.current || empezado || !op.presentacion) return;
    presentado.current = true;
    entrenador.decir(op.presentacion, PRIORIDAD.ALTA, 'presentacion');
  }, [activa, empezado, op.presentacion, entrenador]);

  /** Botón "Escuchar instrucciones": vuelve a decir la presentación. */
  const repetirInstrucciones = useCallback(() => {
    if (!op.presentacion) return;
    entrenador.callar();
    entrenador.decir(op.presentacion, PRIORIDAD.ALTA, `presentacion:${Date.now()}`);
  }, [op.presentacion, entrenador]);

  /* ── Empezar / pausa / reanudar ── */
  const grabandoAntes = useRef(false);
  useEffect(() => {
    if (grabando && !grabandoAntes.current) {
      // Al empezar: la serie que arranca, el ritmo (lo que evalúa la regla
      // de tempo) y el criterio clínico — qué tiene que pasar para que
      // cuente como bien hecha, no solo hasta dónde llegar. Cómo se hace y
      // dónde ponerse ya lo dijo la presentación; si todavía la estaba
      // diciendo, se corta: el paciente ya decidió empezar.
      if (!repeticiones.length) entrenador.callar();
      const inicio = op.posicion
        ? frases.comienzo(op.seriesPrescritas, op.repsPrescritas, op.posicion.tempo, op.posicion.criterio)
        : frases.empezar;
      entrenador.decir(repeticiones.length ? frases.reanudar : inicio, PRIORIDAD.ALTA);
    } else if (!grabando && grabandoAntes.current && empezado && !terminado) {
      entrenador.decir(frases.pausa, PRIORIDAD.ALTA);
    }
    grabandoAntes.current = grabando;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al cambiar grabando
  }, [grabando, empezado, terminado, entrenador, op.posicion]);

  /* ── Preparación: una indicación por cambio de fase ── */
  useEffect(() => {
    if (!grabando) return;
    const texto =
      estado.fase === 'SIN_PERSONA'
        ? frases.sinPersona
        : estado.fase === 'DATO_NO_FIABLE'
          ? frases.reposicionate
          : estado.fase === 'COLOCATE'
            ? (op.posicion?.completa ?? frases.colocate)
            : estado.fase === 'CALIBRANDO'
              ? frases.calibrando
              : estado.fase === 'LISTO'
                ? frases.listo
                : null;
    // "Listo" importa (es la señal de arrancar); lo demás se recuerda cada 8 s.
    if (texto) {
      entrenador.decir(
        texto,
        estado.fase === 'LISTO' ? PRIORIDAD.MEDIA : PRIORIDAD.BAJA,
        `fase:${estado.fase}`,
        estado.fase === 'LISTO' ? 0 : estado.fase === 'COLOCATE' ? 12000 : 8000
      );
    }
  }, [estado.fase, grabando, entrenador, op.posicion]);

  /* ── Cada repetición: número y si estuvo bien, o por qué no ── */
  const repsDichas = useRef(0);
  useEffect(() => {
    if (repeticiones.length <= repsDichas.current) {
      repsDichas.current = repeticiones.length; // se reinició la sesión
      return;
    }
    const rep = repeticiones[repeticiones.length - 1];
    repsDichas.current = repeticiones.length;
    // Número dentro de la serie: el evaluador ya pasó a la siguiente serie
    // si esta fue la última, y entonces su contador vuelve a 0.
    const enSerie = estado.repeticiones > 0 ? estado.repeticiones : op.repsPrescritas;
    // En "sostenido" (R10), pct_rom_objetivo mide OSCILACIÓN contra el
    // objetivo, no profundidad: un valor alto ahí es que tembló mucho, lo
    // contrario de "buen recorrido". El reconocimiento solo tiene sentido
    // en los ejercicios cíclicos normales.
    const pctParaVoz = op.esSostenido ? null : rep.pct_rom_objetivo;
    entrenador.decir(
      frases.repeticion(enSerie, op.repsPrescritas, rep.veredicto === 'CORRECTA', rep.motivos[0], pctParaVoz),
      PRIORIDAD.ALTA,
      `rep:${rep.n}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuando llega una repetición nueva
  }, [repeticiones.length]);

  /* ── Cada serie cerrada por el servidor ── */
  const seriesDichas = useRef(0);
  useEffect(() => {
    if (seriesCerradas.length <= seriesDichas.current) {
      seriesDichas.current = seriesCerradas.length;
      return;
    }
    for (const s of seriesCerradas.slice(seriesDichas.current)) {
      const quedan = op.seriesPrescritas - s.serie;
      entrenador.decir(
        frases.serie(s.serie, s.correctas, s.repeticiones_prescritas, s.veredicto, quedan),
        PRIORIDAD.ALTA,
        `serie:${s.serie}`
      );
    }
    seriesDichas.current = seriesCerradas.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuando se cierra una serie
  }, [seriesCerradas.length]);

  /* ── Fin de todas las series: avisa que se acabó (la pantalla guarda sola) ── */
  useEffect(() => {
    if (!terminado) return;
    entrenador.decir(frases.terminado, PRIORIDAD.ALTA, 'terminado', 60000);
  }, [terminado, entrenador]);

  /* ── Al cerrar la sesión: la retroalimentación y la pregunta del dolor ── */
  const anunciarResumen = useCallback(
    (resumen: { hechas: number; correctas: number; prescritas: number; consejo?: string | null; repetir?: boolean }) => {
      // Al cerrar no se calla: si todavía está diciendo "Terminaste todas
      // las series", el resumen se encola detrás en vez de cortarlo. Con el
      // botón "Escuchar de nuevo" sí, para no oír dos cosas a la vez.
      if (resumen.repetir) entrenador.callar();
      entrenador.decir(frases.resumenFinal(resumen), PRIORIDAD.ALTA, 'resumen');
    },
    [entrenador]
  );

  /** Al marcar el dolor en la pantalla de cierre: se le responde. */
  const anunciarDolor = useCallback(
    (nivel: number) => {
      entrenador.callar();
      entrenador.decir(frases.dolor(nivel), PRIORIDAD.ALTA, `dolor:${Date.now()}`);
    },
    [entrenador]
  );

  /* ── Meta de tiempo del catálogo: un solo aviso, no corta la sesión ── */
  const metaDichaRef = useRef(false);
  useEffect(() => {
    if (!grabando) return;
    const { segundos, duracionObjetivo } = op;
    if (segundos == null || duracionObjetivo == null) return;
    if (segundos >= duracionObjetivo && !metaDichaRef.current) {
      metaDichaRef.current = true;
      entrenador.decir(frases.metaTiempo, PRIORIDAD.MEDIA, 'metaTiempo');
    }
  }, [op.segundos, op.duracionObjetivo, grabando, entrenador]);
  // Ejercicio distinto (cambia la meta) = puede volver a avisar.
  useEffect(() => {
    metaDichaRef.current = false;
  }, [op.duracionObjetivo]);

  /* ── Corrección de postura o ánimo, mientras se mueve ── */
  const primera = correcciones[0];
  useEffect(() => {
    if (!grabando || !EN_MOVIMIENTO.has(estado.fase) || !primera) return;
    if (primera === TEXTO_EXCELENTE) {
      entrenador.decir(frases.animo, PRIORIDAD.BAJA, 'animo', ANIMO_CADA_MS);
    } else {
      entrenador.corregir(primera);
    }
  }, [primera, estado.fase, grabando, entrenador]);

  return { anunciarResumen, anunciarDolor, repetirInstrucciones };
}
