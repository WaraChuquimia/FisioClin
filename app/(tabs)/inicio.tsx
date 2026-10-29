import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  ImageSourcePropType,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { crearEstilos, Paleta } from '@/context/TemaContext';
import { SafeAreaView } from 'react-native-safe-area-context';

/* ══════════════════════════════════════════════════════════════════
   PALETA
   ══════════════════════════════════════════════════════════════════ */

/** Paleta clara original de Inicio. Los datos de ejemplo (consejos) guardan
 *  estos colores; en modo oscuro se traducen con `tono()`. */
const C_CLARO = {
  verde: '#1E7A34',
  verdeOscuro: '#155C27',
  verdeClaro: '#E7F3EA',
  verdeTexto: '#1E7A34',
  azul: '#1560C4',
  azulClaro: '#E8F0FC',
  fondo: '#F4F6F5',
  blanco: '#FFFFFF',
  texto: '#16241C',
  textoSuave: '#5F6D66',
  borde: '#E4EAE6',
  naranja: '#C2740B',
  naranjaClaro: '#FDF1DF',
  rojo: '#C0392B',
  rojoClaro: '#FDECEA',
  morado: '#6B4FBB',
  moradoClaro: '#F0ECFB',
  cyan: '#0E7C8A',
  cyanClaro: '#E4F4F6',
};

/** Colores de Inicio: en claro, exactamente los de siempre; en oscuro, los del tema. */
const coloresDe = (p: Paleta, oscuro: boolean) => ({
  verde: oscuro ? p.verde : C_CLARO.verde,
  verdeOscuro: oscuro ? p.verdeOscuro : C_CLARO.verdeOscuro,
  verdeClaro: oscuro ? p.verdeSuave : C_CLARO.verdeClaro,
  verdeTexto: oscuro ? p.verdeTexto : C_CLARO.verdeTexto,
  azul: oscuro ? p.azul : C_CLARO.azul,
  /** Azul como fondo de franjas: el mismo en ambos modos. */
  azulFondo: C_CLARO.azul,
  azulClaro: oscuro ? p.azulSuave : C_CLARO.azulClaro,
  fondo: oscuro ? p.fondo : C_CLARO.fondo,
  blanco: C_CLARO.blanco,
  superficie: p.superficie,
  superficieAlt: oscuro ? p.superficieAlt : '#F3F7F4',
  texto: oscuro ? p.texto : C_CLARO.texto,
  textoSuave: oscuro ? p.textoSuave : C_CLARO.textoSuave,
  borde: oscuro ? p.borde : C_CLARO.borde,
  divisor: oscuro ? p.borde : '#E5EBE7',
  pista: oscuro ? p.pista : '#DCE5DF',
  punto: oscuro ? p.pista : '#CBD8CF',
  heroVacio: oscuro ? p.superficieAlt : '#DDE7E0',
  naranja: oscuro ? p.ambar : C_CLARO.naranja,
  naranjaClaro: oscuro ? p.ambarSuave : C_CLARO.naranjaClaro,
  rojo: oscuro ? p.rojo : C_CLARO.rojo,
  rojoClaro: oscuro ? p.rojoSuave : C_CLARO.rojoClaro,
  alertaBorde: oscuro ? '#5A2A26' : '#F5D3CE',
  alertaTitulo: oscuro ? '#F4A59E' : '#7E2A20',
  alertaDesc: oscuro ? '#D9A39C' : '#8A4238',
  morado: oscuro ? p.morado : C_CLARO.morado,
  moradoClaro: oscuro ? p.moradoSuave : C_CLARO.moradoClaro,
  cyan: oscuro ? p.cyan : C_CLARO.cyan,
  cyanClaro: oscuro ? p.cyanSuave : C_CLARO.cyanClaro,
  pie: oscuro ? p.textoTenue : '#9AA8A0',
});

/** Traduce un color de C_CLARO (p. ej. el de un consejo) al del modo activo. */
const traductorDe = (c: ReturnType<typeof coloresDe>) => {
  const mapa = new Map<string, string>();
  (Object.keys(C_CLARO) as (keyof typeof C_CLARO)[]).forEach((k) => {
    if (k in c) mapa.set(C_CLARO[k], c[k as keyof typeof c]);
  });
  return (color: string) => mapa.get(color) ?? color;
};


/* ══════════════════════════════════════════════════════════════════
   TIPOS
   ══════════════════════════════════════════════════════════════════ */

export type Ejercicio = {
  id: string;
  nombre: string;
  zona: string;
  series: number;
  repeticiones: number;
  completado?: boolean;
  imagen?: ImageSourcePropType;
};

export type Consejo = {
  id: string;
  categoria: string;
  titulo: string;
  descripcion: string;
  icono: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  color: string;
  colorFondo: string;
};

export type DiaProgreso = { dia: string; valor: number }; // valor entre 0 y 1

export type Tratamiento = {
  objetivo: string;
  medicoResponsable: string;
  duracionSemanas: number;
  fechaFinEstimada: string;
  estado: string;
};

type Props = {
  nombrePaciente?: string;
  avatar?: ImageSourcePropType;
  imagenHero?: ImageSourcePropType;
  ejercicios?: Ejercicio[];
  consejos?: Consejo[];
  progresoSemanal?: DiaProgreso[];
  minutosSesion?: number;
  notificaciones?: number;
  tratamiento?: Tratamiento | null;
  onComenzarSesion?: () => void;
  onVerEjercicio?: (e: Ejercicio) => void;
  onVerTodos?: () => void;
  onConsejo?: (c: Consejo) => void;
  onContactar?: () => void;
  onNotificaciones?: () => void;
  onPerfil?: () => void;
};

/* ══════════════════════════════════════════════════════════════════
   DATOS POR DEFECTO (reemplázalos por los de tu backend)
   ══════════════════════════════════════════════════════════════════ */

export const EJERCICIOS_DEMO: Ejercicio[] = [
  { id: '1', nombre: 'Elevación de pierna', zona: 'Cadera', series: 3, repeticiones: 10, completado: true },
  { id: '2', nombre: 'Flexión de rodilla', zona: 'Rodilla', series: 3, repeticiones: 12 },
  { id: '3', nombre: 'Estiramiento isquiotibial', zona: 'Pierna', series: 2, repeticiones: 8 },
  { id: '4', nombre: 'Marcha asistida', zona: 'Equilibrio', series: 2, repeticiones: 15 },
];

export const CONSEJOS_DEMO: Consejo[] = [
  {
    id: 'c1',
    categoria: 'Hidratación',
    titulo: 'Toma agua antes y después',
    descripcion:
      'Un vaso de agua 15 minutos antes de tu sesión y otro al terminar ayuda a tus músculos a recuperarse.',
    icono: 'water-outline',
    color: C_CLARO.azul,
    colorFondo: C_CLARO.azulClaro,
  },
  {
    id: 'c2',
    categoria: 'Calentamiento',
    titulo: 'Nunca empieces en frío',
    descripcion:
      'Camina o mueve suavemente la articulación durante 5 minutos antes del primer ejercicio.',
    icono: 'run-fast',
    color: C_CLARO.naranja,
    colorFondo: C_CLARO.naranjaClaro,
  },
  {
    id: 'c3',
    categoria: 'Dolor',
    titulo: 'Escucha a tu cuerpo',
    descripcion:
      'Una molestia leve es normal. Si el dolor pasa de 4 sobre 10 o es punzante, detente y avisa a tu fisioterapeuta.',
    icono: 'alert-decagram-outline',
    color: C_CLARO.rojo,
    colorFondo: C_CLARO.rojoClaro,
  },
  {
    id: 'c4',
    categoria: 'Postura',
    titulo: 'Espalda apoyada, hombros sueltos',
    descripcion:
      'Siéntate con la espalda recta y los pies apoyados en el piso. Una buena postura evita compensaciones.',
    icono: 'human-handsup',
    color: C_CLARO.morado,
    colorFondo: C_CLARO.moradoClaro,
  },
  {
    id: 'c5',
    categoria: 'Descanso',
    titulo: 'Duerme de 7 a 8 horas',
    descripcion:
      'El tejido se repara mientras duermes. Un buen descanso acelera tu recuperación más que entrenar de más.',
    icono: 'sleep',
    color: C_CLARO.cyan,
    colorFondo: C_CLARO.cyanClaro,
  },
  {
    id: 'c6',
    categoria: 'Constancia',
    titulo: 'Mejor poco, pero todos los días',
    descripcion:
      '15 minutos diarios rinden más que una sesión larga a la semana. La constancia es tu mejor medicina.',
    icono: 'calendar-check-outline',
    color: C_CLARO.verde,
    colorFondo: C_CLARO.verdeClaro,
  },
  {
    id: 'c7',
    categoria: 'Alimentación',
    titulo: 'Proteína en cada comida',
    descripcion:
      'Huevo, leche, pollo, pescado o legumbres ayudan a reconstruir el músculo que trabajas en tus ejercicios.',
    icono: 'food-apple-outline',
    color: C_CLARO.naranja,
    colorFondo: C_CLARO.naranjaClaro,
  },
  {
    id: 'c8',
    categoria: 'Postura',
    titulo: 'Muévete cada hora',
    descripcion:
      'Si pasas mucho tiempo sentado, levántate y camina un par de minutos cada hora. La articulación lo agradece.',
    icono: 'walk',
    color: C_CLARO.azul,
    colorFondo: C_CLARO.azulClaro,
  },
  {
    id: 'c9',
    categoria: 'Frío y calor',
    titulo: 'Hielo si hay hinchazón',
    descripcion:
      'Si la articulación se inflama después de ejercitar, aplica frío envuelto en una tela por 15 minutos.',
    icono: 'snowflake',
    color: C_CLARO.cyan,
    colorFondo: C_CLARO.cyanClaro,
  },
  {
    id: 'c10',
    categoria: 'Calzado',
    titulo: 'Usa zapatos cómodos',
    descripcion:
      'Un calzado con buena suela y sin taco reduce el impacto sobre cadera y rodilla al caminar.',
    icono: 'shoe-sneaker',
    color: C_CLARO.morado,
    colorFondo: C_CLARO.moradoClaro,
  },
  {
    id: 'c11',
    categoria: 'Peso',
    titulo: 'Cada kilo cuenta',
    descripcion:
      'Mantener un peso saludable disminuye la carga sobre tus articulaciones y alivia el dolor de la artrosis.',
    icono: 'scale-bathroom',
    color: C_CLARO.verde,
    colorFondo: C_CLARO.verdeClaro,
  },
  {
    id: 'c12',
    categoria: 'Ánimo',
    titulo: 'Celebra tus avances',
    descripcion:
      'Cada sesión completada suma. Mira tu progreso semanal y date crédito por el esfuerzo de hoy.',
    icono: 'emoticon-happy-outline',
    color: C_CLARO.rojo,
    colorFondo: C_CLARO.rojoClaro,
  },
];

/** Cuántos consejos al azar muestra el carrusel de Inicio. */
const CONSEJOS_VISIBLES = 5;

/** Copia de `lista` en orden aleatorio (Fisher-Yates). */
function barajar<T>(lista: T[]): T[] {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

export const PROGRESO_DEMO: DiaProgreso[] = [
  { dia: 'L', valor: 1 },
  { dia: 'M', valor: 0.82 },
  { dia: 'X', valor: 0.6 },
  { dia: 'J', valor: 0.25 },
  { dia: 'V', valor: 0 },
  { dia: 'S', valor: 0 },
  { dia: 'D', valor: 0 },
];

/* ══════════════════════════════════════════════════════════════════
   UTILIDADES
   ══════════════════════════════════════════════════════════════════ */

function saludoPorHora(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

const sombra = (elev: number) =>
  Platform.select({
    ios: {
      shadowColor: '#0B2016',
      shadowOpacity: 0.08,
      shadowRadius: elev * 1.6,
      shadowOffset: { width: 0, height: elev / 2 },
    },
    android: { elevation: elev },
    default: {},
  });

/* ══════════════════════════════════════════════════════════════════
   CARRUSEL DEL HERO
   ══════════════════════════════════════════════════════════════════ */

/** Fotos del banner "Muévete con confianza": fisioterapia de rodilla y
 *  sentadilla asistida. Se van alternando con un fundido. */
const IMAGENES_HERO: ImageSourcePropType[] = [
  require('../../assets/images/hero_fisio_rodilla.jpg'),
  require('../../assets/images/hero_fisio_sentadilla.jpg'),
];
const HERO_CAMBIO_MS = 5000;
const HERO_FUNDIDO_MS = 900;

/** Todas las fotos apiladas; solo cambia la opacidad (hilo nativo), así el
 *  fundido no compite con el resto de la pantalla. */
function HeroCarrusel({ imagenes, estilo }: { imagenes: ImageSourcePropType[]; estilo: object }) {
  // useState y no useRef: React Compiler no deja leer refs al renderizar.
  const [opacidades] = useState(() => imagenes.map((_, i) => new Animated.Value(i === 0 ? 1 : 0)));
  const [actual, setActual] = useState(0);

  useEffect(() => {
    if (imagenes.length < 2) return;
    const id = setInterval(() => setActual((prev) => (prev + 1) % imagenes.length), HERO_CAMBIO_MS);
    return () => clearInterval(id);
  }, [imagenes.length]);

  // Fundido cruzado: la foto actual sube a 1 y las demás bajan a 0.
  useEffect(() => {
    const anim = Animated.parallel(
      opacidades.map((o, i) =>
        Animated.timing(o, {
          toValue: i === actual ? 1 : 0,
          duration: HERO_FUNDIDO_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        })
      )
    );
    anim.start();
    return () => anim.stop();
  }, [actual, opacidades]);

  return (
    <>
      {imagenes.map((src, i) => (
        <Animated.Image
          key={i}
          source={src}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, estilo, { opacity: opacidades[i] }]}
        />
      ))}
      {imagenes.length > 1 && (
        <View style={estilosHero.puntos} pointerEvents="none">
          {imagenes.map((_, i) => (
            <View key={i} style={[estilosHero.punto, i === actual && estilosHero.puntoActivo]} />
          ))}
        </View>
      )}
    </>
  );
}

const estilosHero = StyleSheet.create({
  puntos: { position: 'absolute', top: 12, right: 14, flexDirection: 'row', gap: 5 },
  punto: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.45)' },
  puntoActivo: { width: 18, backgroundColor: '#FFFFFF' },
});

/* ══════════════════════════════════════════════════════════════════
   PANTALLA
   ══════════════════════════════════════════════════════════════════ */

export default function InicioScreen({
  nombrePaciente = 'Jorge Mamani',
  avatar,
  imagenHero,
  ejercicios = EJERCICIOS_DEMO,
  consejos = CONSEJOS_DEMO,
  progresoSemanal = PROGRESO_DEMO,
  minutosSesion = 15,
  notificaciones = 2,
  tratamiento = null,
  onComenzarSesion,
  onVerEjercicio,
  onVerTodos,
  onConsejo,
  onContactar,
  onNotificaciones,
  onPerfil,
}: Props) {
  const { styles, C, tono } = useEstilos();
  const { width } = useWindowDimensions();
  // useState y no useRef: React Compiler no deja leer refs al renderizar.
  const [anim] = useState(() => new Animated.Value(0));
  const [consejoActivo, setConsejoActivo] = useState(0);

  const totales = useMemo(() => {
    const hechos = ejercicios.filter((e) => e.completado).length;
    const total = ejercicios.length || 1;
    return { hechos, total: ejercicios.length, pct: Math.round((hechos / total) * 100) };
  }, [ejercicios]);

  const promedioSemanal = useMemo(() => {
    const activos = progresoSemanal.filter((d) => d.valor > 0);
    if (!activos.length) return 0;
    return Math.round((activos.reduce((s, d) => s + d.valor, 0) / activos.length) * 100);
  }, [progresoSemanal]);

  // Consejos al azar: cada vez que el paciente entra a Inicio se mezclan y
  // el carrusel muestra CONSEJOS_VISIBLES de ellos.
  const [consejosMezclados, setConsejosMezclados] = useState(() => barajar(consejos));
  useFocusEffect(
    useCallback(() => {
      setConsejosMezclados(barajar(consejos));
      setConsejoActivo(0);
    }, [consejos])
  );
  const consejosCarrusel = consejosMezclados.slice(0, CONSEJOS_VISIBLES);

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [anim]);

  const anchoBarra = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', `${totales.pct}%`],
  });

  const anchoTarjetaConsejo = Math.min(width * 0.74, 290);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.verdeOscuro} />

      {/* ─── ENCABEZADO ─────────────────────────────────────────── */}
      <LinearGradient
        colors={[C.verde, C.verdeOscuro] as const}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      >
        <SafeAreaView edges={['top']}>
          <View style={styles.header}>
            <View style={styles.headerTexto}>
              <Text style={styles.saludo}>{saludoPorHora()}</Text>
              <Text style={styles.nombre} numberOfLines={1}>
                {nombrePaciente}
              </Text>
              <Text style={styles.subSaludo}>¿Listo para continuar con tu rehabilitación?</Text>
            </View>

            <View style={styles.headerAcciones}>
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={onPerfil}
                accessibilityRole="button"
                accessibilityLabel="Ver mi perfil"
              >
                {avatar ? (
                  <Image source={avatar} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarVacio]}>
                    <Ionicons name="person" size={28} color={C.verde} />
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.campana}
                activeOpacity={0.85}
                onPress={onNotificaciones}
                accessibilityRole="button"
                accessibilityLabel={`Notificaciones, ${notificaciones} sin leer`}
              >
                <Ionicons name="notifications-outline" size={22} color={C.texto} />
                {notificaciones > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeTexto}>
                      {notificaciones > 9 ? '9+' : notificaciones}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContenido}
        showsVerticalScrollIndicator={false}
      >
        {/* ─── HERO ─────────────────────────────────────────────── */}
        <View style={styles.hero}>
          <HeroCarrusel imagenes={imagenHero ? [imagenHero] : IMAGENES_HERO} estilo={styles.heroImg} />
          <LinearGradient
            colors={['transparent', 'rgba(6,26,15,0.15)', 'rgba(6,26,15,0.82)'] as const}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.heroTexto}>
            <Text style={styles.heroTitulo}>Muévete con confianza</Text>
            <Text style={styles.heroSub}>Cada ejercicio te acerca a tu recuperación.</Text>
          </View>
        </View>

        {/* ─── SESIÓN DE HOY ────────────────────────────────────── */}
        <View style={styles.tarjeta}>
          <View style={styles.tarjetaTop}>
            <View style={styles.tituloConIcono}>
              <View style={styles.iconoChip}>
                <MaterialCommunityIcons name="pulse" size={22} color={C.verde} />
              </View>
              <Text style={styles.tarjetaTitulo}>Sesión de hoy</Text>
            </View>
            <View style={styles.pillEstado}>
              <Text style={styles.pillEstadoTexto}>
                {totales.pct === 100 ? 'Completada' : totales.pct === 0 ? 'Pendiente' : 'En progreso'}
              </Text>
            </View>
          </View>

          <View style={styles.stats}>
            <Stat valor={String(totales.total)} etiqueta="ejercicios" />
            <Stat valor={String(minutosSesion)} etiqueta="minutos" />
            <Stat valor={`${totales.pct}%`} etiqueta="completado" />
          </View>

          <View style={styles.barraFondo}>
            <Animated.View style={[styles.barraRelleno, { width: anchoBarra }]} />
          </View>
          <Text style={styles.barraTexto}>
            {totales.hechos} de {totales.total} ejercicios completados
          </Text>

          <TouchableOpacity
            style={styles.botonPrincipal}
            activeOpacity={0.9}
            onPress={onComenzarSesion}
            accessibilityRole="button"
            accessibilityLabel="Comenzar sesión de hoy"
          >
            <Ionicons name="play-circle" size={24} color={C.blanco} />
            <Text style={styles.botonPrincipalTexto}>
              {totales.hechos > 0 ? 'Continuar sesión' : 'Comenzar sesión'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ─── MI TRATAMIENTO ───────────────────────────────────── */}
        {tratamiento && (
          <View style={styles.citaWrap}>
            <View style={[styles.citaHeader, { backgroundColor: C.verdeOscuro }]}>
              <MaterialCommunityIcons name="clipboard-pulse-outline" size={18} color={C.blanco} />
              <Text style={styles.citaHeaderTexto}>Mi tratamiento</Text>
            </View>
            <View style={styles.citaCuerpo}>
              <View style={styles.citaIcono}>
                <MaterialCommunityIcons name="doctor" size={24} color={C.verde} />
              </View>
              <View style={styles.citaInfo}>
                <Text style={styles.citaNombre} numberOfLines={2}>
                  {tratamiento.objetivo}
                </Text>
                <Text style={styles.citaEspecialidad}>
                  A cargo de {tratamiento.medicoResponsable}
                </Text>
                <View style={styles.citaMetaFila}>
                  <View style={styles.citaMeta}>
                    <Ionicons name="time-outline" size={14} color={C.textoSuave} />
                    <Text style={styles.citaMetaTexto}>
                      {tratamiento.duracionSemanas} semanas
                    </Text>
                  </View>
                  <View style={styles.citaMeta}>
                    <Ionicons name="flag-outline" size={14} color={C.textoSuave} />
                    <Text style={styles.citaMetaTexto}>
                      Termina {tratamiento.fechaFinEstimada}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          </View>
        )}

        {/* ─── EJERCICIOS DE HOY ────────────────────────────────── */}
        <SeccionTitulo titulo="Ejercicios de hoy" accion="Ver todos" onAccion={onVerTodos} />

        {ejercicios.map((e) => (
          <TouchableOpacity
            key={e.id}
            style={styles.ejercicio}
            activeOpacity={0.9}
            onPress={() => onVerEjercicio?.(e)}
            accessibilityRole="button"
            accessibilityLabel={`${e.nombre}, ${e.series} series de ${e.repeticiones} repeticiones${
              e.completado ? ', completado' : ''
            }`}
          >
            {e.imagen ? (
              <Image source={e.imagen} style={styles.ejercicioImg} />
            ) : (
              <View style={[styles.ejercicioImg, styles.ejercicioImgVacia]}>
                <MaterialCommunityIcons name="human-handsup" size={26} color={C.verde} />
              </View>
            )}

            <View style={styles.ejercicioInfo}>
              <Text style={styles.ejercicioNombre} numberOfLines={1}>
                {e.nombre}
              </Text>
              <View style={styles.ejercicioMeta}>
                <Ionicons name="location-outline" size={13} color={C.textoSuave} />
                <Text style={styles.ejercicioMetaTexto}>
                  {e.zona} · {e.series} series · {e.repeticiones} rep
                </Text>
              </View>
            </View>

            {e.completado ? (
              <View style={styles.ejercicioHecho}>
                <Ionicons name="checkmark" size={20} color={C.verde} />
              </View>
            ) : (
              <View style={styles.ejercicioIniciar}>
                <Text style={styles.ejercicioIniciarTexto}>Iniciar</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}

        {/* ─── CONSEJOS PARA TI (NUEVO) ─────────────────────────── */}
        <SeccionTitulo titulo="Consejos para ti" />

        <ScrollView
          // Al mezclarse de nuevo, el carrusel vuelve al principio.
          key={consejosCarrusel.map((c) => c.id).join()}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={anchoTarjetaConsejo + 14}
          decelerationRate="fast"
          contentContainerStyle={styles.carrusel}
          onMomentumScrollEnd={(ev) =>
            setConsejoActivo(
              Math.round(ev.nativeEvent.contentOffset.x / (anchoTarjetaConsejo + 14)),
            )
          }
        >
          {consejosCarrusel.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={[styles.consejo, { width: anchoTarjetaConsejo }]}
              activeOpacity={0.9}
              onPress={() => onConsejo?.(c)}
              accessibilityRole="button"
              accessibilityLabel={`${c.categoria}: ${c.titulo}. ${c.descripcion}`}
            >
              <View style={[styles.consejoIcono, { backgroundColor: tono(c.colorFondo) }]}>
                <MaterialCommunityIcons name={c.icono} size={24} color={tono(c.color)} />
              </View>
              <Text style={[styles.consejoCategoria, { color: tono(c.color) }]}>
                {c.categoria.toUpperCase()}
              </Text>
              <Text style={styles.consejoTitulo}>{c.titulo}</Text>
              <Text style={styles.consejoDesc}>{c.descripcion}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.puntos}>
          {consejosCarrusel.map((c, i) => (
            <View key={c.id} style={[styles.punto, i === consejoActivo && styles.puntoActivo]} />
          ))}
        </View>

        {/* ─── PROGRESO SEMANAL ─────────────────────────────────── */}
        <View style={styles.tarjeta}>
          <View style={styles.tituloConIcono}>
            <View style={styles.iconoChip}>
              <MaterialCommunityIcons name="trending-up" size={22} color={C.verde} />
            </View>
            <Text style={styles.tarjetaTitulo}>Mi progreso semanal</Text>
          </View>

          <View style={styles.semana}>
            {progresoSemanal.map((d, i) => (
              <BarraDia key={`${d.dia}-${i}`} dia={d.dia} valor={d.valor} anim={anim} />
            ))}
          </View>

          <Text style={styles.semanaResumen}>
            {promedioSemanal >= 80
              ? `¡Muy bien! Has completado el ${promedioSemanal}% esta semana.`
              : promedioSemanal > 0
                ? `Vas por buen camino: ${promedioSemanal}% esta semana. ¡Sigue así!`
                : 'Aún no registras actividad esta semana. ¡Empecemos hoy!'}
          </Text>
        </View>

      </ScrollView>
    </View>
  );
}

/* ══════════════════════════════════════════════════════════════════
   SUBCOMPONENTES
   ══════════════════════════════════════════════════════════════════ */

function Stat({ valor, etiqueta }: { valor: string; etiqueta: string }) {
  const { styles } = useEstilos();
  return (
    <View style={styles.stat}>
      <Text style={styles.statValor}>{valor}</Text>
      <Text style={styles.statEtiqueta}>{etiqueta}</Text>
    </View>
  );
}

function SeccionTitulo({
  titulo,
  accion,
  onAccion,
}: {
  titulo: string;
  accion?: string;
  onAccion?: () => void;
}) {
  const { styles } = useEstilos();
  return (
    <View style={styles.seccion}>
      <Text style={styles.seccionTitulo}>{titulo}</Text>
      {accion && (
        <TouchableOpacity onPress={onAccion} activeOpacity={0.7} accessibilityRole="button">
          <Text style={styles.seccionAccion}>{accion}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const ALTO_BARRA = 72;

function BarraDia({ dia, valor, anim }: { dia: string; valor: number; anim: Animated.Value }) {
  const { styles, C } = useEstilos();
  const alto = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [6, Math.max(6, valor * ALTO_BARRA)],
  });
  const activo = valor > 0;

  return (
    <View style={styles.diaCol}>
      <View style={styles.diaPista}>
        <Animated.View
          style={[
            styles.diaBarra,
            {
              height: alto,
              backgroundColor: activo ? C.verde : C.pista,
              opacity: activo ? 1 : 0.7,
            },
          ]}
        />
      </View>
      <Text style={[styles.diaTexto, activo && styles.diaTextoActivo]}>{dia}</Text>
    </View>
  );
}

/* ══════════════════════════════════════════════════════════════════
   ESTILOS
   ══════════════════════════════════════════════════════════════════ */

const useEstilos = crearEstilos((p, oscuro) => {
  const C = coloresDe(p, oscuro);
  return {
    oscuro,
    C,
    tono: traductorDe(C),
    styles: StyleSheet.create({
  root: { flex: 1, backgroundColor: C.fondo },

  /* Encabezado */
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 26,
    gap: 14,
  },
  headerTexto: { flex: 1 },
  saludo: { color: 'rgba(255,255,255,0.88)', fontSize: 16, fontWeight: '600' },
  nombre: { color: C.blanco, fontSize: 30, fontWeight: '800', marginTop: 2, letterSpacing: -0.4 },
  subSaludo: { color: 'rgba(255,255,255,0.86)', fontSize: 15, marginTop: 6, lineHeight: 21 },
  headerAcciones: { alignItems: 'center', gap: 10 },
  avatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    borderWidth: 3,
    borderColor: C.blanco,
    backgroundColor: C.verdeClaro,
  },
  avatarVacio: { alignItems: 'center', justifyContent: 'center' },
  campana: {
    width: 46,
    height: 40,
    borderRadius: 14,
    backgroundColor: C.superficie,
    alignItems: 'center',
    justifyContent: 'center',
    ...sombra(3),
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: C.rojo,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: C.superficie,
  },
  badgeTexto: { color: C.blanco, fontSize: 10, fontWeight: '800' },

  /* Franja institucional */
  franja: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: C.azulFondo,
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
  franjaTexto: { color: C.blanco, fontSize: 13.5, fontWeight: '700', letterSpacing: 0.2 },

  /* Scroll */
  scroll: { flex: 1 },
  scrollContenido: { padding: 16, paddingBottom: 44 },

  /* Hero */
  hero: {
    height: 170,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: C.heroVacio,
    ...sombra(4),
  },
  heroImg: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  heroTexto: { position: 'absolute', left: 18, right: 18, bottom: 16 },
  heroTitulo: { color: C.blanco, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: 14.5, marginTop: 3 },

  /* Tarjeta genérica */
  tarjeta: {
    backgroundColor: C.superficie,
    borderRadius: 20,
    padding: 18,
    marginTop: 16,
    borderWidth: 1,
    borderColor: C.borde,
    ...sombra(2),
  },
  tarjetaTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tituloConIcono: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconoChip: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: C.verdeClaro,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tarjetaTitulo: { fontSize: 18.5, fontWeight: '800', color: C.texto },
  pillEstado: {
    backgroundColor: C.naranjaClaro,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pillEstadoTexto: { color: C.naranja, fontSize: 12.5, fontWeight: '700' },

  /* Stats */
  stats: { flexDirection: 'row', gap: 10, marginTop: 16 },
  stat: {
    flex: 1,
    backgroundColor: C.superficieAlt,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  statValor: { fontSize: 23, fontWeight: '800', color: C.verdeTexto },
  statEtiqueta: { fontSize: 12.5, color: C.textoSuave, marginTop: 2 },

  /* Barra de progreso */
  barraFondo: {
    height: 9,
    borderRadius: 999,
    backgroundColor: C.divisor,
    marginTop: 16,
    overflow: 'hidden',
  },
  barraRelleno: { height: '100%', borderRadius: 999, backgroundColor: C.verde },
  barraTexto: { fontSize: 13, color: C.textoSuave, marginTop: 8 },

  botonPrincipal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: C.verde,
    borderRadius: 15,
    paddingVertical: 16,
    marginTop: 16,
    ...sombra(3),
  },
  botonPrincipalTexto: { color: C.blanco, fontSize: 17.5, fontWeight: '800' },

  /* Cita */
  citaWrap: {
    marginTop: 16,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: C.superficie,
    borderWidth: 1,
    borderColor: C.borde,
    ...sombra(2),
  },
  citaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.azulFondo,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  citaHeaderTexto: { color: C.blanco, fontSize: 16, fontWeight: '800' },
  citaCuerpo: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  citaIcono: {
    width: 48,
    height: 48,
    borderRadius: 15,
    backgroundColor: C.azulClaro,
    alignItems: 'center',
    justifyContent: 'center',
  },
  citaInfo: { flex: 1 },
  citaNombre: { fontSize: 16.5, fontWeight: '800', color: C.texto },
  citaEspecialidad: { fontSize: 13.5, color: C.textoSuave, marginTop: 1 },
  citaMetaFila: { flexDirection: 'row', gap: 14, marginTop: 6 },
  citaMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  citaMetaTexto: { fontSize: 12.5, color: C.textoSuave, fontWeight: '600' },

  /* Sección */
  seccion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 24,
    marginBottom: 10,
  },
  seccionTitulo: { fontSize: 20, fontWeight: '800', color: C.texto, letterSpacing: -0.3 },
  seccionAccion: { fontSize: 14.5, fontWeight: '700', color: C.azul },

  /* Ejercicios */
  ejercicio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.superficie,
    borderRadius: 18,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: C.borde,
    ...sombra(1),
  },
  ejercicioImg: { width: 58, height: 58, borderRadius: 14, backgroundColor: C.verdeClaro },
  ejercicioImgVacia: { alignItems: 'center', justifyContent: 'center' },
  ejercicioInfo: { flex: 1 },
  ejercicioNombre: { fontSize: 16.5, fontWeight: '800', color: C.texto },
  ejercicioMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  ejercicioMetaTexto: { fontSize: 12.5, color: C.textoSuave },
  ejercicioHecho: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: C.verdeClaro,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ejercicioIniciar: {
    backgroundColor: C.verde,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 13,
  },
  ejercicioIniciarTexto: { color: C.blanco, fontWeight: '800', fontSize: 14.5 },

  /* Carrusel de consejos */
  carrusel: { paddingTop: 2, paddingBottom: 4, paddingRight: 6, gap: 14 },
  consejo: {
    backgroundColor: C.superficie,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: C.borde,
    ...sombra(1),
  },
  consejoIcono: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consejoCategoria: { fontSize: 11, fontWeight: '800', letterSpacing: 0.9, marginTop: 12 },
  consejoTitulo: { fontSize: 16, fontWeight: '800', color: C.texto, marginTop: 4 },
  consejoDesc: { fontSize: 13.5, lineHeight: 19.5, color: C.textoSuave, marginTop: 6 },

  puntos: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 12 },
  punto: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.punto },
  puntoActivo: { width: 20, backgroundColor: C.verde },

  /* Alerta de seguridad */
  alerta: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: C.rojoClaro,
    borderRadius: 18,
    padding: 16,
    marginTop: 20,
    borderWidth: 1,
    borderColor: C.alertaBorde,
  },
  alertaIcono: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: C.superficie,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertaTexto: { flex: 1 },
  alertaTitulo: { fontSize: 16, fontWeight: '800', color: C.alertaTitulo },
  alertaDesc: { fontSize: 13.5, lineHeight: 19.5, color: C.alertaDesc, marginTop: 4 },
  alertaBoton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    backgroundColor: C.rojo,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 12,
    marginTop: 12,
  },
  alertaBotonTexto: { color: C.blanco, fontWeight: '800', fontSize: 14 },

  /* Progreso semanal */
  semana: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 18,
  },
  diaCol: { alignItems: 'center', flex: 1 },
  diaPista: { height: ALTO_BARRA, justifyContent: 'flex-end' },
  diaBarra: { width: 30, borderRadius: 10 },
  diaTexto: { fontSize: 13, color: C.textoSuave, marginTop: 8, fontWeight: '700' },
  diaTextoActivo: { color: C.texto },
  semanaResumen: {
    textAlign: 'center',
    color: C.verdeTexto,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 16,
    lineHeight: 21,
  },

  pie: { textAlign: 'center', color: C.pie, fontSize: 12, marginTop: 26 },
    }),
  };
});