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
