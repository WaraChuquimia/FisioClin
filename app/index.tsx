import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuth } from '@/context/AuthContext';

export default function IndexScreen() {
  const { patient, loading } = useAuth();

  if (loading) {
    return <View style={styles.container}><ActivityIndicator color="#1E8A4C" /></View>;
  }

  return <Redirect href={patient ? '/(tabs)' : '/login'} />;
}

const styles = StyleSheet.create({ container: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
