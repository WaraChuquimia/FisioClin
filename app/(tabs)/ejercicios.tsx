import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  Platform,
  ScrollView,
  StatusBar,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { crearEstilos, Paleta } from '@/context/TemaContext';

import { useAuth } from '@/context/AuthContext';
import { useRecargaAutomatica } from '@/hooks/useRecargaAutomatica';
import {
  EjercicioCatalogo,
  obtenerCatalogoEjercicios,
  totalPrescrito,
} from '@/lib/ejerciciosData';

// ─────────────────────────────────────────────
// Iconos: wrappers sobre @expo/vector-icons (ya instalado). Reemplazan a
// lucide-react-native, que no es dependencia del proyecto.
// ─────────────────────────────────────────────
type IconProps = { size?: number; color?: string; strokeWidth?: number; style?: StyleProp<TextStyle> };

const ionIcon = (name: React.ComponentProps<typeof Ionicons>['name']) => {
  const IconoGenerado = ({ size = 18, color, style }: IconProps) => (
    <Ionicons name={name} size={size} color={color} style={style} />
  );
  IconoGenerado.displayName = `Icono(${name})`;
  return IconoGenerado;
};

const AlertCircle = ionIcon('alert-circle-outline');
const Calendar = ionIcon('calendar-outline');
const Check = ionIcon('checkmark');
const CheckCircle2 = ionIcon('checkmark-circle');
const Clock = ionIcon('time-outline');

const ICONO_ZONA: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
  cadera: 'human-handsup',
  rodilla: 'human-handsdown',
  tobillo: 'shoe-print',
};

const iconoParaZona = (zona: string) => ICONO_ZONA[zona.toLowerCase()] ?? 'run';

// ─────────────────────────────────────────────
// PALETA INSTITUCIONAL — misma que perfil.tsx, no tocar
// ─────────────────────────────────────────────
/** Colores de esta pantalla, sacados de la paleta del tema (claro/oscuro). */
const coloresDe = (p: Paleta) => ({
  navy: p.navy,
  navyLight: p.navy,
  green: p.verde,
  greenDark: p.verdeTexto,
  greenSoft: p.verdeSuave,
  amberSoft: p.ambarSuave,
  amber: p.ambar,
  redSoft: p.rojoSuave,
  red: p.rojo,
  white: p.blanco,
  surface: p.superficie,
  bg: p.fondo,
  cardBorder: p.borde,
  grayText: p.textoSuave,
  grayMuted: p.textoTenue,
  textDark: p.texto,
});

function capitalizar(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function EjerciciosScreen() {
  const { styles, COLORS, oscuro } = useEstilos();
  const { patient } = useAuth();
  const router = useRouter();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  const [ejercicios, setEjercicios] = useState<EjercicioCatalogo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (idPaciente == null) return;
    try {
      setError(null);
      const data = await obtenerCatalogoEjercicios(idPaciente);
      setEjercicios(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cargar tus ejercicios.');
    } finally {
      setCargando(false);
    }
  }, [idPaciente]);

  // Al entrar, cada 30 s y cuando el médico prescribe algo nuevo.
  useRecargaAutomatica(cargar);

  const [recargando, setRecargando] = useState(false);
  const alRecargar = async () => {
    setRecargando(true);
    await cargar();
    setRecargando(false);
  };

  // La base ya devuelve solo lo prescrito vigente, uno por ejercicio
  // (prescripciones_vigentes.sql).
  const rutinaHoy = ejercicios;

  const completadosHoy = rutinaHoy.filter((e) => e.completado_hoy).length;
  const totalHoy = rutinaHoy.length;
  const porcentaje = totalHoy > 0 ? Math.round((completadosHoy / totalHoy) * 100) : 0;
  const minutosRestantes = rutinaHoy
    .filter((e) => !e.completado_hoy)
    .reduce((acc, e) => acc + Math.round(e.duracion_estimada_segundos / 60), 0);

  // Abre el detalle: video de referencia del médico y el botón "Iniciar"
  // que lleva a la sesión con cámara (app/ejercicio.tsx).
  const abrirEjercicio = useCallback(
    (ej: EjercicioCatalogo) => {
      if (ej.id_prescripcion == null) return;
      router.push({
        pathname: '/ejercicio',
        params: { idPrescripcion: String(ej.id_prescripcion) },
      });
    },
    [router]
  );

  const hoy = new Date();
  const fechaTexto = hoy
    .toLocaleDateString('es-BO', { day: '2-digit', month: 'short' })
    .toUpperCase()
    .replace('.', '');

  if (cargando) {
    return (
      <SafeAreaView style={[styles.safe, styles.centrado]}>
        <ActivityIndicator color={COLORS.green} size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={oscuro ? 'light-content' : 'dark-content'} backgroundColor={COLORS.surface} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={recargando}
            onRefresh={alRecargar}
            tintColor={COLORS.green}
            colors={[COLORS.green]}
          />
        }
      >
        <View style={styles.pageIntro}>
          <Text style={styles.pageTitle}>Mis Ejercicios</Text>
          <Text style={styles.pageSubtitle}>Sigue tu rutina diaria personalizada.</Text>
        </View>

        {error && (
          <View style={styles.errorBox}>
            <AlertCircle size={16} color={COLORS.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ───────────── TARJETA DE PROGRESO ───────────── */}
        <View style={styles.progressCard}>
          <View style={styles.progressCardHeaderRow}>
            <Calendar size={13} color="rgba(255,255,255,0.85)" />
            <Text style={styles.progressCardHeaderText}>
              SESIÓN DE HOY · {fechaTexto}
            </Text>
          </View>
          <Text style={styles.progressCardTitle}>Plan de Recuperación</Text>

          <View style={styles.progressStatsRow}>
            <View>
              <Text style={styles.progressPercent}>{porcentaje}%</Text>
              <Text style={styles.progressLabel}>COMPLETADO HOY</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.progressPercent}>
                {completadosHoy} de {totalHoy}
              </Text>
              <Text style={styles.progressLabel}>EJERCICIOS LISTOS</Text>
            </View>
          </View>

          <View style={styles.progressBarTrack}>
            <View style={[styles.progressBarFill, { width: `${porcentaje}%` }]} />
          </View>

          {minutosRestantes > 0 && (
            <View style={styles.progressTimeRow}>
              <Clock size={13} color="rgba(255,255,255,0.85)" />
              <Text style={styles.progressTimeText}>
                Te quedan {minutosRestantes} minutos para terminar
              </Text>
            </View>
          )}
        </View>

        {/* ───────────── RUTINA DEL DÍA (prescrita por el médico) ───────────── */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Rutina del Día</Text>
          <View style={styles.sectionBadge}>
            <Text style={styles.sectionBadgeText}>{totalHoy} Ejercicios</Text>
          </View>
        </View>

        {totalHoy === 0 ? (
          <Text style={styles.vacioText}>
            Todavía no tienes ejercicios prescritos. Tu kinesiólogo los asignará pronto.
          </Text>
        ) : (
          <View style={styles.listWrap}>
            {rutinaHoy.map((ej) => (
              <RutinaCard
                key={ej.id_prescripcion}
                ejercicio={ej}
                onAbrir={() => abrirEjercicio(ej)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────
// Tarjeta de la rutina prescrita (incluye cantidad: series x repeticiones)
// ─────────────────────────────────────────────
function RutinaCard({
  ejercicio,
  onAbrir,
}: {
  ejercicio: EjercicioCatalogo;
  onAbrir: () => void;
}) {
  const { styles, COLORS } = useEstilos();
  const completado = ejercicio.completado_hoy;
  const hechas = ejercicio.repeticiones_hechas_hoy ?? 0;
  const total = totalPrescrito(ejercicio);
  const minutos = Math.round(ejercicio.duracion_estimada_segundos / 60);

  return (
    <TouchableOpacity
      style={styles.rutinaCard}
      activeOpacity={0.85}
      onPress={onAbrir}
    >
      <View style={styles.rutinaThumbWrap}>
        <View style={[styles.iconoZonaBox, completado && { opacity: 0.45 }]}>
          <MaterialCommunityIcons
            name={iconoParaZona(ejercicio.zona)}
            size={30}
            color={COLORS.green}
          />
        </View>
        {completado && (
          <View style={styles.completadoOverlay}>
            <CheckCircle2 size={26} color={COLORS.green} />
          </View>
        )}
      </View>

      <View style={styles.rutinaBody}>
        <Text style={[styles.rutinaTitle, completado && styles.strikethrough]}>
          {ejercicio.nombre}
        </Text>
        <Text style={styles.rutinaSubtitle} numberOfLines={1}>
          {capitalizar(ejercicio.zona)}
        </Text>

        {completado ? (
          <View style={styles.finalizadoPill}>
            <Check size={12} color={COLORS.greenDark} strokeWidth={3} />
            <Text style={styles.finalizadoPillText}>FINALIZADO</Text>
          </View>
        ) : hechas > 0 ? (
          // Empezó pero no terminó todas las repeticiones prescritas.
          <View style={[styles.finalizadoPill, styles.parcialPill]}>
            <Clock size={12} color={COLORS.amber} />
            <Text style={[styles.finalizadoPillText, { color: COLORS.amber }]}>
              REALIZADO {hechas}{total ? ` DE ${total}` : ''}
            </Text>
          </View>
        ) : (
          <View style={styles.pillRow}>
            <View style={styles.metaPill}>
              <Clock size={12} color={COLORS.grayText} />
              <Text style={styles.metaPillText}>{minutos} min</Text>
            </View>
            {ejercicio.series != null && ejercicio.repeticiones != null && (
              <View style={styles.metaPill}>
                <Text style={styles.metaPillText}>
                  {ejercicio.series}×{ejercicio.repeticiones}
                </Text>
              </View>
            )}
          </View>
        )}

        {!completado && (
          <TouchableOpacity
            style={styles.iniciarCamaraBtn}
            activeOpacity={0.85}
            onPress={onAbrir}
          >
            <Ionicons name="play-circle-outline" size={15} color={COLORS.white} />
            <Text style={styles.iniciarCamaraTexto}>Ver video e iniciar</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────
// Estilos
// ─────────────────────────────────────────────
const useEstilos = crearEstilos((p, oscuro) => {
  const COLORS = coloresDe(p);
  return {
    oscuro,
    COLORS,
    styles: StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  centrado: { alignItems: 'center', justifyContent: 'center' },

  pageIntro: {
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 28 : 16,
    paddingBottom: 18,
  },
  pageTitle: { fontSize: 26, fontWeight: '800', color: COLORS.textDark },
  pageSubtitle: { fontSize: 14, color: COLORS.grayText, marginTop: 4 },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.redSoft,
    marginHorizontal: 20,
    marginBottom: 14,
    borderRadius: 12,
    padding: 12,
  },
  errorText: { flex: 1, fontSize: 12.5, color: COLORS.red },

  vacioText: {
    fontSize: 13,
    color: COLORS.grayText,
    paddingHorizontal: 20,
    marginBottom: 20,
    lineHeight: 19,
  },

  progressCard: {
    marginHorizontal: 20,
    backgroundColor: COLORS.navy,
    borderRadius: 22,
    padding: 20,
    marginBottom: 26,
  },
  progressCardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  progressCardHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 0.5,
  },
  progressCardTitle: { fontSize: 19, fontWeight: '800', color: COLORS.white, marginBottom: 16 },
  progressStatsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  progressPercent: { fontSize: 26, fontWeight: '800', color: COLORS.white },
  progressLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.7)',
    letterSpacing: 0.4,
    marginTop: 2,
  },
  progressBarTrack: {
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    overflow: 'hidden',
  },
  progressBarFill: { height: '100%', backgroundColor: COLORS.green, borderRadius: 999 },
  progressTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  progressTimeText: { fontSize: 12.5, color: 'rgba(255,255,255,0.85)', fontWeight: '600' },

  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: COLORS.textDark },
  sectionBadge: {
    backgroundColor: COLORS.greenSoft,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  sectionBadgeText: { fontSize: 12, fontWeight: '700', color: COLORS.greenDark },

  listWrap: { paddingHorizontal: 20, gap: 14 },

  rutinaCard: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 12,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 1,
  },
  rutinaThumbWrap: { width: 78, height: 78, borderRadius: 14, overflow: 'hidden' },
  iconoZonaBox: {
    width: '100%',
    height: '100%',
    backgroundColor: COLORS.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completadoOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.35)',
  },

  rutinaBody: { flex: 1, justifyContent: 'center', gap: 4 },
  rutinaTitle: { fontSize: 15.5, fontWeight: '800', color: COLORS.textDark },
  rutinaSubtitle: { fontSize: 12.5, color: COLORS.grayText },
  strikethrough: { textDecorationLine: 'line-through', color: COLORS.grayMuted },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  metaPillText: { fontSize: 11.5, fontWeight: '700', color: COLORS.grayText },

  finalizadoPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    backgroundColor: COLORS.greenSoft,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    marginTop: 4,
  },
  finalizadoPillText: { fontSize: 11.5, fontWeight: '800', color: COLORS.greenDark },
  parcialPill: { backgroundColor: COLORS.amberSoft },


  iniciarCamaraBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    backgroundColor: COLORS.navy,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    marginTop: 8,
  },
  iniciarCamaraTexto: { fontSize: 11.5, fontWeight: '700', color: COLORS.white },
    }),
  };
});
