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
