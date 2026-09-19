import { SlashCommandBuilder, type SlashCommandSubcommandsOnlyBuilder } from 'discord.js';

// Estructura de ESPECIFICACION.md §2: subcomandos `enable`/`disable` a nivel
// raíz + grupo `voice` con `list`/`set` (mezclar subcomandos y grupo es legal
// y está documentado por discord.js). `voice set` lleva autocompletado sobre
// el catálogo de voces de Inworld, resuelto en `eventos.ts`. Tras el primer
// `addSubcommand`, discord.js tipa el builder como
// `SlashCommandSubcommandsOnlyBuilder` (ya no admite opciones sueltas): es el
// tipo de retorno correcto, no `SlashCommandBuilder`.
export function construirComandoJspeak(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName('jspeak')
    .setDescription('Controla el TTS de este servidor')
    .setDMPermission(false)
    .addSubcommand((s) => s
      .setName('enable')
      .setDescription('Activa el TTS para ti en este servidor'))
    .addSubcommand((s) => s
      .setName('disable')
      .setDescription('Desactiva el TTS para ti en este servidor'))
    .addSubcommandGroup((g) => g
      .setName('voice')
      .setDescription('Gestiona la voz usada por el TTS')
      .addSubcommand((s) => s
        .setName('list')
        .setDescription('Lista las voces disponibles'))
      .addSubcommand((s) => s
        .setName('set')
        .setDescription('Fija la voz usada por el TTS')
        .addStringOption((o) => o
          .setName('voz')
          .setDescription('Nombre de la voz (voiceId)')
          .setRequired(true)
          .setAutocomplete(true))));
}
