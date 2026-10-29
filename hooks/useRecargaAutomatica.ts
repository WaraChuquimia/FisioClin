import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { AppState } from 'react-native';

import { useNotificaciones } from '@/context/NotificacionesContext';

/**
 * Mantiene al día una pantalla que muestra la rutina del paciente:
 * recarga al entrar a la pantalla, cada `intervaloMs` mientras está a la
 * vista y en cuanto llega un aviso de nueva prescripción del médico.
 * `cargar` debe ser estable (useCallback).
 */
export function useRecargaAutomatica(cargar: () => unknown, intervaloMs = 30_000) {
  const { cambiosRutina } = useNotificaciones();

  useFocusEffect(
    useCallback(() => {
      void cargar();
      const id = setInterval(() => {
        if (AppState.currentState === 'active') void cargar();
      }, intervaloMs);
      return () => clearInterval(id);
      // cambiosRutina no se lee: está para que un aviso nuevo dispare la recarga.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cargar, intervaloMs, cambiosRutina])
  );
}
