-- Marca / desmarca como completado, para hoy, un ejercicio prescrito.
-- Usado por el checkbox de la "Rutina del Día" en la pestaña Ejercicios.
-- Inserta o borra la sesión de hoy asociada a esa prescripción; nunca toca
-- sesiones de otros días. security definer por el mismo motivo que el
-- resto de funciones: no hay sesión de Supabase Auth detrás del login.

create or replace function public.marcar_ejercicio_hoy(
  p_id_prescripcion integer,
  p_completado boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  presc record;
begin
  select pr.id_paciente, pr.id_ejercicio, ec.nombre, ec.duracion_estimada_segundos
    into presc
    from public.prescripciones_ejercicio pr
    join public.ejercicios_catalogo ec on ec.id_ejercicio = pr.id_ejercicio
   where pr.id_prescripcion = p_id_prescripcion
     and pr.id_prescripcion in (
       select v.id_prescripcion from public.prescripciones_vigentes(pr.id_paciente) v
     );

  if presc is null then
    raise exception 'Prescripción % no encontrada o inactiva', p_id_prescripcion;
  end if;

  if p_completado then
    insert into public.sesiones
      (id_paciente, id_prescripcion, id_ejercicio, ejercicio, fecha_hora,
       duracion_segundos, estado, completado, resultado_evaluacion)
    select
      presc.id_paciente, p_id_prescripcion, presc.id_ejercicio, presc.nombre,
      now(), presc.duracion_estimada_segundos, 'completada', true, 'correcto'
    where not exists (
      select 1 from public.sesiones s
      where s.id_prescripcion = p_id_prescripcion
        and s.completado = true
        and s.fecha_hora::date = current_date
    );
  else
    -- Solo se quita la marca MANUAL de hoy (una sesión sin repeticiones ni
    -- ángulos). Antes borraba también las sesiones con cámara: el médico
    -- perdía datos reales por desmarcar una casilla.
    delete from public.sesiones s
    where s.id_prescripcion = p_id_prescripcion
      and s.completado = true
      and s.fecha_hora::date = current_date
      and not exists (select 1 from public.repeticiones_ejercicio r where r.id_sesion = s.id_sesion)
      and not exists (select 1 from public.metricas_articulares m where m.id_sesion = s.id_sesion);
  end if;

  return jsonb_build_object('id_prescripcion', p_id_prescripcion, 'completado', p_completado);
end;
$$;

grant execute on function public.marcar_ejercicio_hoy(integer, boolean) to anon, authenticated;
