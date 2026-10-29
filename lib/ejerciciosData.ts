import { supabase } from './supabase';

export type EjercicioCatalogo = {
  id_ejercicio: number;
  nombre: string;
  descripcion: string | null;
  zona: string;
  duracion_estimada_segundos: number;
  /** 'C01'..'R10': liga con el catálogo de visión. null si no tiene sesión en vivo. */
  codigo_cv: string | null;
  /** Video de referencia subido por el médico (depósito privado). */
  video_bucket?: string | null;
  video_path?: string | null;
  /** Enlace externo que pegó el médico en lugar de subir un archivo. */
  video_url?: string | null;
  prescrito: boolean;
  id_prescripcion: number | null;
  series: number | null;
  repeticiones: number | null;
  /** true solo si hoy hizo TODAS las repeticiones (o lo marcó a mano). */
  completado_hoy: boolean;
  /** Repeticiones de su mejor sesión de hoy con cámara (0 si no hizo ninguna). */
  repeticiones_hechas_hoy?: number;
};

/** Total prescrito para hoy: series × repeticiones (null si falta alguno). */
export const totalPrescrito = (e: Pick<EjercicioCatalogo, 'series' | 'repeticiones'>) =>
  e.series != null && e.repeticiones != null ? e.series * e.repeticiones : null;

/**
 * El siguiente ejercicio que le toca hacer hoy: el primero sin terminar,
 * dando prioridad a los que se pueden hacer con la cámara. null si ya
 * terminó todo.
 */
export function siguientePendiente(lista: EjercicioCatalogo[]): EjercicioCatalogo | null {
  const pendientes = lista.filter((e) => !e.completado_hoy && e.id_prescripcion != null);
  return pendientes.find((e) => e.codigo_cv && totalPrescrito(e)) ?? pendientes[0] ?? null;
}

export async function obtenerCatalogoEjercicios(idPaciente: number): Promise<EjercicioCatalogo[]> {
  const { data, error } = await supabase.rpc('obtener_catalogo_ejercicios', {
    p_id_paciente: idPaciente,
  });
  if (error) throw error;
  return (data ?? []) as EjercicioCatalogo[];
}

/** El ejercicio que corresponde a una prescripción, o null si ya no está vigente. */
export async function obtenerEjercicioPrescrito(
  idPaciente: number,
  idPrescripcion: number
): Promise<EjercicioCatalogo | null> {
  const lista = await obtenerCatalogoEjercicios(idPaciente);
  return lista.find((e) => e.id_prescripcion === idPrescripcion) ?? null;
}

/**
 * Dirección para reproducir el video de referencia. El archivo subido tiene
 * prioridad; el depósito es privado, así que se abre con un enlace temporal
 * (política en supabase/videos_ejercicios.sql). Si no hay archivo, se usa el
 * enlace externo. null si el ejercicio no tiene video.
 */
export async function urlVideoEjercicio(
  ej: Pick<EjercicioCatalogo, 'video_bucket' | 'video_path' | 'video_url'>,
  segundos = 60 * 60 * 2
): Promise<string | null> {
  if (ej.video_path) {
    const { data, error } = await supabase.storage
      .from(ej.video_bucket || 'ejercicios-videos')
      .createSignedUrl(ej.video_path, segundos);
    if (!error && data?.signedUrl) return data.signedUrl;
  }
  return ej.video_url?.trim() || null;
}

export async function marcarEjercicioHoy(idPrescripcion: number, completado: boolean) {
  const { error } = await supabase.rpc('marcar_ejercicio_hoy', {
    p_id_prescripcion: idPrescripcion,
    p_completado: completado,
  });
  if (error) throw error;
}
