// Troceo del texto en frases para mandarlas al TTS según llegan, en vez de
// esperar el texto completo. Las frases muy cortas ("Vale.") se arrastran
// como prefijo de la siguiente: sueltas suenan robóticas y desperdician
// una petición de síntesis.
export function extraerFrases(texto: string, forzar = false): { frases: string[]; resto: string } {
  const frases: string[] = [];
  let resto = texto;
  let arrastre = '';
  let m: RegExpMatchArray | null;
  while ((m = resto.match(/[.!?…]["')\]]?(\s+|$)/)) !== null) {
    const corte = m.index! + m[0].length;
    const frase = (arrastre + resto.slice(0, corte)).trim();
    resto = resto.slice(corte);
    if (frase.length >= 10) { frases.push(frase); arrastre = ''; }
    else { arrastre = `${frase} `; if (!resto) break; }
  }
  if (arrastre.length + resto.length > 120) {
    const coma = resto.lastIndexOf(',', 120);
    if (coma > 40) {
      frases.push((arrastre + resto.slice(0, coma + 1)).trim());
      resto = resto.slice(coma + 1); arrastre = '';
    }
  }
  resto = arrastre + resto;
  if (forzar && resto.trim()) { frases.push(resto.trim()); resto = ''; }
  return { frases, resto };
}
