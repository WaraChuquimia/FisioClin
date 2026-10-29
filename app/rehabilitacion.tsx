import { Ionicons } from '@expo/vector-icons';
import { useCameraPermissions } from 'expo-camera';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { BarraDolor } from '@/components/BarraDolor';
import {
  CamaraPose,
  type CamaraPoseRef,
  type EstadoCamara,
  type PuntosImagen,
  type PuntosMundo,
} from '@/components/CamaraPose';
import { useAuth } from '@/context/AuthContext';
import { crearEstilos, useTema } from '@/context/TemaContext';
import { useEntrenadorVoz } from '@/hooks/useEntrenadorVoz';
import { useEvaluadorFisioclin } from '@/hooks/useEvaluadorFisioclin';
import { URL_CV } from '@/lib/fisioclin/config';
import { colorPorSimilitud, TEXTO_EXCELENTE } from '@/lib/fisioclin/guiaPostura';
import { EjercicioCatalogo, obtenerCatalogoEjercicios } from '@/lib/ejerciciosData';
import { fichaEjercicio } from '@/lib/fisioclin/evaluador';
import { autoprueba } from '@/lib/fisioclin/modelo';
import { posicionInicial } from '@/lib/fisioclin/posiciones';
import { consejoPara, frases } from '@/lib/fisioclin/voz';
import type { Fase, Repeticion, Veredicto, VeredictoSerie } from '@/lib/fisioclin/tipos';
import { guardarSesion, registrarDolor } from '@/lib/rehabilitacionData';

const VERDE = '#22C55E';
const ROJO = '#EF4444';
const AMBAR = '#F5B83D';
const AZUL_BOTON = '#1D4ED8';
const ROJO_BOTON = '#DC2626';

/** "3" → 3; cualquier otra cosa (falta, "0", "abc", "2.5") → null. Las series
 *  y repeticiones las define el médico al prescribir: si no vienen, la
 *  pantalla lo dice en vez de inventar un 3 x 10. */
const enteroPositivo = (v: string | undefined) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n >= 1 ? n : null;
};

/** Fases en las que todavía no hay nada que corregir: se muestra la
 *  indicación del evaluador ("Colócate…", "Mantente…") en vez de la guía. */
const FASES_PREPARACION: Fase[] = ['SIN_PERSONA', 'DATO_NO_FIABLE', 'COLOCATE', 'CALIBRANDO', 'LISTO'];

type ParamsRehabilitacion = {
  ejercicio?: string;
  idPrescripcion?: string;
  series?: string;
  repeticiones?: string;
  /** Nombre clínico del ejercicio (el de la base), para el título. */
  nombre?: string;
  /** Duración (seg) del catálogo — la que pone el médico en "Editar
   *  Ejercicio" (panel web). Distinta por ejercicio: cada uno trae la suya. */
  duracionSegundos?: string;
};

const capitalizar = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const legible = (id: string) => capitalizar(id.replace(/_/g, ' '));
const formatoReloj = (seg: number) =>
  `${String(Math.floor(seg / 60)).padStart(2, '0')}:${String(seg % 60).padStart(2, '0')}`;

const TEXTO_VEREDICTO: Record<Veredicto, string> = {
  CORRECTA: 'Correcta',
  INCORRECTA: 'Incorrecta',
};
const TEXTO_VEREDICTO_SERIE: Record<VeredictoSerie, string> = {
  BIEN_HECHA: 'Bien hecha',
  MEJORABLE: 'Mejorable',
  MAL_HECHA: 'Mal hecha',
  INCOMPLETA: 'Incompleta',
};
const colorVeredicto = (v: Veredicto) => (v === 'CORRECTA' ? VERDE : ROJO);

/** El error que más se repitió en las repeticiones incorrectas, dicho como
 *  consejo para la próxima vez. null si no hubo incorrectas con motivo. */
function consejoPrincipal(reps: Repeticion[]): string | null {
  const cuenta = new Map<string, number>();
  for (const r of reps) {
    if (r.veredicto === 'CORRECTA' || !r.motivos[0]) continue;
    const clave = r.motivos[0].replace(/\s*\(.*\)$/, '');
    cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
  }
  let mejor: string | null = null;
  let max = 0;
  for (const [motivo, n] of cuenta) {
    if (n > max) {
      mejor = motivo;
      max = n;
    }
  }
  return mejor ? consejoPara(mejor) : null;
}

type ResumenCierre = {
  completa: boolean;
  hechas: number;
  prescritas: number;
  correctas: number;
  duracion: string;
  anguloMax: number | null;
  series: { serie: number; correctas: number; prescritas: number; veredicto: VeredictoSerie }[];
  consejo: string | null;
  idSesion: number;
};
const colorConexion = (c: string) => (c === 'listo' ? VERDE : c === 'error' ? ROJO : AMBAR);

export default function RehabilitacionScreen() {
  const { patient } = useAuth();
  const s = useEstilos();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  const params = useLocalSearchParams<ParamsRehabilitacion>();
  const EJERCICIO = typeof params.ejercicio === 'string' ? params.ejercicio : '';
  const idPrescripcion = params.idPrescripcion ? Number(params.idPrescripcion) : null;

  const [prescritos, setPrescritos] = useState<EjercicioCatalogo[] | 'cargando' | 'error'>('cargando');
  useEffect(() => {
    if (idPaciente == null) return;
    let vivo = true;
    obtenerCatalogoEjercicios(idPaciente)
      .then((lista) => vivo && setPrescritos(lista))
      .catch(() => vivo && setPrescritos('error'));
    return () => {
      vivo = false;
    };
  }, [idPaciente]);
  const listaPrescritos = Array.isArray(prescritos) ? prescritos : [];
  const miPrescripcion =
    listaPrescritos.find((e) => e.id_prescripcion === idPrescripcion && e.codigo_cv === EJERCICIO) ?? null;
  const seriesPrescritas = enteroPositivo(
    miPrescripcion?.series != null ? String(miPrescripcion.series) : params.series
  );
  const repsPrescritas = enteroPositivo(
    miPrescripcion?.repeticiones != null ? String(miPrescripcion.repeticiones) : params.repeticiones
  );
  const duracionObjetivoRaw =
    miPrescripcion?.duracion_estimada_segundos != null
      ? String(miPrescripcion.duracion_estimada_segundos)
      : params.duracionSegundos;
  const duracionObjetivo = enteroPositivo(duracionObjetivoRaw);
  // Nombres del modelo de los ejercicios prescritos (para el LSTM).
  const nombresPrescritos = listaPrescritos
    .map((e) => (e.codigo_cv ? fichaEjercicio(e.codigo_cv)?.ejercicio : undefined))
    .filter((n): n is string => Boolean(n));
  const clavePrescritos = nombresPrescritos.join(',');

  // El WebView necesita que la APP tenga permiso de cámara; se pide aquí.
  const [permiso, pedirPermiso] = useCameraPermissions();
  // Frontal por defecto: el paciente se ve a sí mismo mientras hace el
  // ejercicio. La trasera queda para cuando un familiar sostiene el teléfono.
  const [frontal, setFrontal] = useState(true);

  // La primera vez se pide el permiso directamente, sin pantalla intermedia.
  // Si el paciente ya lo negó para siempre (canAskAgain = false), el sistema
  // no vuelve a preguntar: se ofrece abrir los Ajustes.
  const permisoPedido = useRef(false);
  useEffect(() => {
    if (permiso && !permiso.granted && permiso.canAskAgain && !permisoPedido.current) {
      permisoPedido.current = true;
      void pedirPermiso();
    }
  }, [permiso, pedirPermiso]);

  const camara = useRef<CamaraPoseRef>(null);
  const [estadoCamara, setEstadoCamara] = useState<EstadoCamara>({ fase: 'cargando', detalle: 'Abriendo la cámara…' });
  const [fpsVideo, setFpsVideo] = useState(0);
  const [verHud, setVerHud] = useState(false);
  const [grabando, setGrabando] = useState(false);
  const [empezado, setEmpezado] = useState(false);
  const grabandoRef = useRef(false);
  const t0Ref = useRef(0);

  // Cronómetro de la sesión: solo corre mientras se graba (Pausar lo congela).
  const [segundos, setSegundos] = useState(0);
  useEffect(() => {
    if (!grabando) return;
    const id = setInterval(() => setSegundos((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [grabando]);

  const [guardando, setGuardando] = useState(false);
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  /** true en cuanto la sesión quedó guardada (Finalizar o al salir): nunca dos veces. */
  const guardadoRef = useRef(false);

  /** Resumen de la sesión recién guardada: dispara el modal de cierre, que
   *  junto al texto de siempre pide el nivel de dolor (EVA 0-10) antes de
   *  volver a Ejercicios. null = modal cerrado. */
  const [resumenFinal, setResumenFinal] = useState<ResumenCierre | null>(null);
  const [nivelDolor, setNivelDolor] = useState<number | null>(null);
  const [guardandoDolor, setGuardandoDolor] = useState(false);

  // Lista estable entre renders mientras no cambie su contenido.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- la clave resume el contenido
  const ejerciciosPrescritos = useMemo(() => nombresPrescritos, [clavePrescritos]);

  // Sin prescripción comprobada no se abre la conexión ni se cuenta nada:
  // series/repeticiones en null apagan el evaluador (ver el hook).
  const ev = useEvaluadorFisioclin({
    url: URL_CV,
    ejercicio: EJERCICIO,
    series: miPrescripcion ? seriesPrescritas : null,
    repeticiones: miPrescripcion ? repsPrescritas : null,
    ejerciciosPrescritos,
  });

  // El LSTM se comprueba contra el .tflite una vez, en desarrollo. Si esto
  // avisa, los pesos empaquetados no son los del modelo entrenado.
  useEffect(() => {
    if (!__DEV__) return;
    const r = autoprueba();
    if (!r.ok) console.warn('[fisioclin]', r.detalle);
  }, []);

  /** Ángulo máximo que alcanzó en la sesión (lo calcula el hook con cada medida). */
  const anguloMax = ev.anguloMax;

  /** Llega del WebView ~15 veces por segundo. Solo se manda al Python
   *  mientras se graba; el esqueleto se dibuja siempre, para colocarse. */
  const { enviarPose } = ev;
  const alLlegarPose = useCallback(
    (ts: number, lm: PuntosImagen, mundo: PuntosMundo) => {
      if (!grabandoRef.current) return;
      enviarPose(lm, mundo, (ts - t0Ref.current) / 1000);
    },
    [enviarPose]
  );

  // Instrucciones de voz (interruptor del Perfil): le dice al paciente, sin
  // mirar la pantalla, si cada repetición y cada serie salieron bien y qué
  // corregir mientras se mueve.
  const { vozActiva } = useTema();
  // Posición inicial del ejercicio prescrito: la dice la voz al empezar y
  // la muestra el aviso mientras el paciente no está en ella.
  const posicion = useMemo(() => (EJERCICIO ? posicionInicial(EJERCICIO) : null), [EJERCICIO]);
  const nombreEjercicio =
    (typeof params.nombre === 'string' && params.nombre) ||
    miPrescripcion?.nombre ||
    (ev.ficha ? legible(ev.ficha.ejercicio) : 'Rehabilitación');
  // Qué ejercicio es, cuánto le toca y cómo se hace: lo dice la voz al
  // abrir la pantalla (cuando ya se puede usar la cámara). Si el médico
  // escribió una descripción en la base, esa manda sobre la de la tabla.
  const descripcionMedico = miPrescripcion?.descripcion?.trim() || null;
  const presentacion =
    permiso?.granted && miPrescripcion && seriesPrescritas != null && repsPrescritas != null
      ? frases.presentacion({
          nombre: nombreEjercicio,
          series: seriesPrescritas,
          repeticiones: repsPrescritas,
          sostenido: ev.ficha?.tipo === 'sostenido',
          comoHacerlo: descripcionMedico ?? posicion?.movimiento ?? null,
          camara: posicion?.camara ?? null,
          posicion: posicion?.completa ?? null,
        })
      : null;
  const { anunciarResumen, anunciarDolor, repetirInstrucciones } = useEntrenadorVoz({
    presentacion,
    posicion,
    activa: vozActiva,
    grabando,
    empezado,
    estado: ev.estado,
    repeticiones: ev.repeticiones,
    seriesCerradas: ev.seriesCerradas,
    terminado: ev.sesionServidor?.terminado ?? false,
    correcciones: ev.guia.correcciones,
    seriesPrescritas: seriesPrescritas ?? 1,
    repsPrescritas: repsPrescritas ?? 1,
    segundos,
    duracionObjetivo,
    esSostenido: ev.ficha?.tipo === 'sostenido' && !ev.ficha?.umbrales,
  });

  // El esqueleto se pinta del color de la similitud con la postura objetivo.
  const colorGuia = colorPorSimilitud(ev.guia.similitud);
  useEffect(() => {
    camara.current?.pintar(grabando ? colorGuia ?? null : null);
  }, [colorGuia, grabando]);

  /** Empezar / Pausar / Reanudar. El reloj de la sesión (t0) se fija la
   *  primera vez: al reanudar sigue contando, así la rejilla de 10 Hz del
   *  servicio ve un hueco y reinicia su ventana en vez de mezclar tiempos. */
  const alternar = useCallback(() => {
    if (grabandoRef.current) {
      grabandoRef.current = false;
      setGrabando(false);
      return;
    }
    if (!empezado) {
      t0Ref.current = Date.now();
      setEmpezado(true);
    }
    grabandoRef.current = true;
    setGrabando(true);
  }, [empezado]);

  const terminarYGuardar = useCallback(async () => {
    grabandoRef.current = false;
    setGrabando(false);

    // Con el veredicto por serie del servicio; si no contesta en 4 s, el
    // resumen del teléfono con las series que ya se cerraron en vivo.
    const base = await ev.resumenConSeries();
    if (!base) {
      router.back();
      return;
    }
    const resumen = { ...base, fin: 'finalizada' as const };
    if (idPaciente == null) {
      // Sin paciente autenticado no hay a quién atar la sesión. No
      // debería pasar (la pantalla vive detrás del login), pero mejor
      // avisar que perder el resumen en silencio.
      setErrorGuardado('No se encontró el paciente de la sesión.');
      return;
    }

    setGuardando(true);
    setErrorGuardado(null);
    try {
      const guia = ev.resumenGuia();
      const guardado = await guardarSesion(resumen, {
        idPaciente,
        idPrescripcion,
        calidad: {
          fps_medio: ev.calidad.fpsCamara,
          pct_filas_interpoladas: ev.calidad.pctFilasInterpoladas,
          pct_frames_descartados: ev.pctFramesDescartados(),
          serie_angulos: ev.serieAngulos(),
          guia,
        },
      });
      guardadoRef.current = true;
      const completa = guardado.hechas >= guardado.prescritas && guardado.prescritas > 0;
      const correctas = resumen.correctas;
      const consejo = consejoPrincipal(ev.repeticiones);
      // Retroalimentación en voz (si está activada): que se acabó, cuántas
      // hizo y cuántas bien, qué mejorar y la pregunta del dolor. La pantalla
      // de cierre muestra lo mismo. Todo queda en Supabase para el médico.
      anunciarResumen({ hechas: guardado.hechas, correctas, prescritas: guardado.prescritas, consejo });
      setResumenFinal({
        completa,
        hechas: guardado.hechas,
        prescritas: guardado.prescritas,
        correctas,
        duracion: formatoReloj(segundos),
        anguloMax,
        series: (resumen.series ?? []).map((x) => ({
          serie: x.serie,
          correctas: x.correctas,
          prescritas: x.repeticiones_prescritas,
          veredicto: x.veredicto,
        })),
        consejo,
        idSesion: guardado.idSesion,
      });
    } catch (e) {
      // Se queda en la pantalla con el botón de reintentar: el teléfono
      // puede estar sin red justo al terminar, y perder el resumen aquí
      // significa repetir la sesión completa con el paciente.
      setErrorGuardado(e instanceof Error ? e.message : 'Error desconocido');
    } finally {
      setGuardando(false);
    }
  }, [ev, idPaciente, idPrescripcion, segundos, anguloMax, anunciarResumen]);

  /* Cuando el servicio cierra la última serie, la sesión termina sola: la
     voz avisa "Terminaste todas las series" y a los pocos segundos se
     guarda y aparece la pantalla de cierre. Antes el paciente tenía que
     volver al teléfono y tocar Finalizar, y muchos no se daban cuenta de
     que ya había terminado. */
  const terminadoServidor = ev.sesionServidor?.terminado ?? false;
  // terminarYGuardar cambia cada segundo (lee el cronómetro): por ref, para
  // que el temporizador no se reinicie con cada tic.
  const terminarYGuardarRef = useRef(terminarYGuardar);
  useEffect(() => {
    terminarYGuardarRef.current = terminarYGuardar;
  });
  useEffect(() => {
    if (!terminadoServidor || !grabando || guardadoRef.current) return;
    const id = setTimeout(() => void terminarYGuardarRef.current(), 2500);
    return () => clearTimeout(id);
  }, [terminadoServidor, grabando]);

  /* Si el paciente sale de la pantalla (flecha atrás, botón atrás de Android)
     después de haber empezado y sin tocar Finalizar, la sesión se guarda
     sola como ABANDONADA, con lo que alcanzó a hacer: el médico tiene que
     poder ver que lo intentó y hasta dónde llegó. Se lee todo de refs porque
     esto corre al desmontar, cuando el estado de React ya no está. */
  const alSalirRef = useRef<() => void>(() => {});
  useEffect(() => {
    alSalirRef.current = () => {
      if (!empezado || guardadoRef.current || idPaciente == null) return;
      const base = ev.resumen();
      if (!base) return;
      guardadoRef.current = true;
      void guardarSesion(
        { ...base, series: ev.seriesCerradas, fin: 'abandonada' },
        {
          idPaciente,
          idPrescripcion,
          calidad: {
            fps_medio: ev.calidad.fpsCamara,
            pct_filas_interpoladas: ev.calidad.pctFilasInterpoladas,
            pct_frames_descartados: ev.pctFramesDescartados(),
            serie_angulos: ev.serieAngulos(),
            guia: ev.resumenGuia(),
          },
        }
      ).catch(() => {
        // Sin red al salir no hay a quién avisar: la pantalla ya se cerró.
      });
    };
  });
  useEffect(() => () => alSalirRef.current(), []);

  const articulacionMedida = ev.ficha?.articulacion_medida ?? null;

  /** Botón "Continuar" del modal de cierre: si eligió un nivel, lo guarda
   *  (momento 'despues_sesion', ligado a la sesión que se acaba de crear)
   *  antes de volver. Un fallo de red aquí no debe dejar al paciente
   *  atrapado en la pantalla: se avisa y se vuelve igual. */
  // El compilador de React no logra inferir las dependencias de este async
  // con try/catch/finally y rechaza el array manual (que sí es el correcto:
  // las cuatro variables que lee). No afecta el comportamiento, solo deja
  // de auto-memoizar esta función.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const cerrarResumen = useCallback(async () => {
    if (nivelDolor != null && idPaciente != null && resumenFinal) {
      setGuardandoDolor(true);
      try {
        await registrarDolor({
          idPaciente,
          nivelDolor,
          momento: 'despues_sesion',
          idSesion: resumenFinal.idSesion,
          articulacion: articulacionMedida,
        });
      } catch {
        // No se bloquea la salida por esto: la sesión en sí ya se guardó bien.
      } finally {
        setGuardandoDolor(false);
      }
    }
    setResumenFinal(null);
    setNivelDolor(null);
    router.back();
  }, [nivelDolor, idPaciente, resumenFinal, articulacionMedida]);

  const finalizar = useCallback(() => {
    if (ev.repeticiones.length === 0 && !errorGuardado) {
      Alert.alert('¿Finalizar sin repeticiones?', 'Todavía no se contó ninguna repetición.', [
        { text: 'Seguir', style: 'cancel' },
        { text: 'Finalizar', style: 'destructive', onPress: () => void terminarYGuardar() },
      ]);
      return;
    }
    void terminarYGuardar();
  }, [ev.repeticiones.length, errorGuardado, terminarYGuardar]);

  // Salir de la pantalla no debe dejar poses viajando al servidor.
  useEffect(() => {
    return () => {
      grabandoRef.current = false;
    };
  }, []);

  if (prescritos === 'cargando') {
    return (
      <View style={s.centrado}>
        <ActivityIndicator color={VERDE} />
        <Text style={s.parrafo}>Revisando tu prescripción…</Text>
      </View>
    );
  }

  if (prescritos === 'error' || !miPrescripcion) {
    return (
      <View style={s.centrado}>
        <Text style={s.titulo}>
          {prescritos === 'error' ? 'No pudimos revisar tu prescripción' : 'Este ejercicio no está en tu prescripción'}
        </Text>
        <Text style={s.parrafo}>
          {prescritos === 'error'
            ? 'Revisa tu conexión a internet y vuelve a entrar.'
            : 'Solo se miden los ejercicios que tu médico te recetó. Elige uno de tu rutina en la pestaña Ejercicios.'}
        </Text>
        <Pressable style={s.botonPermiso} onPress={() => router.back()}>
          <Text style={s.botonTexto}>Volver</Text>
        </Pressable>
      </View>
    );
  }

  if (seriesPrescritas == null || repsPrescritas == null) {
    return (
      <View style={s.centrado}>
        <Text style={s.titulo}>Falta la prescripción</Text>
        <Text style={s.parrafo}>
          Tu médico todavía no definió cuántas series y repeticiones tienes que hacer de este
          ejercicio. Cuando lo haga, aparecerá aquí.
        </Text>
        <Pressable style={s.botonPermiso} onPress={() => router.back()}>
          <Text style={s.botonTexto}>Volver</Text>
        </Pressable>
      </View>
    );
  }

  if (!permiso) {
    return (
      <View style={s.centrado}>
        <ActivityIndicator color={VERDE} />
      </View>
    );
  }

  if (!permiso.granted) {
    return (
      <View style={s.centrado}>
        <Text style={s.titulo}>Necesitamos la cámara</Text>
        <Text style={s.parrafo}>
          Usamos la cámara frontal para medir tu movimiento mientras haces el ejercicio. El video se
          analiza en tu teléfono y no se guarda.
        </Text>
        {permiso.canAskAgain ? (
          <Pressable style={s.botonPermiso} onPress={pedirPermiso}>
            <Text style={s.botonTexto}>Permitir cámara</Text>
          </Pressable>
        ) : (
          <>
            <Text style={s.parrafo}>
              Negaste el permiso antes. Actívalo en Ajustes → Aplicaciones → Permisos → Cámara.
            </Text>
            <Pressable style={s.botonPermiso} onPress={() => void Linking.openSettings()}>
              <Text style={s.botonTexto}>Abrir ajustes</Text>
            </Pressable>
          </>
        )}
        <Pressable style={s.botonVolverTexto} onPress={() => router.back()}>
          <Text style={s.volverTexto}>Volver</Text>
        </Pressable>
      </View>
    );
  }

  const { estado, conexion, detalleConexion, repeticiones, calidad, ficha, guia, sesionServidor } = ev;
  const ultima = repeticiones[repeticiones.length - 1];

  const titulo = nombreEjercicio;
  const esAbduccion = ficha?.senal === 'abduccion';
  const correctasSerie =
    sesionServidor?.correctas_serie ??
    repeticiones.filter((r) => r.serie === estado.serie && r.veredicto === 'CORRECTA').length;

  // ── Un solo aviso, el más importante ──
  const enPreparacion = FASES_PREPARACION.includes(estado.fase);
  const todoBien = guia.correcciones.length === 1 && guia.correcciones[0] === TEXTO_EXCELENTE;
  const aviso =
    estadoCamara.fase === 'error'
      ? { texto: estadoCamara.detalle, tono: 'aviso' as const }
      : estadoCamara.fase === 'cargando'
        ? { texto: estadoCamara.detalle, tono: 'neutro' as const }
        : conexion !== 'listo'
          ? {
              texto: detalleConexion || 'Conectando con el servidor de FisioClin… (¿está encendido en el PC?)',
              tono: 'aviso' as const,
            }
          : !empezado
            ? {
                // Antes de empezar: dónde ponerse, en qué posición arrancar
                // y qué decide que cuente como bien hecha (mismo texto que
                // dice la voz — ver useEntrenadorVoz.ts).
                texto: posicion
                  ? `${posicion.camara} Posición inicial: ${posicion.corta}. ${posicion.tempo ?? ''} ${posicion.criterio ?? ''} Toca Empezar.`
                  : 'Colócate de cuerpo entero y toca Empezar',
                tono: 'neutro' as const,
              }
            : !grabando
              ? { texto: 'Sesión en pausa', tono: 'neutro' as const }
              : estado.fase === 'COLOCATE' && posicion
                ? { texto: `Posición inicial: ${posicion.corta}`, tono: 'aviso' as const }
                : enPreparacion || guia.correcciones.length === 0
                  ? { texto: estado.mensaje, tono: 'neutro' as const }
                : todoBien
                  ? { texto: 'Postura correcta, continúa', tono: 'bien' as const }
                  : { texto: guia.correcciones[0], tono: 'aviso' as const };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.pantalla}>
        <CamaraPose
          ref={camara}
          frontal={frontal}
          onPose={alLlegarPose}
          onEstado={setEstadoCamara}
          onFps={setFpsVideo}
        />

        {/* ─────────────────────────── Barra de arriba */}
        <View style={s.encabezado}>
          <Pressable style={s.botonIcono} onPress={() => router.back()} hitSlop={10}>
            <Ionicons name="arrow-back" size={22} color="#fff" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={s.tituloEjercicio} numberOfLines={1}>
              {titulo}
            </Text>
            <Text style={s.subtituloEjercicio} numberOfLines={1}>
              Serie {estado.serie}/{seriesPrescritas} · {estado.repeticiones}/{repsPrescritas} reps ·{' '}
              {correctasSerie} bien
            </Text>
          </View>
          {!grabando && vozActiva && (
            <Pressable
              style={s.botonIcono}
              onPress={repetirInstrucciones}
              accessibilityRole="button"
              accessibilityLabel="Escuchar las instrucciones del ejercicio"
            >
              <Ionicons name="volume-high-outline" size={20} color="#fff" />
            </Pressable>
          )}
          {!grabando && (
            <Pressable
              style={s.botonIcono}
              onPress={() => setFrontal((f) => !f)}
              accessibilityRole="button"
              accessibilityLabel={frontal ? 'Usar cámara trasera' : 'Usar cámara frontal'}
            >
              <Ionicons name="camera-reverse-outline" size={20} color="#fff" />
            </Pressable>
          )}
          <Pressable style={s.reloj} onLongPress={() => setVerHud((v) => !v)} delayLongPress={500}>
            <View>
              <Text
                style={[
                  s.relojTexto,
                  duracionObjetivo != null && segundos >= duracionObjetivo && { color: AMBAR },
                ]}
              >
                {formatoReloj(segundos)}
              </Text>
              {/* Meta del catálogo (Editar Ejercicio → Duración): distinta
                  por ejercicio, no bloquea — solo avisa cuando se cumplió. */}
              {duracionObjetivo != null && (
                <Text style={s.metaTexto}>meta {formatoReloj(duracionObjetivo)}</Text>
              )}
            </View>
            <View style={[s.puntoConexion, { backgroundColor: colorConexion(conexion) }]} />
          </Pressable>
        </View>

        {verHud && (
          <View style={s.hud} pointerEvents="none">
            <Text style={s.hudTexto}>video {fpsVideo} fps</Text>
            <Text style={s.hudTexto}>
              {estadoCamara.fase === 'lista' ? estadoCamara.delegado : '—'} · {calidad.latenciaMs} ms
            </Text>
            <Text style={s.hudTexto}>{estado.fase}</Text>
          </View>
        )}

        {/* ─────────────────────────── Parte de abajo */}
        <View style={s.abajo} pointerEvents="box-none">
          <View style={s.filaDatos} pointerEvents="none">
            <View style={s.chip}>
              <Text style={s.chipEtiqueta}>{esAbduccion ? 'ABDUCCIÓN' : 'FLEXIÓN'}</Text>
              <Text style={s.chipValor}>{estado.angulo != null ? `${Math.round(estado.angulo)}°` : '—'}</Text>
            </View>
            {/* Hasta dónde llegó en toda la sesión: se guarda y lo ve el médico. */}
            <View style={s.chip}>
              <Text style={s.chipEtiqueta}>MÁX</Text>
              <Text style={s.chipValor}>{anguloMax != null ? `${Math.round(anguloMax)}°` : '—'}</Text>
            </View>
            {ultima && (
              <View style={[s.chip, { borderColor: colorVeredicto(ultima.veredicto) }]}>
                <Text style={s.chipEtiqueta}>REP {ultima.n}</Text>
                <Text style={[s.chipValor, { color: colorVeredicto(ultima.veredicto) }]}>
                  {TEXTO_VEREDICTO[ultima.veredicto]}
                </Text>
              </View>
            )}
          </View>

          <View style={[s.aviso, aviso.tono === 'bien' && s.avisoBien, aviso.tono === 'aviso' && s.avisoAlerta]}>
            <Text style={s.avisoTexto} numberOfLines={4}>
              {aviso.texto}
            </Text>
          </View>

          {errorGuardado && (
            <Text style={s.errorGuardado}>
              No se pudo guardar: {errorGuardado}. Revisa tu conexión y toca Finalizar de nuevo.
            </Text>
          )}

          <View style={s.botones}>
            <Pressable style={[s.boton, { backgroundColor: AZUL_BOTON }]} onPress={alternar} disabled={guardando}>
              <Ionicons name={grabando ? 'pause' : 'play'} size={20} color="#fff" />
              <Text style={s.botonTexto}>{grabando ? 'Pausar' : empezado ? 'Reanudar' : 'Empezar'}</Text>
            </Pressable>
            <Pressable
              style={[s.boton, { backgroundColor: ROJO_BOTON }, guardando && { opacity: 0.6 }]}
              onPress={finalizar}
              disabled={guardando}
            >
              {guardando ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="stop" size={18} color="#fff" />
                  <Text style={s.botonTexto}>{errorGuardado ? 'Reintentar' : 'Finalizar'}</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>

        {/* ─────────────────────────── Pantalla de cierre: resumen + dolor */}
        <Modal visible={resumenFinal != null} transparent animationType="slide" statusBarTranslucent>
          <View style={s.modalFondo}>
            <View style={s.modalTarjeta}>
              {resumenFinal && (
                <ScrollView contentContainerStyle={s.modalContenido} showsVerticalScrollIndicator={false}>
                  <View style={[s.cierreIcono, !resumenFinal.completa && s.cierreIconoIncompleta]}>
                    <Ionicons
                      name={resumenFinal.completa ? 'trophy' : 'flag'}
                      size={38}
                      color={resumenFinal.completa ? VERDE : AMBAR}
                    />
                  </View>
                  <Text style={s.modalTitulo}>
                    {resumenFinal.completa ? '¡Sesión terminada!' : 'Sesión terminada'}
                  </Text>
                  <Text style={s.modalSubtitulo}>
                    {resumenFinal.completa
                      ? `Completaste «${titulo}» de hoy.`
                      : 'Quedó guardada hasta donde llegaste. Puedes volver a hacerla hoy.'}
                  </Text>

                  <View style={s.cifras}>
                    <Cifra
                      valor={`${resumenFinal.hechas}/${resumenFinal.prescritas}`}
                      etiqueta="Realizadas"
                      color={resumenFinal.completa ? VERDE : AMBAR}
                    />
                    <Cifra
                      valor={String(resumenFinal.correctas)}
                      etiqueta={resumenFinal.correctas === 1 ? 'Correcta' : 'Correctas'}
                      color={VERDE}
                    />
                    <Cifra valor={resumenFinal.duracion} etiqueta="Duración" />
                    {resumenFinal.anguloMax != null && (
                      <Cifra valor={`${Math.round(resumenFinal.anguloMax)}°`} etiqueta="Ángulo máx." />
                    )}
                  </View>

                  {resumenFinal.series.length > 0 && (
                    <View style={s.seriesLista}>
                      {resumenFinal.series.map((x) => (
                        <View key={x.serie} style={s.serieFila}>
                          <Text style={s.serieNombre}>Serie {x.serie}</Text>
                          <Text style={s.serieDato}>
                            {x.correctas}/{x.prescritas} bien
                          </Text>
                          <Text
                            style={[
                              s.serieVeredicto,
                              { color: x.veredicto === 'BIEN_HECHA' ? VERDE : x.veredicto === 'MAL_HECHA' ? ROJO : AMBAR },
                            ]}
                          >
                            {TEXTO_VEREDICTO_SERIE[x.veredicto]}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {resumenFinal.consejo && resumenFinal.correctas < resumenFinal.hechas && (
                    <View style={s.consejo}>
                      <Ionicons name="bulb-outline" size={20} color={AMBAR} />
                      <View style={{ flex: 1 }}>
                        <Text style={s.consejoTitulo}>Para la próxima</Text>
                        <Text style={s.consejoTexto}>{resumenFinal.consejo}</Text>
                      </View>
                    </View>
                  )}

                  <Text style={s.modalNota}>Tu médico ya puede ver esta sesión.</Text>

                  <View style={s.modalSeparador} />

                  <Text style={s.modalPreguntaDolor}>¿Cuánto te dolió al hacer este ejercicio?</Text>
                  <BarraDolor
                    valor={nivelDolor}
                    onCambiar={(n) => {
                      setNivelDolor(n);
                      anunciarDolor(n);
                    }}
                  />

                  <Pressable
                    style={[s.botonModal, guardandoDolor && { opacity: 0.6 }]}
                    onPress={() => void cerrarResumen()}
                    disabled={guardandoDolor}
                  >
                    {guardandoDolor ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={s.botonTexto}>Continuar</Text>
                    )}
                  </Pressable>
                  {vozActiva && (
                    <Pressable
                      style={s.botonEscuchar}
                      onPress={() =>
                        anunciarResumen({
                          hechas: resumenFinal.hechas,
                          correctas: resumenFinal.correctas,
                          prescritas: resumenFinal.prescritas,
                          consejo: resumenFinal.consejo,
                          repetir: true,
                        })
                      }
                    >
                      <Ionicons name="volume-high-outline" size={18} color={VERDE} />
                      <Text style={s.botonEscucharTexto}>Escuchar de nuevo</Text>
                    </Pressable>
                  )}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>
      </View>
    </>
  );
}

function Cifra({ valor, etiqueta, color }: { valor: string; etiqueta: string; color?: string }) {
  const s = useEstilos();
  return (
    <View style={s.cifra}>
      <Text style={[s.cifraValor, color != null && { color }]}>{valor}</Text>
      <Text style={s.cifraEtiqueta}>{etiqueta}</Text>
    </View>
  );
}

const useEstilos = crearEstilos((p) =>
  StyleSheet.create({
    // El video es TODA la pantalla; lo demás flota encima y ocupa poco.
    pantalla: { flex: 1, backgroundColor: '#0E1116' },
    centrado: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      gap: 12,
      backgroundColor: p.fondo,
    },
    titulo: { fontSize: 24, fontWeight: '700', color: p.texto, textAlign: 'center' },
    parrafo: { fontSize: 15, color: p.textoSuave, textAlign: 'center', lineHeight: 22 },
    botonPermiso: {
      backgroundColor: p.verde,
      paddingVertical: 15,
      paddingHorizontal: 28,
      borderRadius: 12,
      alignItems: 'center',
    },
    botonVolverTexto: { paddingVertical: 10 },
    volverTexto: { color: p.verdeTexto, fontSize: 15, fontWeight: '600' },

    encabezado: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingTop: Platform.OS === 'ios' ? 52 : 34,
      paddingBottom: 8,
      paddingHorizontal: 10,
      backgroundColor: 'rgba(8,10,14,0.55)',
    },
    botonIcono: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: 'rgba(0,0,0,0.35)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tituloEjercicio: { color: '#fff', fontSize: 15, fontWeight: '800' },
    subtituloEjercicio: { color: 'rgba(255,255,255,0.85)', fontSize: 12.5, fontWeight: '700', marginTop: 1 },
    reloj: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 2 },
    relojTexto: { color: '#fff', fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
    metaTexto: { color: 'rgba(255,255,255,0.75)', fontSize: 10, fontWeight: '700', marginTop: -2 },
    puntoConexion: { width: 9, height: 9, borderRadius: 5 },

    hud: {
      position: 'absolute',
      top: Platform.OS === 'ios' ? 104 : 86,
      left: 10,
      backgroundColor: 'rgba(0,0,0,0.55)',
      borderRadius: 8,
      paddingVertical: 5,
      paddingHorizontal: 8,
      gap: 1,
    },
    hudTexto: { color: '#fff', fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

    abajo: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 10,
      paddingBottom: Platform.OS === 'ios' ? 28 : 14,
      gap: 8,
    },
    filaDatos: { flexDirection: 'row', gap: 8 },
    chip: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      backgroundColor: 'rgba(8,10,14,0.6)',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.15)',
      paddingVertical: 5,
      paddingHorizontal: 12,
    },
    chipEtiqueta: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
    chipValor: { color: '#fff', fontSize: 18, fontWeight: '800' },

    aviso: {
      alignSelf: 'stretch',
      backgroundColor: 'rgba(8,10,14,0.6)',
      borderRadius: 12,
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    avisoBien: { backgroundColor: 'rgba(22,128,61,0.85)' },
    avisoAlerta: { backgroundColor: 'rgba(180,110,10,0.85)' },
    avisoTexto: { color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center' },

    errorGuardado: { color: '#FF8A73', fontSize: 12.5, textAlign: 'center', lineHeight: 18 },

    botones: { flexDirection: 'row', gap: 10 },
    boton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 13,
      borderRadius: 14,
    },
    botonTexto: { color: '#fff', fontSize: 16, fontWeight: '800' },

    modalFondo: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    },
    modalTarjeta: {
      width: '100%',
      maxWidth: 420,
      maxHeight: '92%',
      backgroundColor: p.superficie,
      borderRadius: 24,
      overflow: 'hidden',
    },
    modalContenido: { padding: 20, gap: 12 },
    cierreIcono: {
      alignSelf: 'center',
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: 'rgba(34,197,94,0.15)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    cierreIconoIncompleta: { backgroundColor: 'rgba(245,184,61,0.18)' },
    modalTitulo: { fontSize: 22, fontWeight: '800', color: p.texto, textAlign: 'center' },
    modalSubtitulo: { fontSize: 14, color: p.textoSuave, textAlign: 'center', lineHeight: 20, marginTop: -4 },
    cifras: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    cifra: {
      flexGrow: 1,
      flexBasis: '45%',
      backgroundColor: p.superficieAlt,
      borderRadius: 14,
      paddingVertical: 10,
      alignItems: 'center',
    },
    cifraValor: { fontSize: 20, fontWeight: '800', color: p.texto },
    cifraEtiqueta: { fontSize: 12, fontWeight: '600', color: p.textoSuave, marginTop: 2 },
    seriesLista: { backgroundColor: p.superficieAlt, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4 },
    serieFila: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 8 },
    serieNombre: { flex: 1, fontSize: 13.5, fontWeight: '700', color: p.texto },
    serieDato: { fontSize: 13, color: p.textoSuave, fontWeight: '600' },
    serieVeredicto: { fontSize: 13, fontWeight: '800', minWidth: 78, textAlign: 'right' },
    consejo: {
      flexDirection: 'row',
      gap: 10,
      backgroundColor: 'rgba(245,184,61,0.14)',
      borderRadius: 14,
      padding: 12,
    },
    consejoTitulo: { fontSize: 12.5, fontWeight: '800', color: p.texto },
    consejoTexto: { fontSize: 14, color: p.texto, marginTop: 2, lineHeight: 20 },
    modalNota: { fontSize: 12.5, color: p.textoSuave, textAlign: 'center' },
    modalSeparador: { height: 1, backgroundColor: p.borde, marginVertical: 2 },
    modalPreguntaDolor: { fontSize: 15, fontWeight: '700', color: p.texto, textAlign: 'center' },
    botonModal: {
      backgroundColor: p.verde,
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    botonEscuchar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 8,
    },
    botonEscucharTexto: { color: VERDE, fontSize: 14.5, fontWeight: '700' },
  })
);
