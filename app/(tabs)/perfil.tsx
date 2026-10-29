import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/context/AuthContext';
import { useFotoPerfil } from '@/context/FotoPerfilContext';
import { useNotificaciones } from '@/context/NotificacionesContext';
import { crearEstilos, TAMANOS_TEXTO, useTema } from '@/context/TemaContext';
import { InicioData, obtenerInicioPaciente } from '@/lib/pacienteData';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

function textoCampo(valor: unknown): string | null {
  if (typeof valor === 'string' && valor.trim().length > 0) return valor.trim();
  return null;
}

function edad(fechaNacimiento: string | null) {
  if (!fechaNacimiento) return null;
  const n = new Date(`${fechaNacimiento}T00:00:00`);
  if (Number.isNaN(n.getTime())) return null;
  const hoy = new Date();
  let anios = hoy.getFullYear() - n.getFullYear();
  const aunNoCumple =
    hoy.getMonth() < n.getMonth() || (hoy.getMonth() === n.getMonth() && hoy.getDate() < n.getDate());
  if (aunNoCumple) anios -= 1;
  return anios;
}

function iniciales(nombre: string) {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  return partes.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

function capitalizar(t: string) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Escala radiográfica de Kellgren-Lawrence para artrosis (0 a 4). */
const GRADO_KL: Record<number, string> = {
  0: 'Sin signos de artrosis',
  1: 'Artrosis dudosa',
  2: 'Artrosis leve',
  3: 'Artrosis moderada',
  4: 'Artrosis severa',
};

export default function PerfilScreen() {
  const { patient, signOut, refreshPatient } = useAuth();
  const { oscuro, setOscuro, p, tamanoTexto, setTamanoTexto, vozActiva, setVozActiva } = useTema();
  const { activas, setActivas, sinLeer } = useNotificaciones();
  const s = useEstilos();
  const router = useRouter();
  const foto = useFotoPerfil();

  const opcionesFoto = () =>
    Alert.alert('Foto de perfil', 'Tu médico también verá esta foto.', [
      { text: 'Tomar foto', onPress: () => void foto.cambiarFoto('camara') },
      { text: 'Elegir de la galería', onPress: () => void foto.cambiarFoto('galeria') },
      ...(foto.url
        ? [{ text: 'Quitar foto', style: 'destructive' as const, onPress: () => void foto.quitarFoto() }]
        : []),
      { text: 'Cancelar', style: 'cancel' as const },
    ]);

  const [data, setData] = useState<InicioData | null>(null);
  // Hora de referencia para calcular la semana del plan (fija por montaje).
  const [ahora] = useState(() => Date.now());
  const [cargando, setCargando] = useState(true);

  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  // Al entrar al Perfil se trae lo último: si el médico actualizó el
  // diagnóstico o el plan, se ve sin volver a iniciar sesión.
  useFocusEffect(
    useCallback(() => {
      if (idPaciente == null) {
        setCargando(false);
        return;
      }
      let vigente = true;
      void refreshPatient();
      obtenerInicioPaciente(idPaciente)
        .then((d) => vigente && setData(d))
        .catch(() => vigente && setData(null))
        .finally(() => vigente && setCargando(false));
      return () => {
        vigente = false;
      };
      // refreshPatient cambia en cada render del AuthProvider.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idPaciente])
  );

  const nombre =
    textoCampo(data?.paciente?.nombre_completo) ??
    textoCampo(patient?.nombre_completo) ??
    textoCampo(data?.paciente?.nombres) ??
    textoCampo(patient?.nombres) ??
    'Paciente';

  const carnet =
    textoCampo(patient?.numero_carnet) ?? textoCampo(patient?.numero_carnet_normalizado) ?? '—';
  const anios = edad(textoCampo(patient?.fecha_nacimiento));
  const telefono = textoCampo(patient?.telefono);

  const articulacion =
    textoCampo(data?.paciente?.articulacion_principal) ?? textoCampo(patient?.articulacion_principal);
  const diagnostico = textoCampo(patient?.diagnostico_previo);
  const gradoKl = typeof patient?.grado_artrosis_kl === 'number' ? patient.grado_artrosis_kl : null;

  const progresoSemanal = data?.progreso_semanal ?? [];
  const diasActivos = progresoSemanal.filter((d) => d.valor > 0);
  const progresoPromedio = diasActivos.length
    ? diasActivos.reduce((acc, d) => acc + d.valor, 0) / diasActivos.length
    : 0;

  const plan = data?.plan;
  const semanaActual = plan
    ? Math.min(
        plan.duracion_estimada_semanas,
        Math.max(
          1,
          Math.floor((ahora - new Date(plan.fecha_inicio).getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1
        )
      )
    : null;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={p.verdeOscuro} />

      <ScrollView style={s.scroll} contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {/* ───────────── ENCABEZADO ───────────── */}
        <LinearGradient
          colors={[p.verde, p.verdeOscuro]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={s.header}
        >
          <View style={[s.decorCircle, s.decorCircleBig]} />
          <View style={[s.decorCircle, s.decorCircleSmall]} />

          <TouchableOpacity
            style={s.avatar}
            activeOpacity={0.8}
            onPress={opcionesFoto}
            disabled={foto.subiendo}
            accessibilityRole="button"
            accessibilityLabel="Cambiar foto de perfil"
          >
            {foto.url ? (
              <Image source={{ uri: foto.url }} style={s.avatarFoto} />
            ) : (
              <Text style={s.avatarIniciales}>{iniciales(nombre)}</Text>
            )}
            {foto.subiendo && (
              <View style={s.avatarCargando}>
                <ActivityIndicator color={p.blanco} />
              </View>
            )}
            <View style={s.avatarCamara}>
              <Ionicons name="camera" size={16} color={p.blanco} />
            </View>
          </TouchableOpacity>
          <Text style={s.patientName}>{nombre}</Text>
          <View style={s.matriculaPill}>
            <Ionicons name="card-outline" size={14} color={p.blanco} />
            <Text style={s.matriculaText}>CI {carnet}</Text>
          </View>
        </LinearGradient>

        {/* Progreso flotando sobre el encabezado */}
        <View style={s.progressCard}>
          {cargando ? (
            <ActivityIndicator color={p.verde} />
          ) : (
            <>
              <View style={s.progressHeaderRow}>
                <Text style={s.progressLabel}>Progreso del tratamiento</Text>
                <Text style={s.progressPercent}>{Math.round(progresoPromedio * 100)}%</Text>
              </View>
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${progresoPromedio * 100}%` }]} />
              </View>
              <Text style={s.progressHint}>
                {semanaActual != null && plan
                  ? `Semana ${semanaActual} de ${plan.duracion_estimada_semanas}`
                  : 'Aún no tienes un plan de tratamiento activo'}
              </Text>
            </>
          )}
        </View>

        {/* ───────────── DATOS PERSONALES ───────────── */}
        <Card>
          <CardHeader icon="person-outline" title="Mis datos" />
          <Dato icon="person-circle-outline" label="Nombre completo" value={nombre} />
          <Dato icon="card-outline" label="Carnet de identidad" value={carnet} />
          {anios != null && <Dato icon="calendar-outline" label="Edad" value={`${anios} años`} />}
          {telefono && <Dato icon="call-outline" label="Teléfono" value={telefono} />}
        </Card>

        {/* ───────────── DIAGNÓSTICO ───────────── */}
        <Card>
          <CardHeader icon="document-text-outline" title="Diagnóstico" />

          {diagnostico ? (
            <View style={s.diagnosticoCaja}>
              <Text style={s.diagnosticoTexto}>{diagnostico}</Text>
            </View>
          ) : (
            <Text style={s.textoVacio}>Tu médico todavía no registró un diagnóstico.</Text>
          )}

          <View style={s.chipsFila}>
            {articulacion && (
              <View style={s.chip}>
                <Text style={s.chipEtiqueta}>Articulación</Text>
                <Text style={s.chipValor}>{capitalizar(articulacion)}</Text>
              </View>
            )}
            {gradoKl != null && (
              <View style={s.chip}>
                <Text style={s.chipEtiqueta}>Grado de artrosis</Text>
                <Text style={s.chipValor}>
                  {gradoKl} de 4 · {GRADO_KL[gradoKl] ?? '—'}
                </Text>
              </View>
            )}
          </View>
        </Card>

        {/* El detalle del plan vive ahora en la pestaña Tratamiento. */}
        <TouchableOpacity style={s.irTratamiento} activeOpacity={0.8} onPress={() => router.navigate('/(tabs)/tratamiento')}>
          <View style={s.cardHeaderIcon}>
            <Ionicons name="medkit-outline" size={18} color={p.verdeTexto} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardHeaderTitle}>Mi tratamiento</Text>
            <Text style={s.rowDetalle}>Plan, duración, médico y ejercicios</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={p.textoSuave} />
        </TouchableOpacity>

        {/* ───────────── CONFIGURACIÓN ───────────── */}
        <Card>
          <CardHeader icon="settings-outline" title="Configuración" />

          <ToggleRow icon="volume-high-outline" label="Instrucciones de voz" value={vozActiva} onValueChange={setVozActiva} />
          <ToggleRow icon="moon-outline" label="Modo oscuro" value={oscuro} onValueChange={setOscuro} />
          <ToggleRow
            icon="notifications-outline"
            label="Notificaciones"
            detalle="Avisos que te envía tu médico"
            value={activas}
            onValueChange={setActivas}
          />

          {activas && (
            <TouchableOpacity style={s.navRow} activeOpacity={0.6} onPress={() => router.push('/notificaciones')}>
              <View style={s.rowLeft}>
                <Ionicons name="mail-unread-outline" size={20} color={p.textoSuave} />
                <Text style={s.rowLabel}>Ver mis notificaciones</Text>
              </View>
              <View style={s.rowLeft}>
                {sinLeer > 0 && (
                  <View style={s.badge}>
                    <Text style={s.badgeTexto}>{sinLeer > 9 ? '9+' : sinLeer}</Text>
                  </View>
                )}
                <Ionicons name="chevron-forward" size={18} color={p.textoSuave} />
              </View>
            </TouchableOpacity>
          )}

          <View style={s.textSizeSection}>
            <View style={s.rowLeft}>
              <Ionicons name="text-outline" size={20} color={p.textoSuave} />
              <Text style={s.rowLabel}>Tamaño de texto</Text>
            </View>
            <View style={s.segmentedControl}>
              {TAMANOS_TEXTO.map((opt) => {
                const active = tamanoTexto === opt;
                return (
                  <TouchableOpacity
                    key={opt}
                    style={[s.segmentBtn, active && s.segmentBtnActive]}
                    onPress={() => setTamanoTexto(opt)}
                    activeOpacity={0.85}
                  >
                    <Text style={[s.segmentText, active && s.segmentTextActive]}>{opt}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <TouchableOpacity style={s.logoutRow} activeOpacity={0.7} onPress={() => void signOut()}>
            <Ionicons name="log-out-outline" size={20} color={p.rojo} />
            <Text style={s.logoutText}>Cerrar sesión</Text>
          </TouchableOpacity>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  const s = useEstilos();
  return <View style={s.card}>{children}</View>;
}

function CardHeader({ icon, title }: { icon: IconName; title: string }) {
  const s = useEstilos();
  const { p } = useTema();
  return (
    <View style={s.cardHeader}>
      <View style={s.cardHeaderIcon}>
        <Ionicons name={icon} size={18} color={p.verdeTexto} />
      </View>
      <Text style={s.cardHeaderTitle}>{title}</Text>
    </View>
  );
}

/** Etiqueta arriba y valor abajo: un valor largo nunca se monta sobre la etiqueta. */
function Dato({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const s = useEstilos();
  const { p } = useTema();
  return (
    <View style={s.dato}>
      <Ionicons name={icon} size={20} color={p.textoTenue} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        <Text style={s.datoEtiqueta}>{label}</Text>
        <Text style={s.datoValor}>{value}</Text>
      </View>
    </View>
  );
}

function ToggleRow({
  icon,
  label,
  detalle,
  value,
  onValueChange,
}: {
  icon: IconName;
  label: string;
  detalle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const s = useEstilos();
  const { p } = useTema();
  return (
    <View style={s.toggleRow}>
      <View style={[s.rowLeft, { flex: 1 }]}>
        <Ionicons name={icon} size={20} color={p.textoSuave} />
        <View style={{ flex: 1 }}>
          <Text style={s.rowLabel}>{label}</Text>
          {detalle && <Text style={s.rowDetalle}>{detalle}</Text>}
        </View>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: p.pista, true: p.verde }}
        thumbColor={p.blanco}
      />
    </View>
  );
}

// ─────────────────────────────────────────────
// Estilos
// ─────────────────────────────────────────────
const useEstilos = crearEstilos((p, oscuro) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.fondo },
    scroll: { flex: 1 },

    header: {
      paddingTop: Platform.OS === 'android' ? 40 : 16,
      paddingBottom: 50,
      alignItems: 'center',
      borderBottomLeftRadius: 32,
      borderBottomRightRadius: 32,
      overflow: 'hidden',
    },
    decorCircle: { position: 'absolute', borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)' },
    decorCircleBig: { width: 220, height: 220, top: -90, right: -60 },
    decorCircleSmall: { width: 120, height: 120, bottom: -40, left: -30 },

    avatar: {
      width: 96,
      height: 96,
      borderRadius: 48,
      borderWidth: 3,
      borderColor: p.blanco,
      backgroundColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
    },
    avatarIniciales: { fontSize: 32, fontWeight: '800', color: p.blanco },
    avatarFoto: { width: '100%', height: '100%', borderRadius: 48 },
    avatarCargando: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: 48,
      backgroundColor: 'rgba(0,0,0,0.45)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarCamara: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: p.navy,
      borderWidth: 2,
      borderColor: p.blanco,
      alignItems: 'center',
      justifyContent: 'center',
    },
    patientName: {
      fontSize: 21,
      fontWeight: '800',
      color: p.blanco,
      marginBottom: 8,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    matriculaPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(255,255,255,0.16)',
      paddingHorizontal: 14,
      paddingVertical: 5,
      borderRadius: 999,
    },
    matriculaText: { color: p.blanco, fontSize: 13, fontWeight: '700' },

    progressCard: {
      backgroundColor: p.superficie,
      marginHorizontal: 20,
      marginTop: -30,
      borderRadius: 20,
      padding: 18,
      shadowColor: '#000',
      shadowOpacity: oscuro ? 0.3 : 0.08,
      shadowOffset: { width: 0, height: 6 },
      shadowRadius: 12,
      elevation: 4,
      minHeight: 92,
      justifyContent: 'center',
      borderWidth: oscuro ? 1 : 0,
      borderColor: p.borde,
    },
    progressHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
    progressLabel: { fontSize: 13.5, color: p.textoSuave, fontWeight: '600' },
    progressPercent: { fontSize: 15, color: p.verdeTexto, fontWeight: '800' },
    progressTrack: { height: 9, backgroundColor: p.verdeSuave, borderRadius: 999, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: p.verde, borderRadius: 999 },
    progressHint: { marginTop: 8, fontSize: 12, color: p.textoSuave },

    card: {
      backgroundColor: p.superficie,
      marginHorizontal: 20,
      marginTop: 18,
      borderRadius: 20,
      padding: 20,
      borderWidth: 1,
      borderColor: p.borde,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
    cardHeaderIcon: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    cardHeaderTitle: { fontSize: 17, fontWeight: '800', color: p.texto },

    dato: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 14,
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: p.borde,
    },
    datoEtiqueta: { fontSize: 12.5, color: p.textoSuave, fontWeight: '600' },
    datoValor: { fontSize: 16, color: p.texto, fontWeight: '700', marginTop: 2 },

    diagnosticoCaja: {
      backgroundColor: p.superficieAlt,
      borderLeftWidth: 4,
      borderLeftColor: p.verde,
      borderRadius: 12,
      padding: 14,
    },
    diagnosticoTexto: { fontSize: 15, color: p.texto, lineHeight: 22 },
    textoVacio: { fontSize: 14, color: p.textoSuave, lineHeight: 20, paddingVertical: 6 },
    chipsFila: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
    chip: {
      flexGrow: 1,
      flexBasis: '45%',
      backgroundColor: p.verdeSuave,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    chipEtiqueta: { fontSize: 11.5, color: p.verdeTexto, fontWeight: '700', textTransform: 'uppercase' },
    chipValor: { fontSize: 14.5, color: p.texto, fontWeight: '700', marginTop: 3 },




    toggleRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: p.borde,
      gap: 12,
    },
    rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    rowLabel: { fontSize: 15, color: p.texto, fontWeight: '600' },
    rowDetalle: { fontSize: 12, color: p.textoSuave, marginTop: 2 },
    navRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: p.borde,
    },
    badge: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 6,
      backgroundColor: p.rojo,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeTexto: { color: oscuro ? '#1B0B0A' : p.blanco, fontSize: 11.5, fontWeight: '800' },

    textSizeSection: { paddingVertical: 14, borderTopWidth: 1, borderTopColor: p.borde, gap: 12 },
    segmentedControl: { flexDirection: 'row', backgroundColor: p.superficieAlt, borderRadius: 12, padding: 4 },
    segmentBtn: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
    segmentBtnActive: { backgroundColor: p.verde },
    segmentText: { fontSize: 12.5, color: p.textoSuave, fontWeight: '600' },
    segmentTextActive: { color: p.blanco },

    logoutRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingTop: 16,
      borderTopWidth: 1,
      borderTopColor: p.borde,
    },
    logoutText: { color: p.rojo, fontSize: 15, fontWeight: '700' },

    irTratamiento: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: p.superficie,
      marginHorizontal: 20,
      marginTop: 18,
      borderRadius: 20,
      padding: 16,
      borderWidth: 1,
      borderColor: p.borde,
    },

  })
);
