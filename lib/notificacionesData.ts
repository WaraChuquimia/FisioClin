import { supabase } from './supabase';

export type Notificacion = {
  id_notificacion: number;
  tipo: string | null;
  categoria: string | null;
  severidad: string | null;
  titulo: string;
  mensaje: string;
  leida: boolean;
  fecha_creacion: string;
};

export async function obtenerNotificaciones(idPaciente: number): Promise<Notificacion[]> {
  const { data, error } = await supabase.rpc('obtener_notificaciones_paciente', {
    p_id_paciente: idPaciente,
  });
  if (error) throw error;
  return (data ?? []) as Notificacion[];
}

/** Sin `ids` marca todas las del paciente. */
export async function marcarNotificacionesLeidas(idPaciente: number, ids?: number[]) {
  const { error } = await supabase.rpc('marcar_notificaciones_leidas', {
    p_id_paciente: idPaciente,
    p_ids: ids ?? null,
  });
  if (error) throw error;
}
