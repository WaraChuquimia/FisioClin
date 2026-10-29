/* ==================================================================
   FisioClin — dónde vive el servicio de visión
   ==================================================================

   `localhost` desde el teléfono es el propio teléfono, no tu PC. Antes
   esto se resolvía a mano en `.env` (`EXPO_PUBLIC_CV_URL=ws://IP:8000/ws`)
   y cada vez que el PC cambiaba de red — de casa a la universidad, de una
   WiFi a otra — la IP quedaba obsoleta y la app se quedaba en
   "conectando" para siempre sin ningún aviso claro de por qué.

   Ahora se autodetecta: `Constants.expoConfig.hostUri` es el host:puerto
   que el propio Metro le dio al teléfono para bajar el bundle (la misma
   IP que sale en el QR de `npx expo start`), así que siempre es la
   correcta para esta sesión de desarrollo. `.env` queda solo como
   override manual, para cuando el servicio de visión vive en otra
   máquina que el servidor de Expo.
   ================================================================== */

import Constants from 'expo-constants';

function ipDelServidorDeExpo(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return null;
  const host = hostUri.split(':')[0]?.trim();
  return host || null;
}

const ipAutodetectada = ipDelServidorDeExpo();

export const URL_CV =
  process.env.EXPO_PUBLIC_CV_URL ??
  (ipAutodetectada ? `ws://${ipAutodetectada}:8000/ws` : 'ws://192.168.1.100:8000/ws');

/** Cuántos fotogramas por segundo intenta enviar la cámara.
 *
 *  No confundir con los 10 Hz del modelo: el servicio remuestrea a su
 *  rejilla fija, así que este número solo decide cuánta batería y cuánta
 *  red se gastan. Por debajo de ~5 el remuestreo empieza a inventar
 *  demasiado entre muestra y muestra. */
export const FPS_CAPTURA = 8;

/** Calidad del JPEG que se manda. Más baja = menos red, pose más pobre. */
export const CALIDAD_JPEG = 0.35;

/** Ancho, en píxeles, al que se reescala la foto ANTES de mandarla.
 *
 *  `takePictureAsync` da la resolución plena del sensor: una foto de 12 MP
 *  en base64 son ~8 MB, y a eso no le entra ningún ritmo de captura viable
 *  por WiFi. El propio servicio va a reescalar a 640 px de ancho para
 *  MediaPipe (`main.py`), así que hacerlo antes de enviar no pierde nada
 *  de precisión y baja la carga útil a ~100 KB: de ~2 fps reales a 6–8. */
export const ANCHO_ENVIO_PX = 640;
