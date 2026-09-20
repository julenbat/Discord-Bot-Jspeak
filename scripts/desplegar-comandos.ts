// Registro de comandos: bulk overwrite (PUT) por guild, un guild de
// GUILD_ALLOWLIST a la vez (ESPECIFICACION.md §5, "Registro de comandos").
// Ejecución manual: `rtk node scripts/desplegar-comandos.ts`.
import { REST, Routes } from 'discord.js';
import { cargarConfig } from '../src/config.ts';
import { construirComandoJspeak } from '../src/discord/comando-jspeak.ts';

const config = cargarConfig(process.env);
const rest = new REST({ version: '10' }).setToken(config.discordToken);
const cuerpo = [construirComandoJspeak().toJSON()];

// Un guild inaccesible (bot aún no invitado) no debe bloquear a los demás:
// se informa y se sigue, y el proceso termina en error solo si NINGUNO funcionó.
let desplegados = 0;
for (const guildId of config.guildAllowlist) {
  try {
    await rest.put(Routes.applicationGuildCommands(config.discordAppId, guildId), { body: cuerpo });
    console.log(`/jspeak desplegado en el guild ${guildId}`);
    desplegados++;
  } catch (err) {
    const codigo = (err as { code?: number }).code;
    const pista = codigo === 50001
      ? 'el bot no está invitado a ese servidor (falta la URL de OAuth con scope applications.commands)'
      : (err as Error).message;
    console.error(`guild ${guildId}: NO desplegado — ${pista}`);
  }
}
if (desplegados === 0) process.exit(1);
