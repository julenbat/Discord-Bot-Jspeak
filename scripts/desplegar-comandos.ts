// Registro de comandos: bulk overwrite (PUT) por guild, un guild de
// GUILD_ALLOWLIST a la vez (ESPECIFICACION.md §5, "Registro de comandos").
// Ejecución manual: `rtk node scripts/desplegar-comandos.ts`.
import { REST, Routes } from 'discord.js';
import { cargarConfig } from '../src/config.ts';
import { construirComandoJspeak } from '../src/discord/comando-jspeak.ts';

const config = cargarConfig(process.env);
const rest = new REST({ version: '10' }).setToken(config.discordToken);
const cuerpo = [construirComandoJspeak().toJSON()];

for (const guildId of config.guildAllowlist) {
  await rest.put(Routes.applicationGuildCommands(config.discordAppId, guildId), { body: cuerpo });
  console.log(`/jspeak desplegado en el guild ${guildId}`);
}
