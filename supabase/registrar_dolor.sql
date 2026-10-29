-- Guarda cuánto le duele al paciente (escala EVA 0-10) en `registro_dolor`.
-- La tabla y el panel del médico ya la esperaban (ver la nota en
-- guardar_sesion_rehabilitacion.sql: "la app todavía no le pregunta al
-- paciente cuánto le dolió"); este archivo es lo que faltaba.
--
-- security definer por el mismo motivo que el resto de funciones: no hay
-- sesión de Supabase Auth detrás del login por carnet, así que RLS
-- (p_por_paciente) rechazaría el insert directo desde la app.
--
-- p_momento: 'antes_sesion' | 'despues_sesion' | 'independiente'.
-- p_id_sesion: la sesión de cámara a la que se liga el registro (null si
-- el paciente registra dolor fuera de una sesión, p. ej. desde Perfil).

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
