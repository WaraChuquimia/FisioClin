import { Redirect, Tabs } from 'expo-router';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';

import BottomNavBar, { TabKey } from '@/components/barranavegacion';
import { useAuth } from '@/context/AuthContext';
import { useTema } from '@/context/TemaContext';

const ROUTE_BY_TAB: Record<TabKey, string> = {
  Inicio: 'index',
  Tratamiento: 'tratamiento',
  Ejercicios: 'ejercicios',
  Progreso: 'progreso',
  Perfil: 'perfil',
};

const TAB_BY_ROUTE: Record<string, TabKey> = {
  index: 'Inicio',
  tratamiento: 'Tratamiento',
  ejercicios: 'Ejercicios',
  // Rehabilitar ya no tiene botón propio: se llega desde Inicio y desde
  // Tratamiento, y se ve como parte de los ejercicios.
  rehabilitar: 'Ejercicios',
  progreso: 'Progreso',
  perfil: 'Perfil',
};

export default function TabLayout() {
  const { patient, loading } = useAuth();
  const { p } = useTema();

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.fondo }}><ActivityIndicator color={p.verde} /></View>;
  if (!patient) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: 'none' },
      }}
      tabBar={({ state, navigation }) => {
        const currentRoute = state.routes[state.index]?.name ?? 'index';
        const activeTab = TAB_BY_ROUTE[currentRoute] ?? 'Inicio';

        return (
          <BottomNavBar
            activeTab={activeTab}
            onTabPress={(tab: TabKey) => {
              const target = ROUTE_BY_TAB[tab];
              if (currentRoute !== target) navigation.navigate(target as never);
            }}
          />
        );
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Inicio' }} />
      <Tabs.Screen name="tratamiento" options={{ title: 'Tratamiento' }} />
      <Tabs.Screen name="ejercicios" options={{ title: 'Ejercicios' }} />
      <Tabs.Screen name="progreso" options={{ title: 'Progreso' }} />
      <Tabs.Screen name="perfil" options={{ title: 'Perfil' }} />
      <Tabs.Screen name="rehabilitar" options={{ href: null }} />
      <Tabs.Screen name="explore" options={{ href: null }} />
    </Tabs>
  );
}
