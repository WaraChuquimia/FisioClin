/* ==================================================================
   FisioClin — muñeco de la postura OBJETIVO
   ==================================================================

   Puerto de `renderizar_stickman` de probar_modelo.py: un muñeco con la
   cadera y la rodilla en los ángulos meta del ejercicio, para que el
   paciente vea a qué postura tiene que llegar. Los ángulos vienen en la
   escala del script (ángulo interno, 180° = estirado); ver guiaPostura.ts.
   ================================================================== */

import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

const ANCHO = 104;
const ALTO = 128;
const MUSLO = 27;
const PIERNA = 27;
const COLOR_GUIA = '#00FF78';
const COLOR_ACENTO = '#FFD700';

export function MunecoObjetivo({
  anguloCadera,
  anguloRodilla,
}: {
  /** Ángulo interno de cadera (180° = estirada). */
  anguloCadera: number;
  /** Ángulo interno de rodilla (180° = estirada). */
  anguloRodilla: number;
}) {
  // Misma cinemática directa que el script, escalada al recuadro.
  const cx = ANCHO / 2;
  const cabeza = { x: cx, y: 22 };
  const cuello = { x: cx, y: 34 };
  const cadera = { x: cx, y: 68 };

  const radCad = ((anguloCadera - 90) * Math.PI) / 180;
  const rodilla = {
    x: cadera.x + MUSLO * Math.cos(radCad),
    y: cadera.y + MUSLO * Math.sin(radCad),
  };
  const radRod = radCad + ((180 - anguloRodilla) * Math.PI) / 180;
  const tobillo = {
    x: rodilla.x + PIERNA * Math.cos(radRod),
    y: rodilla.y + PIERNA * Math.sin(radRod),
  };

  return (
    <View style={s.caja} pointerEvents="none">
      <Text style={s.titulo}>OBJETIVO</Text>
      <Svg width={ANCHO} height={ALTO}>
        <Circle cx={cabeza.x} cy={cabeza.y} r={8} stroke={COLOR_GUIA} strokeWidth={2} fill="none" />
        <Line x1={cuello.x} y1={cuello.y} x2={cadera.x} y2={cadera.y} stroke={COLOR_GUIA} strokeWidth={3} />
        <Line x1={cuello.x} y1={cuello.y} x2={cx - 20} y2={52} stroke={COLOR_GUIA} strokeWidth={2} />
        <Line x1={cuello.x} y1={cuello.y} x2={cx + 20} y2={52} stroke={COLOR_GUIA} strokeWidth={2} />
        <Line x1={cadera.x} y1={cadera.y} x2={rodilla.x} y2={rodilla.y} stroke={COLOR_GUIA} strokeWidth={3} />
        <Line x1={rodilla.x} y1={rodilla.y} x2={tobillo.x} y2={tobillo.y} stroke={COLOR_GUIA} strokeWidth={3} />
        <Circle cx={rodilla.x} cy={rodilla.y} r={3.5} fill={COLOR_ACENTO} />
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  caja: {
    backgroundColor: 'rgba(20,20,20,0.75)',
    borderColor: COLOR_ACENTO,
    borderWidth: 2,
    borderRadius: 12,
    paddingTop: 6,
    alignItems: 'center',
  },
  titulo: { color: COLOR_ACENTO, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
});
