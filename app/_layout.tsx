import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { AuthProvider } from '@/context/AuthContext';
import { FotoPerfilProvider } from '@/context/FotoPerfilContext';
import { NotificacionesProvider } from '@/context/NotificacionesContext';
import { PALETA_CLARA, PALETA_OSCURA, TemaProvider, useTema } from '@/context/TemaContext';

export const unstable_settings = {
  initialRouteName: 'login',
};

// Los encabezados de navegación siguen el modo que el paciente eligió en
// Perfil, no el del sistema.
const TEMA_CLARO = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: PALETA_CLARA.fondo,
    card: PALETA_CLARA.superficie,
    text: PALETA_CLARA.texto,
    border: PALETA_CLARA.borde,
    primary: PALETA_CLARA.verde,
  },
};
const TEMA_OSCURO = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: PALETA_OSCURA.fondo,
    card: PALETA_OSCURA.superficie,
    text: PALETA_OSCURA.texto,
    border: PALETA_OSCURA.borde,
    primary: PALETA_OSCURA.verde,
  },
};

function Navegacion() {
  const { oscuro } = useTema();

  return (
    <ThemeProvider value={oscuro ? TEMA_OSCURO : TEMA_CLARO}>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="escaneo" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="notificaciones" options={{ headerShown: false }} />
        <Stack.Screen name="ejercicio" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style={oscuro ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <TemaProvider>
      <AuthProvider>
        <NotificacionesProvider>
          <FotoPerfilProvider>
            <Navegacion />
          </FotoPerfilProvider>
        </NotificacionesProvider>
      </AuthProvider>
    </TemaProvider>
  );
}
