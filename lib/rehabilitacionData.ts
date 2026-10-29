import type { ResumenGuia } from './fisioclin/guiaPostura';
import type { ResumenSesion } from './fisioclin/tipos';
import { supabase } from './supabase';

export type CalidadSesion = {
  fps_medio: number;
  pct_filas_interpoladas: number;
  pct_frames_descartados: number;
  /** Traza de ángulos a 10 Hz de la sesión, para el Bland-Altman del objetivo 4. */
  serie_angulos?: { t: number; angulo: number | null }[];
  /** Similitud promedio y ejercicio que más reconoció el LSTM
   *  (guiaPostura.ts). Se guarda en `sesiones.observaciones`. */
  guia?: ResumenGuia;
};

export type EstadoGuardado = 'completada' | 'incompleta' | 'abandonada';

/**
 * Guarda una sesión de rehabilitación con cámara: cabecera, repeticiones y
 * ángulos. La base decide si quedó completa (todas las repeticiones
 * prescritas → el ejercicio de hoy cuenta como hecho), incompleta o
 * abandonada. Ver supabase/guardar_sesion_rehabilitacion.sql.
 */
export async function guardarSesion(
  resumen: ResumenSesion,
  opciones: { idPaciente: number; idPrescripcion: number | null; calidad?: CalidadSesion }
): Promise<{ idSesion: number; estado: EstadoGuardado | null; hechas: number; prescritas: number }> {
  const { data, error } = await supabase.rpc('guardar_sesion_rehabilitacion', {
    p_id_paciente: opciones.idPaciente,
    p_id_prescripcion: opciones.idPrescripcion,
    p_resumen: resumen,
    p_calidad: opciones.calidad ?? {},
  });
  if (error) throw error;
  const d = (data ?? {}) as { id_sesion?: number; estado?: EstadoGuardado; hechas?: number; prescritas?: number };
  return {
    idSesion: Number(d.id_sesion),
    // null si en Supabase sigue la versión anterior de la función.
    estado: d.estado ?? null,
    hechas: Number(d.hechas ?? resumen.repeticiones_detectadas),
    prescritas: Number(d.prescritas ?? resumen.series_prescritas * resumen.repeticiones_prescritas),
  };
}

export type MomentoDolor = 'antes_sesion' | 'despues_sesion' | 'independiente';

/**
 * Guarda cuánto le duele al paciente (escala EVA 0-10) en `registro_dolor`.
 * Ver supabase/registrar_dolor.sql — `idSesion` liga el registro a una
 * sesión de cámara concreta; null si se registra fuera de una sesión.
 */
export async function registrarDolor(opciones: {
  idPaciente: number;
  nivelDolor: number;
  momento?: MomentoDolor;
  idSesion?: number | null;
  articulacion?: string | null;
  observaciones?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('registrar_dolor', {
    p_id_paciente: opciones.idPaciente,
    p_nivel_dolor: opciones.nivelDolor,
    p_momento: opciones.momento ?? 'independiente',
    p_id_sesion: opciones.idSesion ?? null,
    p_articulacion: opciones.articulacion ?? null,
    p_observaciones: opciones.observaciones ?? null,
  });
  if (error) throw error;
}
