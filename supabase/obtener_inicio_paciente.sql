-- Datos de la pantalla de Inicio del paciente en una sola llamada.
-- Mismo patrón que buscar_paciente_por_carnet.sql y obtener_datos_inicio_paciente.sql:
-- security definer porque el login por carnet no abre sesión de Supabase Auth,
-- así que RLS (que exige auth.uid()) dejaría todo en cero.
--
-- Devuelve un objeto JSON con:
--   paciente                 -> nombre, código, articulación, ruta de foto
--   plan                     -> plan de tratamiento activo (o null)
--   ejercicios_hoy           -> prescripciones activas + si ya se hicieron hoy
--   progreso_semanal         -> 7 días (L..D) con el avance 0..1 de cada uno
--   minutos_sesion           -> suma estimada de la sesión de hoy, en minutos
--   notificaciones_sin_leer  -> contador para la campana

create or replace function public.obtener_inicio_paciente(p_id_paciente integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with pac as (
    select p.id_paciente, p.id_usuario, p.nombre_completo, p.nombres,
           p.codigo_anonimo,
           p.articulacion_principal::text as articulacion_principal,
           p.foto_rostro_path
    from public.pacientes p
    where p.id_paciente = p_id_paciente
      and p.activo = true
  ),
  presc as (
    select pr.id_prescripcion, pr.series, pr.repeticiones,
           ec.id_ejercicio, ec.nombre,
           ec.articulacion_objetivo::text as zona,
           ec.duracion_estimada_segundos
    from public.prescripciones_vigentes(p_id_paciente) pr
    join public.ejercicios_catalogo ec on ec.id_ejercicio = pr.id_ejercicio
  ),
  plan_activo as (
    select pt.id_plan, pt.objetivo_general, pt.fecha_inicio,
           pt.duracion_estimada_semanas, pt.fecha_fin_estimada, pt.estado,
           m.nombre_completo as medico_responsable
    from public.planes_tratamiento pt
    join public.medicos m on m.id_medico = pt.id_medico_responsable
    where pt.id_paciente = p_id_paciente
      and pt.estado = 'activo'
    order by pt.fecha_inicio desc
    limit 1
  ),
  -- Lunes de la semana en curso + los 7 días con su etiqueta.
  dias as (
    select g.i,
           (date_trunc('week', current_date)::date + g.i) as fecha,
           (array['L','M','X','J','V','S','D'])[g.i + 1]  as etiqueta
    from generate_series(0, 6) as g(i)
  ),
  ses_dia as (
    select s.fecha_hora::date as fecha, count(*) as hechas
    from public.sesiones s
    where s.id_paciente = p_id_paciente
      and s.completado = true
      and s.fecha_hora::date >= date_trunc('week', current_date)::date
    group by s.fecha_hora::date
  )
  select jsonb_build_object(
    'paciente', (select to_jsonb(pac) from pac),
    'plan',     (select to_jsonb(plan_activo) from plan_activo),

    'ejercicios_hoy', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id_prescripcion', pr.id_prescripcion,
                 'id_ejercicio',    pr.id_ejercicio,
                 'nombre',          pr.nombre,
                 'zona',            pr.zona,
                 'series',          pr.series,
                 'repeticiones',    pr.repeticiones,
                 'duracion_estimada_segundos', pr.duracion_estimada_segundos,
                 'completado', exists (
                   select 1 from public.sesiones s
                   where s.id_prescripcion = pr.id_prescripcion
                     and s.completado = true
                     and s.fecha_hora::date = current_date
                 )
               )
               order by pr.nombre
             )
      from presc pr
    ), '[]'::jsonb),

    'progreso_semanal', (
      select jsonb_agg(
               jsonb_build_object(
                 'dia', d.etiqueta,
                 'valor', case
                            when (select count(*) from presc) = 0 then 0
                            else least(1.0, round(
                                   coalesce(sd.hechas, 0)::numeric
                                   / (select count(*) from presc), 2))
                          end
               )
               order by d.i
             )
      from dias d
      left join ses_dia sd on sd.fecha = d.fecha
    ),

    'minutos_sesion', coalesce((
      select round(sum(pr.duracion_estimada_segundos)::numeric / 60)
      from presc pr
    ), 0),

    'notificaciones_sin_leer', coalesce((
      select count(*)
      from public.notificaciones n
      where n.id_paciente = p_id_paciente
        and n.leida = false
    ), 0)
  );
$$;

grant execute on function public.obtener_inicio_paciente(integer) to anon, authenticated;
