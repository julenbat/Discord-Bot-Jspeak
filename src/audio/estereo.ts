// Discord exige 48 kHz ESTÉREO; Inworld entrega mono. Duplicar la muestra
// en ambos canales es la conversión correcta y gratis (sin resampleo).
export const MS_TRAMA = 20;
export const BYTES_TRAMA = (48000 / 1000) * MS_TRAMA * 2 * 2; // 3840

export function monoAEstereo(mono: Buffer): Buffer {
  const muestras = mono.length >> 1;
  const salida = Buffer.allocUnsafe(muestras * 4);
  for (let i = 0; i < muestras; i++) {
    const m = mono.readInt16LE(i * 2);
    salida.writeInt16LE(m, i * 4);
    salida.writeInt16LE(m, i * 4 + 2);
  }
  return salida;
}
