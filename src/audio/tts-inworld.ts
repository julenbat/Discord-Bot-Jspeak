import { ParserNdjson } from './ndjson.ts';

export interface Voz { voiceId: string; displayName: string; languages: string[]; description: string }
export interface UsoTts { caracteresProveedor: number | null; modeloDevuelto: string | null; msPrimerByte: number }

const URL_STREAM = 'https://api.inworld.ai/tts/v1/voice:stream';
const URL_VOCES = 'https://api.inworld.ai/tts/v1/voices';

export class ClienteInworld {
  // erasableSyntaxOnly prohíbe parameter properties (`constructor(private
  // readonly cfg: ...)`, código verbatim del brief): campo explícito +
  // asignación en el cuerpo del constructor.
  readonly #cfg: { apiKey: string; modelo: string; idioma: string };

  constructor(cfg: { apiKey: string; modelo: string; idioma: string }) {
    this.#cfg = cfg;
  }

  async sintetizar(texto: string, voz: string, onPcm: (pcm: Buffer) => void, señal: AbortSignal): Promise<UsoTts> {
    const t0 = performance.now();
    const res = await fetch(URL_STREAM, {
      method: 'POST',
      headers: { Authorization: this.#cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: texto, voiceId: voz, modelId: this.#cfg.modelo, language: this.#cfg.idioma,
        audioConfig: { audioEncoding: 'PCM', sampleRateHertz: 48000 },
      }),
      signal: señal,
    });
    if (!res.ok || !res.body) {
      const cuerpo = await res.text().catch(() => '');
      const err = new Error(`Inworld ${res.status}: ${cuerpo.slice(0, 300)}`);
      (err as Error & { status: number }).status = res.status;
      throw err;
    }
    const parser = new ParserNdjson();
    const uso: UsoTts = { caracteresProveedor: null, modeloDevuelto: null, msPrimerByte: -1 };
    const procesar = (t: import('./ndjson.ts').TrozoInworld) => {
      if (t.caracteresProveedor !== null) uso.caracteresProveedor = t.caracteresProveedor;
      if (t.modeloDevuelto !== null) uso.modeloDevuelto = t.modeloDevuelto;
      if (t.pcm?.length) {
        if (uso.msPrimerByte < 0) uso.msPrimerByte = Math.round(performance.now() - t0);
        onPcm(t.pcm);
      }
    };
    for await (const chunk of res.body) {
      if (señal.aborted) return uso;
      parser.alimentar(Buffer.from(chunk)).forEach(procesar);
    }
    parser.rematar().forEach(procesar);
    return uso;
  }

  async listarVoces(): Promise<Voz[]> {
    const res = await fetch(URL_VOCES, { headers: { Authorization: this.#cfg.apiKey } });
    if (!res.ok) throw new Error(`Inworld voces ${res.status}`);
    const data = (await res.json()) as { voices: Voz[] };
    const idiomaCorto = this.#cfg.idioma.split('-')[0]!;
    return data.voices.filter((v) => v.languages.includes(idiomaCorto));
  }
}
