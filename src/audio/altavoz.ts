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

  // erasableSyntaxOnly prohíbe parameter properties (`constructor(private
  // readonly log: Logger)`, código verbatim del brief): campo explícito +
  // asignación en el cuerpo del constructor, patrón ya usado en
  // tts-inworld.ts y semaforo.ts.
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

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

    // Nada de lo que se crea aquí entra en #porGuild hasta la ÚLTIMA línea, y
    // #porGuild es el único sitio del que desconectar()/cortar() sacan sus
    // referencias. Si `entersState(Ready, 20 s)` lanza (timeout, permisos,
    // aforo, canal de escenario) y no se limpiara a mano, esa conexión se
    // quedaría viva y sin dueño: un bot fantasma dentro del canal que nadie
    // puede destruir hasta reiniciar el proceso. De ahí el try/catch.
    let conexion: VoiceConnection | undefined;
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 25 },
    });
    try {
      const con = joinVoiceChannel({
        channelId: canal.id, guildId,
        adapterCreator: canal.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      conexion = con;
      con.subscribe(player);

      // Movido o expulsado: distinguir "me están cambiando de canal" (vuelve a
      // Ready solo) de "me han echado" con una carrera corta; si es expulsión,
      // limpiar y esperar al siguiente mensaje. Nunca volver por iniciativa propia.
      con.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(con, VoiceConnectionStatus.Signalling, 5_000),
            entersState(con, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          this.#log.info({ guildId }, 'expulsado del canal de voz; limpiando');
          void this.desconectar(guildId);
        }
      });

      await entersState(con, VoiceConnectionStatus.Ready, 20_000);

      const tubo = new PassThrough({ highWaterMark: BYTES_TRAMA * 250 }); // ~5 s de colchón
      player.play(createAudioResource(tubo, { inputType: StreamType.Raw }));
      this.#porGuild.set(guildId, { conexion: con, player, tubo, canalId: canal.id, bytesLocucion: 0 });
    } catch (err) {
      // stop(true) es lo único que dispara el .delete() del encoder de
      // opusscript; destroy() saca al bot del canal. Ambos toleran mal que se
      // les llame dos veces, así que van blindados.
      try { player.stop(true); } catch { /* ya parado */ }
      try { conexion?.destroy(); } catch { /* ya destruida */ }
      this.#log.warn({ err: (err as Error).message, guildId, canalId: canal.id },
        'no se pudo establecer la conexión de voz; conexión y player destruidos');
      throw err;
    }
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
