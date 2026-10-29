import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { crearEstilos, useTema } from '@/context/TemaContext';

export const COLORS = {
  azulOscuro: '#16265C',
  verde: '#1E8A4C',
  verdeClaro: '#E7F5EC',
  blanco: '#FFFFFF',
  grisClaro: '#EDEFF2',
  grisOscuro: '#4A4A4A',
  grisTexto: '#8A8F98',
};

export type TabKey = 'Inicio' | 'Tratamiento' | 'Ejercicios' | 'Progreso' | 'Perfil';

type TabItem = {
  key: TabKey;
  label: string;
  icon: (color: string) => React.ReactNode;
};

const TABS: TabItem[] = [
  {
    key: 'Inicio',
    label: 'Inicio',
    icon: (color) => <Ionicons name="home-outline" size={24} color={color} />,
  },
  {
    key: 'Tratamiento',
    label: 'Tratamiento',
    icon: (color) => <Ionicons name="medkit-outline" size={24} color={color} />,
  },
  {
    key: 'Ejercicios',
    label: 'Ejercicios',
    icon: (color) => <MaterialCommunityIcons name="dumbbell" size={24} color={color} />,
  },
  {
    key: 'Progreso',
    label: 'Progreso',
    icon: (color) => <Ionicons name="analytics-outline" size={24} color={color} />,
  },
  {
    key: 'Perfil',
    label: 'Perfil',
    icon: (color) => <Ionicons name="person-outline" size={24} color={color} />,
  },
];

interface BottomNavBarProps {
  activeTab: TabKey;
  onTabPress: (tab: TabKey) => void;
}

export default function BottomNavBar({ activeTab, onTabPress }: BottomNavBarProps) {
  const { p } = useTema();
  const styles = useEstilos();

  return (
    <View style={styles.container}>
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        const color = isActive ? p.verdeTexto : p.textoTenue;

        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tabButton}
            onPress={() => onTabPress(tab.key)}
            activeOpacity={0.7}
          >
            <View style={[styles.iconWrapper, isActive && styles.iconWrapperActive]}>
              {tab.icon(color)}
            </View>
            <Text style={[styles.label, isActive && styles.labelActive]} numberOfLines={1} adjustsFontSizeToFit>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const useEstilos = crearEstilos((p, oscuro) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: p.superficie,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
    borderTopWidth: 1,
    borderTopColor: p.borde,
    shadowColor: '#000',
    shadowOpacity: oscuro ? 0.25 : 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -3 },
    elevation: 6,
  },
  tabButton: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  iconWrapper: {
    width: 44,
    height: 32,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  iconWrapperActive: {
    backgroundColor: p.verdeSuave,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: p.textoTenue,
  },
  labelActive: {
    color: p.verdeTexto,
    fontWeight: '700',
  },
}));
