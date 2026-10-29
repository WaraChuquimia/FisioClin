import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';

/* ══════════════════════════════════════════════════════════════════
   Tema de la app (modo claro / oscuro)
   ══════════════════════════════════════════════════════════════════

   El paciente lo elige en Perfil > Configuración y queda guardado en el
   teléfono. No sigue el modo del sistema: muchos pacientes mayores tienen
   el teléfono en oscuro sin saberlo, y la app debe verse como la eligieron.

   También guarda el tamaño de texto (Normal / Grande / Muy grande).

   Cada pantalla arma sus estilos con `crearEstilos(p => StyleSheet.create(...))`:
   se construyen una vez por combinación de modo y tamaño (no en cada
   render), con todos los `fontSize` y `lineHeight` ya escalados, y el hook
   devuelve los de la preferencia activa.
   ══════════════════════════════════════════════════════════════════ */

export type Paleta = {
  /** Fondo general de la pantalla. */
  fondo: string;
  /** Tarjetas, barras y cualquier superficie sobre el fondo. */
  superficie: string;
  /** Superficie secundaria dentro de una tarjeta (chips, cajitas de icono). */
  superficieAlt: string;
  borde: string;
  texto: string;
  textoSuave: string;
  textoTenue: string;
  /** Azul institucional como color de texto/icono (se aclara en oscuro). */
  navyTexto: string;
  /** Azul institucional como fondo de bloques (se mantiene en ambos modos). */
  navy: string;
  verde: string;
  verdeOscuro: string;
  /** Verde como texto sobre superficie (se aclara en oscuro para contraste). */
  verdeTexto: string;
  verdeSuave: string;
  /** Verde intermedio: barras de semanas pasadas en gráficos. */
  verdeMedio: string;
  ambar: string;
  ambarSuave: string;
  rojo: string;
  rojoSuave: string;
  azul: string;
  azulSuave: string;
  morado: string;
  moradoSuave: string;
  cyan: string;
  cyanSuave: string;
  /** Blanco fijo: texto e iconos sobre verde/azul. No cambia con el modo. */
  blanco: string;
  /** Para el interruptor apagado y pistas de barras vacías. */
  pista: string;
};

export const PALETA_CLARA: Paleta = {
  fondo: '#F3F5F9',
  superficie: '#FFFFFF',
  superficieAlt: '#F3F5F9',
  borde: '#EEF1F6',
  texto: '#1B2233',
  textoSuave: '#6B7280',
  textoTenue: '#9AA1AE',
  navyTexto: '#16265C',
  navy: '#16265C',
  verde: '#1E8A4C',
  verdeOscuro: '#146138',
  verdeTexto: '#1E8A4C',
  verdeSuave: '#E4F4EB',
  verdeMedio: '#BFD9C8',
  ambar: '#B45309',
  ambarSuave: '#FEF3C7',
  rojo: '#B3261E',
  rojoSuave: '#FDE2E2',
  azul: '#1560C4',
  azulSuave: '#E8F0FC',
  morado: '#6B4FBB',
  moradoSuave: '#F0ECFB',
  cyan: '#0E7C8A',
  cyanSuave: '#E4F4F6',
  blanco: '#FFFFFF',
  pista: '#DADFE7',
};

export const PALETA_OSCURA: Paleta = {
  fondo: '#0E131C',
  superficie: '#182030',
  superficieAlt: '#222B3D',
  borde: '#2A3448',
  texto: '#E9EDF4',
  textoSuave: '#A7B0C0',
  textoTenue: '#7D8799',
  navyTexto: '#A9BCF5',
  navy: '#1D2F6B',
  verde: '#23A05A',
  verdeOscuro: '#17753F',
  verdeTexto: '#5BD08E',
  verdeSuave: '#173A28',
  verdeMedio: '#2F6B48',
  ambar: '#F2B35A',
  ambarSuave: '#3D2F14',
  rojo: '#F2837B',
  rojoSuave: '#43201E',
  azul: '#7AA7F0',
  azulSuave: '#1B2A45',
  morado: '#B29CF0',
  moradoSuave: '#2B2344',
  cyan: '#5FC4D1',
  cyanSuave: '#15343A',
  blanco: '#FFFFFF',
  pista: '#34405A',
};

export type TamanoTexto = 'Normal' | 'Grande' | 'Muy grande';
export const TAMANOS_TEXTO: TamanoTexto[] = ['Normal', 'Grande', 'Muy grande'];
const ESCALA_TEXTO: Record<TamanoTexto, number> = { Normal: 1, Grande: 1.15, 'Muy grande': 1.3 };

const CLAVE_MODO_OSCURO = 'fisioclin.preferencias.modoOscuro';
const CLAVE_TAMANO_TEXTO = 'fisioclin.preferencias.tamanoTexto';
const CLAVE_VOZ = 'fisioclin.preferencias.instruccionesVoz';

type TemaValue = {
  oscuro: boolean;
  p: Paleta;
  setOscuro: (valor: boolean) => void;
  tamanoTexto: TamanoTexto;
  /** Multiplicador de letra (1, 1.15 o 1.3) para tamaños puestos a mano. */
  escalaTexto: number;
  setTamanoTexto: (valor: TamanoTexto) => void;
  /** "Instrucciones de voz" del Perfil: el entrenador habla durante la sesión. */
  vozActiva: boolean;
  setVozActiva: (valor: boolean) => void;
};

const TemaContext = createContext<TemaValue>({
  oscuro: false,
  p: PALETA_CLARA,
  setOscuro: () => {},
  tamanoTexto: 'Normal',
  escalaTexto: 1,
  setTamanoTexto: () => {},
  vozActiva: true,
  setVozActiva: () => {},
});

export function TemaProvider({ children }: { children: React.ReactNode }) {
  const [oscuro, setOscuroState] = useState(false);
  const [tamanoTexto, setTamanoState] = useState<TamanoTexto>('Normal');
  // Encendida por defecto: es la forma en que el paciente se entera de si lo
  // está haciendo bien sin mirar la pantalla a 2-3 metros.
  const [vozActiva, setVozState] = useState(true);

  useEffect(() => {
    AsyncStorage.multiGet([CLAVE_MODO_OSCURO, CLAVE_TAMANO_TEXTO, CLAVE_VOZ])
      .then(([[, modo], [, tamano], [, voz]]) => {
        if (modo === '1') setOscuroState(true);
        if (tamano && tamano in ESCALA_TEXTO) setTamanoState(tamano as TamanoTexto);
        if (voz === '0') setVozState(false);
      })
      .catch(() => {});
  }, []);

  const setVozActiva = (valor: boolean) => {
    setVozState(valor);
    AsyncStorage.setItem(CLAVE_VOZ, valor ? '1' : '0').catch(() => {});
  };

  const setOscuro = (valor: boolean) => {
    setOscuroState(valor);
    AsyncStorage.setItem(CLAVE_MODO_OSCURO, valor ? '1' : '0').catch(() => {});
  };

  const setTamanoTexto = (valor: TamanoTexto) => {
    setTamanoState(valor);
    AsyncStorage.setItem(CLAVE_TAMANO_TEXTO, valor).catch(() => {});
  };

  return (
    <TemaContext.Provider
      value={{
        oscuro,
        p: oscuro ? PALETA_OSCURA : PALETA_CLARA,
        setOscuro,
        tamanoTexto,
        escalaTexto: ESCALA_TEXTO[tamanoTexto],
        setTamanoTexto,
        vozActiva,
        setVozActiva,
      }}
    >
      {children}
    </TemaContext.Provider>
  );
}

export function useTema() {
  return useContext(TemaContext);
}

/** Copia `valor` multiplicando cada `fontSize` y `lineHeight` numérico. */
function escalarTexto<T>(valor: T, escala: number): T {
  if (escala === 1 || valor === null || typeof valor !== 'object') return valor;
  if (Array.isArray(valor)) return valor.map((v) => escalarTexto(v, escala)) as T;
  if (Object.getPrototypeOf(valor) !== Object.prototype) return valor;
  const copia: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor)) {
    copia[k] =
      (k === 'fontSize' || k === 'lineHeight') && typeof v === 'number'
        ? Math.round(v * escala * 10) / 10
        : escalarTexto(v, escala);
  }
  return copia as T;
}

/** Construye los estilos de una pantalla y devuelve un hook que entrega los
 *  del modo (claro/oscuro) y tamaño de texto activos. Cada combinación se
 *  arma una sola vez y queda en caché. */
export function crearEstilos<T>(fabrica: (p: Paleta, oscuro: boolean) => T): () => T {
  const base = { claro: fabrica(PALETA_CLARA, false), oscuro: fabrica(PALETA_OSCURA, true) };
  const cache = new Map<string, T>();
  return function useEstilos() {
    const { oscuro, tamanoTexto } = useTema();
    const clave = `${oscuro ? 'oscuro' : 'claro'}|${tamanoTexto}`;
    let estilos = cache.get(clave);
    if (!estilos) {
      estilos = escalarTexto(oscuro ? base.oscuro : base.claro, ESCALA_TEXTO[tamanoTexto]);
      cache.set(clave, estilos);
    }
    return estilos;
  };
}
