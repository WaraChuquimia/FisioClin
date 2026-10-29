import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import { useAuth } from '@/context/AuthContext';
import {
  marcarNotificacionesLeidas,
  Notificacion,
  obtenerNotificaciones,
} from '@/lib/notificacionesData';

/* ══════════════════════════════════════════════════════════════════
   Avisos que envía el médico desde el panel (tabla `notificaciones`).

   Con el interruptor de Perfil encendido, la app consulta cada
   INTERVALO_MS mientras está abierta y, si llega un aviso nuevo, lo
   muestra en pantalla. Apagado, no consulta ni avisa, y la campana de
   Inicio no muestra contador.

   Son avisos dentro de la app: con la app cerrada no suena nada. Para
   eso haría falta push real (expo-notifications + un build propio, no
   funciona en Expo Go).
   ══════════════════════════════════════════════════════════════════ */

const CLAVE_ACTIVAS = 'fisioclin.preferencias.notificaciones';
const INTERVALO_MS = 30_000;

type NotificacionesValue = {
  activas: boolean;
  setActivas: (v: boolean) => void;
  lista: Notificacion[];
  sinLeer: number;
  cargando: boolean;
  /** Sube cada vez que llega un aviso de nueva prescripción: las pantallas
   *  de la rutina lo escuchan para recargarse (useRecargaAutomatica). */
  cambiosRutina: number;
  recargar: () => Promise<void>;
  marcarTodasLeidas: () => Promise<void>;
};

const NotificacionesContext = createContext<NotificacionesValue | undefined>(undefined);

export function NotificacionesProvider({ children }: { children: React.ReactNode }) {
  const { patient } = useAuth();
  const idPaciente = typeof patient?.id_paciente === 'number' ? patient.id_paciente : null;

  const [activas, setActivasState] = useState(true);
  // La lista se guarda junto al paciente al que pertenece: al cambiar de
  // sesión, lo del paciente anterior deja de mostrarse sin tener que borrarlo.
  const [datos, setDatos] = useState<{ idPaciente: number | null; lista: Notificacion[] }>({
    idPaciente: null,
    lista: [],
  });
  const lista = datos.idPaciente === idPaciente ? datos.lista : [];
  const [cargando, setCargando] = useState(false);
  const [cambiosRutina, setCambiosRutina] = useState(0);
  // Mayor id ya visto por paciente: lo que llegue por encima es "nuevo" y
  // se avisa. Sin entrada = todavía no hubo primera carga (esa no avisa).
  const ultimoIdVisto = useRef(new Map<number, number>());

  useEffect(() => {
    AsyncStorage.getItem(CLAVE_ACTIVAS)
      .then((v) => {
        if (v === '0') setActivasState(false);
      })
      .catch(() => {});
  }, []);

  const setActivas = (v: boolean) => {
    setActivasState(v);
    AsyncStorage.setItem(CLAVE_ACTIVAS, v ? '1' : '0').catch(() => {});
  };

  /** Consulta la base y avisa de lo nuevo. Solo toca estado después del await. */
  const consultar = useCallback(async () => {
    if (idPaciente == null) return;
    try {
      const nuevas = await obtenerNotificaciones(idPaciente);
      const maxId = nuevas.reduce((m, n) => Math.max(m, n.id_notificacion), 0);
      const visto = ultimoIdVisto.current.get(idPaciente);

      if (visto != null) {
        const recientes = nuevas.filter((n) => !n.leida && n.id_notificacion > visto);
        if (recientes.some((n) => n.categoria === 'prescripcion')) {
          setCambiosRutina((c) => c + 1);
        }
        if (recientes.length === 1) {
          Alert.alert(recientes[0].titulo, recientes[0].mensaje);
        } else if (recientes.length > 1) {
          Alert.alert(
            'Tienes avisos nuevos de tu médico',
            `Llegaron ${recientes.length} avisos. Míralos en la campana de Inicio.`
          );
        }
      }
      ultimoIdVisto.current.set(idPaciente, Math.max(visto ?? 0, maxId));
      setDatos({ idPaciente, lista: nuevas });
    } catch {
      // Sin red: se reintenta en la siguiente vuelta.
    }
  }, [idPaciente]);

  /** Recarga manual (deslizar hacia abajo): muestra el indicador. */
  const recargar = useCallback(async () => {
    setCargando(true);
    await consultar();
    setCargando(false);
  }, [consultar]);

  useEffect(() => {
    if (!activas || idPaciente == null) return;

    const primera = setTimeout(() => void consultar(), 0);
    const intervalo = setInterval(() => {
      if (AppState.currentState === 'active') void consultar();
    }, INTERVALO_MS);
    const sub = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') void consultar();
    });

    return () => {
      clearTimeout(primera);
      clearInterval(intervalo);
      sub.remove();
    };
  }, [activas, idPaciente, consultar]);

  const marcarTodasLeidas = useCallback(async () => {
    if (idPaciente == null) return;
    setDatos((prev) => ({ ...prev, lista: prev.lista.map((n) => ({ ...n, leida: true })) }));
    try {
      await marcarNotificacionesLeidas(idPaciente);
    } catch {
      void recargar();
    }
  }, [idPaciente, recargar]);

  const sinLeer = activas ? lista.filter((n) => !n.leida).length : 0;

  return (
    <NotificacionesContext.Provider
      value={{ activas, setActivas, lista, sinLeer, cargando, cambiosRutina, recargar, marcarTodasLeidas }}
    >
      {children}
    </NotificacionesContext.Provider>
  );
}

export function useNotificaciones() {
  const ctx = useContext(NotificacionesContext);
  if (!ctx) throw new Error('useNotificaciones debe usarse dentro de NotificacionesProvider');
  return ctx;
}
