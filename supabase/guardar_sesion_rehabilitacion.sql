-- Guarda una sesión de rehabilitación en vivo contra el esquema REAL de
-- FisioClinDoctor (sql/1_BASE_DE_DATOS.sql): la cabecera en `sesiones`, el
-- resumen articular en `metricas_articulares`, y cada repetición en
-- `repeticiones_ejercicio`. La sesión queda `completado = true` (el
-- ejercicio de hoy cuenta como hecho) SOLO si hizo todas las repeticiones
-- prescritas; si no, queda 'incompleta' o 'abandonada' con su avance.
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
