-- =============================================================================
-- FisioClin (app del paciente) — funciones que llama la app por RPC
-- =============================================================================
-- IMPORTANTE — esto NO crea el esquema. El esquema real (28 tablas, RLS,
-- vistas de reporte, historial clínico, etc.) vive en el proyecto del
-- panel del médico:
--
--     C:\Users\WARA\FisioClinDoctor\sql\1_BASE_DE_DATOS.sql
--     C:\Users\WARA\FisioClinDoctor\sql\2_DATOS.sql              (datos de prueba)
--     C:\Users\WARA\FisioClinDoctor\sql\3_USUARIOS_Y_CLAVES.sql  (cuentas del panel)
--
-- Corre esos TRES archivos primero, en ese orden, en el SQL Editor de
-- Supabase (https://supabase.com/dashboard/project/ukjsbywrltiuqdawrnye/sql/new).
-- Después, y solo después, corre este archivo completo. Es idempotente
-- (create or replace): correrlo varias veces no rompe nada.
--
-- Junta, en orden, el contenido de:
--   prescripciones_vigentes.sql           (criterio único de "prescrito")
--   buscar_paciente_por_carnet.sql        (login: solo número de carnet)
--   obtener_datos_inicio_paciente.sql     (plan activo + ejercicios de hoy)
--   obtener_inicio_paciente.sql           (todo lo de la pantalla Inicio)
--   obtener_catalogo_ejercicios.sql       (pestaña Ejercicios: solo lo prescrito)
--   marcar_ejercicio_hoy.sql              (checkbox de "hecho" en Ejercicios)
--   obtener_progreso_paciente.sql         (pestaña Progreso)
--   guardar_sesion_rehabilitacion.sql     (guardar una sesión con cámara)
--   notificaciones_paciente.sql           (avisos del médico: leer y marcar leídas)
--   foto_perfil_paciente.sql              (subir y guardar la foto de perfil)
--   videos_ejercicios.sql                 (ver los videos de referencia de los ejercicios)
--   registrar_dolor.sql                   (escala EVA 0-10: antes/después de la sesión)
-- =============================================================================


-- ── 0) Qué cuenta como ejercicio prescrito (lo usan todas las demás) ──────

-- Qué cuenta como "ejercicio prescrito" para la app del paciente. Todas las
-- demás funciones leen las prescripciones a través de esta, para que el
-- criterio sea uno solo:
--   * la prescripción está activa,
--   * pertenece a un plan de tratamiento ACTIVO (una prescripción que quedó
--     activa en un plan ya completado no cuenta), y
--   * una sola por ejercicio: si el médico lo recetó más de una vez, gana la
--     más reciente. Así la app nunca muestra el mismo ejercicio dos veces.
--
-- Uso interno: la llaman las funciones security definer de esta carpeta, no
-- la app directamente, así que no se le da permiso a anon/authenticated.

create or replace function public.prescripciones_vigentes(p_id_paciente integer)
returns table (
  id_prescripcion integer,
  id_ejercicio integer,
  series smallint,
  repeticiones smallint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct on (pr.id_ejercicio)
         pr.id_prescripcion, pr.id_ejercicio, pr.series, pr.repeticiones
  from public.prescripciones_ejercicio pr
  join public.planes_tratamiento pt on pt.id_plan = pr.id_plan
  where pr.id_paciente = p_id_paciente
    and pr.activo = true
    and pt.estado = 'activo'
  order by pr.id_ejercicio, pr.id_prescripcion desc;
$$;

revoke execute on function public.prescripciones_vigentes(integer) from public, anon, authenticated;


-- ── 1) Login: solo con el número de carnet ──────────────────────────────────

--
-- La app del paciente NO usa Supabase Auth real (así se decidió: mantener
-- el login de un solo dato es más accesible para pacientes mayores que no
-- manejan contraseñas). Antes se pedía además la fecha de nacimiento como
-- segundo factor; se quitó a pedido para que el paciente entre solo con su
-- carnet. Ojo: esto vuelve a abrir el agujero de PLAN_VISION.md, Fase 2.5
-- ("cualquiera con el número de carnet de un paciente lee su historial
-- clínico").
--
-- `fn_normalizar_ci` ya existe en la base (la crea sql/1_BASE_DE_DATOS.sql
-- de FisioClinDoctor): sube a mayúsculas y quita todo lo que no sea
-- alfanumérico. `numero_carnet_normalizado` es una columna generada con
-- esa misma función, así que comparar contra ella es exacto.

-- La versión anterior (carnet + fecha) tenía otra firma: create or replace
-- no la reemplaza, crearía una sobrecarga. Se borra explícitamente.
drop function if exists public.buscar_paciente_por_carnet(text, date);

create or replace function public.buscar_paciente_por_carnet(
  p_carnet text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  paciente jsonb;
begin
  select to_jsonb(p)
    into paciente
    from public.pacientes as p
   where p.numero_carnet_normalizado = public.fn_normalizar_ci(p_carnet)
     and p.activo = true
   limit 1;

  return paciente;
end;
$$;

grant execute on function public.buscar_paciente_por_carnet(text) to anon, authenticated;


-- ── 2) Plan activo y ejercicios de hoy (piezas sueltas) ─────────────────────

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


-- ── 3) Todo lo de la pantalla Inicio en una sola llamada ────────────────────

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


-- ── 4) Catálogo completo de ejercicios (pestaña Ejercicios) ─────────────────

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


-- ── 5) Marcar / desmarcar un ejercicio como hecho hoy ────────────────────────

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


-- ── 6) Pestaña Progreso ──────────────────────────────────────────────────────

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


-- ── 7) Guardar una sesión de rehabilitación con cámara ──────────────────────

-- FisioClinDoctor (sql/1_BASE_DE_DATOS.sql): la cabecera en `sesiones`, el
-- resumen articular en `metricas_articulares`, y cada repetición en
-- `repeticiones_ejercicio`. Si vino de una prescripción real, marca el
-- ejercicio de hoy como hecho (reutiliza marcar_ejercicio_hoy) para que la
-- pestaña Progreso se encienda sola.
--
-- No usa las tablas `sesiones_rehabilitacion`/`repeticiones_sesion` de un
-- diseño anterior de este archivo: esas NO existen en la base real y no
-- hace falta crearlas — el esquema de 28 tablas ya trae exactamente esto,
-- integrado con `historial_clinico`, las vistas de reporte y el resto del
-- panel del médico.
--
-- `p_resumen` es `ResumenSesion` tal cual lo arma
-- lib/fisioclin/evaluador.ts (`resumen()`). `p_resumen->>'id_ejercicio'`
-- es el código del catálogo de visión ('C01'..'R10'), no un id numérico —
-- se resuelve contra ejercicios_catalogo.clase_lstm.
--
-- Nota: `registro_dolor` (EVA 0-10) queda sin tocar — la app todavía no le
-- pregunta al paciente cuánto le dolió, así que no hay nada real que
-- guardar ahí. `landmarks_json` es NOT NULL en metricas_articulares y la
-- app hoy no persiste la traza de landmarks (solo la usa en vivo para el
-- esqueleto), así que se guarda como '[]'::jsonb.

-- Estados de una sesión con cámara (24-sep-2026). La tabla solo aceptaba
-- 'procesando', 'completada' y 'error'; se agregan 'incompleta' (finalizó
-- antes de terminar) y 'abandonada' (salió sin finalizar). Se busca la
-- restricción por su contenido y no por su nombre, por si Postgres le puso
-- otro. Idempotente.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.sesiones'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%estado%procesando%'
  loop
    execute format('alter table public.sesiones drop constraint %I', c.conname);
  end loop;
  alter table public.sesiones add constraint sesiones_estado_check
    check (estado in ('procesando', 'completada', 'incompleta', 'abandonada', 'error'));
end $$;

create or replace function public.guardar_sesion_rehabilitacion(
  p_id_paciente integer,
  p_id_prescripcion integer,
  p_resumen jsonb,
  p_calidad jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clase_lstm text := p_resumen->>'id_ejercicio';
  v_id_ejercicio integer;
  v_id_sesion integer;
  v_fecha_hora timestamptz := now();
  v_lado text;
  v_resultado varchar(20);
  v_pct_correctas numeric := (p_resumen->>'pct_correctas')::numeric;
  v_angulo_max numeric;
  v_angulo_min numeric;
  v_vel_prom numeric;
  -- Avance contra la prescripción del médico (p. ej. 2 x 3 = 6).
  v_prescritas integer := coalesce((p_resumen->>'series_prescritas')::integer, 0)
                          * coalesce((p_resumen->>'repeticiones_prescritas')::integer, 0);
  v_hechas integer := jsonb_array_length(coalesce(p_resumen->'repeticiones', '[]'::jsonb));
  v_completa boolean;
  v_estado varchar(20);
  v_avance text;
begin
  select id_ejercicio into v_id_ejercicio
  from public.ejercicios_catalogo
  where clase_lstm = v_clase_lstm;

  -- Completa = hizo TODAS las repeticiones prescritas. Si no:
  --   'incompleta' si tocó Finalizar antes de terminar,
  --   'abandonada' si salió de la pantalla sin finalizar (la app lo manda
  --                sola con p_resumen.fin = 'abandonada').
  -- Solo una sesión completa cuenta como "hecho hoy" (sesiones.completado).
  v_completa := v_prescritas > 0 and v_hechas >= v_prescritas;
  v_estado := case
    when v_completa then 'completada'
    when p_resumen->>'fin' = 'abandonada' then 'abandonada'
    else 'incompleta'
  end;
  v_avance := 'Avance: ' || v_hechas || ' de ' || coalesce(nullif(v_prescritas, 0)::text, '?')
    || ' repeticiones (' || case v_estado
         when 'completada' then 'completa'
         when 'abandonada' then 'abandonada: salió sin terminar'
         else 'incompleta: finalizó antes de terminar'
       end || ')';

  -- Ángulo máximo y mínimo: de las repeticiones y, si no hubo ninguna, de
  -- la traza de 10 Hz, para que el médico vea hasta dónde llegó igual.
  select max((r->>'flex_max_grados')::numeric), min((r->>'flex_min_grados')::numeric),
         avg((r->>'velocidad_media_gr_s')::numeric)
    into v_angulo_max, v_angulo_min, v_vel_prom
  from jsonb_array_elements(coalesce(p_resumen->'repeticiones', '[]'::jsonb)) r;

  if v_angulo_max is null then
    select max((a->>'angulo')::numeric), min((a->>'angulo')::numeric)
      into v_angulo_max, v_angulo_min
    from jsonb_array_elements(coalesce(p_calidad->'serie_angulos', '[]'::jsonb)) a
    where a->>'angulo' is not null;
  end if;

  v_lado := case p_resumen->>'lado_medido'
              when 'izq' then 'izquierdo'
              when 'der' then 'derecho'
              else null
            end;

  v_resultado := case
    when v_pct_correctas is null then 'pendiente'
    when v_pct_correctas >= 80 then 'correcto'
    when v_pct_correctas >= 50 then 'parcial'
    else 'incorrecto'
  end;

  insert into public.sesiones (
    id_paciente, id_prescripcion, id_ejercicio, ejercicio, fecha_hora,
    duracion_segundos, fps_captura, estado, completado, resultado_evaluacion,
    observaciones
  )
  values (
    p_id_paciente, p_id_prescripcion, v_id_ejercicio,
    p_resumen->>'ejercicio', v_fecha_hora,
    round((p_resumen->>'duracion_seg')::numeric)::integer,
    round((p_calidad->>'fps_medio')::numeric)::smallint,
    v_estado, v_completa, v_resultado,
    -- Guía de postura de la app (lib/fisioclin/guiaPostura.ts, puerto de
    -- probar_modelo.py): similitud promedio con la postura objetivo y el
    -- ejercicio que más reconoció el LSTM. Texto para que el médico lo lea
    -- tal cual; null si la app no mandó la guía.
    nullif(concat_ws(' · ',
      -- Lo primero: cuánto hizo y hasta qué ángulo llegó.
      v_avance,
      case when v_angulo_max is not null
           then 'Ángulo máximo alcanzado: ' || round(v_angulo_max, 1) || '°' end,
      -- Resultado por serie (backend/cv-service/evaluador_series.py), lo
      -- primero que tiene que ver el médico: "Serie 1: 10/12 bien hechas
      -- (Bien hecha)". Null si la app no mandó series.
      (select string_agg(
         'Serie ' || (s->>'serie') || ': ' || coalesce(s->>'correctas', '0') || '/'
           || coalesce(s->>'repeticiones_prescritas', '?') || ' bien hechas ('
           || case s->>'veredicto'
                when 'BIEN_HECHA' then 'Bien hecha'
                when 'MEJORABLE' then 'Mejorable'
                when 'MAL_HECHA' then 'Mal hecha'
                when 'INCOMPLETA' then 'Incompleta'
                else coalesce(s->>'veredicto', '?')
              end || ')',
         ' · ' order by (s->>'serie')::int)
       from jsonb_array_elements(coalesce(p_resumen->'series', '[]'::jsonb)) s),
      case when p_calidad->'guia'->>'similitud_promedio' is not null
           then 'Similitud promedio con la postura objetivo: '
                || (p_calidad->'guia'->>'similitud_promedio') || '%' end,
      case when p_calidad->'guia'->>'lstm_predominante' is not null
           then 'LSTM reconoció: ' || (p_calidad->'guia'->>'lstm_predominante')
                || ' (' || coalesce(p_calidad->'guia'->>'lstm_pct_ventanas', '?') || '% de '
                || coalesce(p_calidad->'guia'->>'lstm_ventanas', '?') || ' ventanas)' end,
      case when p_calidad->'guia'->>'lstm_calidad_predominante' is not null
           then 'Calidad según LSTM: ' || (p_calidad->'guia'->>'lstm_calidad_predominante') end,
      case when jsonb_array_length(coalesce(p_calidad->'guia'->'correcciones_frecuentes', '[]'::jsonb)) > 0
           then 'Correcciones más frecuentes: ' || (
             select string_agg(c, ', ')
             from jsonb_array_elements_text(p_calidad->'guia'->'correcciones_frecuentes') c
           ) end
    ), '')
  )
  returning id_sesion into v_id_sesion;

  if v_angulo_max is not null and v_angulo_min is not null then
    insert into public.metricas_articulares (
      id_sesion, articulacion, lado, angulo_maximo, angulo_minimo,
      velocidad_angular_prom, landmarks_json, angulos_json
    )
    values (
      v_id_sesion, (p_resumen->>'articulacion')::public.articulacion, v_lado,
      v_angulo_max, v_angulo_min, v_vel_prom,
      '[]'::jsonb, coalesce(p_calidad->'serie_angulos', '[]'::jsonb)
    );
  end if;

  insert into public.repeticiones_ejercicio (
    id_sesion, numero_repeticion, angulo_alcanzado, duracion_segundos,
    calidad_ejecucion, observacion_automatica,
    timestamp_inicio, timestamp_fin, detalle_json
  )
  select
    v_id_sesion,
    (r->>'n')::smallint,
    (r->>'rom_grados')::numeric,
    (r->>'duracion_s')::numeric,
    case r->>'veredicto'
      when 'CORRECTA' then 'correcta'
      when 'INCORRECTA' then 'incorrecta'
      else 'pendiente'
    end,
    -- El motivo de las reglas; si no hubo, la corrección de la guía de
    -- postura que vio el paciente durante esa repetición.
    nullif(left(coalesce(r->'motivos'->>0, r->'correcciones_guia'->>0, ''), 200), ''),
    v_fecha_hora + make_interval(secs => (r->>'t_inicio_s')::numeric),
    v_fecha_hora + make_interval(secs => (r->>'t_inicio_s')::numeric + (r->>'duracion_s')::numeric),
    r
  from jsonb_array_elements(coalesce(p_resumen->'repeticiones', '[]'::jsonb)) r;

  -- Antes se llamaba aquí a marcar_ejercicio_hoy(), que marcaba el día como
  -- hecho aunque el paciente hubiera hecho 1 de 6 repeticiones. Ya no hace
  -- falta: esta misma sesión lleva `completado = true` solo si está completa,
  -- y eso es lo que miran la pestaña Ejercicios y el panel del médico.

  return jsonb_build_object('id_sesion', v_id_sesion, 'estado', v_estado,
                            'hechas', v_hechas, 'prescritas', v_prescritas);
end;
$$;

grant execute on function public.guardar_sesion_rehabilitacion(integer, integer, jsonb, jsonb) to anon, authenticated;


-- ── 8) Notificaciones del médico ─────────────────────────────────────────────

-- Notificaciones que el médico le envía al paciente (tabla `notificaciones`,
-- la llena el panel de FisioClinDoctor: nueva prescripción, indicaciones,
-- etc.). Se ligan por `id_paciente`: el paciente de la app no tiene
-- `id_usuario` porque entra con su carnet, sin cuenta de Supabase Auth.
-- security definer por el mismo motivo que el resto de funciones.

create or replace function public.obtener_notificaciones_paciente(p_id_paciente integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.fecha_creacion desc), '[]'::jsonb)
  from (
    select n.id_notificacion, n.tipo, n.categoria, n.severidad, n.titulo,
           n.mensaje, n.leida, n.fecha_creacion
    from public.notificaciones n
    where n.id_paciente = p_id_paciente
    order by n.fecha_creacion desc
    limit 50
  ) t;
$$;

grant execute on function public.obtener_notificaciones_paciente(integer) to anon, authenticated;


-- Marca como leídas las notificaciones del paciente. Con p_ids null marca
-- todas; nunca toca las de otro paciente.
create or replace function public.marcar_notificaciones_leidas(
  p_id_paciente integer,
  p_ids integer[] default null
)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with actualizadas as (
    update public.notificaciones n
       set leida = true,
           fecha_lectura = now()
     where n.id_paciente = p_id_paciente
       and n.leida = false
       and (p_ids is null or n.id_notificacion = any (p_ids))
    returning 1
  )
  select count(*)::integer from actualizadas;
$$;

grant execute on function public.marcar_notificaciones_leidas(integer, integer[]) to anon, authenticated;


-- ── 9) Foto de perfil del paciente ───────────────────────────────────────────

-- Foto de perfil del paciente desde la app.
--
-- Se guarda donde ya la busca el panel del médico: en el depósito
-- `avatares`, con la ruta en `pacientes.foto_rostro_path` (FisioClinDoctor
-- la muestra con <Avatar bucket="avatares" path={p.foto_rostro_path}/>).
-- Ruta: pacientes/<id_paciente>/perfil-<marca de tiempo>.jpg
--
-- La app del paciente entra solo con el carnet, sin cuenta de Supabase
-- Auth (rol `anon`), y las políticas del panel solo dejan tocar `avatares`
-- a usuarios autenticados. Estas dos políticas le abren a `anon` SOLO la
-- carpeta pacientes/ del depósito: subir fotos nuevas y leerlas para
-- mostrarlas. No puede borrar ni sobrescribir, ni tocar las fotos del
-- personal (perfiles/). Mismo nivel de confianza que el login por carnet:
-- quien use la app podría subir una foto a la carpeta de otro paciente si
-- conoce su id, pero solo actualizar_foto_paciente la pone en su ficha.

drop policy if exists p_avatares_app_paciente_subir on storage.objects;
create policy p_avatares_app_paciente_subir on storage.objects
  for insert to anon
  with check (
    bucket_id = 'avatares'
    and (storage.foldername(name))[1] = 'pacientes'
    and (storage.foldername(name))[2] ~ '^[0-9]+$'
  );

drop policy if exists p_avatares_app_paciente_leer on storage.objects;
create policy p_avatares_app_paciente_leer on storage.objects
  for select to anon
  using (
    bucket_id = 'avatares'
    and (storage.foldername(name))[1] = 'pacientes'
  );


-- Pone (o quita, con p_ruta null) la foto en la ficha del paciente. Solo
-- acepta una ruta de SU carpeta y que de verdad exista en el depósito.
create or replace function public.actualizar_foto_paciente(
  p_id_paciente integer,
  p_ruta text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ruta is not null then
    if p_ruta not like 'pacientes/' || p_id_paciente || '/%' then
      raise exception 'Ruta de foto no válida para este paciente';
    end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'avatares' and o.name = p_ruta
    ) then
      raise exception 'La foto no llegó a subirse';
    end if;
  end if;

  update public.pacientes
     set foto_rostro_path = p_ruta,
         actualizado_en = now()
   where id_paciente = p_id_paciente
     and activo = true;

  if not found then
    raise exception 'Paciente % no encontrado', p_id_paciente;
  end if;

  return p_ruta;
end;
$$;

grant execute on function public.actualizar_foto_paciente(integer, text) to anon, authenticated;


-- ── 10) Videos de referencia de los ejercicios ───────────────────────────────

-- Videos de referencia de los ejercicios, vistos desde la app del paciente.
--
-- El médico los sube desde el panel al depósito privado `ejercicios-videos`
-- y la ruta queda en ejercicios_catalogo.video_storage_path. Las políticas
-- del panel solo dejan leer ese depósito a usuarios autenticados, pero la
-- app del paciente entra solo con el carnet (rol `anon`), así que no podía
-- pedir el enlace firmado para reproducirlos.
--
-- Esta política le abre a `anon` SOLO la lectura de los archivos que están
-- puestos como video (o portada) de un ejercicio del catálogo. No puede
-- listar el depósito, ni ver archivos sueltos, ni subir, borrar o cambiar
-- nada. Son videos instructivos, no datos del paciente.

-- security definer: la política corre como `anon`, que por RLS no ve
-- ejercicios_catalogo; la función sí.
create or replace function public.es_video_de_ejercicio(p_ruta text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.ejercicios_catalogo ec
    where ec.video_storage_path = p_ruta
       or ec.video_poster_path = p_ruta
  );
$$;

grant execute on function public.es_video_de_ejercicio(text) to anon, authenticated;

drop policy if exists p_ejercicios_videos_app_paciente_leer on storage.objects;
create policy p_ejercicios_videos_app_paciente_leer on storage.objects
  for select to anon
  using (
    bucket_id = 'ejercicios-videos'
    and public.es_video_de_ejercicio(name)
  );

-- =============================================================================
-- registrar_dolor.sql — escala EVA 0-10: antes/después de la sesión
-- =============================================================================
create or replace function public.registrar_dolor(
  p_id_paciente integer,
  p_nivel_dolor smallint,
  p_momento varchar default 'independiente',
  p_id_sesion integer default null,
  p_articulacion public.articulacion default null,
  p_observaciones text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id integer;
begin
  if p_nivel_dolor is null or p_nivel_dolor < 0 or p_nivel_dolor > 10 then
    raise exception 'El nivel de dolor tiene que estar entre 0 y 10';
  end if;
  if p_momento not in ('antes_sesion', 'despues_sesion', 'independiente') then
    raise exception 'Momento de dolor inválido: %', p_momento;
  end if;

  insert into public.registro_dolor
    (id_paciente, id_sesion, momento, nivel_dolor, articulacion, observaciones)
  values
    (p_id_paciente, p_id_sesion, p_momento, p_nivel_dolor, p_articulacion,
     nullif(trim(p_observaciones), ''))
  returning id_registro_dolor into v_id;

  return jsonb_build_object('id_registro_dolor', v_id);
end;
$$;

grant execute on function public.registrar_dolor(integer, smallint, varchar, integer, public.articulacion, text)
  to anon, authenticated;
