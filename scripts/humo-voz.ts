// Humo: node scripts/humo-voz.ts <guildId> <canalVozId> "texto"
// Verifica el pipeline entero contra Discord e Inworld reales.
//
// APARCADO (Task 6): este script está escrito y compila, pero no se ha
// ejecutado contra Discord real — aún no hay credenciales de un servidor de
// pruebas. Queda listo para cuando las haya; ver task-6-report.md.
import { Client, Events, GatewayIntentBits, ChannelType } from 'discord.js';
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
// discord.js v14.27: 'clientReady' (Events.ClientReady) sustituye a 'ready',
// deprecado desde v14.16. Se usa el enum en vez del literal del brief para
// que el tipado lo resuelva sin ambigüedad.
client.once(Events.ClientReady, async () => {
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
