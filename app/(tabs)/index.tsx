import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';

import { useAuth } from '@/context/AuthContext';
import { useFotoPerfil } from '@/context/FotoPerfilContext';
import { useNotificaciones } from '@/context/NotificacionesContext';
import { useRecargaAutomatica } from '@/hooks/useRecargaAutomatica';
import { InicioData, obtenerInicioPaciente } from '@/lib/pacienteData';

import InicioScreen, { DiaProgreso, Ejercicio, Tratamiento } from './inicio';

function formatearFecha(fecha: string) {
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return fecha;
  return d.toLocaleDateString('es-BO', { day: '2-digit', month: 'short' });
}

export default function HomeScreen() {
  const { patient } = useAuth();
  const router = useRouter();
  const { sinLeer } = useNotificaciones();
  const { url: fotoUrl } = useFotoPerfil();

  const [data, setData] = useState<InicioData | null>(null);

  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  // Se recarga al volver a Inicio (p. ej. después de una sesión con cámara),
  // cada 30 s y cuando el médico prescribe algo nuevo.
  const cargar = useCallback(async () => {
    if (idPaciente == null) return;
    try {
      setData(await obtenerInicioPaciente(idPaciente));
    } catch {
      // Sin red: se conserva lo último cargado y se reintenta.
    }
  }, [idPaciente]);
  useRecargaAutomatica(cargar);

  const nombrePaciente =
    data?.paciente?.nombre_completo ??
    data?.paciente?.nombres ??
    (typeof patient?.nombre_completo === 'string' ? patient.nombre_completo : undefined) ??
    (typeof patient?.nombres === 'string' ? patient.nombres : undefined);

  const ejercicios: Ejercicio[] = (data?.ejercicios_hoy ?? []).map((e) => ({
    id: String(e.id_prescripcion),
    nombre: e.nombre,
    zona: e.zona,
    series: e.series,
    repeticiones: e.repeticiones,
    completado: e.completado,
  }));

  const tratamiento: Tratamiento | null = data?.plan
    ? {
        objetivo: data.plan.objetivo_general,
        medicoResponsable: data.plan.medico_responsable,
        duracionSemanas: data.plan.duracion_estimada_semanas,
        fechaFinEstimada: formatearFecha(data.plan.fecha_fin_estimada),
        estado: data.plan.estado,
      }
    : null;

  const progresoSemanal: DiaProgreso[] | undefined =
    data?.progreso_semanal && data.progreso_semanal.length > 0
      ? data.progreso_semanal
      : undefined;

  return (
    <InicioScreen
      nombrePaciente={nombrePaciente}
      avatar={fotoUrl ? { uri: fotoUrl } : undefined}
      ejercicios={ejercicios}
      tratamiento={tratamiento}
      progresoSemanal={progresoSemanal}
      minutosSesion={data?.minutos_sesion || undefined}
      notificaciones={sinLeer}
      onPerfil={() => router.push('/(tabs)/perfil')}
      onVerTodos={() => router.push('/(tabs)/ejercicios')}
      onComenzarSesion={() => router.push('/(tabs)/rehabilitar')}
      onVerEjercicio={() => router.push('/(tabs)/rehabilitar')}
      onNotificaciones={() => router.push('/notificaciones')}
    />
  );
}
