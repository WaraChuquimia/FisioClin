/* ==================================================================
   FisioClin — hook que junta las tres piezas
   ==================================================================

     cámara ──JPEG──▶ cv-service (MediaPipe)
                          │
                          └──ángulos + 14 features──▶ teléfono
                                                        ├─ evaluador.ts  (reglas → repeticiones)
                                                        └─ modelo.ts     (LSTM → verificación)

   La pantalla solo tiene que llamar a `enviarFotograma` cuando tenga un
   JPEG y pintar `estado`.
   ================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CalidadCaptura, ClienteCv, type EstadoConexion } from '@/lib/fisioclin/clienteCv';
import { esEnteroPositivo, EvaluadorEjercicio, fichaEjercicio } from '@/lib/fisioclin/evaluador';
import {
  AcumuladorGuia,
  correcciones,
  type EstadoGuia,
  GUIA_INICIAL,
  metaDe,
  similitud,
} from '@/lib/fisioclin/guiaPostura';
import { predecir, restringirAPrescritos, verificarEjercicio } from '@/lib/fisioclin/modelo';
import type {
  EstadoSesion,
  FotogramaCv,
  Prediccion,
  Punto,
  Repeticion,
  ResumenSerie,
  ResumenSesion,
  SesionServidor,
} from '@/lib/fisioclin/tipos';
import { VentanaDeslizante } from '@/lib/fisioclin/ventana';

/** Para el HUD de instrumentación de la Fase 1: sin esto no hay forma de
 *  saber si la captura mejoró, ni de defender la cifra con datos propios. */
export type CalidadHud = {
  fpsCamara: number;
  latenciaMs: number;
  pctFilasInterpoladas: number;
};

export type OpcionesEvaluador = {
  /** ws://IP_DE_TU_PC:8000/ws */
  url: string;
  /** Id del catálogo: 'C01', 'R07'… */
  ejercicio: string;
  /** De la prescripción del médico. null = el médico no las definió, y
   *  entonces no se evalúa nada: no se inventa un 3 x 10. */
  series: number | null;
  repeticiones: number | null;
  romObjetivo?: number | null;
  /**
   * Correr el LSTM para comprobar que el paciente hace el ejercicio
   * prescrito. Apagado por defecto, y no por coste — son 3 ms por
   * segundo: la cabeza de ejercicio se equivoca incluso con las features
   * del entrenamiento, así que encendida marcaría como incorrectas
   * repeticiones buenas. Ver la cabecera de `modelo.ts`.
   */
  verificarConRed?: boolean;
  /**
   * Ejercicios prescritos a ESTE paciente, con el nombre del modelo
   * ('sentadilla_profunda'…). El reconocimiento del LSTM elige solo entre
   * ellos: no puede "reconocer" un ejercicio que el médico no le recetó.
   */
  ejerciciosPrescritos?: string[];
};

const ESTADO_INICIAL: EstadoSesion = {
  fase: 'SIN_PERSONA',
  mensaje: 'Colócate frente a la cámara, de cuerpo entero',
  hay_persona: false,
  dato_fiable: false,
  motivo_no_fiable: '',
  angulo: null,
  lado: '',
  repeticiones: 0,
  serie: 1,
  progreso: 0,
  repeticion_nueva: null,
};

export function useEvaluadorFisioclin(op: OpcionesEvaluador) {
  const { url, ejercicio, series, repeticiones, romObjetivo = null } = op;
  // En ref: la lista llega de la base después del primer render y no debe
  // reconstruir el evaluador ni reabrir el WebSocket.
  const prescritosRef = useRef<string[]>([]);
  useEffect(() => {
    prescritosRef.current = op.ejerciciosPrescritos ?? [];
  }, [op.ejerciciosPrescritos]);
  const prescripcionValida = esEnteroPositivo(series) && esEnteroPositivo(repeticiones);
  const verificarConRed = op.verificarConRed ?? false;

  const [estado, setEstado] = useState<EstadoSesion>(ESTADO_INICIAL);
  const [conexion, setConexion] = useState<EstadoConexion>('desconectado');
  const [detalleConexion, setDetalleConexion] = useState('');
  const [reps, setReps] = useState<Repeticion[]>([]);
  /** El mayor ángulo medido en la sesión (articulación que evalúa el ejercicio). */
  const [anguloMax, setAnguloMax] = useState<number | null>(null);
  const [prediccion, setPrediccion] = useState<Prediccion | null>(null);
  const [ejercicioCorrecto, setEjercicioCorrecto] = useState<boolean | null>(null);
  const [landmarks, setLandmarks] = useState<Punto[] | null>(null);
  /** Lo que calcula el servicio con la prescripción (evaluador_series.py):
   *  estado de la serie en curso y las series ya cerradas con su veredicto. */
  const [sesionServidor, setSesionServidor] = useState<SesionServidor | null>(null);
  const [seriesCerradas, setSeriesCerradas] = useState<ResumenSerie[]>([]);
  /** Similitud con la postura objetivo y correcciones en vivo (guiaPostura.ts). */
  const [guia, setGuia] = useState<EstadoGuia>(GUIA_INICIAL);
  const acumuladorGuiaRef = useRef(new AcumuladorGuia());
  const [calidad, setCalidad] = useState<CalidadHud>({
    fpsCamara: 0,
    latenciaMs: 0,
    pctFilasInterpoladas: 0,
  });

  const evaluadorRef = useRef<EvaluadorEjercicio | null>(null);
  const ventanaRef = useRef(new VentanaDeslizante());
  const clienteRef = useRef<ClienteCv | null>(null);
  const ultimoTRef = useRef(0);
  /** Reloj de pared del último `enviarFotograma`, para medir la latencia
   *  ida y vuelta cuando llegue la respuesta (Fase 1.4). */
  const ultimoEnvioWallRef = useRef(0);
  /** Reloj de pared del último mensaje recibido, para el fps real de la
   *  cámara (no confundir con los 10 Hz fijos de la rejilla). */
  const ultimoMensajeWallRef = useRef(0);
  const fpsSuavizadoRef = useRef(0);
  /** Traza de ángulos a 10 Hz durante la sesión: lo que exige el
   *  Bland-Altman del objetivo 4 contra la goniometría del especialista.
   *  ~3 KB/min, se manda entero al guardar (ver `serieAngulos`). */
  const serieAngulosRef = useRef<{ t: number; angulo: number | null }[]>([]);

  const ficha = useMemo(() => fichaEjercicio(ejercicio), [ejercicio]);
  const meta = useMemo(() => metaDe(ficha?.ejercicio), [ficha]);

  /* El evaluador se reconstruye cuando cambia la prescripción, no en cada
     render: lleva dentro el ciclo en curso y reiniciarlo perdería la
     repetición que el paciente esté haciendo. */
  useEffect(() => {
    try {
      evaluadorRef.current = new EvaluadorEjercicio(ejercicio, {
        series: series ?? 0,
        repeticiones: repeticiones ?? 0,
        romObjetivo,
      });
      setEstado(ESTADO_INICIAL);
      setReps([]);
      setAnguloMax(null);
      setSesionServidor(null);
      setSeriesCerradas([]);
      setPrediccion(null);
      setEjercicioCorrecto(null);
      ventanaRef.current.reiniciar();
      serieAngulosRef.current = [];
      acumuladorGuiaRef.current.reiniciar();
      setGuia(GUIA_INICIAL);
    } catch (e) {
      evaluadorRef.current = null;
      setConexion('error');
      setDetalleConexion(e instanceof Error ? e.message : String(e));
    }
  }, [ejercicio, series, repeticiones, romObjetivo]);

  const alLlegarFotograma = useCallback(
    (f: FotogramaCv) => {
      ultimoTRef.current = f.t;
      serieAngulosRef.current.push({ t: f.t, angulo: f.fiable ? f.angulo : null });
      if (f.fiable && f.angulo != null) {
        const a = f.angulo;
        setAnguloMax((m) => (m == null || a > m ? a : m));
      }

      const ev = evaluadorRef.current;
      let enMovimiento = false;
      if (ev) {
        const nuevo = ev.procesar(
          f.t,
          f.fiable ? f.angulo : null,
          f.inclinacion_tronco,
          f.contra,
          f.lado,
          f.hay_persona && !f.fiable ? f.motivo : ''
        );
        setEstado(nuevo);
        enMovimiento = nuevo.fase === 'MOVIMIENTO' || nuevo.fase === 'EXTREMO';
        if (nuevo.repeticion_nueva) {
          const rep = { ...nuevo.repeticion_nueva, ...acumuladorGuiaRef.current.cerrarRepeticion() };
          setReps((previas) => [...previas, rep]);
        }
      }

      // Guía de postura (puerto de probar_modelo.py): cadera y rodilla del
      // lado medido vienen en las features 0 y 2, en flexión (0° = estirado).
      const flexCadera = f.features[0];
      const flexRodilla = f.features[2];
      if (f.fiable && flexCadera != null && flexRodilla != null) {
        const s = similitud(flexCadera, flexRodilla, meta);
        const cs = correcciones({
          flexRodilla,
          inclinacionTronco: f.inclinacion_tronco,
          troncoEsperado: ficha?.tronco_mediano_grados ?? null,
          enMovimiento,
          meta,
        });
        acumuladorGuiaRef.current.agregarSimilitud(s, cs);
        setGuia({ similitud: s, correcciones: cs });
      } else {
        setGuia(GUIA_INICIAL);
      }

      if (!f.hay_persona) {
        // Sin persona en el encuadre la ventana se vacía: si no, al volver
        // el modelo vería 3 s pegados de dos momentos sin relación.
        ventanaRef.current.reiniciar();
        return;
      }

      const ventana = ventanaRef.current.push(f.features);
      if (!ventana || !ficha) return;

      // El LSTM corre siempre (3 ms por segundo) para registrar qué ejercicio
      // reconoce, como hacía probar_modelo.py; se guarda en la sesión pero no
      // se le muestra al paciente. Solo con `verificarConRed` se expone.
      // Solo entre los ejercicios prescritos a este paciente.
      const p = restringirAPrescritos(predecir(ventana), prescritosRef.current);
      acumuladorGuiaRef.current.agregarPrediccion(p.ejercicio, p.calidad);
      if (!verificarConRed) return;
      setPrediccion(p);
      setEjercicioCorrecto(verificarEjercicio(p, ficha.ejercicio).coincide);
    },
    [verificarConRed, ficha, meta]
  );

  const alLlegarCalidad = useCallback((c: CalidadCaptura) => {
    // El servicio avisa `reinicio` cuando tuvo que vaciar su rejilla (dato
    // no fiable, o un hueco de red > 0,4 s). Sin esto la ventana del
    // teléfono conservaba muestras que ya no eran contiguas (Capa 1c).
    if (c.reinicio) ventanaRef.current.reiniciar();

    const ahora = Date.now();
    if (ultimoEnvioWallRef.current > 0) {
      const latencia = ahora - ultimoEnvioWallRef.current;
      setCalidad((prev) => ({ ...prev, latenciaMs: Math.round(latencia) }));
    }
    if (ultimoMensajeWallRef.current > 0) {
      const dt = ahora - ultimoMensajeWallRef.current;
      if (dt > 0) {
        const instantaneo = 1000 / dt;
        // EMA: un fotograma suelto lento o rápido no debe hacer saltar el HUD.
        fpsSuavizadoRef.current =
          fpsSuavizadoRef.current === 0
            ? instantaneo
            : 0.8 * fpsSuavizadoRef.current + 0.2 * instantaneo;
        setCalidad((prev) => ({ ...prev, fpsCamara: Math.round(fpsSuavizadoRef.current * 10) / 10 }));
      }
    }
    ultimoMensajeWallRef.current = ahora;

    if (c.filasEmitidas > 0) {
      const pct = Math.max(0, 1 - c.muestrasReales / c.filasEmitidas) * 100;
      setCalidad((prev) => ({ ...prev, pctFilasInterpoladas: Math.round(pct * 10) / 10 }));
    }
  }, []);

  /* Un solo WebSocket por sesión. Los callbacks se leen de una ref para
     que cambiarlos no tire la conexión a la mitad. */
  const callbackRef = useRef(alLlegarFotograma);
  useEffect(() => {
    callbackRef.current = alLlegarFotograma;
  }, [alLlegarFotograma]);

  const calidadRef = useRef(alLlegarCalidad);
  useEffect(() => {
    calidadRef.current = alLlegarCalidad;
  }, [alLlegarCalidad]);

  useEffect(() => {
    // Sin prescripción no se abre el WebSocket: no hay nada que evaluar.
    if (!prescripcionValida) return;
    const cliente = new ClienteCv({
      url,
      ejercicio,
      series: series!,
      repeticiones: repeticiones!,
      romObjetivo,
      onFotograma: (f) => callbackRef.current(f),
      onSesion: (s) => {
        setSesionServidor(s);
        if (s.series_cerradas?.length) {
          setSeriesCerradas((previas) => [...previas, ...s.series_cerradas]);
        }
      },
      onLandmarks: (l) => setLandmarks(l),
      onCalidad: (c) => calidadRef.current(c),
      onEstado: (e, detalle) => {
        setConexion(e);
        setDetalleConexion(detalle ?? '');
      },
    });
    clienteRef.current = cliente;
    cliente.conectar();

    return () => {
      cliente.cerrar();
      clienteRef.current = null;
    };
  }, [url, ejercicio, series, repeticiones, romObjetivo, prescripcionValida]);

  const enviarFotograma = useCallback((jpgBase64: string, t: number) => {
    const enviado = clienteRef.current?.enviarFotograma(jpgBase64, t) ?? false;
    if (enviado) ultimoEnvioWallRef.current = Date.now();
    return enviado;
  }, []);

  /** La pose ya detectada en el teléfono (video en vivo, CamaraPose). */
  const enviarPose = useCallback(
    (lm: [number, number, number][] | null, mundo: [number, number, number][] | null, t: number) => {
      const enviado = clienteRef.current?.enviarPose(lm, mundo, t) ?? false;
      if (enviado) ultimoEnvioWallRef.current = Date.now();
      return enviado;
    },
    []
  );

  const listoParaEnviar = useCallback(() => {
    return clienteRef.current?.listoParaEnviar ?? false;
  }, []);

  /** Llamar al terminar, antes de guardar en Supabase. */
  const resumen = useCallback((): ResumenSesion | null => {
    return evaluadorRef.current?.resumen(ultimoTRef.current) ?? null;
  }, []);

  /**
   * Como `resumen()`, pero con el veredicto por serie que calcula el
   * servicio. Si el servicio no contesta, devuelve el resumen del teléfono
   * con las series que ya se hubieran cerrado en vivo.
   */
  const resumenConSeries = useCallback(async (): Promise<ResumenSesion | null> => {
    const base = evaluadorRef.current?.resumen(ultimoTRef.current) ?? null;
    if (!base) return null;
    const informe = await clienteRef.current?.pedirResumen();
    const series = informe?.series ?? seriesCerradas;
    return {
      ...base,
      series,
      series_bien_hechas: series.filter((x) => x.bien_hecha).length,
    };
  }, [seriesCerradas]);

  /** Botón "Terminar serie": cierra la serie en curso aunque falten repeticiones. */
  const terminarSerie = useCallback(() => clienteRef.current?.cerrarSerie(), []);

  /** % de fotogramas sin dato fiable en toda la sesión, para guardarlo
   *  junto al resumen (columna `pct_frames_descartados`). */
  const pctFramesDescartados = useCallback((): number => {
    const cf = evaluadorRef.current?.calidadFrames;
    if (!cf || cf.totales === 0) return 0;
    return Math.round((cf.descartados / cf.totales) * 1000) / 10;
  }, []);

  /** Llamar al terminar, junto con `resumen()`: la traza completa de
   *  ángulos a 10 Hz de la sesión (columna `serie_angulos`). */
  const serieAngulos = useCallback(() => serieAngulosRef.current, []);

  /** Llamar al terminar: similitud promedio y ejercicio que más reconoció
   *  el LSTM en la sesión (lo que el script guardaba en su resumen). */
  const resumenGuia = useCallback(() => acumuladorGuiaRef.current.resumen(), []);

  return {
    /** false si el médico no definió series y repeticiones: no se evalúa. */
    prescripcionValida,
    /** Lo que se pinta en pantalla en este fotograma. */
    estado,
    conexion,
    detalleConexion,
    /** Todas las repeticiones cerradas hasta ahora. */
    repeticiones: reps,
    /** Última salida del LSTM, o null si aún no hay 3 s de vídeo bueno. */
    prediccion,
    /** null mientras no haya predicción; false si parece otro ejercicio. */
    ejercicioCorrecto,
    /** 17 puntos de BlazePose para el overlay, al ritmo de la cámara. */
    landmarks,
    /** fps real de cámara, latencia ida y vuelta y % de filas interpoladas. */
    calidad,
    ficha,
    /** Postura objetivo del ejercicio, para dibujar el muñeco. */
    meta,
    /** Similitud (%) y correcciones del último fotograma fiable. */
    guia,
    resumenGuia,
    /** Estado de la serie según el servicio (null si aún no llegó nada). */
    sesionServidor,
    /** Series ya cerradas, con veredicto BIEN_HECHA / MEJORABLE / MAL_HECHA / INCOMPLETA. */
    seriesCerradas,
    terminarSerie,
    resumenConSeries,
    enviarFotograma,
    enviarPose,
    /** El mayor ángulo medido en la sesión, o null si todavía no hubo medida. */
    anguloMax,
    listoParaEnviar,
    resumen,
    pctFramesDescartados,
    serieAngulos,
  };
}
