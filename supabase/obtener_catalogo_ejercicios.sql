-- Ejercicios del paciente (pestaña "Ejercicios" y selector de la sesión con
-- cámara). Trae SOLO lo prescrito vigente (ver prescripciones_vigentes.sql):
-- nada de ejercicios no recetados ni repetidos. Marca cuáles ya se hicieron
-- hoy. Mismo patrón security definer que el resto: el login por carnet no
-- abre sesión de Supabase Auth.

create or replace function public.obtener_catalogo_ejercicios(p_id_paciente integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(fila order by fila->>'nombre'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id_ejercicio', ec.id_ejercicio,
      'nombre', ec.nombre,
      'descripcion', ec.descripcion,
      'zona', ec.articulacion_objetivo::text,
      'duracion_estimada_segundos', ec.duracion_estimada_segundos,
      -- 'C01'..'R10': liga con el catálogo de visión (ml/configuracion_ejercicios.json).
      -- null en los ejercicios del catálogo clínico que no tienen sesión en vivo.
      -- Ojo: NO es lo mismo que codigo_fisioclin (el código interno de la
      -- unidad, tipo 'ROD-01'); clase_lstm es específicamente el enlace con
      -- el modelo de reconocimiento.
      'codigo_cv', ec.clase_lstm,
      -- Video de referencia que subió el médico. El archivo (bucket privado)
      -- solo cuenta cuando terminó de subirse; la app lo abre con un enlace
      -- firmado (ver videos_ejercicios.sql). Si el médico pegó un enlace
      -- externo, va en video_url y se usa tal cual.
      'video_bucket', ec.video_bucket,
      'video_path', case when ec.video_estado = 'listo' then ec.video_storage_path end,
      'video_url', ec.video_referencia_url,
      'prescrito', pr.id_prescripcion is not null,
      'id_prescripcion', pr.id_prescripcion,
      'series', pr.series,
      'repeticiones', pr.repeticiones,
      -- Hecho hoy = una sesión COMPLETA (todas las repeticiones) o marcada
      -- a mano. Una sesión incompleta o abandonada no cuenta.
      'completado_hoy', pr.id_prescripcion is not null and exists (
        select 1 from public.sesiones s
        where s.id_prescripcion = pr.id_prescripcion
          and s.completado = true
          and s.fecha_hora::date = current_date
      ),
      -- Cuántas repeticiones hizo hoy en su mejor sesión con cámara, para
      -- mostrar "Realizado 4 de 6" cuando no terminó.
      'repeticiones_hechas_hoy', coalesce((
        select max(x.n) from (
          select count(r.id_repeticion) as n
          from public.sesiones s
          left join public.repeticiones_ejercicio r on r.id_sesion = s.id_sesion
          where s.id_prescripcion = pr.id_prescripcion
            and s.fecha_hora::date = current_date
          group by s.id_sesion
        ) x
      ), 0)
    ) as fila
    from public.prescripciones_vigentes(p_id_paciente) pr
    join public.ejercicios_catalogo ec on ec.id_ejercicio = pr.id_ejercicio
  ) t;
$$;

grant execute on function public.obtener_catalogo_ejercicios(integer) to anon, authenticated;
