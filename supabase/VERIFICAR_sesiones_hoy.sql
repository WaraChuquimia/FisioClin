-- =============================================================================
-- Diagnóstico: ¿están llegando las sesiones del celular a la base?
-- Pegar en el SQL Editor de Supabase y darle Run. Solo LEE, no cambia nada.
-- =============================================================================

-- 1) Las últimas 20 sesiones (de cualquier paciente), con su avance.
--    Si aquí aparece la sesión que hiciste con la cámara, la app guarda bien
--    y el problema está en lo que ve el panel (punto 3).
select
  s.id_sesion,
  p.nombre_completo                      as paciente,
  s.ejercicio,
  s.fecha_hora at time zone 'America/La_Paz' as fecha_bolivia,
  s.estado,
  s.completado,
  s.resultado_evaluacion,
  (select count(*) from public.repeticiones_ejercicio r where r.id_sesion = s.id_sesion) as repeticiones,
  (select max(m.angulo_maximo) from public.metricas_articulares m where m.id_sesion = s.id_sesion) as angulo_max,
  left(s.observaciones, 160)             as observaciones
from public.sesiones s
join public.pacientes p on p.id_paciente = s.id_paciente
order by s.fecha_hora desc
limit 20;

-- 2) ¿Está instalada la versión nueva de guardar_sesion_rehabilitacion?
--    Tiene que salir TRUE. Si sale FALSE, falta correr
--    supabase/guardar_sesion_rehabilitacion.sql.
select position('abandonada' in pg_get_functiondef('public.guardar_sesion_rehabilitacion(integer,integer,jsonb,jsonb)'::regprocedure)) > 0
  as version_nueva_instalada;

-- 3) ¿El panel se entera en tiempo real? Tiene que listar 'sesiones' y
--    'repeticiones_ejercicio'. Si no aparecen, correr
--    C:\Users\WARA\FisioClinDoctor\sql\10_tiempo_real.sql
--    (sin eso el panel solo se actualiza al recargar la página).
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('sesiones', 'repeticiones_ejercicio', 'metricas_articulares');
