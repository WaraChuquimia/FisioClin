/* ==================================================================
   FisioClin — cámara en VIDEO con la pose calculada en el teléfono
   ==================================================================

   Por qué un WebView: Expo Go no deja leer el video de la cámara desde
   React Native (no hay frame processors), solo sacar fotos sueltas con
   `takePictureAsync`, y así el esqueleto iba a 3–6 fps con medio segundo
   de retraso. Un WebView sí tiene `getUserMedia` (video en vivo) y puede
   correr MediaPipe Pose Landmarker para web (WASM + GPU). Resultado:

     video en vivo ─▶ MediaPipe (en el teléfono) ─▶ esqueleto en cada cuadro
                                     │
                                     └─ 33 puntos, ~15 veces/s ─▶ onPose
                                        (la app los manda al Python, que
                                         mide ángulos y cuenta series)

   El Python ya no recibe imágenes: recibe los puntos (~2 KB) y hace
   exactamente la misma geometría que antes (`medir_puntos` en main.py).

   Requisitos:
   - Permiso de cámara de la APP (lo pide la pantalla con expo-camera).
   - Internet la primera vez: el modelo y el WASM (~19 MB) se bajan de
     jsDelivr / Google y el WebView los guarda en caché.
   - `baseUrl: https://localhost`: getUserMedia solo funciona en un origen
     seguro, y así el HTML cargado en línea cuenta como tal.

   La imagen que analiza MediaPipe NO se espeja (izquierda y derecha del
   cuerpo quedan bien para el Python); solo se espeja lo que se ve, video
   y esqueleto juntos, con CSS.
   ================================================================== */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

/** 33 × [x, y, visibilidad] de imagen (0..1) — o null si no hay persona. */
export type PuntosImagen = [number, number, number][] | null;
/** 33 × [x, y, z] en metros, centrados en la cadera — o null. */
export type PuntosMundo = [number, number, number][] | null;

export type EstadoCamara =
  | { fase: 'cargando'; detalle: string }
  | { fase: 'lista'; delegado: 'GPU' | 'CPU' }
  | { fase: 'error'; detalle: string };

export type CamaraPoseRef = {
  /** Color de todo el esqueleto (similitud con la postura objetivo), o null = por visibilidad. */
  pintar: (color: string | null) => void;
  usarCamara: (frontal: boolean) => void;
};

type Props = {
  frontal: boolean;
  /** Cada ~66 ms. `ts` es el reloj de pared (Date.now()) del cuadro analizado. */
  onPose: (ts: number, lm: PuntosImagen, mundo: PuntosMundo) => void;
  onEstado?: (e: EstadoCamara) => void;
  /** Cuadros por segundo que realmente analiza MediaPipe, una vez por segundo. */
  onFps?: (fps: number) => void;
};

const VERSION_TASKS = '0.10.14';
const MODELO =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

/** Cada cuánto se mandan los puntos a React Native (y de ahí al Python).
 *  El esqueleto se dibuja en TODOS los cuadros; esto solo decide cuánto
 *  tráfico va al servidor. 15 Hz sobra para su rejilla de 10 Hz. */
const ENVIO_MS = 66;

const HTML = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;height:100%;background:#0E1116;overflow:hidden}
  #v,#c{position:absolute;left:0;top:0;width:100%;height:100%}
  #v{object-fit:cover}
  .espejo{transform:scaleX(-1)}
</style>
</head><body>
<video id="v" playsinline muted autoplay class="espejo"></video>
<canvas id="c" class="espejo"></canvas>
<script>
// Cualquier error de JavaScript aquí dentro sale en la pantalla de la app,
// en vez de dejar el video en negro sin explicación.
(function () {
  function avisar(texto) {
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ tipo: 'estado', fase: 'error', detalle: 'Error en la cámara: ' + texto }));
    } catch (e) {}
  }
  window.addEventListener('error', function (e) { avisar(e.message || 'desconocido'); });
  window.addEventListener('unhandledrejection', function (e) {
    avisar((e.reason && (e.reason.message || e.reason)) || 'desconocido');
  });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    avisar('este WebView no permite usar la cámara (actualiza "Android System WebView" en Play Store)');
  }
})();
</script>
<script type="module">
const RN = window.ReactNativeWebView;
const enviar = (m) => { try { RN && RN.postMessage(JSON.stringify(m)); } catch (e) {} };
const video = document.getElementById('v');
const lienzo = document.getElementById('c');
const ctx = lienzo.getContext('2d');

// Mismos 17 puntos y huesos que el esqueleto de antes (ESQUELETO en main.py).
const HUESOS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],
  [23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]];
const PUNTOS = [0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32];
let color = null;
let frontal = true;
let detector = null;
let flujo = null;

const colorVis = (v) => v >= 0.7 ? '#22C55E' : v >= 0.5 ? '#F5B83D' : '#EF4444';

function ajustarLienzo() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(lienzo.clientWidth * dpr), h = Math.round(lienzo.clientHeight * dpr);
  if (lienzo.width !== w || lienzo.height !== h) { lienzo.width = w; lienzo.height = h; }
}

function dibujar(lm) {
  ajustarLienzo();
  ctx.clearRect(0, 0, lienzo.width, lienzo.height);
  if (!lm || !video.videoWidth) return;
  // object-fit: cover — la misma cuenta que hace el navegador con el video.
  const W = lienzo.width, H = lienzo.height, vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  const P = (i) => [ox + lm[i].x * vw * s, oy + lm[i].y * vh * s];
  const vis = (i) => lm[i].visibility ?? 1;
  const dpr = window.devicePixelRatio || 1;
  ctx.lineCap = 'round';
  ctx.lineWidth = 5 * dpr;
  for (const [a, b] of HUESOS) {
    if (vis(a) < 0.3 || vis(b) < 0.3) continue;
    const [x1, y1] = P(a), [x2, y2] = P(b);
    ctx.strokeStyle = color || colorVis(Math.min(vis(a), vis(b)));
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  for (const i of PUNTOS) {
    if (vis(i) < 0.3) continue;
    const [x, y] = P(i);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, 6 * dpr, 0, 6.2832); ctx.fill();
    ctx.fillStyle = color || colorVis(vis(i));
    ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, 6.2832); ctx.fill();
  }
}

async function abrirCamara() {
  if (flujo) flujo.getTracks().forEach((t) => t.stop());
  flujo = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: frontal ? 'user' : 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
  });
  video.srcObject = flujo;
  await video.play();
  video.classList.toggle('espejo', frontal);
  lienzo.classList.toggle('espejo', frontal);
}

const r4 = (v) => Math.round(v * 10000) / 10000;
let ultimoEnvio = 0, ultimoTiempoVideo = -1, cuadros = 0, relojFps = performance.now();

function bucle() {
  if (detector && video.readyState >= 2 && video.currentTime !== ultimoTiempoVideo) {
    ultimoTiempoVideo = video.currentTime;
    const ts = Date.now();
    let res = null;
    try { res = detector.detectForVideo(video, performance.now()); } catch (e) {}
    const lm = res && res.landmarks && res.landmarks[0];
    const mundo = res && res.worldLandmarks && res.worldLandmarks[0];
    dibujar(lm);
    cuadros++;
    if (ts - ultimoEnvio >= ${ENVIO_MS}) {
      ultimoEnvio = ts;
      enviar({
        tipo: 'pose', ts,
        lm: lm && mundo ? lm.map((p) => [r4(p.x), r4(p.y), r4(p.visibility ?? 1)]) : null,
        mundo: lm && mundo ? mundo.map((p) => [r4(p.x), r4(p.y), r4(p.z)]) : null,
      });
    }
    const ahora = performance.now();
    if (ahora - relojFps >= 1000) {
      enviar({ tipo: 'fps', fps: Math.round((cuadros * 1000) / (ahora - relojFps)) });
      cuadros = 0; relojFps = ahora;
    }
  }
  requestAnimationFrame(bucle);
}

async function crearDetector(vision, PoseLandmarker, delegado) {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: '${MODELO}', delegate: delegado },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

window.fc = {
  pintar: (c) => { color = c; },
  camara: async (f) => {
    frontal = f;
    try { await abrirCamara(); } catch (e) { enviar({ tipo: 'estado', fase: 'error', detalle: 'No se pudo cambiar de cámara' }); }
  },
};

(async () => {
  try {
    enviar({ tipo: 'estado', fase: 'cargando', detalle: 'Abriendo la cámara…' });
    await abrirCamara();
  } catch (e) {
    enviar({ tipo: 'estado', fase: 'error', detalle: 'No se pudo abrir la cámara: ' + (e && e.name || e) });
    return;
  }
  requestAnimationFrame(bucle);
  try {
    enviar({ tipo: 'estado', fase: 'cargando', detalle: 'Cargando el detector de postura…' });
    const { FilesetResolver, PoseLandmarker } =
      await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION_TASKS}/vision_bundle.mjs');
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION_TASKS}/wasm');
    let delegado = 'GPU';
    try { detector = await crearDetector(vision, PoseLandmarker, 'GPU'); }
    catch (e) { delegado = 'CPU'; detector = await crearDetector(vision, PoseLandmarker, 'CPU'); }
    enviar({ tipo: 'estado', fase: 'lista', delegado });
  } catch (e) {
    enviar({ tipo: 'estado', fase: 'error',
      detalle: 'No se pudo cargar el detector (¿hay internet?): ' + (e && e.message || e) });
  }
})();
</script>
</body></html>`;

/**
 * Video de cámara a pantalla completa con el esqueleto encima. Memoizado:
 * el WebView no debe re-renderizarse cada vez que la pantalla cambia un
 * número, y los callbacks se leen de refs para que cambiarlos no lo recargue.
 */
export const CamaraPose = memo(
  forwardRef<CamaraPoseRef, Props>(function CamaraPose({ frontal, onPose, onEstado, onFps }, ref) {
    const web = useRef<WebView>(null);
    const cb = useRef({ onPose, onEstado, onFps });
    useEffect(() => {
      cb.current = { onPose, onEstado, onFps };
    }, [onPose, onEstado, onFps]);

    const inyectar = useCallback((js: string) => web.current?.injectJavaScript(`${js};true;`), []);

    useImperativeHandle(
      ref,
      () => ({
        pintar: (color) => inyectar(`window.fc && window.fc.pintar(${JSON.stringify(color)})`),
        usarCamara: (f) => inyectar(`window.fc && window.fc.camara(${f ? 'true' : 'false'})`),
      }),
      [inyectar]
    );

    // La cámara inicial va en el HTML (frontal); los cambios, por inyección.
    const primera = useRef(true);
    useEffect(() => {
      if (primera.current) {
        primera.current = false;
        if (frontal) return;
      }
      inyectar(`window.fc && window.fc.camara(${frontal ? 'true' : 'false'})`);
    }, [frontal, inyectar]);

    // Si el WebView no dice nada en 10 s (no cargó, o el JavaScript no
    // arrancó), se avisa en pantalla en vez de quedarse en negro.
    const hablo = useRef(false);
    useEffect(() => {
      const id = setTimeout(() => {
        if (!hablo.current) {
          cb.current.onEstado?.({
            fase: 'error',
            detalle: 'La cámara no respondió. Cierra esta pantalla y vuelve a entrar.',
          });
        }
      }, 10000);
      return () => clearTimeout(id);
    }, []);

    const alMensaje = useCallback((e: WebViewMessageEvent) => {
      hablo.current = true;
      let m: any;
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (m.tipo === 'pose') cb.current.onPose(Number(m.ts), m.lm ?? null, m.mundo ?? null);
      else if (m.tipo === 'fps') cb.current.onFps?.(Number(m.fps) || 0);
      else if (m.tipo === 'estado') {
        cb.current.onEstado?.(
          m.fase === 'lista'
            ? { fase: 'lista', delegado: m.delegado === 'CPU' ? 'CPU' : 'GPU' }
            : { fase: m.fase === 'error' ? 'error' : 'cargando', detalle: String(m.detalle ?? '') }
        );
      }
    }, []);

    return (
      <WebView
        ref={web}
        style={StyleSheet.absoluteFill}
        containerStyle={{ backgroundColor: '#0E1116' }}
        source={{ html: HTML, baseUrl: 'https://localhost' }}
        originWhitelist={['*']}
        onMessage={alMensaje}
        javaScriptEnabled
        mediaCapturePermissionGrantType="grant"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        webviewDebuggingEnabled={__DEV__}
        onError={(ev) =>
          cb.current.onEstado?.({ fase: 'error', detalle: ev.nativeEvent.description || 'Error del WebView' })
        }
      />
    );
  })
);
