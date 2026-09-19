import { extraerFrases } from './frases.ts';
import { monoAEstereo } from './estereo.ts';
import type { Semaforo } from './semaforo.ts';
import type { Altavoz } from './altavoz.ts';
import type { UsoTts } from './tts-inworld.ts';
import type { Logger } from '../logger.ts';

export interface SintetizadorTts { // lo que ClienteInworld ya cumple; permite el doble de test y cambiar de proveedor
  sintetizar(texto: string, voz: string, onPcm: (pcm: Buffer) => void, señal: AbortSignal): Promise<UsoTts>;
}
export interface ResultadoLocucion {
  estado: 'reproducido' | 'abortado' | 'fallido';
  msPrimerByte: number | null; msAudio: number;
  caracteresProveedor: number | null; modeloDevuelto: string | null;
}

const REINTENTOS_MAX = 2;
const BACKOFF_MS = [500, 1500] as const;

// Locuta un texto completo (ya saneado) en el guild: trocea en frases,
// sintetiza cada una y empuja el PCM al altavoz. Secuencial por diseño: el
// llamante (cola del plan 3) no llama dos veces a la vez para el mismo guild.
export class Locutor {
  // erasableSyntaxOnly prohíbe parameter properties (código verbatim del
  // brief): campo explícito + asignación en el cuerpo del constructor,
  // patrón ya usado en tts-inworld.ts, semaforo.ts y altavoz.ts.
  readonly #tts: SintetizadorTts;
  readonly #semaforo: Semaforo;
  readonly #altavoz: Altavoz;
  readonly #log: Logger;

  constructor(tts: SintetizadorTts, semaforo: Semaforo, altavoz: Altavoz, log: Logger) {
    this.#tts = tts;
    this.#semaforo = semaforo;
    this.#altavoz = altavoz;
    this.#log = log;
  }

  async locutar(guildId: string, texto: string, voz: string, señal: AbortSignal): Promise<ResultadoLocucion> {
    const resultado: ResultadoLocucion = {
      estado: 'reproducido', msPrimerByte: null, msAudio: 0,
      caracteresProveedor: null, modeloDevuelto: null,
    };
    const { frases, resto } = extraerFrases(texto);
    if (resto) frases.push(...extraerFrases(resto, true).frases);

    for (const frase of frases) {
      if (señal.aborted) return { ...resultado, estado: 'abortado' };
      const ok = await this.#sintetizarFrase(guildId, frase, voz, señal, resultado);
      if (!ok) return { ...resultado, estado: señal.aborted ? 'abortado' : 'fallido' };
    }
    await this.#altavoz.rematarLocucion(guildId);
    return resultado;
  }

  async #sintetizarFrase(guildId: string, frase: string, voz: string,
      señal: AbortSignal, r: ResultadoLocucion): Promise<boolean> {
    // La unidad de reintento es la frase, y SOLO si aún no emitió audio:
    // reintentar media frase sonada es oírla dos veces.
    for (let intento = 0; ; intento++) {
      let bytesMono = 0;
      const liberar = await this.#semaforo.adquirir();
      try {
        const uso = await this.#tts.sintetizar(frase, voz, (pcm) => {
          bytesMono += pcm.length;
          this.#altavoz.empujar(guildId, monoAEstereo(pcm));
        }, señal);
        r.msPrimerByte ??= uso.msPrimerByte;
        r.caracteresProveedor = (r.caracteresProveedor ?? 0) + (uso.caracteresProveedor ?? 0);
        r.modeloDevuelto ??= uso.modeloDevuelto;
        r.msAudio += Math.round(bytesMono / 2 / 48); // bytes mono s16 a 48 kHz → ms
        return true;
      } catch (err) {
        if (señal.aborted) return false;
        const puedeReintentar = bytesMono === 0 && intento < REINTENTOS_MAX;
        this.#log.warn({ err: (err as Error).message, frase: frase.slice(0, 40), intento, puedeReintentar }, 'fallo de síntesis');
        if (!puedeReintentar) return false;
        await new Promise((res) => setTimeout(res, BACKOFF_MS[intento] ?? 1500));
      } finally {
        liberar();
      }
    }
  }
}
