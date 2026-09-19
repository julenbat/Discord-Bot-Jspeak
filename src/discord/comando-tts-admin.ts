import type { Message } from 'discord.js';
import type { ServicioAutorizaciones } from '../aplicacion/autorizaciones.ts';
import type { Orquestador } from '../aplicacion/orquestador.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';

// Puro: sin dependencias de discord.js más allá del tipo del literal. Único
// test automatizable de la Task 7 (el resto es E/S, verificado en la Task 8).
export function parsearTtsAdmin(contenido: string): { accion: 'enable' | 'disable'; userId: string } | null {
  const m = contenido.match(/^!tts\s+user\s+(enable|disable)\s+(?:<@!?(\d{17,20})>|(\d{17,20}))\s*$/);
  return m ? { accion: m[1] as 'enable' | 'disable', userId: (m[2] ?? m[3])! } : null;
}

export interface DepsComandoTtsAdmin {
  config: Config;
  log: Logger;
  orquestador: Orquestador;
  autorizaciones: ServicioAutorizaciones;
}

// Handler fino: traduce discord.js ↔ los métodos reales del orquestador /
// autorizaciones. `eventos.ts` ya ha comprobado `message.inGuild()` antes de
// llamar aquí (por eso el parámetro es `Message<true>`), y también que el
// contenido empieza por "!" (véase ESPECIFICACION.md §2 y §3.1): si no
// arranca por "!tts" en absoluto, no hay nada que hacer aquí, cae en el
// descarte duro genérico de "empieza por !" que ya aplicó el llamante.
export async function manejarComandoTtsAdmin(message: Message<true>, deps: DepsComandoTtsAdmin): Promise<void> {
  const contenido = message.content;
  if (!/^!tts\b/i.test(contenido.trim())) return;

  const parsed = parsearTtsAdmin(contenido);
  const esAdmin = message.author.id === deps.config.discordAdminId;

  if (parsed === null) {
    // "Al admin sí se le responden los errores de sintaxis" (ESPECIFICACION §2).
    if (esAdmin) await message.reply('Sintaxis: `!tts user enable|disable <@usuario|id>`');
    return;
  }
  if (!esAdmin) {
    // "de cualquier otro autor se ignora en silencio (con log del intento)".
    deps.log.debug({ userId: message.author.id, guildId: message.guildId, contenido },
      'intento de comando admin de tts por alguien no autorizado');
    return;
  }

  let miembro;
  try {
    miembro = await message.guild.members.fetch(parsed.userId);
  } catch {
    await message.reply('Ese usuario no es miembro de este servidor.');
    return;
  }
  if (miembro.user.bot) {
    await message.reply('No se puede autorizar a un bot.');
    return;
  }

  if (parsed.accion === 'enable') {
    await deps.autorizaciones.autorizar(message.guildId, parsed.userId, message.author.id);
    await message.reply(`TTS autorizado para <@${parsed.userId}>.`);
  } else {
    await deps.orquestador.revocarAutorizacion(message.guildId, parsed.userId, message.author.id);
    await message.reply(`TTS revocado para <@${parsed.userId}>.`);
  }
}
