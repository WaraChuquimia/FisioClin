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
