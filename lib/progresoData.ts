import { supabase } from './supabase';

export type DiaProgreso = { dia: string; valor: number };
export type SemanaProgreso = { semana: number; valor: number };

export type EjercicioProgreso = {
  id_prescripcion: number;
  nombre: string;
  zona: string;
  series: number;
  repeticiones: number;
  sesiones_completadas: number;
};

export type SesionHistorial = {
  fecha: string;
  ejercicio: string;
  duracion_segundos: number;
  resultado_evaluacion: string | null;
};

export type ProgresoPaciente = {
  progreso_semanal: DiaProgreso[];
  progreso_mensual: SemanaProgreso[];
  racha_dias: number;
  total_sesiones_completadas: number;
  total_ejercicios_prescritos: number;
  por_ejercicio: EjercicioProgreso[];
  historial: SesionHistorial[];
};

export async function obtenerProgresoPaciente(idPaciente: number): Promise<ProgresoPaciente> {
  const { data, error } = await supabase.rpc('obtener_progreso_paciente', {
    p_id_paciente: idPaciente,
  });
  if (error) throw error;

  const d = (data ?? {}) as Partial<ProgresoPaciente>;
  return {
    progreso_semanal: d.progreso_semanal ?? [],
    progreso_mensual: d.progreso_mensual ?? [],
    racha_dias: d.racha_dias ?? 0,
    total_sesiones_completadas: d.total_sesiones_completadas ?? 0,
    total_ejercicios_prescritos: d.total_ejercicios_prescritos ?? 0,
    por_ejercicio: d.por_ejercicio ?? [],
    historial: d.historial ?? [],
  };
}
