/* ==================================================================
   FisioClin — alta de paciente con lectura del carnet
   ==================================================================

   Equivalente al `RegisterScreen` original, con dos diferencias que
   importan:

   1. Los campos son editables. En el boceto tenían `value` pero no
      `onChangeText`, lo que en React Native los congela: si el OCR se
      comía una letra de un apellido, no había forma de corregirlo.

   2. El escaneo rellena los campos sin pisar lo que ya estuviera
      escrito a mano. Antes hacía `setFormData(data)` y borraba todo.

   Guardar es a propósito lo único que queda por conectar: hay que
   decidir antes si la ficha va a Supabase o se queda en el teléfono,
   y si se cifra. Ver la nota del final.
   ================================================================== */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EscanerCarnet } from '@/components/escanercarnet';
import {
  DatosDocumentoBolivia,
  datosSuficientes,
} from '@/lib/carnet/ciBoliviaParser';

const COLORS = {
  azulOscuro: '#16265C',
  verde: '#1E8A4C',
  blanco: '#FFFFFF',
  grisClaro: '#EDEFF2',
  grisOscuro: '#4A4A4A',
  grisTexto: '#8A8F98',
  verdeClaro: '#E7F5EC',
};

const VACIO: DatosDocumentoBolivia = {
  ci: '',
  nombres: '',
  apellidoPaterno: '',
  apellidoMaterno: '',
  fechaNacimiento: '',
  fotoRostroBase64: '',
};

type CampoTexto = Exclude<keyof DatosDocumentoBolivia, 'fotoRostroBase64'>;

const CAMPOS: { clave: CampoTexto; etiqueta: string; placeholder: string }[] = [
  { clave: 'ci', etiqueta: 'Nº Cédula de Identidad', placeholder: 'Ej. 10805213' },
  { clave: 'nombres', etiqueta: 'Nombres', placeholder: 'Nombres' },
  { clave: 'apellidoPaterno', etiqueta: 'Apellido Paterno', placeholder: 'Primer apellido' },
  { clave: 'apellidoMaterno', etiqueta: 'Apellido Materno', placeholder: 'Segundo apellido' },
];

export default function RegistroScreen() {
  const router = useRouter();
  const [escanerAbierto, setEscanerAbierto] = useState(false);
  const [datos, setDatos] = useState<DatosDocumentoBolivia>(VACIO);

  const cambiar = (clave: CampoTexto, valor: string) =>
    setDatos((previo) => ({ ...previo, [clave]: valor }));

  const alEscanear = (leido: DatosDocumentoBolivia) => {
    // El escaneo completa huecos; no borra lo que el usuario escribió.
    setDatos((previo) => ({
      ci: leido.ci || previo.ci,
      nombres: leido.nombres || previo.nombres,
      apellidoPaterno: leido.apellidoPaterno || previo.apellidoPaterno,
      apellidoMaterno: leido.apellidoMaterno || previo.apellidoMaterno,
      fechaNacimiento: leido.fechaNacimiento || previo.fechaNacimiento,
      fotoRostroBase64: leido.fotoRostroBase64 || previo.fotoRostroBase64,
    }));
    setEscanerAbierto(false);
  };

  if (escanerAbierto) {
    return (
      <EscanerCarnet
        onScanComplete={alEscanear}
        onClose={() => setEscanerAbierto(false)}
      />
    );
  }

  const listo = datosSuficientes(datos);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.iconButton}
              activeOpacity={0.7}
              onPress={() => router.back()}
            >
              <Ionicons name="chevron-back" size={24} color={COLORS.azulOscuro} />
            </TouchableOpacity>
            <Text style={styles.titulo}>Registro de paciente</Text>
          </View>

          <TouchableOpacity
            style={styles.botonEscanear}
            activeOpacity={0.85}
            onPress={() => setEscanerAbierto(true)}
          >
            <Ionicons name="scan-outline" size={20} color={COLORS.blanco} />
            <Text style={styles.botonEscanearTexto}>
              Escanear carnet de identidad
            </Text>
          </TouchableOpacity>

          <Text style={styles.ayuda}>
            Revisa siempre los datos leídos antes de guardar. Puedes
            corregir cualquier campo a mano.
          </Text>

          {CAMPOS.map(({ clave, etiqueta, placeholder }) => (
            <View key={clave}>
              <Text style={styles.label}>{etiqueta}</Text>
              <TextInput
                style={styles.input}
                value={datos[clave]}
                onChangeText={(t) => cambiar(clave, t)}
                placeholder={placeholder}
                placeholderTextColor={COLORS.grisTexto}
                keyboardType={clave === 'ci' ? 'number-pad' : 'default'}
                autoCapitalize={clave === 'ci' ? 'none' : 'characters'}
              />
            </View>
          ))}

          <TouchableOpacity
            style={[styles.botonGuardar, !listo && styles.botonDeshabilitado]}
            activeOpacity={0.85}
            disabled={!listo}
            onPress={() => {
              // TODO: conectar con el destino que decidas (Supabase o
              // almacenamiento local cifrado). Ver la nota de arriba.
              console.log('[registro] datos listos para guardar:', datos);
            }}
          >
            <Text style={styles.botonGuardarTexto}>Guardar paciente</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.blanco },
  flex: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 48 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.grisClaro,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titulo: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.azulOscuro,
    marginLeft: 12,
  },
  botonEscanear: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.azulOscuro,
    paddingVertical: 14,
    borderRadius: 12,
  },
  botonEscanearTexto: { color: COLORS.blanco, fontSize: 15, fontWeight: '700' },
  ayuda: {
    fontSize: 12,
    color: COLORS.grisTexto,
    marginTop: 12,
    marginBottom: 4,
    lineHeight: 17,
  },
  label: { fontSize: 13, color: COLORS.grisOscuro, marginTop: 14 },
  input: {
    borderWidth: 1,
    borderColor: COLORS.grisClaro,
    backgroundColor: COLORS.blanco,
    color: COLORS.azulOscuro,
    padding: 12,
    borderRadius: 8,
    marginTop: 6,
    fontSize: 15,
  },
  botonGuardar: {
    backgroundColor: COLORS.verde,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 28,
  },
  botonDeshabilitado: { backgroundColor: COLORS.grisClaro },
  botonGuardarTexto: { color: COLORS.blanco, fontSize: 16, fontWeight: '700' },
});
