import { supabase } from './supabase';

export type EjercicioAsignado = {
  id_prescripcion: number;
  id_ejercicio: number;
  nombre: string;
  zona: string;
  series: number;
  repeticiones: number;
  duracion_estimada_segundos: number;
  completado: boolean;
};

export type PlanTratamiento = {
  id_plan: number;
  objetivo_general: string;
  fecha_inicio: string;
  duracion_estimada_semanas: number;
  fecha_fin_estimada: string;
  estado: string;
  medico_responsable: string;
};

export async function obtenerEjerciciosHoy(idPaciente: number): Promise<EjercicioAsignado[]> {
  const { data, error } = await supabase.rpc('obtener_ejercicios_hoy_paciente', {
    p_id_paciente: idPaciente,
  });
  if (error) throw error;
  return (data ?? []) as EjercicioAsignado[];
}

export async function obtenerPlanActivo(idPaciente: number): Promise<PlanTratamiento | null> {
  const { data, error } = await supabase.rpc('obtener_plan_activo_paciente', {
    p_id_paciente: idPaciente,
  });
  if (error) throw error;
  return (data ?? null) as PlanTratamiento | null;
}

export type DiaProgreso = { dia: string; valor: number };

export type PacienteInicio = {
  id_paciente: number;
  id_usuario: number | null;
  nombre_completo: string | null;
  nombres: string | null;
  codigo_anonimo: string;
  articulacion_principal: string;
  foto_rostro_path: string | null;
};

export type InicioData = {
  paciente: PacienteInicio | null;
  plan: PlanTratamiento | null;
  ejercicios_hoy: EjercicioAsignado[];
  progreso_semanal: DiaProgreso[];
  minutos_sesion: number;
  notificaciones_sin_leer: number;
};

// Trae en una sola llamada todo lo que pinta la pantalla de Inicio.
export async function obtenerInicioPaciente(idPaciente: number): Promise<InicioData> {
  const { data, error } = await supabase.rpc('obtener_inicio_paciente', {
    p_id_paciente: idPaciente,
  });
  if (error) throw error;

  const d = (data ?? {}) as Partial<InicioData>;
  return {
    paciente: d.paciente ?? null,
    plan: d.plan ?? null,
    ejercicios_hoy: d.ejercicios_hoy ?? [],
    progreso_semanal: d.progreso_semanal ?? [],
    minutos_sesion: d.minutos_sesion ?? 0,
    notificaciones_sin_leer: d.notificaciones_sin_leer ?? 0,
  };
}
