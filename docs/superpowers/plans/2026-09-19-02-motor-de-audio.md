# Plan 2/3 — Motor de audio: texto → voz en un canal de Discord

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dado un texto, una voz y un canal de voz, el bot entra y lo locuta en streaming: Inworld (PCM 48 kHz mono) → estéreo → Opus (opusscript) → canal. Termina con un script de humo que locuta una frase en un canal real.

**Architecture:** Capa de audio pura (frases, estéreo, parseo NDJSON: funciones sin E/S, testeadas a fondo) + adaptadores con E/S (cliente Inworld, altavoz de Discord). El altavoz mantiene **una** conexión y **un** encoder de larga vida por guild; la cadencia de tramas la pone `@discordjs/voice`, no nosotros (dos relojes con deriva independiente se oyen).

**Tech Stack:** `discord.js`, `@discordjs/voice`, `opusscript@0.0.8` **exacto** (peer de prism-media `^0.0.8`; la 0.1.1 rompe `npm ci` solo dentro de Docker), `fetch` nativo contra Inworld.

**Spec:** `ESPECIFICACION.md` §5 (filas Opus, Inworld, Concurrencia TTS, Cancelación, Player) y §3 pasos 5-6. Datos medidos 2026-09-19: 48 kHz reales, TTFB 276 ms, catálogo en `GET /tts/v1/voices` con esquema `{languages, voiceId, displayName, description, tags, isCustom}`.

## Global Constraints

- Las del plan 1 (rtk, castellano, sin `enum`/decoradores, imports `.ts`, snowflakes como `string`).
- Trama de Discord: 20 ms = 960 muestras/canal = **3840 bytes** de PCM s16le estéreo 48 kHz.
- Al dejar de hablar: **5 tramas de silencio** antes de soltar el player (evita interpolación de Opus).
- Todo callback que empuje audio comprueba su **epoch** antes de empujar (cancelación real).
- Jamás reintentar una frase que ya emitió audio (el oyente la escucharía dos veces).
- `.delete()` del encoder al destruir la conexión: un encoder por locución agota el heap WASM en la locución ~55.

---

### Task 1: Troceo en frases (`frases.ts`)

**Files:**
- Create: `src/audio/frases.ts`
- Test: `test/frases.test.ts`

**Interfaces:**
- Produces: `extraerFrases(texto: string, forzar?: boolean): { frases: string[]; resto: string }` — port tipado de `sentences.js` del voice-agent (leído en ionos), misma semántica: frases <10 caracteres se arrastran como prefijo de la siguiente; parrafadas sin puntuación se cortan por la última coma pasados 120 caracteres; `forzar` vuelca lo pendiente.

- [ ] **Step 1: Test que falla**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraerFrases } from '../src/audio/frases.ts';

test('corta por puntuación y arrastra frases cortas', () => {
  const r = extraerFrases('Vale. Esto es una frase completa que sí se emite. Y esto queda');
  assert.deepEqual(r.frases, ['Vale. Esto es una frase completa que sí se emite.']);
  assert.equal(r.resto, 'Y esto queda');
});

test('parrafada sin puntuación corta por la última coma pasados 120', () => {
  const largo = 'palabra '.repeat(14) + ', ' + 'palabra '.repeat(14) + 'y sigue sin terminar nunca';
  const r = extraerFrases(largo);
  assert.equal(r.frases.length, 1);
  assert.ok(r.frases[0]!.endsWith(','));
});

test('forzar vuelca el resto', () => {
  assert.deepEqual(extraerFrases('sin puntuacion final', true).frases, ['sin puntuacion final']);
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/frases.test.ts` → FAIL.

- [ ] **Step 3: Implementación** — traducción directa del `sentences.js` heredado con tipos:

```ts
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
```

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/frases.test.ts` → PASS.
- [ ] **Step 5: Commit** — `rtk git commit -am "feat: troceo de texto en frases (port tipado del voice-agent)"`

---

### Task 2: Mono → estéreo (`estereo.ts`)

**Files:**
- Create: `src/audio/estereo.ts`
- Test: `test/estereo.test.ts`

**Interfaces:**
- Produces: `monoAEstereo(mono: Buffer): Buffer` — duplica cada muestra s16le. Entrada de N bytes → salida de 2N. Si N es impar, el último byte huérfano se descarta (un chunk de red puede partir una muestra; el llamante reagrupa).
- Produces: `const BYTES_TRAMA = 3840` y `const MS_TRAMA = 20`.

- [ ] **Step 1: Test que falla**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monoAEstereo, BYTES_TRAMA } from '../src/audio/estereo.ts';

test('duplica cada muestra de 16 bits', () => {
  const mono = Buffer.from([0x01, 0x02, 0x03, 0x04]); // muestras 0x0201, 0x0403
  assert.deepEqual([...monoAEstereo(mono)], [0x01, 0x02, 0x01, 0x02, 0x03, 0x04, 0x03, 0x04]);
});

test('byte impar sobrante se descarta', () => {
  assert.equal(monoAEstereo(Buffer.from([1, 2, 3])).length, 4);
});

test('la constante de trama es la de Discord', () => {
  assert.equal(BYTES_TRAMA, 48000 / 1000 * 20 * 2 * 2); // 48 kHz · 20 ms · 16 bits · 2 canales
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/estereo.test.ts` → FAIL.
- [ ] **Step 3: Implementación**

```ts
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
```

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/estereo.test.ts` → PASS.
- [ ] **Step 5: Commit** — `rtk git commit -am "feat: conversión mono a estéreo y constantes de trama"`

---

### Task 3: Parseo NDJSON de Inworld (puro) + cliente con E/S

**Files:**
- Create: `src/audio/ndjson.ts`, `src/audio/tts-inworld.ts`
- Test: `test/ndjson.test.ts`

**Interfaces:**
- Produces (`ndjson.ts`, puro): `class ParserNdjson { alimentar(chunk: Buffer): TrozoInworld[]; rematar(): TrozoInworld[] }` con `interface TrozoInworld { pcm: Buffer | null; caracteresProveedor: number | null; modeloDevuelto: string | null }`. Quita cabecera RIFF defensivamente. Las líneas incompletas quedan en el residuo hasta el siguiente chunk.
- Produces (`tts-inworld.ts`): 

```ts
export interface Voz { voiceId: string; displayName: string; languages: string[]; description: string }
export interface UsoTts { caracteresProveedor: number | null; modeloDevuelto: string | null; msPrimerByte: number }
export class ClienteInworld {
  constructor(cfg: { apiKey: string; modelo: string; idioma: string }) {}
  sintetizar(texto: string, voz: string, onPcm: (pcm: Buffer) => void, señal: AbortSignal): Promise<UsoTts>;
  listarVoces(): Promise<Voz[]>; // GET /tts/v1/voices, filtradas por el idioma configurado
}
```

- [ ] **Step 1: Test del parser que falla** (con fixtures reales de la forma medida en el prototipo)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParserNdjson } from '../src/audio/ndjson.ts';

const linea = (pcm: Buffer, extra = {}) => JSON.stringify({
  result: { audioContent: pcm.toString('base64'), ...extra } }) + '\n';

test('línea partida entre dos chunks se reconstruye', () => {
  const p = new ParserNdjson();
  const l = linea(Buffer.from([1, 2, 3, 4]));
  const corte = Math.floor(l.length / 2);
  assert.equal(p.alimentar(Buffer.from(l.slice(0, corte))).length, 0);
  const trozos = p.alimentar(Buffer.from(l.slice(corte)));
  assert.deepEqual([...trozos[0]!.pcm!], [1, 2, 3, 4]);
});

test('cabecera RIFF se quita defensivamente', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.from([9, 9])]);
  const p = new ParserNdjson();
  const trozos = p.alimentar(Buffer.from(linea(wav)));
  assert.deepEqual([...trozos[0]!.pcm!], [9, 9]);
});

test('usage y modelId se capturan; rematar vuelca la última línea sin \\n', () => {
  const p = new ParserNdjson();
  const sinSalto = JSON.stringify({ result: { usage: { processedCharactersCount: 42, modelId: 'inworld-tts-2' } } });
  assert.equal(p.alimentar(Buffer.from(sinSalto)).length, 0);
  const trozos = p.rematar();
  assert.equal(trozos[0]!.caracteresProveedor, 42);
  assert.equal(trozos[0]!.modeloDevuelto, 'inworld-tts-2');
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/ndjson.test.ts` → FAIL.

- [ ] **Step 3: Implementación**

`src/audio/ndjson.ts`:
```ts
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
```

`src/audio/tts-inworld.ts`:
```ts
import { ParserNdjson } from './ndjson.ts';

export interface Voz { voiceId: string; displayName: string; languages: string[]; description: string }
export interface UsoTts { caracteresProveedor: number | null; modeloDevuelto: string | null; msPrimerByte: number }

const URL_STREAM = 'https://api.inworld.ai/tts/v1/voice:stream';
const URL_VOCES = 'https://api.inworld.ai/tts/v1/voices';

export class ClienteInworld {
  constructor(private readonly cfg: { apiKey: string; modelo: string; idioma: string }) {}

  async sintetizar(texto: string, voz: string, onPcm: (pcm: Buffer) => void, señal: AbortSignal): Promise<UsoTts> {
    const t0 = performance.now();
    const res = await fetch(URL_STREAM, {
      method: 'POST',
      headers: { Authorization: this.cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: texto, voiceId: voz, modelId: this.cfg.modelo, language: this.cfg.idioma,
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
    const res = await fetch(URL_VOCES, { headers: { Authorization: this.cfg.apiKey } });
    if (!res.ok) throw new Error(`Inworld voces ${res.status}`);
    const data = (await res.json()) as { voices: Voz[] };
    const idiomaCorto = this.cfg.idioma.split('-')[0]!;
    return data.voices.filter((v) => v.languages.includes(idiomaCorto));
  }
}
```

- [ ] **Step 4: Verificar** — Run: `rtk node --test test/ndjson.test.ts && rtk npm run check` → PASS.
- [ ] **Step 5: Commit** — `rtk git commit -am "feat: cliente Inworld en streaming con parser NDJSON testeado"`

---

### Task 4: Semáforo de síntesis

**Files:**
- Create: `src/audio/semaforo.ts`
- Test: `test/semaforo.test.ts`

**Interfaces:**
- Produces: `class Semaforo { constructor(limite: number); adquirir(): Promise<() => void>; enUso(): number; esperando(): number }` — el limitador global delante de Inworld (On-Demand limita 5/cuenta; nosotros 3 por defecto). El liberador devuelto es idempotente.

- [ ] **Step 1: Test que falla**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaforo } from '../src/audio/semaforo.ts';

test('limita la concurrencia y respeta el orden FIFO', async () => {
  const s = new Semaforo(2);
  const l1 = await s.adquirir();
  const l2 = await s.adquirir();
  let tercero = false;
  const p3 = s.adquirir().then((l) => { tercero = true; return l; });
  await new Promise((r) => setImmediate(r));
  assert.equal(tercero, false);
  assert.equal(s.esperando(), 1);
  l1();
  l1(); // liberar dos veces no abre hueco extra
  const l3 = await p3;
  assert.equal(tercero, true);
  assert.equal(s.enUso(), 2);
  l2(); l3();
  assert.equal(s.enUso(), 0);
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/semaforo.test.ts` → FAIL.
- [ ] **Step 3: Implementación**

```ts
// Limitador FIFO delante del proveedor de TTS: la cuenta de Inworld tiene un
// tope de peticiones simultáneas y superarlo es un 429 sin procesar.
export class Semaforo {
  #enUso = 0;
  #cola: Array<() => void> = [];
  constructor(private readonly limite: number) {}

  enUso(): number { return this.#enUso; }
  esperando(): number { return this.#cola.length; }

  async adquirir(): Promise<() => void> {
    if (this.#enUso < this.limite) this.#enUso++;
    else await new Promise<void>((r) => this.#cola.push(r));
    let liberado = false;
    return () => {
      if (liberado) return; liberado = true;
      const siguiente = this.#cola.shift();
      if (siguiente) siguiente();      // el hueco pasa directo al siguiente
      else this.#enUso--;
    };
  }
}
```

Nota: cuando se usa `adquirir()` tras esperar en cola, el hueco ya viene contado (`#enUso` no baja al ceder). El test lo cubre con `enUso() === 2` tras el relevo.

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/semaforo.test.ts` → PASS.
- [ ] **Step 5: Commit** — `rtk git commit -am "feat: semáforo FIFO para la concurrencia de síntesis"`

---

### Task 5: Altavoz por guild (conexión + player + encoder de larga vida)

**Files:**
- Create: `src/audio/altavoz.ts`
- Test: `rtk npm run check` + el humo de la Task 6 (esta pieza es toda E/S contra Discord; el valor testeable a máquina está en las tareas 1-4)

**Interfaces:**
- Consumes: `BYTES_TRAMA` de `estereo.ts`.
- Produces:

```ts
export class Altavoz {
  constructor(log: Logger) {}
  // Single-flight: N llamadas concurrentes al mismo guild comparten una promesa.
  conectar(canal: VoiceBasedChannel): Promise<void>;
  canalActualId(guildId: string): string | null;
  // Empuja PCM estéreo 48 kHz de la locución en curso.
  empujar(guildId: string, pcm: Buffer): void;
  // Fin de locución: rellena hasta múltiplo de trama y resuelve cuando el player queda Idle.
  rematarLocucion(guildId: string): Promise<void>;
  // Corta ya: para el player y descarta lo no reproducido.
  cortar(guildId: string): void;
  // 5 tramas de silencio → destroy de la conexión → encoder.delete().
  desconectar(guildId: string): Promise<void>;
}
```

- [ ] **Step 1: Instalar dependencias de voz**

Run: `rtk npm install discord.js @discordjs/voice opusscript@0.0.8`
Después `rtk grep '"opusscript"' package.json` → versión **exacta** `"0.0.8"` (sin `^`; editar a mano si npm lo añadió). Commit del lockfile incluido.

- [ ] **Step 2: Implementación**

```ts
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, StreamType,
  type VoiceConnection, type AudioPlayer,
} from '@discordjs/voice';
import { PassThrough } from 'node:stream';
import type { VoiceBasedChannel } from 'discord.js';
import { BYTES_TRAMA } from './estereo.ts';
import type { Logger } from '../logger.ts';

interface EstadoGuild {
  conexion: VoiceConnection;
  player: AudioPlayer;
  tubo: PassThrough;         // PCM crudo → recurso de larga vida (un solo encoder por guild)
  canalId: string;
  bytesLocucion: number;
}

// El recurso de audio es UNO por conexión y vive lo que ella: crear uno por
// locución crea un encoder de opusscript por locución, y su heap WASM
// se agota (~55 locuciones, medido). El re-paceo de tramas lo hace
// @discordjs/voice; aquí no hay ningún reloj propio.
export class Altavoz {
  #porGuild = new Map<string, EstadoGuild>();
  #conectando = new Map<string, Promise<void>>(); // single-flight

  constructor(private readonly log: Logger) {}

  canalActualId(guildId: string): string | null {
    return this.#porGuild.get(guildId)?.canalId ?? null;
  }

  async conectar(canal: VoiceBasedChannel): Promise<void> {
    const guildId = canal.guild.id;
    const actual = this.#porGuild.get(guildId);
    if (actual?.canalId === canal.id) return;
    const enVuelo = this.#conectando.get(guildId);
    if (enVuelo) return enVuelo;

    const promesa = this.#conectarDeVerdad(canal).finally(() => this.#conectando.delete(guildId));
    this.#conectando.set(guildId, promesa);
    return promesa;
  }

  async #conectarDeVerdad(canal: VoiceBasedChannel): Promise<void> {
    const guildId = canal.guild.id;
    await this.desconectar(guildId); // nunca dos conexiones al mismo guild
    const conexion = joinVoiceChannel({
      channelId: canal.id, guildId,
      adapterCreator: canal.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 25 },
    });
    conexion.subscribe(player);

    // Movido o expulsado: distinguir "me están cambiando de canal" (vuelve a
    // Ready solo) de "me han echado" con una carrera corta; si es expulsión,
    // limpiar y esperar al siguiente mensaje. Nunca volver por iniciativa propia.
    conexion.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conexion, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conexion, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.log.info({ guildId }, 'expulsado del canal de voz; limpiando');
        void this.desconectar(guildId);
      }
    });

    await entersState(conexion, VoiceConnectionStatus.Ready, 20_000);

    const tubo = new PassThrough({ highWaterMark: BYTES_TRAMA * 250 }); // ~5 s de colchón
    player.play(createAudioResource(tubo, { inputType: StreamType.Raw }));
    this.#porGuild.set(guildId, { conexion, player, tubo, canalId: canal.id, bytesLocucion: 0 });
  }

  empujar(guildId: string, pcm: Buffer): void {
    const e = this.#porGuild.get(guildId);
    if (!e) return; // conexión muerta entre síntesis y reproducción: se descarta
    e.bytesLocucion += pcm.length;
    e.tubo.write(pcm);
  }

  async rematarLocucion(guildId: string): Promise<void> {
    const e = this.#porGuild.get(guildId);
    if (!e) return;
    const resto = e.bytesLocucion % BYTES_TRAMA;
    if (resto) e.tubo.write(Buffer.alloc(BYTES_TRAMA - resto)); // silencio hasta cerrar la trama
    e.bytesLocucion = 0;
    // Fin real = el player se queda sin datos. Con el tubo aún abierto no
    // pasa a Idle, así que esperamos a que el buffer interno se drene.
    await new Promise<void>((resolver) => {
      const mirar = () => {
        if (!this.#porGuild.has(guildId) || e.tubo.readableLength === 0) return resolver();
        setTimeout(mirar, 40);
      };
      mirar();
    });
  }

  cortar(guildId: string): void {
    const e = this.#porGuild.get(guildId);
    if (!e) return;
    // Vaciar el tubo descartando lo no reproducido; el player sigue vivo
    // para la siguiente locución.
    e.tubo.read(e.tubo.readableLength);
    e.bytesLocucion = 0;
  }

  async desconectar(guildId: string): Promise<void> {
    const e = this.#porGuild.get(guildId);
    if (!e) return;
    this.#porGuild.delete(guildId);
    // 5 tramas de silencio para que Opus no interpole con la siguiente vez.
    for (let i = 0; i < 5; i++) e.tubo.write(Buffer.alloc(BYTES_TRAMA));
    await new Promise((r) => setTimeout(r, 120));
    e.tubo.destroy();
    e.player.stop(true);
    e.conexion.destroy(); // destroy() del recurso libera el encoder de opusscript
  }
}
```

- [ ] **Step 3: Puerta de tipos** — Run: `rtk npm run check` → sin errores.
- [ ] **Step 4: Commit** — `rtk git commit -am "feat: altavoz por guild con encoder de larga vida y single-flight"`

---

### Task 6: Locutor (orquesta frase → síntesis → altavoz) + humo real

**Files:**
- Create: `src/audio/locutor.ts`, `scripts/humo-voz.ts`
- Test: `test/locutor.test.ts` (con TTS falso) + humo manual en un canal real

**Interfaces:**
- Consumes: `extraerFrases`, `monoAEstereo`, `ClienteInworld` (o cualquier `SintetizadorTts`), `Semaforo`, `Altavoz`.
- Produces:

```ts
export interface SintetizadorTts { // lo que ClienteInworld ya cumple; permite el doble de test y cambiar de proveedor
  sintetizar(texto: string, voz: string, onPcm: (pcm: Buffer) => void, señal: AbortSignal): Promise<UsoTts>;
}
export interface ResultadoLocucion {
  estado: 'reproducido' | 'abortado' | 'fallido';
  msPrimerByte: number | null; msAudio: number; caracteresProveedor: number | null; modeloDevuelto: string | null;
}
export class Locutor {
  constructor(tts: SintetizadorTts, semaforo: Semaforo, altavoz: Altavoz, log: Logger) {}
  // Locuta un texto completo (ya saneado) en el guild. Secuencial por diseño:
  // el llamante (cola del plan 3) no llama dos veces a la vez para el mismo guild.
  locutar(guildId: string, texto: string, voz: string, señal: AbortSignal): Promise<ResultadoLocucion>;
}
```

- [ ] **Step 1: Test con sintetizador falso que falla**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Locutor } from '../src/audio/locutor.ts';
import { Semaforo } from '../src/audio/semaforo.ts';
import { crearLogger } from '../src/logger.ts';

// Altavoz falso: acumula lo empujado, remata al instante.
function altavozFalso() {
  const empujado: Buffer[] = [];
  return {
    empujado,
    empujar: (_g: string, pcm: Buffer) => { empujado.push(pcm); },
    rematarLocucion: async () => {}, cortar: () => {},
    conectar: async () => {}, desconectar: async () => {}, canalActualId: () => 'c',
  };
}

test('trocea en frases, sintetiza en orden y convierte a estéreo', async () => {
  const llamadas: string[] = [];
  const tts = {
    async sintetizar(texto: string, _v: string, onPcm: (b: Buffer) => void) {
      llamadas.push(texto);
      onPcm(Buffer.from([1, 0, 2, 0])); // 2 muestras mono
      return { caracteresProveedor: texto.length, modeloDevuelto: 'm', msPrimerByte: 5 };
    },
  };
  const alt = altavozFalso();
  const locutor = new Locutor(tts, new Semaforo(1), alt as never, crearLogger('silent', 'UTC'));
  const r = await locutor.locutar('g', 'Primera frase completa aquí. Segunda frase completa aquí.', 'Marta', new AbortController().signal);
  assert.equal(r.estado, 'reproducido');
  assert.equal(llamadas.length, 2);
  assert.equal(alt.empujado[0]!.length, 8); // estéreo: 2 muestras → 8 bytes
});

test('el fallo con audio ya emitido NO se reintenta', async () => {
  let intentos = 0;
  const tts = {
    async sintetizar(_t: string, _v: string, onPcm: (b: Buffer) => void) {
      intentos++;
      onPcm(Buffer.from([1, 0]));
      throw Object.assign(new Error('corte a mitad'), { status: 500 });
    },
  };
  const locutor = new Locutor(tts, new Semaforo(1), altavozFalso() as never, crearLogger('silent', 'UTC'));
  const r = await locutor.locutar('g', 'Frase única suficientemente larga.', 'Marta', new AbortController().signal);
  assert.equal(r.estado, 'fallido');
  assert.equal(intentos, 1); // sin reintento: ya sonó media frase
});

test('abortar devuelve estado abortado sin seguir sintetizando', async () => {
  const control = new AbortController();
  const tts = {
    async sintetizar(_t: string, _v: string, _onPcm: (b: Buffer) => void, señal: AbortSignal) {
      control.abort(); // se aborta durante la primera frase
      señal.throwIfAborted();
      return { caracteresProveedor: 0, modeloDevuelto: null, msPrimerByte: 0 };
    },
  };
  const locutor = new Locutor(tts, new Semaforo(1), altavozFalso() as never, crearLogger('silent', 'UTC'));
  const r = await locutor.locutar('g', 'Primera frase completa aquí. Segunda que no debe llegar.', 'Marta', control.signal);
  assert.equal(r.estado, 'abortado');
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/locutor.test.ts` → FAIL.

- [ ] **Step 3: Implementación**

```ts
import { extraerFrases } from './frases.ts';
import { monoAEstereo } from './estereo.ts';
import type { Semaforo } from './semaforo.ts';
import type { Altavoz } from './altavoz.ts';
import type { UsoTts } from './tts-inworld.ts';
import type { Logger } from '../logger.ts';

export interface SintetizadorTts {
  sintetizar(texto: string, voz: string, onPcm: (pcm: Buffer) => void, señal: AbortSignal): Promise<UsoTts>;
}
export interface ResultadoLocucion {
  estado: 'reproducido' | 'abortado' | 'fallido';
  msPrimerByte: number | null; msAudio: number;
  caracteresProveedor: number | null; modeloDevuelto: string | null;
}

const REINTENTOS_MAX = 2;
const BACKOFF_MS = [500, 1500] as const;

export class Locutor {
  constructor(
    private readonly tts: SintetizadorTts,
    private readonly semaforo: Semaforo,
    private readonly altavoz: Altavoz,
    private readonly log: Logger,
  ) {}

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
    await this.altavoz.rematarLocucion(guildId);
    return resultado;
  }

  async #sintetizarFrase(guildId: string, frase: string, voz: string,
      señal: AbortSignal, r: ResultadoLocucion): Promise<boolean> {
    // La unidad de reintento es la frase, y SOLO si aún no emitió audio:
    // reintentar media frase sonada es oírla dos veces.
    for (let intento = 0; ; intento++) {
      let bytesMono = 0;
      const liberar = await this.semaforo.adquirir();
      try {
        const uso = await this.tts.sintetizar(frase, voz, (pcm) => {
          bytesMono += pcm.length;
          this.altavoz.empujar(guildId, monoAEstereo(pcm));
        }, señal);
        r.msPrimerByte ??= uso.msPrimerByte;
        r.caracteresProveedor = (r.caracteresProveedor ?? 0) + (uso.caracteresProveedor ?? 0);
        r.modeloDevuelto ??= uso.modeloDevuelto;
        r.msAudio += Math.round(bytesMono / 2 / 48); // bytes mono s16 a 48 kHz → ms
        return true;
      } catch (err) {
        if (señal.aborted) return false;
        const puedeReintentar = bytesMono === 0 && intento < REINTENTOS_MAX;
        this.log.warn({ err: (err as Error).message, frase: frase.slice(0, 40), intento, puedeReintentar }, 'fallo de síntesis');
        if (!puedeReintentar) return false;
        await new Promise((res) => setTimeout(res, BACKOFF_MS[intento] ?? 1500));
      } finally {
        liberar();
      }
    }
  }
}
```

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/locutor.test.ts && rtk npm run check` → PASS.

- [ ] **Step 5: Script de humo contra Discord real**

`scripts/humo-voz.ts` — se ejecuta a mano con el bot invitado a un servidor de pruebas:

```ts
// Humo: node scripts/humo-voz.ts <guildId> <canalVozId> "texto"
// Verifica el pipeline entero contra Discord e Inworld reales.
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { cargarConfig } from '../src/config.ts';
import { crearLogger } from '../src/logger.ts';
import { ClienteInworld } from '../src/audio/tts-inworld.ts';
import { Semaforo } from '../src/audio/semaforo.ts';
import { Altavoz } from '../src/audio/altavoz.ts';
import { Locutor } from '../src/audio/locutor.ts';

const [guildId, canalId, texto] = process.argv.slice(2);
if (!guildId || !canalId || !texto) { console.error('uso: humo-voz <guildId> <canalId> "texto"'); process.exit(1); }

const config = cargarConfig(process.env);
const log = crearLogger('debug', config.tz);
console.log(generateDependencyReport()); // diagnóstico de "se conecta pero no se oye"

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.once('clientReady', async () => {
  const canal = await client.channels.fetch(canalId!);
  if (canal?.type !== ChannelType.GuildVoice) { console.error('no es un canal de voz'); process.exit(1); }
  const altavoz = new Altavoz(log);
  const locutor = new Locutor(new ClienteInworld({
    apiKey: config.inworldApiKey, modelo: config.inworldModel, idioma: config.inworldLanguage,
  }), new Semaforo(config.ttsConcurrencia), altavoz, log);
  const t0 = performance.now();
  await altavoz.conectar(canal);
  const r = await locutor.locutar(guildId!, texto!, 'Marta', new AbortController().signal);
  log.info({ ...r, msTotal: Math.round(performance.now() - t0) }, 'humo terminado');
  await altavoz.desconectar(guildId!);
  await client.destroy();
});
await client.login(config.discordToken);
```

Run: `rtk node scripts/humo-voz.ts <guild> <canal> "Hola, esto es una prueba del motor de audio."`
Expected: el bot entra al canal, se oye la frase con la voz Marta, sale, y el log da `estado: reproducido` con `msPrimerByte` en el orden de 300 ms. **Criterio de "hecho" del plan entero.**

- [ ] **Step 6: Commit** — `rtk git add -A && rtk git commit -m "feat: locutor con reintento por frase y humo real contra Discord"`

---

## Self-Review (hecho al escribir el plan)

- Cobertura: §5 Opus (T5), Inworld (T3), Concurrencia (T4 + reintento en T6), Cancelación parcial (señal + `cortar`; el EPOCH completo y `pararTodo` viven en el plan 3 donde está la sesión), Player (T5).
- Tipos: `UsoTts` definido en T3 y consumido en T6; `SintetizadorTts` es la interfaz que el plan 3 usa para cablear; `BYTES_TRAMA` única fuente (T2).
- El circuit breaker por guild (3 fallos → 30 s) se implementa en el plan 3 junto a los avisos, porque necesita el canal de texto para avisar al usuario.
