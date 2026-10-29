/* ==================================================================
   FisioClin — pestaña Tratamiento
   ==================================================================

   Todo el plan de tratamiento activo del paciente en una sola pantalla:
   nombre del plan, médico responsable, objetivo, fechas (inicio, duración,
   alta estimada), en qué semana va y cuánto le falta, y los ejercicios que
   el médico le prescribió dentro de ese plan con su dosis (series ×
   repeticiones), duración aproximada y si ya los hizo hoy.

   Datos: obtener_inicio_paciente (plan) + obtener_catalogo_ejercicios
   (prescripciones vigentes). Tocar un ejercicio abre su detalle
   (app/ejercicio.tsx), nunca directo a la cámara.
   ================================================================== */

import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/context/AuthContext';
import { crearEstilos, useTema } from '@/context/TemaContext';
import { useRecargaAutomatica } from '@/hooks/useRecargaAutomatica';
import {
  EjercicioCatalogo,
  obtenerCatalogoEjercicios,
  siguientePendiente,
  totalPrescrito,
} from '@/lib/ejerciciosData';
import { obtenerInicioPaciente, PlanTratamiento } from '@/lib/pacienteData';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const DIA_MS = 24 * 60 * 60 * 1000;

const capitalizar = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim().length > 0 ? valor.trim() : null;
}

/** Fecha 'YYYY-MM-DD' (o ISO) como día local, sin corrimiento por zona horaria. */
function aFecha(fecha: string) {
  return new Date(fecha.length <= 10 ? `${fecha}T00:00:00` : fecha);
}

function formatearFecha(fecha: string) {
  const d = aFecha(fecha);
  if (Number.isNaN(d.getTime())) return fecha;
  return d.toLocaleDateString('es-BO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatearDuracion(segundos: number) {
  if (!segundos || segundos <= 0) return null;
  if (segundos < 60) return `${segundos} s`;
  const min = Math.round(segundos / 60);
  return `${min} min`;
}

/** Semana actual, días transcurridos y días restantes del plan. */
function avancePlan(plan: PlanTratamiento, ahora: number) {
  const inicio = aFecha(plan.fecha_inicio).getTime();
  const fin = plan.fecha_fin_estimada
    ? aFecha(plan.fecha_fin_estimada).getTime()
    : inicio + plan.duracion_estimada_semanas * 7 * DIA_MS;
  if (Number.isNaN(inicio) || Number.isNaN(fin)) return null;

  const totalDias = Math.max(1, Math.round((fin - inicio) / DIA_MS));
  const transcurridos = Math.min(totalDias, Math.max(0, Math.floor((ahora - inicio) / DIA_MS)));
  const semana = Math.min(plan.duracion_estimada_semanas, Math.floor(transcurridos / 7) + 1);
  return {
    semana,
    restantes: Math.max(0, totalDias - transcurridos),
    fraccion: transcurridos / totalDias,
    noEmpezo: ahora < inicio,
  };
}

/** El plan no tiene un campo "nombre": se arma con la articulación tratada. */
function nombrePlan(articulacion: string | null) {
  return articulacion ? `Rehabilitación de ${articulacion.toLowerCase()}` : 'Plan de rehabilitación';
}

export default function TratamientoScreen() {
  const { patient } = useAuth();
  const { p } = useTema();
  const s = useEstilos();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  const [plan, setPlan] = useState<PlanTratamiento | null>(null);
  const [articulacionPlan, setArticulacionPlan] = useState<string | null>(null);
  const [ejercicios, setEjercicios] = useState<EjercicioCatalogo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recargando, setRecargando] = useState(false);
  const [ahora, setAhora] = useState(() => Date.now());

  const cargar = useCallback(async () => {
    if (idPaciente == null) {
      setCargando(false);
      return;
    }
    try {
      const [inicio, catalogo] = await Promise.all([
        obtenerInicioPaciente(idPaciente),
        obtenerCatalogoEjercicios(idPaciente),
      ]);
      setPlan(inicio.plan);
      setArticulacionPlan(texto(inicio.paciente?.articulacion_principal));
      setEjercicios(catalogo);
      setAhora(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cargar tu tratamiento.');
    } finally {
      setCargando(false);
    }
  }, [idPaciente]);

  // Al entrar, cada 30 s y cuando el médico cambia la rutina.
  useRecargaAutomatica(cargar);

  const alRecargar = async () => {
    setRecargando(true);
    await cargar();
    setRecargando(false);
  };

  const articulacion = articulacionPlan ?? texto(patient?.articulacion_principal);
  const diagnostico = texto(patient?.diagnostico_previo);
  const avance = plan ? avancePlan(plan, ahora) : null;

  const hechos = ejercicios.filter((e) => e.completado_hoy).length;
  const siguiente = siguientePendiente(ejercicios);
  const minutosDia = Math.round(
    ejercicios.reduce(
      (acc, e) => acc + (e.duracion_estimada_segundos || 0) * Math.max(1, e.series ?? 1),
      0
    ) / 60
  );

  const abrirEjercicio = (e: EjercicioCatalogo) =>
    e.id_prescripcion != null &&
    router.push({ pathname: '/ejercicio', params: { idPrescripcion: String(e.id_prescripcion) } });

  if (cargando) {
    return (
      <SafeAreaView style={[s.safe, s.centro]}>
        <ActivityIndicator color={p.verde} size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor={p.verdeOscuro} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={recargando} onRefresh={alRecargar} tintColor={p.verde} colors={[p.verde]} />
        }
      >
        {/* ───────────── ENCABEZADO DEL PLAN ───────────── */}
        <LinearGradient colors={[p.verde, p.verdeOscuro]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.header}>
          <View style={[s.decor, s.decorGrande]} />
          <View style={[s.decor, s.decorChico]} />

          <Text style={s.headerEtiqueta}>MI TRATAMIENTO</Text>
          <Text style={s.headerTitulo}>{plan ? nombrePlan(articulacion) : 'Sin plan activo'}</Text>

          {plan && (
            <View style={s.headerPills}>
              <View style={s.headerPill}>
                <View style={s.headerPunto} />
                <Text style={s.headerPillTexto}>{plan.estado === 'activo' ? 'En curso' : capitalizar(plan.estado)}</Text>
              </View>
              <View style={s.headerPill}>
                <Ionicons name="time-outline" size={13} color={p.blanco} />
                <Text style={s.headerPillTexto}>{plan.duracion_estimada_semanas} semanas</Text>
              </View>
              {articulacion && (
                <View style={s.headerPill}>
                  <MaterialCommunityIcons name="bone" size={13} color={p.blanco} />
                  <Text style={s.headerPillTexto}>{capitalizar(articulacion)}</Text>
                </View>
              )}
            </View>
          )}
        </LinearGradient>

        {error && (
          <View style={s.aviso}>
            <Ionicons name="cloud-offline-outline" size={18} color={p.ambar} />
            <Text style={s.avisoTexto}>{error}</Text>
          </View>
        )}

        {!plan ? (
          <View style={[s.card, s.cardFlotante]}>
            <View style={s.vacioIcono}>
              <Ionicons name="clipboard-outline" size={30} color={p.verdeTexto} />
            </View>
            <Text style={s.vacioTitulo}>Aún no tienes un plan asignado</Text>
            <Text style={s.vacioTexto}>
              Tu kinesiólogo creará tu plan de tratamiento en tu próxima cita. Cuando lo haga, aquí verás
              cuánto dura, tus ejercicios y tu avance.
            </Text>
          </View>
        ) : (
          <>
            {/* ───────────── DURACIÓN Y AVANCE ───────────── */}
            <View style={[s.card, s.cardFlotante]}>
              <View style={s.avanceFila}>
                <View style={{ flex: 1 }}>
                  <Text style={s.avanceEtiqueta}>Duración del tratamiento</Text>
                  <Text style={s.avanceSemana}>
                    {avance?.noEmpezo
                      ? 'Empieza pronto'
                      : `Semana ${avance?.semana ?? 1} de ${plan.duracion_estimada_semanas}`}
                  </Text>
                </View>
                <View style={s.restantesCaja}>
                  <Text style={s.restantesNumero}>{avance?.restantes ?? '—'}</Text>
                  <Text style={s.restantesTexto}>{avance?.restantes === 1 ? 'día restante' : 'días restantes'}</Text>
                </View>
              </View>

              <View style={s.pista}>
                <View style={[s.relleno, { width: `${Math.round((avance?.fraccion ?? 0) * 100)}%` }]} />
              </View>

              {/* Una marca por semana: verde las ya cumplidas. */}
              <View style={s.semanas}>
                {Array.from({ length: plan.duracion_estimada_semanas }, (_, i) => {
                  const n = i + 1;
                  const actual = !avance?.noEmpezo && n === avance?.semana;
                  const pasada = !avance?.noEmpezo && n < (avance?.semana ?? 0);
                  return (
                    <View key={n} style={[s.semana, pasada && s.semanaPasada, actual && s.semanaActual]}>
                      <Text style={[s.semanaTexto, pasada && s.semanaTextoPasada, actual && s.semanaTextoActual]}>{n}</Text>
                    </View>
                  );
                })}
              </View>

              <View style={s.fechasFila}>
                <Fecha icon="play-circle-outline" label="Inicio" value={formatearFecha(plan.fecha_inicio)} />
                <Fecha icon="hourglass-outline" label="Duración" value={`${plan.duracion_estimada_semanas} semanas`} />
                <Fecha icon="flag-outline" label="Alta estimada" value={formatearFecha(plan.fecha_fin_estimada)} />
              </View>
            </View>

            {/* ───────────── MÉDICO Y OBJETIVO ───────────── */}
            <View style={s.card}>
              <CardHeader icon="medkit-outline" title="Detalles del plan" />

              <View style={s.medicoFila}>
                <View style={s.medicoIcono}>
                  <Ionicons name="medical-outline" size={22} color={p.verdeTexto} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.mini}>Médico responsable</Text>
                  <Text style={s.medicoNombre}>{plan.medico_responsable}</Text>
                </View>
              </View>

              {texto(plan.objetivo_general) && (
                <View style={s.bloque}>
                  <View style={s.bloqueTitulo}>
                    <Ionicons name="locate-outline" size={16} color={p.verdeTexto} />
                    <Text style={s.mini}>Objetivo del tratamiento</Text>
                  </View>
                  <Text style={s.bloqueTexto}>{plan.objetivo_general}</Text>
                </View>
              )}

              {diagnostico && (
                <View style={s.bloque}>
                  <View style={s.bloqueTitulo}>
                    <Ionicons name="document-text-outline" size={16} color={p.verdeTexto} />
                    <Text style={s.mini}>Motivo (diagnóstico)</Text>
                  </View>
                  <Text style={s.bloqueTexto}>{diagnostico}</Text>
                </View>
              )}
            </View>

            {/* ───────────── RUTINA DE HOY ───────────── */}
            {ejercicios.length > 0 && (
              <View style={s.hoy}>
                <View style={{ flex: 1 }}>
                  <Text style={s.hoyEtiqueta}>Tu rutina de hoy</Text>
                  <Text style={s.hoyTexto}>
                    {hechos} de {ejercicios.length} {ejercicios.length === 1 ? 'ejercicio' : 'ejercicios'} hechos
                    {minutosDia > 0 ? ` · ~${minutosDia} min` : ''}
                  </Text>
                </View>
                {siguiente ? (
                  <TouchableOpacity style={s.hoyBoton} activeOpacity={0.85} onPress={() => abrirEjercicio(siguiente)}>
                    <Ionicons name="play" size={16} color="#16265C" />
                    <Text style={s.hoyBotonTexto}>Continuar</Text>
                  </TouchableOpacity>
                ) : (
                  <MaterialCommunityIcons name="check-decagram" size={30} color={p.blanco} />
                )}
              </View>
            )}

            {/* ───────────── EJERCICIOS DEL PLAN ───────────── */}
            <View style={s.card}>
              <CardHeader
                icon="barbell-outline"
                title="Ejercicios del plan"
                extra={ejercicios.length > 0 ? String(ejercicios.length) : undefined}
              />
              {ejercicios.length === 0 ? (
                <Text style={s.vacioTexto}>Tu médico todavía no te asignó ejercicios en este plan.</Text>
              ) : (
                ejercicios.map((e, i) => (
                  <FilaEjercicio
                    key={e.id_prescripcion ?? e.id_ejercicio}
                    numero={i + 1}
                    ejercicio={e}
                    onPress={() => abrirEjercicio(e)}
                  />
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────
function CardHeader({ icon, title, extra }: { icon: IconName; title: string; extra?: string }) {
  const s = useEstilos();
  const { p } = useTema();
  return (
    <View style={s.cardHeader}>
      <View style={s.cardHeaderIcono}>
        <Ionicons name={icon} size={18} color={p.verdeTexto} />
      </View>
      <Text style={s.cardHeaderTitulo}>{title}</Text>
      {extra && (
        <View style={s.contador}>
          <Text style={s.contadorTexto}>{extra}</Text>
        </View>
      )}
    </View>
  );
}

function Fecha({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const s = useEstilos();
  const { p } = useTema();
  return (
    <View style={s.fechaCaja}>
      <Ionicons name={icon} size={18} color={p.verdeTexto} />
      <Text style={s.fechaEtiqueta}>{label}</Text>
      <Text style={s.fechaValor}>{value}</Text>
    </View>
  );
}

function FilaEjercicio({
  numero,
  ejercicio: e,
  onPress,
}: {
  numero: number;
  ejercicio: EjercicioCatalogo;
  onPress: () => void;
}) {
  const s = useEstilos();
  const { p } = useTema();
  const total = totalPrescrito(e);
  const hechasHoy = e.repeticiones_hechas_hoy ?? 0;
  const duracion = formatearDuracion(e.duracion_estimada_segundos);
  const descripcion = texto(e.descripcion);

  return (
    <TouchableOpacity style={s.ejFila} activeOpacity={0.7} onPress={onPress}>
      <View style={[s.ejNumero, e.completado_hoy && s.ejNumeroHecho]}>
        {e.completado_hoy ? (
          <Ionicons name="checkmark" size={18} color={p.blanco} />
        ) : (
          <Text style={s.ejNumeroTexto}>{numero}</Text>
        )}
      </View>

      <View style={{ flex: 1 }}>
        <Text style={s.ejNombre}>{e.nombre}</Text>
        {descripcion && (
          <Text style={s.ejDescripcion} numberOfLines={2}>
            {descripcion}
          </Text>
        )}

        <View style={s.ejChips}>
          <Chip icon="body-outline" texto={capitalizar(e.zona)} />
          {e.series != null && e.repeticiones != null && (
            <Chip icon="repeat-outline" texto={`${e.series} × ${e.repeticiones} rep.`} />
          )}
          {duracion && <Chip icon="time-outline" texto={duracion} />}
          {e.codigo_cv && <Chip icon="videocam-outline" texto="Con cámara" />}
        </View>

        {e.completado_hoy ? (
          <Text style={[s.ejEstado, { color: p.verdeTexto }]}>Hecho hoy</Text>
        ) : hechasHoy > 0 && total ? (
          <Text style={[s.ejEstado, { color: p.ambar }]}>
            Hoy llevas {hechasHoy} de {total} repeticiones
          </Text>
        ) : (
          <Text style={[s.ejEstado, { color: p.textoSuave }]}>Pendiente hoy</Text>
        )}
      </View>

      <Ionicons name="chevron-forward" size={18} color={p.textoTenue} />
    </TouchableOpacity>
  );
}

function Chip({ icon, texto: t }: { icon: IconName; texto: string }) {
  const s = useEstilos();
  const { p } = useTema();
  return (
    <View style={s.chip}>
      <Ionicons name={icon} size={12} color={p.textoSuave} />
      <Text style={s.chipTexto}>{t}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────
// Estilos
// ─────────────────────────────────────────────
const useEstilos = crearEstilos((p, oscuro) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.fondo },
    centro: { alignItems: 'center', justifyContent: 'center' },

    header: {
      paddingTop: Platform.OS === 'android' ? 48 : 60,
      paddingBottom: 56,
      paddingHorizontal: 24,
      borderBottomLeftRadius: 32,
      borderBottomRightRadius: 32,
      overflow: 'hidden',
    },
    decor: { position: 'absolute', borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)' },
    decorGrande: { width: 220, height: 220, top: -90, right: -60 },
    decorChico: { width: 120, height: 120, bottom: -40, left: -30 },
    headerEtiqueta: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
    headerTitulo: { color: p.blanco, fontSize: 24, fontWeight: '800', marginTop: 6 },
    headerPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
    headerPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(255,255,255,0.16)',
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 999,
    },
    headerPunto: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#7CF0A9' },
    headerPillTexto: { color: p.blanco, fontSize: 12.5, fontWeight: '700' },

    aviso: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: p.ambarSuave,
      marginHorizontal: 20,
      marginTop: 12,
      borderRadius: 12,
      padding: 12,
    },
    avisoTexto: { flex: 1, color: p.ambar, fontSize: 13, fontWeight: '600' },

    card: {
      backgroundColor: p.superficie,
      marginHorizontal: 20,
      marginTop: 18,
      borderRadius: 20,
      padding: 20,
      borderWidth: 1,
      borderColor: p.borde,
    },
    cardFlotante: {
      marginTop: -32,
      borderWidth: oscuro ? 1 : 0,
      shadowColor: '#000',
      shadowOpacity: oscuro ? 0.3 : 0.08,
      shadowOffset: { width: 0, height: 6 },
      shadowRadius: 12,
      elevation: 4,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
    cardHeaderIcono: {
      width: 34,
      height: 34,
      borderRadius: 10,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    cardHeaderTitulo: { flex: 1, fontSize: 17, fontWeight: '800', color: p.texto },
    contador: { backgroundColor: p.verdeSuave, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
    contadorTexto: { color: p.verdeTexto, fontWeight: '800', fontSize: 13 },

    vacioIcono: {
      alignSelf: 'center',
      width: 60,
      height: 60,
      borderRadius: 18,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
    },
    vacioTitulo: { fontSize: 17, fontWeight: '800', color: p.texto, textAlign: 'center' },
    vacioTexto: { fontSize: 14, color: p.textoSuave, lineHeight: 20, marginTop: 6, textAlign: 'center' },

    avanceFila: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    avanceEtiqueta: { fontSize: 13, color: p.textoSuave, fontWeight: '600' },
    avanceSemana: { fontSize: 20, color: p.texto, fontWeight: '800', marginTop: 2 },
    restantesCaja: {
      alignItems: 'center',
      backgroundColor: p.verdeSuave,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    restantesNumero: { fontSize: 20, fontWeight: '800', color: p.verdeTexto },
    restantesTexto: { fontSize: 11, fontWeight: '700', color: p.verdeTexto },
    pista: { height: 9, backgroundColor: p.verdeSuave, borderRadius: 999, overflow: 'hidden', marginTop: 16 },
    relleno: { height: '100%', backgroundColor: p.verde, borderRadius: 999 },

    semanas: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
    semana: {
      minWidth: 30,
      height: 30,
      borderRadius: 9,
      backgroundColor: p.superficieAlt,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
    },
    semanaPasada: { backgroundColor: p.verdeSuave },
    semanaActual: { backgroundColor: p.verde },
    semanaTexto: { fontSize: 12.5, fontWeight: '700', color: p.textoTenue },
    semanaTextoPasada: { color: p.verdeTexto },
    semanaTextoActual: { color: p.blanco },

    fechasFila: { flexDirection: 'row', gap: 8, marginTop: 16 },
    fechaCaja: {
      flex: 1,
      alignItems: 'center',
      backgroundColor: p.superficieAlt,
      borderRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 6,
    },
    fechaEtiqueta: { fontSize: 11.5, color: p.textoSuave, fontWeight: '600', marginTop: 6 },
    fechaValor: { fontSize: 13, color: p.texto, fontWeight: '800', marginTop: 2, textAlign: 'center' },

    medicoFila: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: p.superficieAlt,
      borderRadius: 16,
      padding: 12,
    },
    medicoIcono: {
      width: 46,
      height: 46,
      borderRadius: 14,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
    },
    mini: { fontSize: 12.5, color: p.textoSuave, fontWeight: '600' },
    medicoNombre: { fontSize: 15.5, fontWeight: '800', color: p.texto, marginTop: 1 },
    bloque: { marginTop: 14 },
    bloqueTitulo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    bloqueTexto: { fontSize: 15, color: p.texto, fontWeight: '600', marginTop: 4, lineHeight: 21 },

    hoy: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: p.navy,
      marginHorizontal: 20,
      marginTop: 18,
      borderRadius: 18,
      padding: 16,
    },
    hoyEtiqueta: { color: 'rgba(255,255,255,0.75)', fontSize: 12.5, fontWeight: '700' },
    hoyTexto: { color: p.blanco, fontSize: 16, fontWeight: '800', marginTop: 2 },
    hoyBoton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: p.blanco,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    hoyBotonTexto: { color: '#16265C', fontWeight: '800', fontSize: 14 },

    ejFila: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: p.borde,
    },
    ejNumero: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'flex-start',
    },
    ejNumeroHecho: { backgroundColor: p.verde },
    ejNumeroTexto: { color: p.verdeTexto, fontWeight: '800', fontSize: 14 },
    ejNombre: { fontSize: 15.5, fontWeight: '800', color: p.texto },
    ejDescripcion: { fontSize: 13, color: p.textoSuave, marginTop: 3, lineHeight: 18 },
    ejChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: p.superficieAlt,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    chipTexto: { fontSize: 11.5, color: p.textoSuave, fontWeight: '700' },
    ejEstado: { fontSize: 12, fontWeight: '700', marginTop: 8 },
  })
);
