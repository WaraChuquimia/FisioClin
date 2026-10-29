import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { crearEstilos, Paleta } from '@/context/TemaContext';

import { useAuth } from '@/context/AuthContext';
import { useRecargaAutomatica } from '@/hooks/useRecargaAutomatica';
import {
  ProgresoPaciente,
  obtenerProgresoPaciente,
} from '@/lib/progresoData';

/** Colores de esta pantalla, sacados de la paleta del tema (claro/oscuro). */
const coloresDe = (p: Paleta) => ({
  navy: p.navy,
  navyText: p.navyTexto,
  green: p.verde,
  greenDark: p.verdeTexto,
  greenSoft: p.verdeSuave,
  greenMid: p.verdeMedio,
  track: p.pista,
  amber: p.ambar,
  amberSoft: p.ambarSuave,
  red: p.rojo,
  redSoft: p.rojoSuave,
  white: p.blanco,
  surface: p.superficie,
  bg: p.fondo,
  cardBorder: p.borde,
  grayText: p.textoSuave,
  grayMuted: p.textoTenue,
  textDark: p.texto,
});

const ALTO_BARRA = 76;

/** `resultado_evaluacion` (de sesiones.resultado_evaluacion, calculado en
 *  guardar_sesion_rehabilitacion.sql por % de repeticiones correctas) ya
 *  llegaba con los datos pero no se mostraba: cada fila del historial se
 *  veía con el mismo check verde sin importar si la sesión salió bien,
 *  a medias o mal — el paciente no podía distinguir una cosa de otra de
 *  un vistazo. Esto le pone cara a cada resultado. */
const RESULTADO_INFO: Record<
  string,
  { icono: React.ComponentProps<typeof Ionicons>['name']; etiqueta: string }
> = {
  correcto: { icono: 'checkmark-circle', etiqueta: 'Bien hecho' },
  parcial: { icono: 'alert-circle', etiqueta: 'Parcial' },
  incorrecto: { icono: 'close-circle', etiqueta: 'A mejorar' },
  pendiente: { icono: 'time-outline', etiqueta: 'Sin evaluar' },
};

function formatearFechaHora(fecha: string) {
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return fecha;
  return d.toLocaleDateString('es-BO', { day: '2-digit', month: 'short' });
}

export default function ProgresoScreen() {
  const { styles, COLORS, oscuro } = useEstilos();
  const { patient } = useAuth();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  const [data, setData] = useState<ProgresoPaciente | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (idPaciente == null) return;
    try {
      setError(null);
      const d = await obtenerProgresoPaciente(idPaciente);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cargar tu progreso.');
    } finally {
      setCargando(false);
    }
  }, [idPaciente]);

  // Antes cargaba una sola vez: un ejercicio recetado después, o una sesión
  // recién hecha, no aparecían. Ahora recarga al entrar, cada 30 s y cuando
  // el médico prescribe algo nuevo.
  useRecargaAutomatica(cargar);

  const [recargando, setRecargando] = useState(false);
  const alRecargar = async () => {
    setRecargando(true);
    await cargar();
    setRecargando(false);
  };

  if (cargando) {
    return (
      <SafeAreaView style={[styles.safe, styles.centrado]}>
        <ActivityIndicator color={COLORS.green} size="large" />
      </SafeAreaView>
    );
  }

  const progresoSemanal = data?.progreso_semanal ?? [];
  const progresoMensual = data?.progreso_mensual ?? [];
  const porEjercicio = data?.por_ejercicio ?? [];
  const historial = data?.historial ?? [];

  const promedioSemanal = progresoSemanal.length
    ? Math.round(
        (progresoSemanal.reduce((s, d) => s + d.valor, 0) / progresoSemanal.length) * 100
      )
    : 0;

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
          <Text style={styles.pageTitle}>Mi Progreso</Text>
          <Text style={styles.pageSubtitle}>Así va tu recuperación con el tiempo.</Text>
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={COLORS.red} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ───────────── STATS RÁPIDAS ───────────── */}
        <View style={styles.statsRow}>
          <StatCard
            icono="flame"
            valor={String(data?.racha_dias ?? 0)}
            etiqueta={data?.racha_dias === 1 ? 'día seguido' : 'días seguidos'}
            color={COLORS.amber}
            fondo={COLORS.amberSoft}
          />
          <StatCard
            icono="checkmark-done"
            valor={String(data?.total_sesiones_completadas ?? 0)}
            etiqueta="sesiones hechas"
            color={COLORS.green}
            fondo={COLORS.greenSoft}
          />
          <StatCard
            icono="body"
            valor={String(data?.total_ejercicios_prescritos ?? 0)}
            etiqueta="ejercicios activos"
            color={COLORS.navyText}
            fondo="#E7EAF6"
          />
        </View>

        {/* ───────────── SEMANA ACTUAL ───────────── */}
        <View style={styles.tarjeta}>
          <View style={styles.tarjetaHeaderRow}>
            <Text style={styles.tarjetaTitulo}>Esta semana</Text>
            <Text style={styles.tarjetaPorcentaje}>{promedioSemanal}%</Text>
          </View>

          {progresoSemanal.length === 0 ? (
            <Text style={styles.vacioText}>Sin datos de esta semana todavía.</Text>
          ) : (
            <View style={styles.semana}>
              {progresoSemanal.map((d, i) => (
                <BarraDia key={`${d.dia}-${i}`} dia={d.dia} valor={d.valor} />
              ))}
            </View>
          )}

          <Text style={styles.semanaResumen}>
            {promedioSemanal >= 80
              ? `¡Excelente! Llevas el ${promedioSemanal}% de tu rutina esta semana.`
              : promedioSemanal > 0
                ? `Vas por buen camino: ${promedioSemanal}% esta semana. ¡Sigue así!`
                : 'Aún no registras actividad esta semana. ¡Empecemos hoy!'}
          </Text>
        </View>

        {/* ───────────── ÚLTIMAS 4 SEMANAS ───────────── */}
        <View style={styles.tarjeta}>
          <Text style={styles.tarjetaTitulo}>Últimas 4 semanas</Text>

          {progresoMensual.length === 0 ? (
            <Text style={styles.vacioText}>Todavía no hay historial suficiente.</Text>
          ) : (
            <View style={styles.mesRow}>
              {[...progresoMensual].reverse().map((s) => (
                <View key={s.semana} style={styles.mesCol}>
                  <View style={styles.mesPista}>
                    <View
                      style={[
                        styles.mesBarra,
                        {
                          height: Math.max(6, s.valor * ALTO_BARRA),
                          backgroundColor: s.semana === 0 ? COLORS.green : COLORS.greenMid,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.mesTexto}>
                    {s.semana === 0 ? 'Hoy' : `-${s.semana}sem`}
                  </Text>
                  <Text style={styles.mesPct}>{Math.round(s.valor * 100)}%</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* ───────────── ADHERENCIA POR EJERCICIO ───────────── */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Por ejercicio</Text>
        </View>

        {porEjercicio.length === 0 ? (
          <Text style={[styles.vacioText, { paddingHorizontal: 20 }]}>
            No tienes ejercicios prescritos todavía.
          </Text>
        ) : (
          <View style={styles.listWrap}>
            {porEjercicio.map((e) => (
              <View key={e.id_prescripcion} style={styles.ejercicioCard}>
                <View style={styles.ejercicioIconBox}>
                  <MaterialCommunityIcons name="chart-line" size={20} color={COLORS.green} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ejercicioNombre}>{e.nombre}</Text>
                  <Text style={styles.ejercicioMeta}>
                    {e.zona} · {e.series}×{e.repeticiones}
                  </Text>
                </View>
                <View style={styles.ejercicioSesionesPill}>
                  <Text style={styles.ejercicioSesionesTexto}>{e.sesiones_completadas}</Text>
                  <Text style={styles.ejercicioSesionesLabel}>sesiones</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ───────────── HISTORIAL RECIENTE ───────────── */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Historial reciente</Text>
        </View>

        {historial.length === 0 ? (
          <Text style={[styles.vacioText, { paddingHorizontal: 20 }]}>
            Todavía no completaste ninguna sesión.
          </Text>
        ) : (
          <View style={styles.listWrap}>
            {historial.map((s, i) => {
              const clave = s.resultado_evaluacion ?? 'pendiente';
              const info = RESULTADO_INFO[clave] ?? RESULTADO_INFO.pendiente;
              const color =
                clave === 'correcto'
                  ? COLORS.green
                  : clave === 'parcial'
                    ? COLORS.amber
                    : clave === 'incorrecto'
                      ? COLORS.red
                      : COLORS.grayText;
              const fondo =
                clave === 'correcto'
                  ? COLORS.greenSoft
                  : clave === 'parcial'
                    ? COLORS.amberSoft
                    : clave === 'incorrecto'
                      ? COLORS.redSoft
                      : COLORS.track;
              return (
                <View key={`${s.fecha}-${i}`} style={styles.historialRow}>
                  <View style={[styles.historialIcono, { backgroundColor: fondo }]}>
                    <Ionicons name={info.icono} size={16} color={color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.historialNombre}>{s.ejercicio}</Text>
                    <View style={styles.historialSubfila}>
                      <Text style={styles.historialFecha}>{formatearFechaHora(s.fecha)}</Text>
                      <Text style={[styles.historialEtiqueta, { color }]}>· {info.etiqueta}</Text>
                    </View>
                  </View>
                  <Text style={styles.historialDuracion}>
                    {Math.round(s.duracion_segundos / 60)} min
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({
  icono,
  valor,
  etiqueta,
  color,
  fondo,
}: {
  icono: React.ComponentProps<typeof Ionicons>['name'];
  valor: string;
  etiqueta: string;
  color: string;
  fondo: string;
}) {
  const { styles } = useEstilos();
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconBox, { backgroundColor: fondo }]}>
        <Ionicons name={icono} size={18} color={color} />
      </View>
      <Text style={styles.statValor}>{valor}</Text>
      <Text style={styles.statEtiqueta}>{etiqueta}</Text>
    </View>
  );
}

function BarraDia({ dia, valor }: { dia: string; valor: number }) {
  const { styles, COLORS } = useEstilos();
  const activo = valor > 0;
  return (
    <View style={styles.diaCol}>
      <View style={styles.diaPista}>
        <View
          style={[
            styles.diaBarra,
            {
              height: Math.max(6, valor * ALTO_BARRA),
              backgroundColor: activo ? COLORS.green : COLORS.track,
              opacity: activo ? 1 : 0.7,
            },
          ]}
        />
      </View>
      <Text style={[styles.diaTexto, activo && styles.diaTextoActivo]}>{dia}</Text>
    </View>
  );
}

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
    paddingTop: Platform.OS === 'android' ? 24 : 16,
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

  statsRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, marginBottom: 18 },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 12,
    alignItems: 'center',
  },
  statIconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  statValor: { fontSize: 19, fontWeight: '800', color: COLORS.textDark },
  statEtiqueta: { fontSize: 10.5, color: COLORS.grayText, marginTop: 2, textAlign: 'center' },

  tarjeta: {
    backgroundColor: COLORS.surface,
    marginHorizontal: 20,
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  tarjetaHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tarjetaTitulo: { fontSize: 17, fontWeight: '800', color: COLORS.textDark },
  tarjetaPorcentaje: { fontSize: 17, fontWeight: '800', color: COLORS.green },

  vacioText: { fontSize: 13, color: COLORS.grayText, marginTop: 10, lineHeight: 19 },

  semana: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 18 },
  diaCol: { alignItems: 'center', flex: 1 },
  diaPista: { height: ALTO_BARRA, justifyContent: 'flex-end' },
  diaBarra: { width: 26, borderRadius: 8 },
  diaTexto: { fontSize: 12.5, color: COLORS.grayText, marginTop: 8, fontWeight: '700' },
  diaTextoActivo: { color: COLORS.textDark },
  semanaResumen: {
    textAlign: 'center',
    color: COLORS.greenDark,
    fontSize: 13.5,
    fontWeight: '700',
    marginTop: 16,
    lineHeight: 19,
  },

  mesRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 18 },
  mesCol: { alignItems: 'center', flex: 1 },
  mesPista: { height: ALTO_BARRA, justifyContent: 'flex-end' },
  mesBarra: { width: 30, borderRadius: 8 },
  mesTexto: { fontSize: 11, color: COLORS.grayText, marginTop: 8, fontWeight: '700' },
  mesPct: { fontSize: 11.5, color: COLORS.textDark, fontWeight: '800', marginTop: 2 },

  sectionHeaderRow: { paddingHorizontal: 20, marginBottom: 12, marginTop: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: COLORS.textDark },

  listWrap: { paddingHorizontal: 20, gap: 12, marginBottom: 20 },

  ejercicioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 14,
  },
  ejercicioIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ejercicioNombre: { fontSize: 14.5, fontWeight: '800', color: COLORS.textDark },
  ejercicioMeta: { fontSize: 12, color: COLORS.grayText, marginTop: 2 },
  ejercicioSesionesPill: { alignItems: 'center', backgroundColor: COLORS.bg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  ejercicioSesionesTexto: { fontSize: 15, fontWeight: '800', color: COLORS.green },
  ejercicioSesionesLabel: { fontSize: 9.5, color: COLORS.grayText, fontWeight: '700' },

  historialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 12,
  },
  historialIcono: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: COLORS.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historialNombre: { fontSize: 14, fontWeight: '700', color: COLORS.textDark },
  historialSubfila: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  historialFecha: { fontSize: 11.5, color: COLORS.grayText },
  historialEtiqueta: { fontSize: 11.5, fontWeight: '700' },
  historialDuracion: { fontSize: 12.5, fontWeight: '700', color: COLORS.grayText },
    }),
  };
});
