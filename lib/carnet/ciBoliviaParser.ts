/* ==================================================================
   FisioClin — lectura de la cédula de identidad boliviana
   ==================================================================

   Convierte el texto suelto que devuelve un OCR en campos. No sabe nada
   de cámaras ni de red: le das los bloques de texto y te devuelve lo
   que haya podido reconocer. Por eso da igual quién haga el OCR —el
   backend, ML Kit, o un test con texto a mano—: este archivo funciona
   igual en los tres sitios.

   Devuelve `Partial<>` a propósito. Una cédula gastada o mal iluminada
   se lee a medias muy a menudo, y es mejor entregar tres campos de
   cinco que inventar los que faltan. Quien llama decide si basta.
   ================================================================== */

export interface DatosDocumentoBolivia {
  ci: string;
  nombres: string;
  apellidoPaterno: string;
  apellidoMaterno: string;
  /** Siempre DD-MM-YYYY, o '' si no se pudo leer. */
  fechaNacimiento: string;
  /** Base64 con prefijo data:. Vacío si no se capturó rostro. */
  fotoRostroBase64: string;
}

/** Letras que pueden aparecer en un nombre boliviano. */
const LETRAS = 'A-ZÁÉÍÓÚÜÑ';

/* El número suele venir precedido de "N°", pero el OCR se come ese
   símbolo con frecuencia, así que hay una segunda pasada que busca un
   número suelto. Las barras de una fecha impiden que 12/05/1998 se
   confunda con un CI. */
const RE_CI_ETIQUETADO = new RegExp(
  String.raw`N[°ºO\s]*[:.]?\s*(\d{5,9})(?:\s*-\s*([0-9A-Z]{1,2}))?`,
  'i',
);
const RE_CI_SUELTO = /(?:^|[^\d/\-.])(\d{6,9})(?![\d/\-.])/;

const RE_NOMBRES = new RegExp(
  String.raw`NOMBRES?[:\s]+([${LETRAS}\s]+?)(?=\n|APELLIDOS?|FECHA|NACIMIENTO|$)`,
  'i',
);
const RE_APELLIDOS = new RegExp(
  String.raw`APELLIDOS?[:\s]+([${LETRAS}\s]+?)(?=\n|NOMBRES?|FECHA|NACIMIENTO|$)`,
  'i',
);
const RE_FECHA = /(?:NACIMIENTO|NACIDO)[:\s]*([0-3]?\d)[/\-.]([01]?\d)[/\-.]((?:19|20)?\d{2})/i;

/* Línea de nombres del MRZ del reverso:  PATERNO<MATERNO<<NOMBRES */
const RE_MRZ = new RegExp(
  String.raw`([${LETRAS}]{2,})<([${LETRAS}]{2,})<<([${LETRAS}<]+)`,
);

/** Un año de dos dígitos se resuelve hacia atrás: nadie nació mañana.
 *
 *  El código original expandía siempre a 19XX, lo que convertía a un
 *  paciente de 2005 en uno de 1905. */
function expandirAnio(dosDigitos: string): string {
  const n = parseInt(dosDigitos, 10);
  const hoy = new Date().getFullYear();
  const candidato = Math.floor(hoy / 100) * 100 + n;
  return String(candidato > hoy ? candidato - 100 : candidato);
}

function limpiarTexto(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

export function parseCIDocument(
  textBlocks: string[],
): Partial<DatosDocumentoBolivia> {
  const fullText = textBlocks.join('\n').toUpperCase();
  const result: Partial<DatosDocumentoBolivia> = {};

  // 1. Número de cédula ------------------------------------------------
  const ciEtiquetado = fullText.match(RE_CI_ETIQUETADO);
  if (ciEtiquetado) {
    result.ci = ciEtiquetado[2]
      ? `${ciEtiquetado[1]}-${ciEtiquetado[2]}`
      : ciEtiquetado[1];
  } else {
    const ciSuelto = fullText.match(RE_CI_SUELTO);
    if (ciSuelto) result.ci = ciSuelto[1];
  }

  // 2. Nombres ---------------------------------------------------------
  const nombres = fullText.match(RE_NOMBRES);
  if (nombres) {
    const v = limpiarTexto(nombres[1]);
    if (v) result.nombres = v;
  }

  // 3. Apellidos: el primero es el paterno, el resto materno -----------
  const apellidos = fullText.match(RE_APELLIDOS);
  if (apellidos) {
    const partes = limpiarTexto(apellidos[1]).split(' ').filter(Boolean);
    if (partes.length) {
      result.apellidoPaterno = partes[0];
      result.apellidoMaterno = partes.slice(1).join(' ');
    }
  }

  // 4. Fecha de nacimiento --------------------------------------------
  const fecha = fullText.match(RE_FECHA);
  if (fecha) {
    const dia = parseInt(fecha[1], 10);
    const mes = parseInt(fecha[2], 10);
    // Un OCR que lee "32/13" ha leído mal; mejor dejar el campo vacío
    // que meter una fecha imposible en la ficha del paciente.
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      const anio = fecha[3].length === 2 ? expandirAnio(fecha[3]) : fecha[3];
      result.fechaNacimiento = `${String(dia).padStart(2, '0')}-${String(mes).padStart(2, '0')}-${anio}`;
    }
  }

  // 5. Reverso: el MRZ solo rellena huecos -----------------------------
  //
  //    Antes pisaba los apellidos aunque el frente ya se hubiera leído
  //    bien. El MRZ está truncado a 30 caracteres, así que el frente es
  //    la fuente buena siempre que exista.
  const mrz = fullText.match(RE_MRZ);
  if (mrz) {
    if (!result.apellidoPaterno) result.apellidoPaterno = mrz[1];
    if (!result.apellidoMaterno) result.apellidoMaterno = mrz[2];
    if (!result.nombres) {
      const v = limpiarTexto(mrz[3].replace(/</g, ' '));
      if (v) result.nombres = v;
    }
  }

  return result;
}

/** ¿Hay suficiente para abrir una ficha? El rostro y el segundo
 *  apellido son opcionales; sin CI y sin nombre no hay paciente. */
export function datosSuficientes(d: Partial<DatosDocumentoBolivia>): boolean {
  return Boolean(d.ci && d.nombres && d.apellidoPaterno);
}
