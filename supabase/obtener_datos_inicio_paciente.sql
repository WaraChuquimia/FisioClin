-- Datos para la pantalla de Inicio del paciente: plan de tratamiento activo
-- y ejercicios prescritos. Mismo patrón que buscar_paciente_por_carnet.sql:
-- security definer porque RLS exige auth.uid() y el login del paciente en la
-- app no crea una sesión de Supabase Auth (solo valida el carnet).

create or replace function public.obtener_plan_activo_paciente(p_id_paciente integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(t)
  from (
    select
      pt.id_plan,
      pt.objetivo_general,
      pt.fecha_inicio,
      pt.duracion_estimada_semanas,
      pt.fecha_fin_estimada,
      pt.estado,
      m.nombre_completo as medico_responsable
    from public.planes_tratamiento pt
    join public.medicos m on m.id_medico = pt.id_medico_responsable
    where pt.id_paciente = p_id_paciente
      and pt.estado = 'activo'
    order by pt.fecha_inicio desc
    limit 1
  ) t;
$$;

grant execute on function public.obtener_plan_activo_paciente(integer) to anon, authenticated;


create or replace function public.obtener_ejercicios_hoy_paciente(p_id_paciente integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(fila order by fila->>'nombre'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id_prescripcion', pr.id_prescripcion,
      'id_ejercicio', ec.id_ejercicio,
      'nombre', ec.nombre,
      'zona', ec.articulacion_objetivo::text,
      'series', pr.series,
      'repeticiones', pr.repeticiones,
      'duracion_estimada_segundos', ec.duracion_estimada_segundos,
      'completado', exists (
        select 1 from public.sesiones s
        where s.id_prescripcion = pr.id_prescripcion
          and s.completado = true
          and s.fecha_hora::date = current_date
      )
    ) as fila
    from public.prescripciones_vigentes(p_id_paciente) pr
    join public.ejercicios_catalogo ec on ec.id_ejercicio = pr.id_ejercicio
  ) t;
$$;

grant execute on function public.obtener_ejercicios_hoy_paciente(integer) to anon, authenticated;
