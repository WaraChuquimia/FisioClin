/* ==================================================================
   FisioClin — cliente del servicio de visión
   ==================================================================

   MediaPipe Pose no existe en Expo Go: es un módulo nativo. Así que la
   pose se calcula en `backend/cv-service` (Python) y el teléfono le
   manda fotogramas JPEG por WebSocket. Lo que vuelve son ángulos y las
   14 features del modelo; el conteo de repeticiones, las reglas y el
   LSTM corren aquí, en el teléfono.

   Hay control de flujo: nunca se manda un fotograma nuevo si el anterior
   sigue sin respuesta. Sin eso la cola del WebSocket crece sin freno en
   cuanto la red o el servidor se atrasan, y el vídeo acaba llegando con
   segundos de retraso — que en una app que corrige postura es peor que
   perder fotogramas.
   ================================================================== */

import type { FotogramaCv, Punto, ResumenSerie, SesionServidor } from './tipos';

export type EstadoConexion = 'desconectado' | 'conectando' | 'listo' | 'error';

/** Calidad de captura del mensaje que acaba de llegar. Ver `SobreFotogramaCv`. */
export type CalidadCaptura = {
  reinicio: boolean;
  tCaptura: number;
  muestrasReales: number;
  filasEmitidas: number;
};

export type OpcionesCliente = {
  /** ws://IP:8000/ws — la IP de tu PC en la red local, no localhost. */
  url: string;
  /** Id del catálogo, p. ej. 'C01'. El servidor lo usa para elegir la articulación. */
  ejercicio: string;
  /** Prescripción: con ella el servicio cuenta series y da veredicto por
   *  serie (evaluador_series.py). Sin ella solo mide. */
  series?: number;
  repeticiones?: number;
  romObjetivo?: number | null;
  onFotograma: (f: FotogramaCv) => void;
  /** Estado de la serie calculado en el servicio, una vez por mensaje. */
  onSesion?: (s: SesionServidor) => void;
  /**
   * El esqueleto, aparte de `onFotograma`: sigue el reloj de la cámara
   * (2–8 Hz según el teléfono), no el de la rejilla de evaluación (10 Hz
   * fijo). Tratarlos como el mismo reloj es lo que hacía desaparecer el
   * esqueleto justo cuando la rejilla no tenía fila que emitir.
   */
  onLandmarks?: (landmarks: Punto[] | null) => void;
  /** Para el HUD de instrumentación (Fase 1.4) y para vaciar la ventana
   *  deslizante cuando el servicio avisa `reinicio`. */
  onCalidad?: (c: CalidadCaptura) => void;
  onEstado?: (e: EstadoConexion, detalle?: string) => void;
};

export class ClienteCv {
  private ws: WebSocket | null = null;
  private esperandoRespuesta = false;
  private cerradoAPropósito = false;
  private reintentos = 0;
  private temporizador: ReturnType<typeof setTimeout> | null = null;
  private esperandoResumen: ((r: any) => void) | null = null;

  constructor(private readonly op: OpcionesCliente) {}

  /** ¿Se puede mandar un fotograma ahora mismo? */
  get listoParaEnviar(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.esperandoRespuesta;
  }

  conectar(): void {
    this.cerradoAPropósito = false;
    this.op.onEstado?.('conectando');

    const ws = new WebSocket(this.op.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reintentos = 0;
      this.esperandoRespuesta = false;
      ws.send(
        JSON.stringify({
          tipo: 'inicio',
          ejercicio: this.op.ejercicio,
          series: this.op.series,
          repeticiones: this.op.repeticiones,
          rom_objetivo: this.op.romObjetivo ?? undefined,
        })
      );
      this.op.onEstado?.('listo');
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        this.esperandoRespuesta = false;
        return; // basura en el canal: se ignora, el siguiente fotograma reintenta
      }
      // El informe y el cierre de serie no responden a un fotograma: no
      // deben liberar el control de flujo.
      if (msg.tipo === 'resumen') {
        this.esperandoResumen?.(msg.resumen ?? null);
        this.esperandoResumen = null;
        return;
      }
      if (msg.tipo === 'serie_cerrada') return;
      this.esperandoRespuesta = false;
      if (msg.tipo === 'fotograma' && msg.sesion) {
        this.op.onSesion?.(msg.sesion as SesionServidor);
      }
      // El servicio responde con 0, 1 o varias filas: no manda una por
      // fotograma sino una por instante de su rejilla de 10 Hz. El
      // esqueleto y las banderas de calidad van sueltos en el sobre.
      if (msg.tipo === 'fotograma') {
        if (Array.isArray(msg.filas)) {
          for (const fila of msg.filas as FotogramaCv[]) this.op.onFotograma(fila);
        }
        this.op.onLandmarks?.((msg.landmarks as Punto[] | null) ?? null);
        this.op.onCalidad?.({
          reinicio: Boolean(msg.reinicio),
          tCaptura: Number(msg.t_captura ?? 0),
          muestrasReales: Number(msg.muestras_reales ?? 0),
          filasEmitidas: Number(msg.filas_emitidas ?? 0),
        });
      } else if (msg.tipo === 'error') {
        this.op.onEstado?.('error', msg.detalle);
      }
    };

    ws.onerror = () => {
      this.op.onEstado?.('error', 'No se pudo hablar con el servicio de visión');
    };

    ws.onclose = () => {
      this.esperandoRespuesta = false;
      this.ws = null;
      if (this.cerradoAPropósito) {
        this.op.onEstado?.('desconectado');
        return;
      }
      // Reintento con espera creciente, tope 5 s.
      const espera = Math.min(5000, 500 * 2 ** this.reintentos++);
      this.op.onEstado?.('conectando', `Reintentando en ${Math.round(espera / 1000)} s`);
      this.temporizador = setTimeout(() => this.conectar(), espera);
    };
  }

  /**
   * Manda un fotograma. Si el anterior sigue en vuelo, lo descarta y
   * devuelve false: es preferible saltarse fotogramas que acumular retraso.
   *
   * @param jpgBase64  imagen JPEG en base64, sin el prefijo `data:`
   * @param t          segundos desde el arranque de la sesión
   */
  enviarFotograma(jpgBase64: string, t: number): boolean {
    if (!this.listoParaEnviar) return false;
    this.esperandoRespuesta = true;
    this.ws!.send(JSON.stringify({ tipo: 'frame', t, jpg: jpgBase64 }));
    return true;
  }

  /**
   * Manda la pose ya detectada en el teléfono (CamaraPose): 33 puntos de
   * imagen y 33 en metros, o null si no hay persona. Mismo control de flujo
   * que `enviarFotograma`: si el anterior sigue en vuelo, se descarta.
   */
  enviarPose(
    lm: [number, number, number][] | null,
    mundo: [number, number, number][] | null,
    t: number
  ): boolean {
    if (!this.listoParaEnviar) return false;
    this.esperandoRespuesta = true;
    this.ws!.send(JSON.stringify({ tipo: 'pose', t, lm, mundo }));
    return true;
  }

  /** Botón "Terminar serie": cierra en el servicio la serie a medias. */
  cerrarSerie(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ tipo: 'cerrar_serie' }));
    }
  }

  /**
   * Pide el informe final (series con veredicto, repeticiones y ángulos).
   * Resuelve null si no hay conexión o el servicio tarda más de `esperaMs`:
   * guardar la sesión no puede quedar colgado de la red.
   */
  pedirResumen(
    esperaMs = 4000
  ): Promise<{ series: ResumenSerie[]; series_bien_hechas: number } | null> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolver) => {
      const t = setTimeout(() => {
        this.esperandoResumen = null;
        resolver(null);
      }, esperaMs);
      this.esperandoResumen = (r) => {
        clearTimeout(t);
        resolver(r);
      };
      this.ws!.send(JSON.stringify({ tipo: 'fin' }));
    });
  }

  cerrar(): void {
    this.cerradoAPropósito = true;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null;
    this.ws?.close();
    this.ws = null;
  }
}
