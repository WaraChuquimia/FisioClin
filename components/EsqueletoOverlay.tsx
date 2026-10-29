/* ==================================================================
   FisioClin — esqueleto dibujado encima de la vista previa de cámara
   ==================================================================

   Los 17 landmarks ya viajan del servicio de visión (ver `ESQUELETO` en
   `backend/cv-service/main.py`), en el MISMO orden que la constante
   `ARISTAS` de abajo espera — no son índices de BlazePose, son la
   posición dentro del array que manda el servicio.

   Dos cosas que si se hacen mal parecen "la detección falla" sin fallar:

   1. Mapeo de coordenadas: el servicio mide sobre la foto completa (a
      cualquier resolución, los landmarks son 0..1 normalizados a su
      ancho/alto), pero la vista previa recorta para llenar el marco
      (`resizeMode="cover"` conceptualmente). Sin la transformación
      explícita de abajo, el esqueleto sale desplazado.
   2. Espejo: con `facing="back"` no hace falta espejar. Con la cámara
      frontal, sí — por eso el prop `espejo`.

   Por qué Reanimated y no `requestAnimationFrame` + `setState`: la versión
   anterior re-renderizaba el SVG entero 60 veces por segundo en el hilo de
   JavaScript. Ese es el MISMO hilo que saca las fotos, las codifica en
   base64 y habla con el WebSocket, así que la animación del esqueleto le
   robaba tiempo a la captura que la alimenta: menos fotos por segundo, y
   el esqueleto se veía lento. Ahora el suavizado corre en el hilo de UI
   (`useFrameCallback`) y React solo se entera cuando llega una medida.
   ================================================================== */

import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedProps,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Line } from 'react-native-svg';

import type { Punto } from '@/lib/fisioclin/tipos';

const LineaAnimada = Animated.createAnimatedComponent(Line);
const CirculoAnimado = Animated.createAnimatedComponent(Circle);

type Props = {
  /** null cuando no hay persona en el encuadre: no se dibuja nada. */
  landmarks: Punto[] | null;
  /** Tamaño (en cualquier unidad consistente) de la foto que procesó el
   *  servicio — en la práctica, ancho/alto del primer fotograma capturado,
   *  ya que la proporción no cambia entre reescalados. */
  fotoAncho: number;
  fotoAlto: number;
  /** Tamaño en pantalla del recuadro de la cámara. */
  vistaAncho: number;
  vistaAlto: number;
  /** true solo con cámara frontal. */
  espejo?: boolean;
  /** Color de todo el esqueleto según la similitud con la postura objetivo
   *  (guiaPostura.ts). Sin él, cada hueso se pinta por su visibilidad. */
  color?: string | null;
};

// Posición dentro del array que manda el servicio (no el índice de
// BlazePose): mismo orden que `ESQUELETO` en main.py.
const IDX = {
  nariz: 0,
  hombroIzq: 1,
  hombroDer: 2,
  codoIzq: 3,
  codoDer: 4,
  munecaIzq: 5,
  munecaDer: 6,
  caderaIzq: 7,
  caderaDer: 8,
  rodillaIzq: 9,
  rodillaDer: 10,
  tobilloIzq: 11,
  tobilloDer: 12,
  talonIzq: 13,
  talonDer: 14,
  pieIzq: 15,
  pieDer: 16,
} as const;

const N_PUNTOS = 17;

const ARISTAS: [number, number][] = [
  [IDX.hombroIzq, IDX.hombroDer],
  [IDX.hombroIzq, IDX.codoIzq],
  [IDX.codoIzq, IDX.munecaIzq],
  [IDX.hombroDer, IDX.codoDer],
  [IDX.codoDer, IDX.munecaDer],
  [IDX.hombroIzq, IDX.caderaIzq],
  [IDX.hombroDer, IDX.caderaDer],
  [IDX.caderaIzq, IDX.caderaDer],
  [IDX.caderaIzq, IDX.rodillaIzq],
  [IDX.rodillaIzq, IDX.tobilloIzq],
  [IDX.caderaDer, IDX.rodillaDer],
  [IDX.rodillaDer, IDX.tobilloDer],
  [IDX.tobilloIzq, IDX.talonIzq],
  [IDX.talonIzq, IDX.pieIzq],
  [IDX.tobilloIzq, IDX.pieIzq],
  [IDX.tobilloDer, IDX.talonDer],
  [IDX.talonDer, IDX.pieDer],
  [IDX.tobilloDer, IDX.pieDer],
];

/** Constante de tiempo del suavizado, en segundos. Con 60 ms el punto
 *  recorre el 80 % del camino hacia la medida nueva en ~100 ms: se ve
 *  fluido entre dos medidas (llegan cada 120–250 ms) sin quedarse atrás.
 *  Depende del tiempo real entre cuadros, no del número de cuadros, así
 *  que se comporta igual a 60 y a 120 Hz. */
const TAU_S = 0.06;

/** Geometría de la proyección foto → pantalla, calculada una vez por render. */
type Proyeccion = {
  escala: number;
  offsetX: number;
  offsetY: number;
  fotoAncho: number;
  fotoAlto: number;
  vistaAncho: number;
  espejo: boolean;
};

function colorPorVisibilidad(v: number) {
  'worklet';
  if (v >= 0.7) return '#1E8A4C'; // se ve bien
  if (v >= 0.5) return '#C98A12'; // marginal
  return '#C0392B'; // mala: es la señal de "por qué no te veo"
}

/** Punto i en píxeles de pantalla. `pts` es plano: [x0, y0, v0, x1, …]. */
function proyectar(pts: number[], i: number, p: Proyeccion) {
  'worklet';
  let px = p.offsetX + pts[i * 3] * p.fotoAncho * p.escala;
  const py = p.offsetY + pts[i * 3 + 1] * p.fotoAlto * p.escala;
  if (p.espejo) px = p.vistaAncho - px;
  return { px, py };
}

export function EsqueletoOverlay({
  landmarks,
  fotoAncho,
  fotoAlto,
  vistaAncho,
  vistaAlto,
  espejo = false,
  color = null,
}: Props) {
  // Plano [x, y, v] × 17: los arrays planos cruzan de hilo más baratos.
  const objetivo = useSharedValue<number[] | null>(null);
  const suave = useSharedValue<number[] | null>(null);

  useEffect(() => {
    if (!landmarks || landmarks.length < N_PUNTOS) {
      objetivo.value = null;
      return;
    }
    const plano = new Array<number>(N_PUNTOS * 3);
    for (let i = 0; i < N_PUNTOS; i++) {
      plano[i * 3] = landmarks[i].x;
      plano[i * 3 + 1] = landmarks[i].y;
      plano[i * 3 + 2] = landmarks[i].v;
    }
    objetivo.value = plano;
  }, [landmarks, objetivo]);

  useFrameCallback((info) => {
    const obj = objetivo.value;
    const prev = suave.value;
    if (!obj) {
      if (prev !== null) suave.value = null;
      return;
    }
    if (!prev) {
      // Primera medida (o vuelve la persona): se coloca de golpe.
      suave.value = obj.slice();
      return;
    }
    const dt = Math.min(Math.max((info.timeSincePreviousFrame ?? 16) / 1000, 0), 0.1);
    const a = 1 - Math.exp(-dt / TAU_S);
    const sig = new Array<number>(obj.length);
    for (let i = 0; i < obj.length; i += 3) {
      sig[i] = prev[i] + (obj[i] - prev[i]) * a;
      sig[i + 1] = prev[i + 1] + (obj[i + 1] - prev[i + 1]) * a;
      sig[i + 2] = obj[i + 2];
    }
    suave.value = sig;
  });

  if (fotoAncho <= 0 || fotoAlto <= 0 || vistaAncho <= 0 || vistaAlto <= 0) {
    return null;
  }

  // "cover": la vista recorta la foto para llenarse, así que la escala es
  // la mayor de las dos razones, no la menor.
  const escala = Math.max(vistaAncho / fotoAncho, vistaAlto / fotoAlto);
  const proy: Proyeccion = {
    escala,
    offsetX: (vistaAncho - fotoAncho * escala) / 2,
    offsetY: (vistaAlto - fotoAlto * escala) / 2,
    fotoAncho,
    fotoAlto,
    vistaAncho,
    espejo,
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={vistaAncho} height={vistaAlto}>
        {ARISTAS.map(([a, b], i) => (
          <Hueso key={i} a={a} b={b} puntos={suave} proy={proy} color={color} />
        ))}
        {Array.from({ length: N_PUNTOS }, (_, i) => (
          <Articulacion key={`p${i}`} i={i} puntos={suave} proy={proy} color={color} />
        ))}
      </Svg>
    </View>
  );
}

type PropsPieza = {
  puntos: SharedValue<number[] | null>;
  proy: Proyeccion;
  color: string | null;
};

function Hueso({ a, b, puntos, proy, color }: PropsPieza & { a: number; b: number }) {
  const animados = useAnimatedProps(() => {
    const pts = puntos.value;
    if (!pts) return { x1: 0, y1: 0, x2: 0, y2: 0, stroke: 'transparent', strokeOpacity: 0 };
    const A = proyectar(pts, a, proy);
    const B = proyectar(pts, b, proy);
    return {
      x1: A.px,
      y1: A.py,
      x2: B.px,
      y2: B.py,
      stroke: color ?? colorPorVisibilidad(Math.min(pts[a * 3 + 2], pts[b * 3 + 2])),
      strokeOpacity: 0.85,
    };
  });
  return <LineaAnimada animatedProps={animados} strokeWidth={3} />;
}

function Articulacion({ i, puntos, proy, color }: PropsPieza & { i: number }) {
  const animados = useAnimatedProps(() => {
    const pts = puntos.value;
    if (!pts) return { cx: 0, cy: 0, fill: 'transparent', opacity: 0 };
    const { px, py } = proyectar(pts, i, proy);
    return { cx: px, cy: py, fill: color ?? colorPorVisibilidad(pts[i * 3 + 2]), opacity: 1 };
  });
  return <CirculoAnimado animatedProps={animados} r={5} />;
}
