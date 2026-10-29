-- =============================================================================
-- DATOS DEMO para ver la pantalla de Inicio con contenido real.
-- Paciente PAC-0001 (id_paciente = 1). Médico fisiatra Dr. Martin (id_medico = 1).
-- Se puede ejecutar varias veces sin duplicar.
-- Ejecutar DESPUÉS del esquema principal y de las funciones de supabase/.
-- =============================================================================

begin;

-- 1. Catálogo de ejercicios (creador: fisiatra id 1) -------------------------
insert into public.ejercicios_catalogo
  (nombre, descripcion, articulacion_objetivo, angulo_min_esperado,
   angulo_max_esperado, duracion_estimada_segundos, id_medico_creador, codigo_fisioclin)
values
  ('Flexión de rodilla en sedestación', 'Sentado, lleva el talón hacia atrás lo más que puedas', 'rodilla', 0, 120, 45, 1, 'FRS'),
  ('Extensión de rodilla',              'Sentado, estira la pierna al frente y sostén 3 s',       'rodilla', 0,  90, 30, 1, 'ERO'),
  ('Elevación de pierna recta',         'Acostado, sube la pierna estirada unos 30 cm',           'cadera',  0,  70, 35, 1, 'EPR'),
  ('Puente de glúteos',                 'Acostado, eleva la cadera apretando los glúteos',        'cadera',  0,  40, 30, 1, 'PGL')
on conflict (codigo_fisioclin) do nothing;

-- 2. Plan de tratamiento activo --------------------------------------------
insert into public.planes_tratamiento
  (id_paciente, id_medico_responsable, objetivo_general, duracion_estimada_semanas)
select 1, 1, 'Recuperar el rango de flexión de rodilla y la fuerza del cuádriceps', 8
where not exists (
  select 1 from public.planes_tratamiento where id_paciente = 1 and estado = 'activo'
);

-- 3. Prescripciones dentro de ese plan ------------------------------------
insert into public.prescripciones_ejercicio
  (id_paciente, id_plan, id_ejercicio, id_medico_prescriptor, series, repeticiones, frecuencia_semanal)
select
  1,
  (select id_plan from public.planes_tratamiento
    where id_paciente = 1 and estado = 'activo' order by id_plan desc limit 1),
  ec.id_ejercicio, 1, 3, 10, 4
from public.ejercicios_catalogo ec
where ec.codigo_fisioclin in ('FRS', 'ERO', 'EPR', 'PGL')
on conflict (id_paciente, id_ejercicio) where activo = true do nothing;

-- 4. Sesiones completadas esta semana (lunes, martes, miércoles) ----------
--    Alimenta "Mi progreso semanal" y las marcas de "completado".
insert into public.sesiones
  (id_paciente, id_prescripcion, id_ejercicio, ejercicio, fecha_hora,
   duracion_segundos, estado, completado, resultado_evaluacion)
select
  1,
  pr.id_prescripcion,
  pr.id_ejercicio,
  ec.nombre,
  (date_trunc('week', current_date)::date + dia.off)::timestamp + time '09:00',
  ec.duracion_estimada_segundos,
  'completada', true, 'correcto'
from generate_series(0, 6) as dia(off)
cross join public.prescripciones_ejercicio pr
join public.ejercicios_catalogo ec on ec.id_ejercicio = pr.id_ejercicio
where pr.id_paciente = 1 and pr.activo = true
  -- solo días ya pasados: hoy queda pendiente para probar "Comenzar sesión"
  and (date_trunc('week', current_date)::date + dia.off) < current_date
  and not exists (
    select 1 from public.sesiones s
    where s.id_prescripcion = pr.id_prescripcion
      and s.completado = true
      and s.fecha_hora::date = (date_trunc('week', current_date)::date + dia.off)
  );

commit;
