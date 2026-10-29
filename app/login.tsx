import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { useAuth } from '@/context/AuthContext';

const LOGO = require('../assets/images/logo_cossmil.png');
const BG_IMAGE = require('../assets/images/rehabilitacion.jpg');

const PURPLE = '#16265C';
const GREEN = '#1E8A4C';
const GREEN_GRADIENT = [GREEN, GREEN] as const;

export default function LoginScreen() {
  const router = useRouter();
  const { signInByCarnet, error: authError } = useAuth();
  const { width, height } = useWindowDimensions();

  const [carnet, setCarnet] = useState('');
  const [focused, setFocused] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const inputRef = React.useRef<TextInput | null>(null);

  const isLandscape = width > height;
  const isCompact = height < 700 || width < 380;

  const logoSize = Math.min(width * 0.38, 170);
  const titleSize = Math.min(width * 0.085, 34);
  const subtitleFontSize = isCompact ? 14 : 15;
  const cardPadding = isCompact ? 18 : 22;
  const inputHeight = isCompact ? 50 : 54;
  const buttonHeight = isCompact ? 52 : 56;

  const handleLogin = async () => {
    if (!carnet.trim()) {
      Alert.alert(
        'Campo incompleto',
        'Introduzca su número de carnet para continuar.'
      );
      return;
    }

    setLoggingIn(true);
    const result = await signInByCarnet(carnet);
    setLoggingIn(false);

    if (!result.error) {
      router.replace('/(tabs)');
    } else {
      Alert.alert(
        'No pudimos verificar sus datos',
        'El número de carnet no está registrado. Si el problema persiste, por favor comuníquese con su médico o con el personal de COSSMIL para verificar sus datos.'
      );
    }
  };

  return (
    <ImageBackground source={BG_IMAGE} style={styles.container} resizeMode="cover">
      <LinearGradient
        colors={['rgba(248,249,253,0.55)', 'rgba(245,247,252,0.7)', 'rgba(20,20,30,0.75)']}
        locations={[0, 0.45, 1]}
        style={styles.overlay}
      >
        <StatusBar barStyle="dark-content" />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={[styles.scrollContent, isLandscape && styles.scrollContentLandscape]}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.hero, { paddingTop: isLandscape ? 20 : Platform.OS === 'ios' ? 72 : 48 }]}>
              <Image source={LOGO} style={[styles.logo, { width: logoSize, height: logoSize }]} resizeMode="contain" />

              <Text style={[styles.title, { fontSize: titleSize }]}>¡Bienvenido!</Text>
              <Text style={[styles.titleAccent, { fontSize: titleSize }]}>a FisioClin!</Text>
              <View style={styles.underline} />
              <Text style={[styles.subtitle, { fontSize: subtitleFontSize }]}>
                Cada pequeño movimiento{"\n"}te acerca a una vida mejor.
              </Text>
            </View>

            <View style={[styles.card, { padding: cardPadding, maxWidth: Math.min(width - 32, 480) }, isLandscape && styles.cardLandscape]}>
              <View style={[styles.inputBorder, focused && styles.inputBorderFocused]} onTouchStart={() => inputRef.current?.focus?.()}>
                  <View style={[styles.inputWrapper, { height: inputHeight }]}>
                    <Ionicons name="card-outline" size={20} color={focused ? PURPLE : '#393d42'} style={styles.inputIcon} />
                    <TextInput
                      ref={inputRef}
                      style={styles.input}
                      placeholder="Nº de carnet (ej: 7000001)"
                      placeholderTextColor="#b5b5b5"
                      value={carnet}
                      onChangeText={setCarnet}
                      autoCapitalize="characters"
                      onFocus={() => setFocused(true)}
                      onBlur={() => setFocused(false)}
                      returnKeyType="done"
                      onSubmitEditing={handleLogin}
                      editable={!loggingIn}
                      maxLength={20}
                    />
                  </View>
              </View>

              {authError ? <Text style={styles.errorText}>{authError}</Text> : null}

              <TouchableOpacity activeOpacity={0.9} onPress={handleLogin} disabled={loggingIn}>
                <LinearGradient
                  colors={GREEN_GRADIENT}
                  style={[styles.button, { height: buttonHeight }, loggingIn && styles.buttonDisabled]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                >
                  {loggingIn ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Text style={styles.buttonText}>Iniciar Sesion</Text>
                      <Ionicons name="arrow-forward-outline" size={18} color="#fff" style={styles.buttonIcon} />
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>

            <View style={[styles.footerWrap, isLandscape && styles.footerWrapLandscape]}>
              <Text style={styles.footerText}>Dirección Nacional de Sistemas</Text>
              <Text style={styles.footerBrand}>COSSMIL</Text>
              <Text style={styles.footerYear}>2026</Text>
              <Text style={styles.footerVersion}>v1.0.1</Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </LinearGradient>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  overlay: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'space-between',
    paddingBottom: 20,
  },
  scrollContentLandscape: {
    justifyContent: 'center',
    paddingVertical: 12,
  },
  hero: {
    paddingHorizontal: 24,
    alignItems: 'center',
    width: '100%',
  },
  logo: { marginBottom: 14 },
  title: { fontWeight: '800', color: PURPLE },
  titleAccent: { fontWeight: '800', color: PURPLE, marginTop: 2 },
  underline: { width: 56, height: 4, borderRadius: 2, backgroundColor: PURPLE, marginVertical: 10 },
  subtitle: { color: '#374151', textAlign: 'center', lineHeight: 22, maxWidth: 340 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.85)',
    marginHorizontal: 20,
    borderRadius: 18,
    padding: 22,
    paddingTop: 26,
    marginTop: 14,
    borderWidth: 1,
    borderColor: 'rgba(107,91,222,0.15)',
    alignSelf: 'center',
    width: '100%',
  },
  cardLandscape: { marginTop: 10, paddingVertical: 16 },
  inputBorder: { width: '100%', borderRadius: 14, padding: 2, marginBottom: 18, borderColor: 'rgba(107,91,222,0.2)', borderWidth: 1 },
  inputBorderFocused: { borderColor: PURPLE, shadowColor: PURPLE, shadowOpacity: 0.3, shadowRadius: 8 },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 12, paddingHorizontal: 14, height: 54, paddingVertical: 8 },
  inputIcon: { marginRight: 12 },
  input: { flex: 1, color: '#1f2937', fontSize: 16, paddingVertical: 0, paddingHorizontal: 4 },
  errorText: { color: '#b91c1c', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  button: { width: '100%', height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', marginTop: 6 },
  buttonDisabled: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  buttonIcon: { position: 'absolute', right: 18 },
  footerWrap: { alignItems: 'center', marginTop: 20, paddingBottom: Platform.OS === 'ios' ? 24 : 16 },
  footerWrapLandscape: { marginTop: 12, paddingBottom: 8 },
  footerText: { color: '#e5e7eb', fontSize: 12 },
  footerBrand: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 1, marginTop: 6 },
  footerYear: { color: '#e5e7eb', fontSize: 12, marginTop: 4 },
  footerVersion: { color: '#fff', fontSize: 11, marginTop: 4 },
});