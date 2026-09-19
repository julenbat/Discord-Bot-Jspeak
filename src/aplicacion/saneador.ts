import emojiRegex from 'emoji-regex';

// Puerto: la presentación (discord.js) resuelve id → nombre desde su caché;
// los tests fingen estos resolutores.
export interface Resolutores {
  nombreUsuario(id: string): string | null;
  nombreCanal(id: string): string | null;
}

export const MAX_CARACTERES = 500;

export function contarPalabras(texto: string): number {
  return texto.split(/\s+/).filter(Boolean).length;
}

// Caracteres de control C0 (U+0000-U+001F), marcas de ancho cero / bidi
// (U+200B-U+200F: ZERO WIDTH SPACE, ZERO WIDTH NON-JOINER, ZERO WIDTH
// JOINER, LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT MARK) y overrides de embebido
// RTL/LTR (U+202A-U+202E: LRE, RLE, PDF, LRO, RLO). Ninguno debe locutarse
// ni cuenta como texto real.
//
// Nota de reconstruccion: la regex de este paso en el brief traia
// caracteres de control invisibles (incluido un byte NUL) pegados entre
// los corchetes -- se corrompieron al copiarla. Decodificando los bytes
// UTF-8 tal cual quedaron en el brief (0x00, 0x1F, U+200B, U+200F, U+202A,
// U+202E como limites de rango) se reconstruyen exactamente los tres rangos
// de abajo, que ademas coinciden con la descripcion textual del pipeline
// en ESPECIFICACION.md: "control/ancho-cero/RTL fuera".
const CONTROL_INVISIBLES_RTL = /[\u0000-\u001F\u200B-\u200F\u202A-\u202E]/gu;

// Pipeline de saneado con ORDEN FIJO (ver ESPECIFICACION.md §3.4): los
// bloques de código pueden contener menciones y markdown falsos, así que
// caen ENTEROS antes que todo lo demás.
export function sanear(texto: string, res: Resolutores): string | null {
  let t = texto;
  t = t.replace(/```[\s\S]*?```/g, ' ');                       // 1 bloques de código enteros
  t = t.replace(/\|\|[\s\S]*?\|\|/g, ' ');                     // 2 spoilers
  t = t.replace(/<@!?(\d+)>/g, (_, id) => res.nombreUsuario(id) ?? 'alguien'); // 3 menciones
  t = t.replace(/<@&\d+>/g, 'un rol');
  t = t.replace(/<#(\d+)>/g, (_, id) => res.nombreCanal(id) ?? 'un canal');
  t = t.replace(/@(everyone|here)/g, 'todos');
  t = t.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1');    // 4 enlaces enmascarados
  t = t.replace(/https?:\/\/\S+/g, 'enlace');                  // 5 URLs sueltas
  t = t.replace(/<a?:\w+:\d+>/g, ' ');                         // 6 emojis custom
  t = t.replace(emojiRegex(), ' ');                            //   y unicode
  t = t.replace(/(\*\*|__|~~|\*|_|`)/g, '');                   // 7 markdown restante
  t = t.normalize('NFKC')                                      // 8 unicode raro
    .replace(CONTROL_INVISIBLES_RTL, '')
    .replace(/(.)\1{3,}/g, '$1$1$1');                          //   repeticiones a 3
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Alfabeto: la voz es castellana; leer cirílico letra a letra suena a avería.
  const letras = [...t].filter((c) => /\p{L}/u.test(c));
  if (letras.length > 0) {
    const latinas = letras.filter((c) => /\p{Script=Latin}/u.test(c)).length;
    if (latinas / letras.length < 0.8) return null;
  }

  if (t.length > MAX_CARACTERES) {                             // 9 recorte por frontera de frase
    const corte = t.slice(0, MAX_CARACTERES);
    const ultimoPunto = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '));
    t = ultimoPunto > 100 ? corte.slice(0, ultimoPunto + 1) : corte;
  }
  return t || null;
}
