import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, StreamType,
  type VoiceConnection, type AudioPlayer,
} from '@discordjs/voice';
import { PassThrough } from 'node:stream';
import type { VoiceBasedChannel } from 'discord.js';
import { BYTES_TRAMA, MS_TRAMA } from './estereo.ts';
import type { Logger } from '../logger.ts';

interface EstadoGuild {
  conexion: VoiceConnection;
  player: AudioPlayer;
  tuboActual: PassThrough | null; // PCM de la locución EN CURSO; null entre locuciones
  canalId: string;
  bytesLocucion: number;
}

// Un AudioResource por LOCUCIÓN, no uno de larga vida por conexión.
//
// El recurso único era un error con síntoma en producción: la primera
// locución sonaba y las siguientes no. Un AudioResource no es reutilizable, y
// el player lo da por muerto en cuanto se queda sin datos: _stepDispatch()
// cuenta `missedFrames` mientras `resource.read()` devuelve null, y al llegar
// a `maxMissedFrames` llama a stop() → 5 tramas de silencio → Idle → el setter
// de `state` hace `playStream.destroy()`. Con un tubo de larga vida bastaba un
// hueco entre locuciones (el silencio natural entre dos mensajes) para que el
// recurso muriera; a partir de ahí el PCM se escribía en un PassThrough ya
// destruido que nadie leía, y rematarLocucion() —que esperaba a
// `readableLength === 0`— se quedaba colgada para siempre con lo que quedó en
// el buffer, bloqueando el bombeo del orquestador.
//
// El miedo histórico a crear un recurso por locución era la fuga del heap WASM
// de opusscript (muere sobre los 55 encoders creados sin liberar). No aplica:
// @discordjs/voice SÍ libera. Cuando el pipeline del recurso termina o se
// destruye, prism-media ejecuta `_final`/`_destroy` → `_cleanup()` →
// `encoder.delete()` (node_modules/prism-media/src/opus/Opus.js:108-123), y el
// player destruye el playStream del recurso viejo en cuanto cambia de estado
// (setter de `state`, index.js:431). Es decir: `tubo.end()` al rematar y
// `player.stop(true)` al cortar liberan cada encoder. El patrón idiomático
// —un recurso por locución— no fuga.
//
// El re-paceo de tramas lo sigue haciendo @discordjs/voice; aquí no hay
// ningún reloj propio.
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
    // maxMissedFrames ya NO marca el final de la locución —eso lo hace
    // `tubo.end()` en rematarLocucion()—, solo es el perro guardián de un
    // stream atascado. Por eso es generoso (5 s): un hueco entre frases
    // mientras Inworld contesta no debe matar el recurso a media locución.
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 250 },
    });
    // El AudioPlayer es un EventEmitter: un 'error' sin oyente (el que emite
    // onStreamError cuando se destruye el playStream a media reproducción,
    // index.js:480) tumbaría el proceso entero. Se registra y se sigue.
    player.on('error', (err) => {
      this.#log.warn({ err: err.message, guildId }, 'error del reproductor de audio; se descarta el recurso');
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

      // Sin tubo ni recurso todavía: los crea el primer empujar().
      this.#porGuild.set(guildId, { conexion: con, player, tuboActual: null, canalId: canal.id, bytesLocucion: 0 });
    } catch (err) {
      // stop(true) destruye el recurso en curso (y con él el encoder de
      // opusscript); destroy() saca al bot del canal. Ambos toleran mal que se
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
    let tubo = e.tuboActual;
    // Un tubo solo vale mientras su recurso siga vivo. Si el player ya está en
    // Idle (perro guardián, error de stream, un stop ajeno) o el tubo está
    // cerrado, escribir ahí es escribir en un stream que nadie lee: se tira y
    // se abre locución nueva. Este es exactamente el agujero que dejaba mudo
    // al bot cuando el recurso era único.
    if (tubo && (tubo.destroyed || tubo.writableEnded || e.player.state.status === AudioPlayerStatus.Idle)) {
      this.#log.warn({ guildId }, 'el recurso de la locución en curso ya no estaba vivo; se abre uno nuevo');
      if (!tubo.destroyed) tubo.destroy();
      tubo = null;
      e.bytesLocucion = 0;
    }
    if (!tubo) {
      tubo = new PassThrough({ highWaterMark: BYTES_TRAMA * 250 }); // ~5 s de colchón
      e.tuboActual = tubo;
      e.bytesLocucion = 0;
      e.player.play(createAudioResource(tubo, { inputType: StreamType.Raw }));
    }
    e.bytesLocucion += pcm.length;
    tubo.write(pcm);
  }

  async rematarLocucion(guildId: string): Promise<void> {
    const e = this.#porGuild.get(guildId);
    const tubo = e?.tuboActual;
    if (!e || !tubo) return; // nada que rematar (locución sin audio, o ya cortada)

    const resto = e.bytesLocucion % BYTES_TRAMA;
    const relleno = resto ? BYTES_TRAMA - resto : 0;
    if (relleno) tubo.write(Buffer.alloc(relleno)); // silencio hasta cerrar la trama
    const msEstimados = ((e.bytesLocucion + relleno) / BYTES_TRAMA) * MS_TRAMA;
    e.bytesLocucion = 0;

    // Fin REAL del stream: el player drena lo que quede, reproduce las 5
    // tramas de silencio de relleno del recurso (silencePaddingFrames, que
    // evitan que Opus interpole con la locución siguiente) y pasa a Idle él
    // solo. Ya no dependemos de que se pierdan tramas.
    tubo.end();
    try {
      // Cota superior generosa: todo lo escrito a tiempo real + margen. Si
      // salta, se avisa y se sigue: colgar el bombeo del orquestador por una
      // locución es mucho peor que solapar audio.
      await entersState(e.player, AudioPlayerStatus.Idle, Math.round(msEstimados) + 10_000);
    } catch {
      this.#log.warn({ guildId, msEstimados: Math.round(msEstimados) },
        'la locución no llegó a Idle dentro del plazo; se continúa igualmente');
    }
    if (e.tuboActual === tubo) e.tuboActual = null; // salvo que cortar/desconectar ya lo hicieran
  }

  cortar(guildId: string): void {
    const e = this.#porGuild.get(guildId);
    if (!e) return;
    const tubo = e.tuboActual;
    if (!tubo) return; // entre locuciones no hay nada que cortar
    e.tuboActual = null;
    e.bytesLocucion = 0;
    // stop(true) ANTES de destruir el tubo: deja el player en Idle, que es lo
    // que desengancha onStreamError y destruye el recurso (y libera su
    // encoder). Destruir primero la fuente haría que el error del pipeline
    // subiera como 'error' del player. El tubo se destruye después por si el
    // recurso ni había llegado a arrancar. El player queda listo para la
    // locución siguiente: el próximo empujar() le da recurso nuevo.
    e.player.stop(true);
    if (!tubo.destroyed) tubo.destroy();
  }

  // El apagado ordenado (SIGTERM de `docker compose stop`) tiene que pasar
  // por aquí: desconectar() es lo ÚNICO que emite las 5 tramas de silencio,
  // hace el player.stop(true) que destruye el recurso (y con él el encoder de
  // opusscript) y destruye la conexión (ESPECIFICACION §5, fila Apagado).
  // Recorre una COPIA de las claves porque desconectar() borra del Map, y va
  // en paralelo para no sumar los 120 ms de cada guild contra el tope duro de
  // 8 s de main.ts. Cubre también los guilds con conexión pero sin sesión
  // viva en el orquestador, que de otro modo se quedarían dentro del canal.
  async desconectarTodos(): Promise<void> {
    await Promise.all([...this.#porGuild.keys()].map((guildId) => this.desconectar(guildId)));
  }

  async desconectar(guildId: string): Promise<void> {
    const e = this.#porGuild.get(guildId);
    if (!e) return;        // idempotente: la segunda llamada no encuentra nada
    this.#porGuild.delete(guildId);
    const tubo = e.tuboActual;
    e.tuboActual = null;
    e.bytesLocucion = 0;
    if (tubo && !tubo.destroyed) {
      // Nos vamos a mitad de una locución: 5 tramas de silencio y 120 ms para
      // que salgan por el cable, así Opus no interpola con la próxima vez.
      // Entre locuciones no hace falta: esas tramas ya las puso el recurso al
      // terminar (silencePaddingFrames).
      for (let i = 0; i < 5; i++) tubo.write(Buffer.alloc(BYTES_TRAMA));
      await new Promise((r) => setTimeout(r, 120));
      e.player.stop(true); // primero Idle (destruye el recurso), luego la fuente
      tubo.destroy();
    } else {
      e.player.stop(true);
    }
    e.conexion.destroy();
  }
}
