import {
  ChannelType, Events, MessageFlags, PermissionFlagsBits,
  type Client, type Message, type Interaction, type ChatInputCommandInteraction,
} from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import type { Altavoz } from '../audio/altavoz.ts';
import type { ClienteInworld, Voz } from '../audio/tts-inworld.ts';
import type { ServicioAutorizaciones } from '../aplicacion/autorizaciones.ts';
import type { Orquestador, MensajeEntrante } from '../aplicacion/orquestador.ts';
import type { Resolutores } from '../aplicacion/saneador.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { plantillas } from '../plantillas.ts';
import { crearCliente } from './cliente.ts';
import { manejarComandoTtsAdmin } from './comando-tts-admin.ts';

const TTL_CATALOGO_MS = 6 * 60 * 60 * 1000; // catálogo de voces: TTL 6 h, relleno perezoso

export interface DepsDiscord {
  config: Config;
  log: Logger;
  orquestador: Orquestador;
  autorizaciones: ServicioAutorizaciones;
  tts: ClienteInworld;
  // AÑADIDO sobre el ruling #4 del brief («arrancarDiscord(deps) recibe
  // {config, log, orquestador, autorizaciones, tts}»): MensajeEntrante.conectarVoz()
  // tiene que envolver altavoz.conectar(canal) con la MISMA instancia de
  // Altavoz que usan Locutor (empujar/rematarLocucion) y el propio
  // Orquestador (cortar) — así lo exige el comentario de orquestador.ts:
  // "Del Altavoz solo se usa cortar(): conectar lo hace la presentación, que
  // es quien tiene el objeto canal de discord.js". Sin esta referencia
  // conectarVoz() no puede hacer nada real (una Altavoz distinta no tendría
  // ninguna conexión que cortar/empujar). Debe ser la MISMA Altavoz que
  // main.ts (Task 8) construye y pasa también al Orquestador. Documentado en
  // el informe de esta tarea para que Task 8 pase `altavoz` en la llamada.
  altavoz: Altavoz;
}

// Composition root de la presentación: crea el Client, registra los cuatro
// handlers de ESPECIFICACION.md §5/§8 y hace login. Los handlers son FINOS:
// traducen discord.js ↔ Orquestador/ServicioAutorizaciones/ClienteInworld;
// cero lógica de negocio.
export async function arrancarDiscord(deps: DepsDiscord): Promise<Client> {
  const { config, log } = deps;
  const client = crearCliente();

  // ESPECIFICACION §5, fila Intents: "cierre 4014 → log FATAL, nunca fallo
  // mudo". Sin estos dos listeners, un MessageContent sin activar en el
  // portal cierra el shard con 4014 (DisallowedIntents) y discord.js deja el
  // proceso VIVO y offline, sin una sola línea en el log: el bot "arranca
  // bien" y no responde a nada. Además, un EventEmitter sin listener de
  // 'error' relanza el error como excepción no capturada.
  client.on(Events.ShardError, (err, shardId) => { alFallarElGateway(err, log, shardId); });
  client.on(Events.Error, (err) => { alFallarElGateway(err, log); });

  // Caché en memoria del catálogo de voces (TTL 6 h), relleno perezoso con la
  // primera llamada (voice list / voice set / autocompletado). Vive en el
  // cierre de arrancarDiscord, no a nivel de módulo: cada Client tiene su
  // propio catálogo, sin estado compartido entre invocaciones (tests, etc.).
  let catalogo: Voz[] = [];
  let catalogoEnMs = 0;
  async function catalogoVoces(): Promise<Voz[]> {
    const ahora = Date.now();
    if (catalogo.length === 0 || ahora - catalogoEnMs >= TTL_CATALOGO_MS) {
      catalogo = await deps.tts.listarVoces();
      catalogoEnMs = ahora;
    }
    return catalogo;
  }

  client.on(Events.MessageCreate, (message) => {
    alRecibirMensaje(message, deps).catch((err) => {
      log.error({ err: (err as Error).message, mensajeId: message.id }, 'fallo procesando messageCreate');
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    alRecibirInteraccion(interaction, deps, catalogoVoces).catch((err) => {
      log.error({ err: (err as Error).message, interactionId: interaction.id }, 'fallo procesando interactionCreate');
    });
  });

  client.on(Events.GuildCreate, (guild) => {
    if (config.guildAllowlist.includes(guild.id)) return;
    log.warn({ guildId: guild.id, guildName: guild.name }, 'guild fuera de la allowlist; abandonando');
    void guild.leave().catch((err) => {
      log.error({ err: (err as Error).message, guildId: guild.id }, 'no se pudo abandonar el guild');
    });
  });

  client.once(Events.ClientReady, (c) => {
    log.info(generateDependencyReport());
    for (const guildId of config.guildAllowlist) {
      if (!c.guilds.cache.has(guildId)) log.warn({ guildId }, 'guild de la allowlist no encontrado al arrancar');
    }
    log.info({ guilds: c.guilds.cache.size }, 'discord listo');
  });

  await client.login(config.discordToken);
  return client;
}

// El gateway se ha roto de una forma de la que discord.js NO se recupera
// solo: se grita en FATAL y se sale con 1 para que el `restart:
// unless-stopped` del compose lo reintente (y para que el operador lo vea en
// `docker compose logs`, en vez de un contenedor sano y un bot mudo).
function alFallarElGateway(err: Error, log: Logger, shardId?: number): never {
  const mensaje = err?.message ?? String(err);
  // 4014 = DisallowedIntents. El mensaje de discord.js es literalmente "Used
  // disallowed intents"; la causa real, el 99 % de las veces, es el toggle
  // de Message Content sin activar.
  const pista = /disallowed intents|4014/i.test(mensaje)
    ? ' — activa Message Content Intent en el portal de Discord (Bot → Privileged Gateway Intents)'
    : '';
  log.fatal({ err: mensaje, shardId }, `el gateway de Discord falló: ${mensaje}${pista}`);
  process.exit(1);
}

// ───────────────────────── Events.MessageCreate ─────────────────────────

async function alRecibirMensaje(message: Message, deps: DepsDiscord): Promise<void> {
  // Descartes duros de presentación (ESPECIFICACION.md §3.1): el contenido de
  // terceros muere aquí, antes de log/BD, si el mensaje no procede.
  if (message.author.bot) return;
  if (!message.inGuild()) return;              // DMs
  if (message.webhookId) return;
  if (message.system) return;                  // mensajes de sistema
  const contenido = message.content;
  if (!contenido) return;                       // solo adjunto/sticker/embed

  // El comando admin de prefijo NO pasa por el filtro P2 (funciona desde
  // cualquier canal del servidor): se resuelve aparte y aquí se acaba, tanto
  // si es "!tts ..." como si es cualquier otro "!algo" (descarte duro).
  if (contenido.startsWith('!')) {
    await manejarComandoTtsAdmin(message, deps);
    return;
  }
  if (contenido.startsWith('\\')) return;        // válvula de escape: escribir sin locutar

  if (!deps.config.guildAllowlist.includes(message.guildId)) return; // guildCreate ya debería haber sacado al bot

  const guild = message.guild;
  const userId = message.author.id;

  // C1 exige leer el estado de voz EN VIVO, nunca de una copia: por eso es
  // una función que consulta el caché de discord.js en CADA llamada, y no un
  // valor capturado aquí. El Orquestador la invoca dos veces por mensaje.
  const estadoVoz = () => {
    const vs = guild.voiceStates.cache.get(userId);
    return { canalId: vs?.channelId ?? null, ensordecido: vs?.deaf ?? false };
  };

  // Supuesto P2: solo se procesa el chat integrado del canal de voz donde
  // está el autor ahora mismo (la audiencia de texto y audio coinciden).
  if (message.channelId !== estadoVoz().canalId) return;

  const resolutores: Resolutores = {
    nombreUsuario: (id) => guild.members.cache.get(id)?.displayName ?? null,
    nombreCanal: (id) => guild.channels.cache.get(id)?.name ?? null,
  };

  const m: MensajeEntrante = {
    mensajeId: message.id,
    guildId: message.guildId,
    userId,
    nombreUsuario: message.member?.displayName ?? message.author.username,
    contenido,
    estadoVoz,
    responder: async (texto, autoborradoMs) => {
      const enviado = await message.channel.send({ content: texto, allowedMentions: { users: [userId] } });
      if (autoborradoMs) {
        setTimeout(() => { enviado.delete().catch(() => {}); }, autoborradoMs);
      }
    },
    reaccionar: async (emoji) => { await message.react(emoji); },
    conectarVoz: async () => {
      const canal = guild.voiceStates.cache.get(userId)?.channel;
      if (!canal) throw new Error('el usuario ya no está en un canal de voz');
      // Validación previa de tipo / aforo / permisos (ESPECIFICACION §3.6).
      // Sin ella, un canal de escenario, lleno o sin Connect/Speak se paga a
      // 20 s de `entersState(Ready)` POR LOCUCIÓN antes de fallar. El
      // Orquestador ya trata este throw como fallo de esa locución: cierra la
      // fila, sigue con la cola y no toca el breaker (entrar al canal no es
      // culpa del proveedor).
      if (canal.type !== ChannelType.GuildVoice) {
        throw new Error(`el canal ${canal.id} no es un canal de voz normal (escenario: rechazado en v1)`);
      }
      const yo = guild.members.me;
      if (yo === null) throw new Error('el bot no figura como miembro de este servidor');
      // El aforo no aplica si el bot YA está dentro: seguir hablando en un
      // canal que se ha llenado por detrás es legal.
      if (canal.userLimit > 0 && canal.members.size >= canal.userLimit && !canal.members.has(yo.id)) {
        throw new Error(`el canal ${canal.id} está lleno (${canal.members.size}/${canal.userLimit})`);
      }
      if (!canal.permissionsFor(yo)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        throw new Error(`sin permisos de Connect/Speak en el canal ${canal.id}`);
      }
      await deps.altavoz.conectar(canal);
    },
    resolutores,
  };

  await deps.orquestador.procesarMensaje(m);
}

// ───────────────────────── Events.InteractionCreate ─────────────────────────

async function alRecibirInteraccion(
  interaction: Interaction, deps: DepsDiscord, catalogoVoces: () => Promise<Voz[]>,
): Promise<void> {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'jspeak') return;
    const escrito = interaction.options.getFocused().toLowerCase();
    const voces = await catalogoVoces();
    const coincidencias = voces
      .filter((v) => v.voiceId.toLowerCase().includes(escrito))
      .slice(0, 25)
      .map((v) => ({ name: v.voiceId, value: v.voiceId }));
    await interaction.respond(coincidencias);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'jspeak') return;
  await manejarJspeak(interaction, deps, catalogoVoces);
}

async function manejarJspeak(
  interaction: ChatInputCommandInteraction, deps: DepsDiscord, catalogoVoces: () => Promise<Voz[]>,
): Promise<void> {
  const { orquestador, autorizaciones } = deps;

  // "En DM se rechazan con mensaje" (ESPECIFICACION §2). setDMPermission(false)
  // ya evita que Discord lo ofrezca en DM, pero esto es cinturón y tirantes.
  if (!interaction.inGuild()) {
    await interaction.reply({ content: plantillas.soloEnServidor(), flags: MessageFlags.Ephemeral });
    return;
  }

  // deferReply SIEMPRE antes de tocar red/BD (ruling #4): un slash command no
  // se puede ignorar (3 s o error rojo).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const grupo = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (grupo === 'voice') {
    if (sub === 'list') {
      const voces = await catalogoVoces();
      await interaction.editReply(plantillas.listaVoces(voces));
      return;
    }
    // sub === 'set': requiere estar autorizado (la voz se guarda en la fila
    // de `autorizaciones`, que solo existe para quien ya lo está).
    if (!autorizaciones.estaAutorizado(guildId, userId)) {
      await interaction.editReply(plantillas.noAutorizado());
      return;
    }
    const vozPedida = interaction.options.getString('voz', true);
    const voces = await catalogoVoces();
    const existe = voces.find((v) => v.voiceId.toLowerCase() === vozPedida.toLowerCase());
    if (!existe) {
      const txt = vozPedida.toLowerCase();
      const parecidas = voces
        .filter((v) => v.voiceId.toLowerCase().includes(txt) || txt.includes(v.voiceId.toLowerCase()))
        .map((v) => v.voiceId)
        .sort()
        .slice(0, 3);
      await interaction.editReply(plantillas.vozNoExiste(vozPedida, parecidas));
      return;
    }
    await autorizaciones.fijarVoz(guildId, userId, existe.voiceId);
    await interaction.editReply(plantillas.vozFijada(existe.voiceId));
    return;
  }

  if (sub === 'enable') {
    if (!autorizaciones.estaAutorizado(guildId, userId)) {
      await interaction.editReply(plantillas.noAutorizado());
      return;
    }
    await orquestador.activarSesion(guildId, userId);
    await interaction.editReply(plantillas.ttsActivado(userId));
    // Confirmación efímera al comando + mensaje PÚBLICO en el canal donde se
    // invocó (un efímero no notifica la mención; hacen falta los dos).
    await interaction.followUp({
      content: plantillas.ttsActivado(userId),
      allowedMentions: { users: [userId] },
    });
    return;
  }
  // sub === 'disable': idempotente, no exige autorización previa (si nunca
  // hubo sesión, no hay nada que desactivar y la respuesta sigue siendo cierta).
  await orquestador.desactivarSesion(guildId, userId);
  await interaction.editReply(plantillas.ttsDesactivado());
}
