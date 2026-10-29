-- Login del paciente: solo con el número de carnet.
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
