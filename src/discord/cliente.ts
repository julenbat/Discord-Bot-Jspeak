import { Client, GatewayIntentBits } from 'discord.js';

// Los CUATRO intents de ESPECIFICACION.md §5, ni uno más: Guilds (caché de
// guild/canal imprescindible), GuildMessages + MessageContent (leer el texto
// de los mensajes del canal de voz) y GuildVoiceStates (saber quién está en
// qué canal y si está ensordecido — C1). Nada de GuildMembers: el admin
// verifica pertenencia con `guild.members.fetch()` por REST bajo demanda.
export function crearCliente(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
}
