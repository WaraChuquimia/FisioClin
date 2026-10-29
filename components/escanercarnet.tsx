/* ==================================================================
   FisioClin — escáner de carnet de identidad
   ==================================================================

   Misma idea que el `DocumentScannerModal` original, pero montado sobre
   `expo-camera` en vez de `react-native-vision-camera` + ML Kit. El
   motivo es el de siempre: Expo Go no carga módulos nativos, así que la
   foto se saca aquí y el OCR lo hace `cv-service`, igual que ya se hace
   con los fotogramas de pose.

   El precio es que escanear necesita el backend levantado. A cambio no
   hay development build, y el OCR de servidor lee una cédula gastada
   bastante mejor que un móvil de gama baja.
   ================================================================== */

import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  DatosDocumentoBolivia,
  datosSuficientes,
  parseCIDocument,
} from '@/lib/carnet/ciBoliviaParser';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

/** Proporción de una cédula ID-1 (85.6 × 53.98 mm). */
const CARD_ASPECT_RATIO = 85.6 / 53.98;
const FRAME_WIDTH = SCREEN_WIDTH * 0.88;
const FRAME_HEIGHT = FRAME_WIDTH / CARD_ASPECT_RATIO;

/* Se reutiliza la variable que ya configura el servicio de visión, para
   no tener dos direcciones que mantener sincronizadas. */
const URL_OCR = (process.env.EXPO_PUBLIC_CV_URL ?? 'ws://192.168.1.100:8000/ws')
  .replace(/^ws/, 'http')
  .replace(/\/ws$/, '/ocr/carnet');

const MS_ESPERA = 20000;

interface ScannerProps {
  onScanComplete: (data: DatosDocumentoBolivia) => void;
  onClose: () => void;
}

export const EscanerCarnet: React.FC<ScannerProps> = ({
  onScanComplete,
  onClose,
}) => {
  const [permiso, pedirPermiso] = useCameraPermissions();
  const [procesando, setProcesando] = useState(false);
  const [mensaje, setMensaje] = useState(
    'Alinea el frente del documento en el marco',
  );
  const camaraRef = useRef<CameraView>(null);

  const capturarYProcesar = async () => {
    if (!camaraRef.current || procesando) return;
    setProcesando(true);
    setMensaje('Procesando documento...');

    // El backend puede estar apagado o en otra IP; sin este corte la
    // pantalla se queda girando para siempre.
    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), MS_ESPERA);

    try {
      const foto = await camaraRef.current.takePictureAsync({
        quality: 0.9,
        base64: true,
        skipProcessing: false,
      });

      if (!foto?.base64) {
        setMensaje('No se pudo leer la foto. Vuelve a intentarlo.');
        return;
      }

      const resp = await fetch(URL_OCR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jpg: foto.base64 }),
        signal: corte.signal,
      });

      if (!resp.ok) {
        setMensaje(`El servicio de lectura respondió ${resp.status}.`);
        return;
      }

      const { bloques } = (await resp.json()) as { bloques: string[] };
      const leido = parseCIDocument(bloques ?? []);

      if (!datosSuficientes(leido)) {
        setMensaje('No se leyeron los datos con claridad. Intenta de nuevo.');
        return;
      }

      onScanComplete({
        ci: leido.ci ?? '',
        nombres: leido.nombres ?? '',
        apellidoPaterno: leido.apellidoPaterno ?? '',
        apellidoMaterno: leido.apellidoMaterno ?? '',
        fechaNacimiento: leido.fechaNacimiento ?? '',
        fotoRostroBase64: '',
      });
    } catch (err: any) {
      const abortado = err?.name === 'AbortError';
      setMensaje(
        abortado
          ? 'El servicio de lectura no responde. Revisa que cv-service esté encendido.'
          : 'Error en la captura. Vuelve a intentarlo.',
      );
      if (!abortado) console.warn('[carnet] fallo al escanear:', err);
    } finally {
      clearTimeout(reloj);
      setProcesando(false);
    }
  };

  if (!permiso) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#00C853" />
        <Text style={styles.text}>Iniciando cámara...</Text>
      </View>
    );
  }

  if (!permiso.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>
          Necesitamos la cámara para leer el carnet.
        </Text>
        <TouchableOpacity style={styles.captureButton} onPress={pedirPermiso}>
          <Text style={styles.captureButtonText}>Permitir cámara</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
          <Text style={styles.closeButtonText}>Cancelar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={camaraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
      />

      {/* Overlay oscuro con el visor recortado */}
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.unfocusedContainer} pointerEvents="none" />
        <View style={styles.middleRow} pointerEvents="none">
          <View style={styles.unfocusedContainer} />
          <View style={styles.frame}>
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </View>
          <View style={styles.unfocusedContainer} />
        </View>
        <View style={styles.unfocusedContainer}>
          <Text style={styles.instructionText}>{mensaje}</Text>
          <TouchableOpacity
            style={[styles.captureButton, procesando && styles.buttonDisabled]}
            onPress={capturarYProcesar}
            disabled={procesando}
          >
            {procesando ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.captureButtonText}>Escanear Documento</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
    padding: 24,
  },
  text: { color: '#FFF', marginTop: 10, textAlign: 'center', marginBottom: 16 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  unfocusedContainer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  middleRow: { flexDirection: 'row', height: FRAME_HEIGHT },
  frame: {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    backgroundColor: 'transparent',
    borderColor: 'rgba(255,255,255,0.3)',
    borderWidth: 1,
    borderRadius: 12,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: '#00E676',
  },
  topLeft: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 },
  topRight: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 },
  bottomLeft: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 },
  bottomRight: { bottom: -2, right: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 12 },
  instructionText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 20,
  },
  captureButton: {
    backgroundColor: '#00C853',
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: 28,
    elevation: 3,
  },
  buttonDisabled: { backgroundColor: '#555' },
  captureButtonText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  closeButton: { marginTop: 16, padding: 8 },
  closeButtonText: { color: '#DDD', fontSize: 14 },
});

export default EscanerCarnet;
