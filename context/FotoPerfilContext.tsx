import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { useAuth } from '@/context/AuthContext';
import { quitarFotoPerfil, subirFotoPerfil, urlFotoPerfil } from '@/lib/fotoPerfilData';

/* ══════════════════════════════════════════════════════════════════
   Foto de perfil del paciente.

   Vive en Supabase (depósito `avatares`, ruta en
   pacientes.foto_rostro_path), así que el médico la ve en su panel y el
   paciente la conserva si cambia de teléfono. Perfil la cambia; Inicio y
   Perfil la muestran.
   ══════════════════════════════════════════════════════════════════ */

const LADO_PX = 512;

type FotoPerfilValue = {
  /** Enlace para mostrar la foto, o null si no tiene. */
  url: string | null;
  subiendo: boolean;
  cambiarFoto: (origen: 'camara' | 'galeria') => Promise<void>;
  quitarFoto: () => Promise<void>;
};

const FotoPerfilContext = createContext<FotoPerfilValue | undefined>(undefined);

export function FotoPerfilProvider({ children }: { children: React.ReactNode }) {
  const { patient, refreshPatient } = useAuth();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;
  const ruta = typeof patient?.foto_rostro_path === 'string' ? patient.foto_rostro_path : null;

  // El enlace se guarda junto a la ruta de la que salió: si la ruta cambia
  // (otra foto, otro paciente), el enlace viejo deja de usarse solo.
  const [enlace, setEnlace] = useState<{ ruta: string; url: string } | null>(null);
  const [subiendo, setSubiendo] = useState(false);

  useEffect(() => {
    if (!ruta || enlace?.ruta === ruta) return;
    let vigente = true;
    urlFotoPerfil(ruta).then((url) => {
      if (vigente && url) setEnlace({ ruta, url });
    });
    return () => {
      vigente = false;
    };
  }, [ruta, enlace?.ruta]);

  const url = ruta && enlace?.ruta === ruta ? enlace.url : null;

  const cambiarFoto = useCallback(
    async (origen: 'camara' | 'galeria') => {
      if (idPaciente == null) return;

      const permiso =
        origen === 'camara'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permiso.granted) {
        Alert.alert(
          'Necesitamos permiso',
          origen === 'camara'
            ? 'Permite el uso de la cámara para tomar tu foto de perfil.'
            : 'Permite el acceso a tus fotos para elegir tu foto de perfil.'
        );
        return;
      }

      const opciones: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      };
      const resultado =
        origen === 'camara'
          ? await ImagePicker.launchCameraAsync(opciones)
          : await ImagePicker.launchImageLibraryAsync(opciones);
      if (resultado.canceled || !resultado.assets[0]) return;

      setSubiendo(true);
      try {
        // Cuadrada y chica: una foto de perfil no necesita los ~8 MB del sensor.
        const reducida = await manipulateAsync(
          resultado.assets[0].uri,
          [{ resize: { width: LADO_PX } }],
          { compress: 0.8, format: SaveFormat.JPEG, base64: true }
        );
        if (!reducida.base64) throw new Error('No se pudo preparar la foto.');

        const nuevaRuta = await subirFotoPerfil(idPaciente, reducida.base64);
        // Se muestra al instante la imagen local mientras llega la ficha nueva.
        setEnlace({ ruta: nuevaRuta, url: reducida.uri });
        await refreshPatient();
      } catch (e) {
        Alert.alert(
          'No se pudo cambiar la foto',
          e instanceof Error ? e.message : 'Revisa tu conexión e inténtalo de nuevo.'
        );
      } finally {
        setSubiendo(false);
      }
    },
    [idPaciente, refreshPatient]
  );

  const quitarFoto = useCallback(async () => {
    if (idPaciente == null) return;
    setSubiendo(true);
    try {
      await quitarFotoPerfil(idPaciente);
      setEnlace(null);
      await refreshPatient();
    } catch (e) {
      Alert.alert('No se pudo quitar la foto', e instanceof Error ? e.message : 'Inténtalo de nuevo.');
    } finally {
      setSubiendo(false);
    }
  }, [idPaciente, refreshPatient]);

  return (
    <FotoPerfilContext.Provider value={{ url, subiendo, cambiarFoto, quitarFoto }}>
      {children}
    </FotoPerfilContext.Provider>
  );
}

export function useFotoPerfil() {
  const ctx = useContext(FotoPerfilContext);
  if (!ctx) throw new Error('useFotoPerfil debe usarse dentro de FotoPerfilProvider');
  return ctx;
}
