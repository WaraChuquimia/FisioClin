import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export type Patient = Record<string, unknown>;

const SESION_STORAGE_KEY = 'fisioclin.paciente.sesion';

type AuthContextValue = {
  patient: Patient | null;
  loading: boolean;
  error: string | null;
  signInByCarnet: (carnet: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshPatient: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function getErrorMessage(error: unknown) {
  const message = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message)
    : error instanceof Error ? error.message : 'Ocurrió un error inesperado.';
  if (message.toLowerCase().includes('invalid api key')) {
    return 'La clave de Supabase no es válida. Reemplázala en el archivo .env y reinicia Expo.';
  }
  return message;
}

function normalizarCarnet(carnet: string) {
  return carnet.trim().replace(/\s+/g, '');
}

async function buscarPacientePorCarnet(carnet: string) {
  const { data, error } = await supabase.rpc('buscar_paciente_por_carnet', {
    p_carnet: normalizarCarnet(carnet),
  });
  const patient = Array.isArray(data) ? data[0] : data;
  return { patient: (patient ?? null) as Patient | null, error };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [patient, setPatient] = useState<Patient | null>(null);
  // Ya no hay sesión que recuperar al abrir: se deja por compatibilidad.
  const loading = false;
  const [error, setError] = useState<string | null>(null);

  // La app SIEMPRE empieza en el login: cada vez que se abre, el paciente
  // vuelve a ingresar su carnet. Por eso la sesión ya no se guarda en el
  // teléfono, y la que dejaron versiones anteriores se borra.
  useEffect(() => {
    void AsyncStorage.removeItem(SESION_STORAGE_KEY);
  }, []);

  const signInByCarnet = async (carnet: string) => {
    setError(null);

    const { patient: found, error: patientError } = await buscarPacientePorCarnet(carnet);

    if (patientError || !found) {
      const message = patientError
        ? getErrorMessage(patientError)
        : 'No encontramos un paciente con ese número de carnet.';
      setError(message);
      return { error: message };
    }

    setPatient(found);
    return { error: null };
  };

  const refreshPatient = async () => {
    const carnetActual = patient?.numero_carnet_normalizado ?? patient?.numero_carnet;
    if (typeof carnetActual !== 'string') return;

    const { patient: found, error: patientError } = await buscarPacientePorCarnet(carnetActual);
    if (patientError) {
      setError(getErrorMessage(patientError));
      return;
    }
    setPatient(found);
  };

  const signOut = async () => {
    await AsyncStorage.removeItem(SESION_STORAGE_KEY);
    setPatient(null);
    setError(null);
  };

  return (
    <AuthContext.Provider
      value={{
        patient,
        loading,
        error,
        signInByCarnet,
        signOut,
        refreshPatient,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
