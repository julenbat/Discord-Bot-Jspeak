// Humo secuencial: node scripts/humo-secuencial.ts <guildId> <canalVozId> [textos...]
//
// Regresión del bug "solo suena la primera locución": locuta TRES textos
// seguidos por la MISMA conexión, esperando cada uno, con una pausa de 2 s
// entre el segundo y el tercero. Esa pausa es el punto clave: con el recurso
// de audio único, medio segundo sin datos bastaba para que el player perdiera
// maxMissedFrames tramas, diera el recurso por muerto y dejara mudo todo lo
// que viniera después (y colgara rematarLocucion). Las tres tienen que sonar
// y los tres ResultadoLocucion tienen que salir con estado 'reproducido'.
//
// NO ejecutar con el contenedor del bot en marcha: dos sesiones de voz en el
// mismo guild chocan. Parar el bot primero.
import { Client, Events, GatewayIntentBits, ChannelType } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { cargarConfig } from '../src/config.ts';
import { crearLogger } from '../src/logger.ts';
import { ClienteInworld } from '../src/audio/tts-inworld.ts';
import { Semaforo } from '../src/audio/semaforo.ts';
import { Altavoz } from '../src/audio/altavoz.ts';
import { Locutor } from '../src/audio/locutor.ts';

const [guildId, canalId, ...resto] = process.argv.slice(2);
if (!guildId || !canalId) {
  console.error('uso: humo-secuencial <guildId> <canalId> [texto1 texto2 texto3]');
  process.exit(1);
}
const TEXTOS = resto.length === 3 ? resto : [
  'Primera locución de la prueba secuencial.',
  'Segunda locución, justo después de la primera.',
  'Tercera locución, después de dos segundos de silencio.',
];

const config = cargarConfig(process.env);
const log = crearLogger('debug', config.tz);
console.log(generateDependencyReport()); // diagnóstico de "se conecta pero no se oye"

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
// discord.js v14.27: 'clientReady' (Events.ClientReady) sustituye a 'ready'.
client.once(Events.ClientReady, async () => {
  const canal = await client.channels.fetch(canalId!);
  if (canal?.type !== ChannelType.GuildVoice) { console.error('no es un canal de voz'); process.exit(1); }
  const altavoz = new Altavoz(log);
  const locutor = new Locutor(new ClienteInworld({
    apiKey: config.inworldApiKey, modelo: config.inworldModel, idioma: config.inworldLanguage,
  }), new Semaforo(config.ttsConcurrencia), altavoz, log);

  const t0 = performance.now();
  await altavoz.conectar(canal);
  let fallos = 0;
  for (const [i, texto] of TEXTOS.entries()) {
    // El hueco > 500 ms va entre la segunda y la tercera: es el que mataba al
    // recurso único mientras el tubo se quedaba sin datos.
    if (i === 2) {
      log.info('pausa de 2 s antes de la tercera locución');
      await new Promise((r) => setTimeout(r, 2_000));
    }
    const tLoc = performance.now();
    const r = await locutor.locutar(guildId!, texto!, 'Marta', new AbortController().signal);
    if (r.estado !== 'reproducido') fallos++;
    log.info({ n: i + 1, texto, ...r, msReloj: Math.round(performance.now() - tLoc) }, 'locución terminada');
  }
  log.info({ locuciones: TEXTOS.length, fallos, msTotal: Math.round(performance.now() - t0) },
    fallos === 0 ? 'humo secuencial OK' : 'humo secuencial CON FALLOS');
  await altavoz.desconectar(guildId!);
  await client.destroy();
  process.exit(fallos === 0 ? 0 : 1);
});
await client.login(config.discordToken);
