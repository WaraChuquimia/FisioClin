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
