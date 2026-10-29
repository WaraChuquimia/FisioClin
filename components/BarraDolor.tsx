/* ──────────────────────────────────────────────────────────────────────────
   FisioClin — barra de registro de dolor (escala EVA 0-10)

   La misma escala que usa el panel del médico (`registro_dolor.nivel_dolor`,
   0 = sin dolor, 10 = el peor dolor imaginable). Es una fila de 11 segmentos
   tocables, no un slider de arrastre: en un paciente con movilidad reducida
   tocar un número es más fiable que acertar un gesto de arrastre preciso.
   ────────────────────────────────────────────────────────────────────────── */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { crearEstilos, type Paleta, useTema } from '@/context/TemaContext';

const NIVELES = Array.from({ length: 11 }, (_, i) => i);

const ETIQUETA_NIVEL: Record<number, string> = {
  0: 'Sin dolor',
  1: 'Muy leve',
  2: 'Leve',
  3: 'Leve',
  4: 'Moderado',
  5: 'Moderado',
  6: 'Moderado',
  7: 'Fuerte',
  8: 'Fuerte',
  9: 'Muy fuerte',
  10: 'Dolor máximo',
};

/** Mezcla lineal entre dos colores hex ("#RRGGBB"), t en [0, 1]. */
function mezclarColor(c1: string, c2: string, t: number): string {
  const h1 = parseInt(c1.slice(1), 16);
  const h2 = parseInt(c2.slice(1), 16);
  const r = Math.round(((h1 >> 16) & 255) + (((h2 >> 16) & 255) - ((h1 >> 16) & 255)) * t);
  const g = Math.round(((h1 >> 8) & 255) + (((h2 >> 8) & 255) - ((h1 >> 8) & 255)) * t);
  const b = Math.round((h1 & 255) + ((h2 & 255) - (h1 & 255)) * t);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/** Verde (0) → ámbar (5) → rojo (10), igual que el semáforo del resto de la app. */
function colorDeNivel(n: number, p: Paleta): string {
  const t = n / 10;
  return t <= 0.5 ? mezclarColor(p.verde, p.ambar, t / 0.5) : mezclarColor(p.ambar, p.rojo, (t - 0.5) / 0.5);
}

export type PropsBarraDolor = {
  valor: number | null;
  onCambiar: (nivel: number) => void;
};

export function BarraDolor({ valor, onCambiar }: PropsBarraDolor) {
  const { p } = useTema();
  const s = useEstilos();

  return (
    <View style={s.contenedor}>
      <View style={s.fila}>
        {NIVELES.map((n) => {
          const activo = valor != null && n <= valor;
          const esElegido = valor === n;
          return (
            <Pressable
              key={n}
              onPress={() => onCambiar(n)}
              hitSlop={6}
              style={[
                s.segmento,
                { backgroundColor: activo ? colorDeNivel(n, p) : p.borde },
                esElegido && s.segmentoElegido,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Dolor nivel ${n} de 10: ${ETIQUETA_NIVEL[n]}`}
              accessibilityState={{ selected: esElegido }}
            >
              <Text style={[s.segmentoTexto, { color: activo ? '#fff' : p.textoSuave }]}>{n}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={s.filaExtremos}>
        <Text style={s.extremoTexto}>Sin dolor</Text>
        <Text style={s.extremoTexto}>Dolor máximo</Text>
      </View>
      <Text style={[s.valorTexto, { color: valor != null ? colorDeNivel(valor, p) : p.textoSuave }]}>
        {valor != null ? `${valor} / 10 · ${ETIQUETA_NIVEL[valor]}` : 'Toca el número que mejor describa tu dolor'}
      </Text>
    </View>
  );
}

const useEstilos = crearEstilos((p) =>
  StyleSheet.create({
    contenedor: { gap: 8 },
    fila: { flexDirection: 'row', gap: 4 },
    segmento: {
      flex: 1,
      height: 38,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segmentoElegido: {
      borderWidth: 2,
      borderColor: p.texto,
    },
    segmentoTexto: { fontSize: 13, fontWeight: '800' },
    filaExtremos: { flexDirection: 'row', justifyContent: 'space-between' },
    extremoTexto: { fontSize: 11, color: p.textoSuave, fontWeight: '600' },
    valorTexto: { fontSize: 14.5, fontWeight: '800', textAlign: 'center', marginTop: 2 },
  })
);
