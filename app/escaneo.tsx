import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EscanerCarnet } from '@/components/escanercarnet';
import { DatosDocumentoBolivia } from '@/lib/carnet/ciBoliviaParser';
import { useAuth } from '@/context/AuthContext';

// Misma paleta institucional COSSMIL
const COLORS = {
  azulOscuro: '#16265C',
  verde: '#1E8A4C',
  blanco: '#FFFFFF',
  grisClaro: '#EDEFF2',
  grisOscuro: '#4A4A4A',
  grisTexto: '#8A8F98',
  verdeClaro: '#E7F5EC',
};

export default function ScanCarnetScreen() {
  const router = useRouter();
  const { signInByCarnet } = useAuth();
  const [escanerAbierto, setEscanerAbierto] = useState(false);
  const [verificando, setVerificando] = useState(false);

  const alEscanear = async (datos: DatosDocumentoBolivia) => {
    setEscanerAbierto(false);

    setVerificando(true);
    const { error } = await signInByCarnet(datos.ci);
    setVerificando(false);

    if (!error) {
      router.replace('/(tabs)');
      return;
    }

    Alert.alert(
      'No pudimos verificar su carnet',
      'Los datos leídos no están registrados. Puedes intentar escanear de nuevo o ingresarlo a mano.',
      [
        { text: 'Escanear de nuevo', onPress: () => setEscanerAbierto(true) },
        { text: 'Ingresar a mano', onPress: () => router.back(), style: 'cancel' },
      ],
    );
  };

  if (escanerAbierto) {
    return (
      <EscanerCarnet
        onScanComplete={alEscanear}
        onClose={() => setEscanerAbierto(false)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >

        {/* HEADER */}
        <View style={styles.header}>

          <TouchableOpacity
            style={styles.iconButton}
            activeOpacity={0.7}
            onPress={() => router.back()}
          >
            <Ionicons
              name="chevron-back"
              size={22}
              color={COLORS.azulOscuro}
            />
          </TouchableOpacity>

          <Text style={styles.headerTitle}>
            Escanear carnet
          </Text>

          <TouchableOpacity
            style={styles.iconButton}
            activeOpacity={0.7}
          >
            <Ionicons
              name="help-circle-outline"
              size={24}
              color={COLORS.azulOscuro}
            />
          </TouchableOpacity>

        </View>

        {/* SUBTÍTULO */}
        <Text style={styles.subtitle}>
          Coloca tu carnet dentro del marco{'\n'}
          y asegúrate de que se vea claramente.
        </Text>

        {/* ÁREA DE ESCANEO */}
        <View style={styles.cameraContainer}>

          {/* Fondo de la cámara */}
          <View style={styles.cameraBackground}>

            {/* Marco */}
            <View style={styles.frameOverlay}>

              {/* Esquina superior izquierda */}
              <View
                style={[
                  styles.corner,
                  styles.cornerTopLeft,
                ]}
              />

              {/* Esquina superior derecha */}
              <View
                style={[
                  styles.corner,
                  styles.cornerTopRight,
                ]}
              />

              {/* Esquina inferior izquierda */}
              <View
                style={[
                  styles.corner,
                  styles.cornerBottomLeft,
                ]}
              />

              {/* Esquina inferior derecha */}
              <View
                style={[
                  styles.corner,
                  styles.cornerBottomRight,
                ]}
              />

              {/* Línea de escaneo */}
              <View style={styles.scanLine} />

              {/* Texto temporal */}
              <Text style={styles.cameraText}>
                Cámara
              </Text>

            </View>

          </View>

        </View>

        {/* BOTÓN PRINCIPAL */}
        <TouchableOpacity
          style={styles.scanButton}
          activeOpacity={0.85}
          onPress={() => setEscanerAbierto(true)}
        >
          <Ionicons name="scan-outline" size={20} color={COLORS.blanco} />
          <Text style={styles.scanButtonText}>Escanear ahora</Text>
        </TouchableOpacity>

        {/* CONSEJOS */}
        <View style={styles.tipsRow}>

          {/* Buena iluminación */}
          <View style={styles.tipItem}>
            <View style={styles.tipIconCircle}>
              <Ionicons
                name="bulb-outline"
                size={20}
                color={COLORS.azulOscuro}
              />
            </View>

            <Text style={styles.tipText}>
              Buena{'\n'}iluminación
            </Text>
          </View>

          {/* Evitar reflejos */}
          <View style={styles.tipItem}>
            <View style={styles.tipIconCircle}>
              <MaterialCommunityIcons
                name="flash-off-outline"
                size={20}
                color={COLORS.azulOscuro}
              />
            </View>

            <Text style={styles.tipText}>
              Evita{'\n'}reflejos
            </Text>
          </View>

          {/* Carnet recto */}
          <View style={styles.tipItem}>
            <View style={styles.tipIconCircle}>
              <Ionicons
                name="card-outline"
                size={20}
                color={COLORS.azulOscuro}
              />
            </View>

            <Text style={styles.tipText}>
              Coloca el{'\n'}carnet recto
            </Text>
          </View>

        </View>

        {/* AVISO */}
        <View style={styles.infoBox}>

          <View style={styles.infoIconCircle}>
            <Ionicons
              name="checkmark"
              size={16}
              color={COLORS.blanco}
            />
          </View>

          <View style={styles.infoContent}>

            <Text style={styles.infoTitle}>
              Tu información se completará automáticamente
            </Text>

            <Text style={styles.infoSubtitle}>
              Verifica que los datos sean correctos antes de continuar.
            </Text>

          </View>

        </View>

        

        {/* BOTÓN MANUAL */}
        <TouchableOpacity
          style={styles.manualButton}
          activeOpacity={0.85}
          onPress={() => router.back()}
        >
          <Ionicons
            name="keypad-outline"
            size={20}
            color={COLORS.azulOscuro}
          />

          <Text style={styles.manualButtonText}>
            Ingresar manualmente
          </Text>
        </TouchableOpacity>

        {/* FOOTER */}
        <View style={styles.footerRow}>

          <Ionicons
            name="lock-closed-outline"
            size={13}
            color={COLORS.grisTexto}
          />

          <Text style={styles.footerText}>
            Tus datos están protegidos y son confidenciales
          </Text>

        </View>

      </ScrollView>

      <Modal visible={verificando} transparent animationType="fade">
        <View style={styles.verificandoOverlay}>
          <View style={styles.verificandoCard}>
            <ActivityIndicator size="large" color={COLORS.verde} />
            <Text style={styles.verificandoTexto}>Verificando carnet...</Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({

  safeArea: {
    flex: 1,
    backgroundColor: COLORS.blanco,
  },

  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },

  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.grisClaro,
    alignItems: 'center',
    justifyContent: 'center',
  },

  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.azulOscuro,
  },

  subtitle: {
    fontSize: 14,
    color: COLORS.grisOscuro,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },

  /* CÁMARA */

  cameraContainer: {
    width: '100%',
    height: 320,
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 20,
    backgroundColor: '#2A2A2A',
  },

  cameraBackground: {
    flex: 1,
    backgroundColor: '#2A2A2A',
  },

  frameOverlay: {
    flex: 1,
    margin: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },

  cameraText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    opacity: 0.7,
  },

  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: COLORS.verde,
  },

  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 8,
  },

  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 8,
  },

  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 8,
  },

  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 8,
  },

  scanLine: {
    position: 'absolute',
    left: 10,
    right: 10,
    top: '50%',
    height: 2,
    backgroundColor: COLORS.verde,
    opacity: 0.9,
  },

  /* CONSEJOS */

  tipsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
  },

  tipItem: {
    flex: 1,
    alignItems: 'center',
  },

  tipIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.grisClaro,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },

  tipText: {
    fontSize: 12,
    color: COLORS.grisOscuro,
    textAlign: 'center',
    lineHeight: 16,
  },

  /* INFORMACIÓN */

  infoBox: {
    flexDirection: 'row',
    backgroundColor: COLORS.verdeClaro,
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
  },

  infoIconCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.verde,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    marginRight: 12,
  },

  infoContent: {
    flex: 1,
  },

  infoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.azulOscuro,
    marginBottom: 4,
  },

  infoSubtitle: {
    fontSize: 12.5,
    color: COLORS.grisOscuro,
    lineHeight: 17,
  },

  /* BOTÓN PRINCIPAL */

  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.azulOscuro,
    borderRadius: 16,
    paddingVertical: 16,
    marginBottom: 12,
  },

  scanButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.blanco,
    marginLeft: 10,
  },

  /* BOTÓN SECUNDARIO */

  manualButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.blanco,
    borderRadius: 16,
    paddingVertical: 16,
    borderWidth: 1.5,
    borderColor: COLORS.grisClaro,
    marginBottom: 18,
  },

  manualButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.azulOscuro,
    marginLeft: 10,
  },

  /* FOOTER */

  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  footerText: {
    fontSize: 12,
    color: COLORS.grisTexto,
    marginLeft: 6,
  },

  /* OVERLAY DE VERIFICACIÓN */

  verificandoOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  verificandoCard: {
    backgroundColor: COLORS.blanco,
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 32,
    alignItems: 'center',
  },

  verificandoTexto: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.azulOscuro,
  },

});