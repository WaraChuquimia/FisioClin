/* ==================================================================
   FisioClin — pestaña Rehabilitar
   ==================================================================

   Lista SOLO los ejercicios que el médico le prescribió al paciente
   (obtener_catalogo_ejercicios -> prescripciones_vigentes en Supabase),
   uno por ejercicio. Tocar uno abre la sesión con cámara
   (app/rehabilitacion.tsx); al terminarla, `router.back()` vuelve aquí y
   la lista se recarga para mostrar lo ya hecho hoy.

   Solo se puede iniciar un ejercicio si en la base tiene `clase_lstm`
   (codigo_cv, 'C01'..'R10') y ese código tiene banda de referencia medida
   en `ml/configuracion_ejercicios.json`; si no, el evaluador no podría
   contar repeticiones y la tarjeta se muestra deshabilitada.
   ================================================================== */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
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
import { EjercicioCatalogo, obtenerCatalogoEjercicios } from '@/lib/ejerciciosData';
import { fichaEjercicio } from '@/lib/fisioclin/evaluador';

const capitalizar = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** true si la cámara puede evaluar este ejercicio prescrito. */
const tieneSesionEnVivo = (e: EjercicioCatalogo) =>
  e.codigo_cv != null && Boolean(fichaEjercicio(e.codigo_cv)?.umbrales);

export default function RehabilitarScreen() {
  const { patient } = useAuth();
  const { p, oscuro } = useTema();
  const s = useEstilos();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  const [ejercicios, setEjercicios] = useState<EjercicioCatalogo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recargando, setRecargando] = useState(false);

  const cargar = useCallback(async () => {
    if (idPaciente == null) return;
    try {
      setError(null);
      setEjercicios(await obtenerCatalogoEjercicios(idPaciente));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos cargar tus ejercicios.');
    }
  }, [idPaciente]);

  // Se recarga al volver a la pestaña (en particular al terminar una sesión
  // con cámara), cada 30 s y cuando el médico prescribe algo nuevo.
  useRecargaAutomatica(cargar);

  const alRecargar = async () => {
    setRecargando(true);
    await cargar();
    setRecargando(false);
  };

  // Siempre pasa por el detalle del ejercicio (video, criterio clínico,
  // botón "Iniciar"), nunca directo a la cámara — mismo criterio que el
  // botón "Rehabilitar" de la barra inferior (app/(tabs)/_layout.tsx).
  const iniciar = (e: EjercicioCatalogo) =>
    router.push({ pathname: '/ejercicio', params: { idPrescripcion: String(e.id_prescripcion) } });

  const hechos = ejercicios?.filter((e) => e.completado_hoy).length ?? 0;
  const total = ejercicios?.length ?? 0;

  let contenido: React.ReactNode;
  if (error) {
    contenido = <Text style={s.vacio}>{error}</Text>;
  } else if (ejercicios == null) {
    contenido = <ActivityIndicator color={p.verde} size="large" style={{ marginTop: 40 }} />;
  } else if (ejercicios.length === 0) {
    contenido = (
      <Text style={s.vacio}>
        Todavía no tienes ejercicios prescritos. Tu kinesiólogo los asignará pronto.
      </Text>
    );
  } else {
    contenido = ejercicios.map((e) => (
      <TarjetaEjercicio key={e.id_prescripcion ?? e.id_ejercicio} ejercicio={e} onPress={() => iniciar(e)} />
    ));
  }

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle={oscuro ? 'light-content' : 'dark-content'} backgroundColor={p.fondo} />
      <ScrollView
        contentContainerStyle={s.contenido}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={recargando} onRefresh={alRecargar} tintColor={p.verde} colors={[p.verde]} />
        }
      >
        <Text style={s.titulo}>Rehabilitación</Text>
        <Text style={s.subtitulo}>
          Elige uno de tus ejercicios. La cámara mide tu movimiento en tiempo real y, al terminar,
          vuelves aquí para seguir con el siguiente.
        </Text>

        {total > 0 && (
          <View style={s.resumen}>
            <MaterialCommunityIcons name="check-decagram" size={22} color={p.blanco} />
            <Text style={s.resumenTexto}>
              {hechos} de {total} {total === 1 ? 'ejercicio hecho' : 'ejercicios hechos'} hoy
            </Text>
          </View>
        )}

        <View style={s.lista}>{contenido}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

function TarjetaEjercicio({ ejercicio, onPress }: { ejercicio: EjercicioCatalogo; onPress: () => void }) {
  const { p } = useTema();
  const s = useEstilos();
  const listo = tieneSesionEnVivo(ejercicio);
  const hecho = ejercicio.completado_hoy;
  const dosis =
    ejercicio.series != null && ejercicio.repeticiones != null
      ? `${ejercicio.series} series × ${ejercicio.repeticiones} repeticiones`
      : null;

  return (
    <TouchableOpacity
      style={[s.tarjeta, hecho && s.tarjetaHecha, !listo && s.tarjetaDeshabilitada]}
      activeOpacity={listo ? 0.85 : 1}
      onPress={listo ? onPress : undefined}
      disabled={!listo}
    >
      <View style={[s.tarjetaIcono, hecho && s.tarjetaIconoHecho]}>
        <MaterialCommunityIcons
          name={hecho ? 'check' : 'human-handsdown'}
          size={22}
          color={hecho ? p.blanco : listo ? p.verdeTexto : p.textoTenue}
        />
      </View>

      <View style={{ flex: 1 }}>
        <View style={s.grupoPill}>
          <Text style={s.grupoPillTexto}>{capitalizar(ejercicio.zona)}</Text>
        </View>
        <Text style={s.tarjetaNombre}>{ejercicio.nombre}</Text>
        {dosis ? <Text style={s.tarjetaDosis}>{dosis}</Text> : null}

        {hecho ? (
          <View style={s.estadoPill}>
            <Text style={s.estadoPillTexto}>Hecho hoy · puedes repetirlo</Text>
          </View>
        ) : listo && (ejercicio.repeticiones_hechas_hoy ?? 0) > 0 ? (
          // Empezó hoy pero no terminó todas las repeticiones prescritas.
          <View style={[s.estadoPill, s.estadoPillAmbar]}>
            <Text style={[s.estadoPillTexto, s.estadoPillTextoAmbar]}>
              Realizado {ejercicio.repeticiones_hechas_hoy} de{' '}
              {(ejercicio.series ?? 0) * (ejercicio.repeticiones ?? 0)} · continúa
            </Text>
          </View>
        ) : listo ? (
          <View style={s.estadoPill}>
            <Text style={s.estadoPillTexto}>Listo para medir</Text>
          </View>
        ) : (
          <View style={[s.estadoPill, s.estadoPillAmbar]}>
            <Text style={[s.estadoPillTexto, s.estadoPillTextoAmbar]}>Aún sin sesión con cámara</Text>
          </View>
        )}
      </View>

      {listo && <MaterialCommunityIcons name="chevron-right" size={22} color={p.textoTenue} />}
    </TouchableOpacity>
  );
}

const useEstilos = crearEstilos((p) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.fondo },
    contenido: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 32 },
    titulo: { fontSize: 26, fontWeight: '800', color: p.texto },
    subtitulo: { fontSize: 14, color: p.textoSuave, marginTop: 6, lineHeight: 20 },

    resumen: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: p.navy,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginTop: 18,
    },
    resumenTexto: { color: p.blanco, fontSize: 15, fontWeight: '700' },

    lista: { gap: 12, marginTop: 18 },
    vacio: { fontSize: 14, color: p.textoSuave, textAlign: 'center', lineHeight: 20, marginTop: 40 },

    tarjeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      backgroundColor: p.superficie,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: p.borde,
      padding: 16,
    },
    tarjetaHecha: { borderColor: p.verde },
    tarjetaDeshabilitada: { opacity: 0.6 },
    tarjetaIcono: {
      width: 46,
      height: 46,
      borderRadius: 14,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tarjetaIconoHecho: { backgroundColor: p.verde },

    grupoPill: {
      alignSelf: 'flex-start',
      backgroundColor: p.superficieAlt,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
    },
    grupoPillTexto: { fontSize: 11, fontWeight: '700', color: p.textoSuave },
    tarjetaNombre: { fontSize: 16, fontWeight: '800', color: p.texto, marginTop: 4 },
    tarjetaDosis: { fontSize: 13, color: p.textoSuave, marginTop: 2 },

    estadoPill: {
      alignSelf: 'flex-start',
      backgroundColor: p.verdeSuave,
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: 8,
      marginTop: 8,
    },
    estadoPillTexto: { fontSize: 11.5, fontWeight: '700', color: p.verdeTexto },
    estadoPillAmbar: { backgroundColor: p.ambarSuave },
    estadoPillTextoAmbar: { color: p.ambar },
  })
);
