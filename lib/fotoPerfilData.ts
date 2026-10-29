import { supabase } from './supabase';

/** Mismo depósito y convención que usa el panel del médico
 *  (<Avatar bucket="avatares" path={p.foto_rostro_path}/>). */
const BUCKET = 'avatares';

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 -> bytes. Storage necesita el binario; en React Native no hay Blob
 *  confiable desde base64, así que se decodifica a mano. */
function base64ABytes(base64: string): Uint8Array {
  const limpio = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array(Math.floor((limpio.length * 3) / 4));
  let j = 0;
  for (let i = 0; i < limpio.length; i += 4) {
    const a = ALFABETO.indexOf(limpio[i]);
    const b = ALFABETO.indexOf(limpio[i + 1]);
    const c = i + 2 < limpio.length ? ALFABETO.indexOf(limpio[i + 2]) : 0;
    const d = i + 3 < limpio.length ? ALFABETO.indexOf(limpio[i + 3]) : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    bytes[j++] = (n >> 16) & 0xff;
    if (i + 2 < limpio.length) bytes[j++] = (n >> 8) & 0xff;
    if (i + 3 < limpio.length) bytes[j++] = n & 0xff;
  }
  return bytes.subarray(0, j);
}

/** Sube la foto (JPEG en base64) y la deja como foto de la ficha del paciente.
 *  Devuelve la ruta guardada en `pacientes.foto_rostro_path`. */
export async function subirFotoPerfil(idPaciente: number, jpegBase64: string): Promise<string> {
  const ruta = `pacientes/${idPaciente}/perfil-${Date.now()}.jpg`;

  const { error: errorSubida } = await supabase.storage
    .from(BUCKET)
    .upload(ruta, base64ABytes(jpegBase64), { contentType: 'image/jpeg' });
  if (errorSubida) throw errorSubida;

  const { error } = await supabase.rpc('actualizar_foto_paciente', {
    p_id_paciente: idPaciente,
    p_ruta: ruta,
  });
  if (error) throw error;
  return ruta;
}

/** Vuelve a las iniciales (la ficha queda sin foto). */
export async function quitarFotoPerfil(idPaciente: number) {
  const { error } = await supabase.rpc('actualizar_foto_paciente', {
    p_id_paciente: idPaciente,
    p_ruta: null,
  });
  if (error) throw error;
}

/** El depósito es privado: la foto se ve con un enlace temporal. */
export async function urlFotoPerfil(ruta: string, segundos = 60 * 60 * 6): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(ruta, segundos);
  if (error) return null;
  return data?.signedUrl ?? null;
}
