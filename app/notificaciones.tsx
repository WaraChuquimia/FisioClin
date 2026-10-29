import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useNotificaciones } from '@/context/NotificacionesContext';
import { crearEstilos, useTema } from '@/context/TemaContext';
import { Notificacion } from '@/lib/notificacionesData';

function formatearFecha(fecha: string) {
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return fecha;
  return d.toLocaleDateString('es-BO', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NotificacionesScreen() {
  const { p } = useTema();
  const s = useEstilos();
  const { activas, setActivas, lista, cargando, recargar, marcarTodasLeidas } = useNotificaciones();
  // Qué estaba sin leer al entrar: se sigue resaltando aunque ya se marcó.
  const [nuevasAlEntrar, setNuevasAlEntrar] = useState<Set<number>>(new Set());

  useFocusEffect(
    useCallback(() => {
      if (!activas) return;
      setNuevasAlEntrar(new Set(lista.filter((n) => !n.leida).map((n) => n.id_notificacion)));
      void marcarTodasLeidas();
      // Solo al entrar a la pantalla, no cada vez que cambia la lista.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activas])
  );

  const nuevas = nuevasAlEntrar.size;
  const subtitulo = !activas
    ? 'Avisos desactivados'
    : nuevas > 0
      ? `${nuevas} ${nuevas === 1 ? 'aviso nuevo' : 'avisos nuevos'}`
      : 'Avisos que te envía tu médico';

  return (
    <SafeAreaView style={s.pantalla} edges={['top']}>
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
        <View style={{ flex: 1 }}>
          <Text style={s.encabezadoTitulo}>Notificaciones</Text>
          <Text style={s.encabezadoSub}>{subtitulo}</Text>
        </View>
      </View>

      {!activas ? (
        <View style={s.centrado}>
          <Ionicons name="notifications-off-outline" size={48} color={p.textoTenue} />
          <Text style={s.vacioTitulo}>Notificaciones desactivadas</Text>
          <Text style={s.vacioTexto}>
            Actívalas para recibir los avisos que te envía tu médico.
          </Text>
          <View style={s.filaInterruptor}>
            <Text style={s.interruptorTexto}>Recibir avisos</Text>
            <Switch
              value={activas}
              onValueChange={setActivas}
              trackColor={{ false: p.pista, true: p.verde }}
              thumbColor={p.blanco}
            />
          </View>
        </View>
      ) : (
        <FlatList
          style={s.pantalla}
          contentContainerStyle={lista.length === 0 ? s.centrado : s.lista}
          data={lista}
          keyExtractor={(n) => String(n.id_notificacion)}
          refreshControl={
            <RefreshControl refreshing={cargando} onRefresh={recargar} tintColor={p.verde} colors={[p.verde]} />
          }
          ListEmptyComponent={
            cargando ? (
              <ActivityIndicator color={p.verde} size="large" />
            ) : (
              <>
                <Ionicons name="notifications-outline" size={48} color={p.textoTenue} />
                <Text style={s.vacioTitulo}>Sin avisos por ahora</Text>
                <Text style={s.vacioTexto}>Aquí verás lo que te envíe tu médico.</Text>
              </>
            )
          }
          renderItem={({ item }) => (
            <TarjetaNotificacion n={item} nueva={nuevasAlEntrar.has(item.id_notificacion)} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function iconoPara(n: Notificacion): React.ComponentProps<typeof Ionicons>['name'] {
  if (n.categoria === 'prescripcion') return 'barbell-outline';
  if (n.severidad === 'alta' || n.severidad === 'critica') return 'alert-circle-outline';
  return 'chatbubble-ellipses-outline';
}

function TarjetaNotificacion({ n, nueva }: { n: Notificacion; nueva: boolean }) {
  const { p } = useTema();
  const s = useEstilos();

  return (
    <View style={[s.tarjeta, nueva && s.tarjetaNueva]}>
      <View style={s.icono}>
        <Ionicons name={iconoPara(n)} size={20} color={p.verdeTexto} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.filaTitulo}>
          <Text style={s.titulo}>{n.titulo}</Text>
          {nueva && <View style={s.punto} />}
        </View>
        <Text style={s.mensaje}>{n.mensaje}</Text>
        <Text style={s.fecha}>{formatearFecha(n.fecha_creacion)}</Text>
      </View>
    </View>
  );
}

const useEstilos = crearEstilos((p) =>
  StyleSheet.create({
    pantalla: { flex: 1, backgroundColor: p.fondo },
    encabezado: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginHorizontal: 16,
      marginTop: 12,
      marginBottom: 14,
      padding: 14,
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
    encabezadoSub: { fontSize: 13, color: p.textoSuave, marginTop: 2 },
    lista: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
    centrado: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      backgroundColor: p.fondo,
    },
    vacioTitulo: { fontSize: 17, fontWeight: '800', color: p.texto, marginTop: 14 },
    vacioTexto: { fontSize: 14, color: p.textoSuave, textAlign: 'center', marginTop: 6, lineHeight: 20 },
    filaInterruptor: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginTop: 20,
      backgroundColor: p.superficie,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: p.borde,
    },
    interruptorTexto: { fontSize: 15, fontWeight: '600', color: p.texto },

    tarjeta: {
      flexDirection: 'row',
      gap: 12,
      backgroundColor: p.superficie,
      borderRadius: 16,
      padding: 14,
      borderWidth: 1,
      borderColor: p.borde,
    },
    tarjetaNueva: { borderColor: p.verde },
    icono: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: p.verdeSuave,
      alignItems: 'center',
      justifyContent: 'center',
    },
    filaTitulo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    titulo: { flexShrink: 1, fontSize: 15, fontWeight: '800', color: p.texto },
    punto: { width: 8, height: 8, borderRadius: 4, backgroundColor: p.verde },
    mensaje: { fontSize: 14, color: p.textoSuave, marginTop: 4, lineHeight: 20 },
    fecha: { fontSize: 12, color: p.textoTenue, marginTop: 8 },
  })
);
