// Inworld streaming: una línea JSON por trozo, audio en base64. Se separa el
// parseo (puro, testeable con fixtures) de la E/S del fetch. Pedimos
// audioEncoding PCM y no LINEAR16 porque LINEAR16 mete cabecera WAV en cada
// trozo (tropiezo documentado en el voice-agent); el RIFF se comprueba igual
// por si el proveedor cambia.
export interface TrozoInworld {
  pcm: Buffer | null;
  caracteresProveedor: number | null;
  modeloDevuelto: string | null;
}

export class ParserNdjson {
  #residuo = '';

  alimentar(chunk: Buffer): TrozoInworld[] {
    this.#residuo += chunk.toString('utf8');
    const trozos: TrozoInworld[] = [];
    let corte: number;
    while ((corte = this.#residuo.indexOf('\n')) >= 0) {
      const linea = this.#residuo.slice(0, corte).trim();
      this.#residuo = this.#residuo.slice(corte + 1);
      const t = this.#parsear(linea);
      if (t) trozos.push(t);
    }
    return trozos;
  }

  rematar(): TrozoInworld[] {
    const t = this.#parsear(this.#residuo.trim());
    this.#residuo = '';
    return t ? [t] : [];
  }

  #parsear(linea: string): TrozoInworld | null {
    if (!linea) return null;
    let datos: unknown;
    try { datos = JSON.parse(linea); } catch { return null; } // línea corrupta: se ignora
    const r = ((datos as { result?: object }).result ?? datos) as {
      audioContent?: string; audio?: string;
      usage?: { processedCharactersCount?: number; modelId?: string };
    };
    const b64 = r.audioContent ?? r.audio;
    let pcm: Buffer | null = null;
    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      pcm = buf.subarray(0, 4).toString('ascii') === 'RIFF' ? buf.subarray(44) : buf;
    }
    return {
      pcm,
      caracteresProveedor: r.usage?.processedCharactersCount ?? null,
      modeloDevuelto: r.usage?.modelId ?? null,
    };
  }
}
