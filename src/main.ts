import { Events, type Client } from 'discord.js';
import { cargarConfig, ErrorConfig } from './config.ts';
import { crearLogger } from './logger.ts';
import { crearPool, esperarBd } from './infra/bd.ts';
import { migrar } from './infra/migrador.ts';
import { relojSistema } from './reloj.ts';
import { ServicioAutorizaciones } from './aplicacion/autorizaciones.ts';
import { ServicioSesiones } from './aplicacion/sesiones.ts';
import { GuardianVoz } from './aplicacion/guardian.ts';
import { ColaLocuciones } from './aplicacion/cola-locuciones.ts';
import { Orquestador } from './aplicacion/orquestador.ts';
import { RepoAutorizacionesMysql } from './infra/repo-autorizaciones.ts';
import { RepoSesionesMysql } from './infra/repo-sesiones.ts';
import { RepoTtsEventosMysql } from './infra/repo-tts-eventos.ts';
import { Locutor } from './audio/locutor.ts';
import { Altavoz } from './audio/altavoz.ts';
import { Semaforo } from './audio/semaforo.ts';
import { ClienteInworld } from './audio/tts-inworld.ts';
import { arrancarDiscord } from './discord/eventos.ts';

// Composition root: TODO se construye y se cablea aquí, a mano.
// Config incompleta → pausa y exit(1): la pausa evita que
// `restart: unless-stopped` haga girar el contenedor sin parar.
let config;
try { config = cargarConfig(process.env); }
catch (err) {
  if (err instanceof ErrorConfig) {
    console.error(err.message);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
    process.exit(1);
  }
  throw err;
}

const log = crearLogger(config.logLevel, config.tz);
const pool = crearPool(config.mysql);
const abortoArranque = new AbortController();

// Se rellenan durante el arranque; apagar() los usa si ya existen (undefined
// mientras seguimos esperando BD/migrando/validando Inworld).
let orquestador: Orquestador | undefined;
let client: Client | undefined;

let apagando = false;
async function apagar(señal: string): Promise<void> {
  if (apagando) return; apagando = true;
  log.info({ señal }, 'apagado ordenado');
  // Si SIGTERM/SIGINT llega mientras `esperarBd` sigue reintentando (o antes
  // de llegar ahí), este abort la saca del backoff exponencial al momento en
  // vez de esperar hasta 30 s al siguiente intento. Si ya pasamos ese punto,
  // abortar un AbortController ya resuelto es un no-op inocuo.
  abortoArranque.abort();
  const tope = setTimeout(() => process.exit(1), 8_000);
  // Orden: dejar de escuchar eventos → orquestador.apagar() (aborta síntesis,
  // vacía colas, corta el altavoz de cada sesión y luego desconecta de todos
  // los canales de voz: 5 tramas de silencio + stop(true) que libera el
  // encoder de opusscript + destroy()) → client.destroy() →
  // pool.end(). MessageCreate e InteractionCreate son las dos puertas por las
  // que entra trabajo nuevo (mensajes de canal de voz y /jspeak); quitarlas
  // ANTES de orquestador.apagar() evita que una interacción en vuelo cree una
  // sesión nueva justo cuando se está vaciando todo lo demás.
  client?.removeAllListeners(Events.MessageCreate);
  client?.removeAllListeners(Events.InteractionCreate);
  if (orquestador) await orquestador.apagar();
  if (client) await client.destroy();
  await pool.end();
  clearTimeout(tope);
  process.exit(0);
}
process.on('SIGTERM', () => void apagar('SIGTERM'));
process.on('SIGINT', () => void apagar('SIGINT'));

try {
  // Nada de Discord hasta tener base: aparecer online prometiendo un servicio
  // que no se puede dar es peor que tardar en aparecer.
  await esperarBd(pool, log, abortoArranque.signal);
  const aplicadas = await migrar(pool, log);
  log.info({ migracionesAplicadas: aplicadas }, 'base de datos lista');

  const autorizaciones = new ServicioAutorizaciones(new RepoAutorizacionesMysql(pool), log);
  const sesiones = new ServicioSesiones(new RepoSesionesMysql(pool), relojSistema, log);
  await autorizaciones.cargar();
  // Barrido de arranque (supuesto P5): TTL 10 min desde el último mensaje
  // aceptado. Las sesiones caducadas quedan desactivadas en BD; las vivas
  // retoman sus relojes de C2/C5 donde iban. El bot NUNCA entra a un canal de
  // voz aquí: cargar() no toca discord.js ni el altavoz, solo memoria + BD.
  await sesiones.cargar(10 * 60_000);

  // La credencial de Inworld se valida con una petición real ANTES de
  // enchufar el gateway de Discord: si la clave es inválida, mejor no
  // aparecer online prometiendo TTS que no puede dar.
  const tts = new ClienteInworld({
    apiKey: config.inworldApiKey, modelo: config.inworldModel, idioma: config.inworldLanguage,
  });
  const voces = await tts.listarVoces();
  log.info({ voces: voces.length }, 'catálogo de voces de Inworld validado');

  const altavoz = new Altavoz(log);
  orquestador = new Orquestador({
    autorizaciones, sesiones,
    guardian: new GuardianVoz(relojSistema),
    cola: new ColaLocuciones(),
    locutor: new Locutor(tts, new Semaforo(config.ttsConcurrencia), altavoz, log),
    altavoz,
    repoEventos: new RepoTtsEventosMysql(pool),
    reloj: relojSistema, log, config,
    killSwitch: () => config.ttsKillSwitch,
  });

  // arrancarDiscord registra los handlers y hace login; si el token es
  // inválido, client.login() rechaza y el error cae al catch de abajo.
  client = await arrancarDiscord({ config, log, orquestador, autorizaciones, tts, altavoz });
  log.info('bot arrancado y a la espera de eventos');
} catch (err) {
  // Si el error viene de un apagado ordenado en curso (abortoArranque
  // disparado por una señal), apagar() ya se está encargando de la salida:
  // no hay nada claro que loguear ni un exit(1) adicional que emitir.
  if (!apagando) {
    log.error({ err: (err as Error).message }, 'fallo arrancando el bot');
    process.exit(1);
  }
}
