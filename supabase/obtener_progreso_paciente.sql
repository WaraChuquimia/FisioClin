-- Datos de la pestaña "Progreso": semana en curso, últimas 4 semanas,
-- racha de días consecutivos, adherencia por ejercicio prescrito e
-- historial reciente de sesiones. security definer, mismo motivo que las
-- demás funciones de esta carpeta.

create or replace function public.obtener_progreso_paciente(p_id_paciente integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with presc as (
    select pr.id_prescripcion, pr.id_ejercicio, pr.series, pr.repeticiones,
           ec.nombre, ec.articulacion_objetivo::text as zona
    from public.prescripciones_vigentes(p_id_paciente) pr
    join public.ejercicios_catalogo ec on ec.id_ejercicio = pr.id_ejercicio
  ),
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
  ),
  ses_dia_todas as (
    select distinct s.fecha_hora::date as fecha
    from public.sesiones s
    where s.id_paciente = p_id_paciente
      and s.completado = true
  ),
  -- Racha: días consecutivos con sesión, contando hacia atrás desde hoy.
  -- Se corta apenas aparece un día sin sesión (incluido hoy, si aún no se
  -- hizo nada).
  racha_serie as (
    select n,
           exists(select 1 from ses_dia_todas d where d.fecha = current_date - n) as tiene
    from generate_series(0, 120) as n
  ),
  racha_calc as (
    select n, tiene,
           bool_and(tiene) over (order by n rows between unbounded preceding and current row) as consecutiva
    from racha_serie
  ),
  racha as (
    select count(*) as dias from racha_calc where consecutiva
  ),
  semanas as (
    select g.n as semanas_atras,
           (date_trunc('week', current_date)::date - (g.n * 7)) as inicio_semana
    from generate_series(0, 3) as g(n)
  ),
  ses_semana as (
    select sem.semanas_atras, count(*) as hechas
    from semanas sem
    left join public.sesiones s
      on s.id_paciente = p_id_paciente
     and s.completado = true
     and s.fecha_hora::date >= sem.inicio_semana
     and s.fecha_hora::date < sem.inicio_semana + 7
    group by sem.semanas_atras
  )
  select jsonb_build_object(
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

    'progreso_mensual', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'semana', ss.semanas_atras,
                 'valor', case
                            when (select count(*) from presc) = 0 then 0
                            else least(1.0, round(
                                   ss.hechas::numeric
                                   / ((select count(*) from presc) * 7), 2))
                          end
               )
               order by ss.semanas_atras desc
             )
      from ses_semana ss
    ), '[]'::jsonb),

    'racha_dias', coalesce((select dias from racha), 0),

    'total_sesiones_completadas', (
      select count(*) from public.sesiones s
      where s.id_paciente = p_id_paciente and s.completado = true
    ),

    'total_ejercicios_prescritos', (select count(*) from presc),

    'por_ejercicio', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id_prescripcion', p.id_prescripcion,
                 'nombre', p.nombre,
                 'zona', p.zona,
                 'series', p.series,
                 'repeticiones', p.repeticiones,
                 'sesiones_completadas', (
                   select count(*) from public.sesiones s
                   where s.id_prescripcion = p.id_prescripcion and s.completado = true
                 )
               )
               order by p.nombre
             )
      from presc p
    ), '[]'::jsonb),

    'historial', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'fecha', s.fecha_hora,
                 'ejercicio', s.ejercicio,
                 'duracion_segundos', s.duracion_segundos,
                 'resultado_evaluacion', s.resultado_evaluacion
               )
               order by s.fecha_hora desc
             )
      from (
        select * from public.sesiones s
        where s.id_paciente = p_id_paciente and s.completado = true
        order by s.fecha_hora desc
        limit 10
      ) s
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.obtener_progreso_paciente(integer) to anon, authenticated;
