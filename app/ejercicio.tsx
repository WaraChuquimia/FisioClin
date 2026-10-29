/* ──────────────────────────────────────────────────────────────────────────
   FisioClin — detalle de un ejercicio prescrito

   Antes de la sesión con cámara, el paciente ve el video de referencia que
   subió su médico (cómo se hace el ejercicio), lo que le recetaron y cómo
   prepararse. Desde aquí pulsa "Iniciar" y pasa a la sesión en vivo
   (app/rehabilitacion.tsx); al terminarla, `router.back()` vuelve aquí y la
   pantalla se recarga para mostrar el ejercicio como hecho.
   ────────────────────────────────────────────────────────────────────────── */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BarraDolor } from '@/components/BarraDolor';
import { useAuth } from '@/context/AuthContext';
import { crearEstilos, useTema } from '@/context/TemaContext';
import {
  EjercicioCatalogo,
  marcarEjercicioHoy,
  obtenerEjercicioPrescrito,
  urlVideoEjercicio,
} from '@/lib/ejerciciosData';
import { registrarDolor } from '@/lib/rehabilitacionData';

const ICONO_ZONA: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
  cadera: 'human-handsup',
  rodilla: 'human-handsdown',
  tobillo: 'shoe-print',
};
const iconoParaZona = (zona: string) => ICONO_ZONA[zona.toLowerCase()] ?? 'run';

const capitalizar = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

/** expo-video no reproduce YouTube: esos enlaces se abren en el navegador. */
const esYoutube = (url: string) => /(^|\.)youtube\.com|youtu\.be/i.test(url);

const PREPARACION: { icono: React.ComponentProps<typeof Ionicons>['name']; texto: string }[] = [
  { icono: 'phone-portrait-outline', texto: 'Apoya el teléfono firme, a 2 o 3 metros de ti.' },
  { icono: 'body-outline', texto: 'Que se vea todo tu cuerpo, de la cabeza a los pies.' },
  { icono: 'sunny-outline', texto: 'Busca buena luz y un espacio libre para moverte.' },
  { icono: 'hand-left-outline', texto: 'Si sientes dolor fuerte, detente y avisa a tu médico.' },
];

export default function EjercicioScreen() {
  const { p } = useTema();
  const s = useEstilos();
  const { patient } = useAuth();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;
  const { idPrescripcion } = useLocalSearchParams<{ idPrescripcion?: string }>();
  const idPresc = Number(idPrescripcion);

  const [ejercicio, setEjercicio] = useState<EjercicioCatalogo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  /** Dolor ANTES de empezar (momento 'antes_sesion'): se pregunta al tocar
   *  "Iniciar", antes de pasar a la cámara — el "después" ya se pregunta
   *  al terminar la sesión (app/rehabilitacion.tsx). */
  const [mostrarDolor, setMostrarDolor] = useState(false);
  const [nivelDolor, setNivelDolor] = useState<number | null>(null);
  const [guardandoDolor, setGuardandoDolor] = useState(false);

  const cargar = useCallback(async () => {
    if (idPaciente == null || !Number.isFinite(idPresc)) {
      setCargando(false);
      setError('No encontramos este ejercicio.');
      return;
    }
    try {
      setError(null);
      const ej = await obtenerEjercicioPrescrito(idPaciente, idPresc);
      setEjercicio(ej);
      if (!ej) setError('Este ejercicio ya no está en tu rutina.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cargar el ejercicio.');
    } finally {
      setCargando(false);
    }
  }, [idPaciente, idPresc]);

  // Al entrar y al volver de la sesión con cámara (para ver si ya quedó hecho).
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar])
  );

  const irACamara = useCallback(() => {
    if (!ejercicio?.codigo_cv) return;
    router.push({
      pathname: '/rehabilitacion',
      params: {
        ejercicio: ejercicio.codigo_cv,
        nombre: ejercicio.nombre.trim(),
        idPrescripcion: ejercicio.id_prescripcion != null ? String(ejercicio.id_prescripcion) : undefined,
        series: ejercicio.series != null ? String(ejercicio.series) : undefined,
        repeticiones: ejercicio.repeticiones != null ? String(ejercicio.repeticiones) : undefined,
        // Duración (seg) del catálogo (panel del médico, "Editar Ejercicio"):
        // antes solo se mostraba como "X min" aquí; ahora es la meta de
        // tiempo que ve el paciente durante la sesión con cámara.
        duracionSegundos:
          ejercicio.duracion_estimada_segundos != null ? String(ejercicio.duracion_estimada_segundos) : undefined,
      },
    });
  }, [ejercicio]);

  /** Botón "Iniciar": primero pregunta el dolor de ahora, recién después
   *  pasa a la cámara. No se pregunta si no hay sesión con cámara (el
   *  botón ya está deshabilitado en ese caso). */
  const iniciar = () => {
    if (!ejercicio?.codigo_cv) return;
    setNivelDolor(null);
    setMostrarDolor(true);
  };

  const confirmarDolorYContinuar = useCallback(async () => {
    if (nivelDolor != null && idPaciente != null && ejercicio) {
      setGuardandoDolor(true);
      try {
        await registrarDolor({
          idPaciente,
          nivelDolor,
          momento: 'antes_sesion',
          articulacion: ejercicio.zona,
        });
      } catch {
        // No se bloquea el inicio del ejercicio por esto: se intenta
        // registrar, pero el paciente no tiene por qué quedarse esperando
        // una red que puede estar fallando justo antes de hacer cámara.
      } finally {
        setGuardandoDolor(false);
      }
    }
    setMostrarDolor(false);
    irACamara();
  }, [nivelDolor, idPaciente, ejercicio, irACamara]);

  const alternarHecho = async () => {
    if (!ejercicio || ejercicio.id_prescripcion == null || guardando) return;
    const nuevo = !ejercicio.completado_hoy;
    setGuardando(true);
    setEjercicio({ ...ejercicio, completado_hoy: nuevo });
    try {
      await marcarEjercicioHoy(ejercicio.id_prescripcion, nuevo);
    } catch {
      setEjercicio({ ...ejercicio, completado_hoy: !nuevo });
    } finally {
      setGuardando(false);
    }
  };

  const encabezado = (
    <View style={s.encabezado}>
      <TouchableOpacity
        style={s.botonAtras}
        activeOpacity={0.7}
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Volver"
      >
        <Ionicons name="chevron-back" size={22} color={p.verdeTexto} />
      </TouchableOpacity>
      <Text style={s.encabezadoTitulo}>Tu ejercicio</Text>
    </View>
  );

  if (cargando) {
    return (
      <SafeAreaView style={s.pantalla} edges={['top']}>
        {encabezado}
        <View style={s.centrado}>
          <ActivityIndicator color={p.verde} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (!ejercicio) {
    return (
      <SafeAreaView style={s.pantalla} edges={['top']}>
        {encabezado}
        <View style={s.centrado}>
          <Ionicons name="alert-circle-outline" size={48} color={p.textoTenue} />
          <Text style={s.vacioTitulo}>{error ?? 'No encontramos este ejercicio.'}</Text>
          <TouchableOpacity style={s.botonSecundario} onPress={() => void cargar()}>
            <Text style={s.botonSecundarioTexto}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const minutos = Math.max(1, Math.round(ejercicio.duracion_estimada_segundos / 60));
  const conCamara = !!ejercicio.codigo_cv;
  const hecho = ejercicio.completado_hoy;

  return (
    <SafeAreaView style={s.pantalla} edges={['top', 'bottom']}>
      {encabezado}

      <ScrollView contentContainerStyle={s.contenido} showsVerticalScrollIndicator={false}>
        <VideoReferencia ejercicio={ejercicio} />

        {/* ── Nombre y zona ── */}
        <View style={s.tituloBloque}>
          <View style={s.chipZona}>
            <MaterialCommunityIcons name={iconoParaZona(ejercicio.zona)} size={14} color={p.verdeTexto} />
            <Text style={s.chipZonaTexto}>{capitalizar(ejercicio.zona)}</Text>
          </View>
          <Text style={s.nombre}>{ejercicio.nombre.trim()}</Text>
        </View>

        {hecho && (
          <View style={s.avisoHecho}>
            <Ionicons name="checkmark-circle" size={20} color={p.verdeTexto} />
            <Text style={s.avisoHechoTexto}>¡Ya completaste este ejercicio hoy! Puedes repetirlo si quieres.</Text>
          </View>
        )}

        {/* ── Lo que recetó el médico ── */}
        <View style={s.datos}>
          <Dato icono="layers-outline" valor={ejercicio.series ?? '—'} etiqueta="Series" />
          <Dato icono="repeat-outline" valor={ejercicio.repeticiones ?? '—'} etiqueta="Repeticiones" />
          <Dato icono="time-outline" valor={`${minutos} min`} etiqueta="Duración" />
        </View>

        {/* ── Cómo hacerlo ── */}
        <View style={s.tarjeta}>
          <View style={s.tarjetaTituloFila}>
            <View style={s.tarjetaIcono}>
              <Ionicons name="document-text-outline" size={18} color={p.verdeTexto} />
            </View>
            <Text style={s.tarjetaTitulo}>Cómo hacerlo</Text>
          </View>
          <Text style={s.parrafo}>
            {ejercicio.descripcion?.trim() ||
              'Mira el video y copia el movimiento con calma. Haz cada repetición completa y controlada, sin rebotes.'}
          </Text>
        </View>

        {/* ── Antes de empezar ── */}
        <View style={s.tarjeta}>
          <View style={s.tarjetaTituloFila}>
            <View style={s.tarjetaIcono}>
              <Ionicons name="checkbox-outline" size={18} color={p.verdeTexto} />
            </View>
            <Text style={s.tarjetaTitulo}>Antes de empezar</Text>
          </View>
          {PREPARACION.map((item) => (
            <View key={item.texto} style={s.pasoFila}>
              <Ionicons name={item.icono} size={18} color={p.textoSuave} />
              <Text style={s.pasoTexto}>{item.texto}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={s.enlaceHecho}
          onPress={() => void alternarHecho()}
          disabled={guardando}
          accessibilityRole="button"
        >
          <Ionicons
            name={hecho ? 'close-circle-outline' : 'checkmark-done-outline'}
            size={18}
            color={p.textoSuave}
          />
          <Text style={s.enlaceHechoTexto}>
            {hecho ? 'Desmarcar como hecho hoy' : 'Ya lo hice sin la cámara · marcar como hecho'}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ── Botón fijo abajo ── */}
      <View style={s.barraInferior}>
        {!conCamara && (
          <Text style={s.notaSinCamara}>
            Tu médico aún no activó la cámara para este ejercicio. Puedes marcarlo como hecho.
          </Text>
        )}
        <TouchableOpacity
          style={[s.botonIniciar, !conCamara && s.botonIniciarApagado]}
          activeOpacity={0.88}
          onPress={iniciar}
          disabled={!conCamara}
          accessibilityRole="button"
          accessibilityLabel="Iniciar ejercicio con la cámara"
        >
          <Ionicons name="play" size={20} color={p.blanco} />
          <Text style={s.botonIniciarTexto}>{hecho ? 'Hacer otra vez' : 'Iniciar'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Modal: dolor ANTES de empezar ── */}
      <Modal visible={mostrarDolor} transparent animationType="fade" statusBarTranslucent>
        <View style={s.modalFondo}>
          <View style={s.modalTarjeta}>
            <Text style={s.modalTitulo}>Antes de empezar</Text>
            <Text style={s.modalPregunta}>¿Cuánto te duele ahora mismo, antes de hacer el ejercicio?</Text>
            <BarraDolor valor={nivelDolor} onCambiar={setNivelDolor} />
            <Pressable
              style={[s.botonModal, guardandoDolor && { opacity: 0.6 }]}
              onPress={() => void confirmarDolorYContinuar()}
              disabled={guardandoDolor}
            >
              {guardandoDolor ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.botonIniciarTexto}>Continuar</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────
// Video de referencia
// ─────────────────────────────────────────────
function VideoReferencia({ ejercicio }: { ejercicio: EjercicioCatalogo }) {
  const { p } = useTema();
  const s = useEstilos();
  // El enlace se guarda junto con el video al que corresponde: mientras no
  // coincida con el actual, todavía se está buscando.
  const [resultado, setResultado] = useState<{ clave: string; url: string | null } | null>(null);

  const player = useVideoPlayer(null, (pl) => {
    pl.loop = true;
    pl.muted = true;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  // Se pide el enlace una sola vez por video (el firmado dura 2 h).
  const { video_bucket, video_path, video_url } = ejercicio;
  const clave = `${video_bucket}|${video_path}|${video_url}`;
  useEffect(() => {
    let vigente = true;
    urlVideoEjercicio({ video_bucket, video_path, video_url })
      .catch(() => null)
      .then((u) => {
        if (vigente) setResultado({ clave, url: u });
      });
    return () => {
      vigente = false;
    };
  }, [clave, video_bucket, video_path, video_url]);
  const buscando = resultado?.clave !== clave;
  const url = buscando ? null : resultado.url;

  useEffect(() => {
    if (!url || esYoutube(url)) return;
    let vigente = true;
    player
      .replaceAsync(url)
      .then(() => vigente && player.play())
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [url, player]);

  // Que no siga sonando/reproduciendo mientras el paciente está en la cámara.
  useFocusEffect(
    useCallback(() => {
      return () => {
        try {
          player.pause();
        } catch {}
      };
    }, [player])
  );

  if (buscando) {
    return (
      <View style={s.video}>
        <ActivityIndicator color={p.blanco} />
      </View>
    );
  }

  if (!url) {
    return (
      <View style={[s.video, s.videoVacio]}>
        <MaterialCommunityIcons name={iconoParaZona(ejercicio.zona)} size={46} color={p.verdeTexto} />
        <Text style={s.videoVacioTitulo}>Sin video de referencia</Text>
        <Text style={s.videoVacioTexto}>Tu médico todavía no subió el video de este ejercicio.</Text>
      </View>
    );
  }

  if (esYoutube(url)) {
    return (
      <Pressable style={[s.video, s.videoVacio]} onPress={() => void WebBrowser.openBrowserAsync(url)}>
        <Ionicons name="logo-youtube" size={48} color="#FF0033" />
        <Text style={s.videoVacioTitulo}>Ver el video de referencia</Text>
        <Text style={s.videoVacioTexto}>Se abre en YouTube. Vuelve aquí para iniciar.</Text>
      </Pressable>
    );
  }

  return (
    <View style={s.video}>
      <VideoView
        style={StyleSheet.absoluteFill}
        player={player}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
      />
      {status === 'loading' && (
        <View style={s.videoCapa} pointerEvents="none">
          <ActivityIndicator color={p.blanco} />
        </View>
      )}
      {status === 'error' && (
        <Pressable style={s.videoCapa} onPress={() => void player.replaceAsync(url).then(() => player.play())}>
          <Ionicons name="refresh" size={30} color={p.blanco} />
          <Text style={s.videoErrorTexto}>No se pudo cargar el video. Toca para reintentar.</Text>
        </Pressable>
      )}
      <View style={s.videoEtiqueta} pointerEvents="none">
        <Ionicons name="videocam" size={12} color={p.blanco} />
        <Text style={s.videoEtiquetaTexto}>Video de referencia</Text>
      </View>
    </View>
  );
}

function Dato({
  icono,
  valor,
  etiqueta,
}: {
  icono: React.ComponentProps<typeof Ionicons>['name'];
  valor: string | number;
  etiqueta: string;
}) {
  const { p } = useTema();
  const s = useEstilos();
  return (
    <View style={s.dato}>
      <Ionicons name={icono} size={18} color={p.verdeTexto} />
      <Text style={s.datoValor}>{valor}</Text>
      <Text style={s.datoEtiqueta}>{etiqueta}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────
// Estilos
// ─────────────────────────────────────────────
const useEstilos = crearEstilos((p) =>
  StyleSheet.create({
    pantalla: { flex: 1, backgroundColor: p.fondo },
    centrado: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },

    encabezado: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginHorizontal: 16,
      marginTop: 12,
      marginBottom: 10,
      paddingHorizontal: 14,
    },
    botonAtras: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
    },
    encabezadoTitulo: { fontSize: 20, fontWeight: '800', color: p.texto },

    contenido: { paddingHorizontal: 16, paddingBottom: 24, gap: 14 },

    video: {
      width: '100%',
      aspectRatio: 16 / 9,
      borderRadius: 20,
      overflow: 'hidden',
      backgroundColor: '#0B1220',
      alignItems: 'center',
      justifyContent: 'center',
    },
    videoVacio: {
      backgroundColor: p.verdeSuave,
      paddingHorizontal: 24,
      gap: 4,
    },
    videoVacioTitulo: { fontSize: 16, fontWeight: '800', color: p.texto, marginTop: 8 },
    videoVacioTexto: { fontSize: 13, color: p.textoSuave, textAlign: 'center', lineHeight: 18 },
    videoCapa: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: 'rgba(0,0,0,0.45)',
      paddingHorizontal: 24,
    },
    videoErrorTexto: { color: '#FFFFFF', fontSize: 13, textAlign: 'center' },
    videoEtiqueta: {
      position: 'absolute',
      top: 10,
      left: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: 'rgba(0,0,0,0.5)',
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    videoEtiquetaTexto: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },

    tituloBloque: { gap: 8, marginTop: 4 },
    chipZona: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: p.verdeSuave,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    chipZonaTexto: { fontSize: 12, fontWeight: '800', color: p.verdeTexto, letterSpacing: 0.3 },
    nombre: { fontSize: 24, fontWeight: '800', color: p.texto, letterSpacing: -0.3 },

    avisoHecho: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: p.verdeSuave,
      borderRadius: 14,
      padding: 12,
    },
    avisoHechoTexto: { flex: 1, fontSize: 13.5, fontWeight: '600', color: p.verdeTexto, lineHeight: 19 },

    datos: { flexDirection: 'row', gap: 10 },
    dato: {
      flex: 1,
      alignItems: 'center',
      gap: 4,
      backgroundColor: p.superficie,
      borderRadius: 16,
      paddingVertical: 14,
      borderWidth: 1,
      borderColor: p.borde,
    },
    datoValor: { fontSize: 20, fontWeight: '800', color: p.texto },
    datoEtiqueta: { fontSize: 12, color: p.textoSuave, fontWeight: '600' },

    tarjeta: {
      backgroundColor: p.superficie,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: p.borde,
      gap: 10,
    },
    tarjetaTituloFila: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    tarjetaIcono: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tarjetaTitulo: { fontSize: 16, fontWeight: '800', color: p.texto },
    parrafo: { fontSize: 14.5, color: p.textoSuave, lineHeight: 21 },
    pasoFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    pasoTexto: { flex: 1, fontSize: 14, color: p.textoSuave, lineHeight: 20 },

    enlaceHecho: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 6,
    },
    enlaceHechoTexto: { fontSize: 13.5, color: p.textoSuave, fontWeight: '600' },

    barraInferior: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      backgroundColor: p.superficie,
      borderTopWidth: 1,
      borderTopColor: p.borde,
      gap: 8,
    },
    notaSinCamara: { fontSize: 12.5, color: p.textoSuave, textAlign: 'center' },
    botonIniciar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: p.verde,
      borderRadius: 16,
      paddingVertical: 16,
    },
    botonIniciarApagado: { opacity: 0.4 },
    botonIniciarTexto: { color: p.blanco, fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },

    vacioTitulo: { fontSize: 16, fontWeight: '700', color: p.texto, textAlign: 'center' },
    botonSecundario: {
      backgroundColor: p.verdeSuave,
      borderRadius: 12,
      paddingHorizontal: 18,
      paddingVertical: 10,
    },
    botonSecundarioTexto: { color: p.verdeTexto, fontWeight: '800' },

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
      backgroundColor: p.superficie,
      borderRadius: 20,
      padding: 20,
      gap: 14,
    },
    modalTitulo: { fontSize: 19, fontWeight: '800', color: p.texto, textAlign: 'center' },
    modalPregunta: { fontSize: 14.5, color: p.textoSuave, textAlign: 'center', lineHeight: 20 },
    botonModal: {
      backgroundColor: p.verde,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
  })
);
