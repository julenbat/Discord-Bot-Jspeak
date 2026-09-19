// Mundo de pruebas del orquestador: servicios REALES (sesiones,
// autorizaciones, guardián, cola) sobre repos falsos en memoria y reloj
// falso —son baratos y su comportamiento es el de producción—, y dobles
// espía SOLO en los bordes caros: locutor, altavoz y repo de eventos.
import { ServicioSesiones } from '../../src/aplicacion/sesiones.ts';
import { ServicioAutorizaciones } from '../../src/aplicacion/autorizaciones.ts';
import { GuardianVoz, type EstadoVoz } from '../../src/aplicacion/guardian.ts';
import { ColaLocuciones } from '../../src/aplicacion/cola-locuciones.ts';
import { Orquestador, type MensajeEntrante } from '../../src/aplicacion/orquestador.ts';
import type {
  Autorizacion, CierreEventoTts, EventoTtsNuevo, RepoAutorizaciones,
  RepoSesiones, RepoTtsEventos, Sesion,
} from '../../src/aplicacion/puertos.ts';
import type { ResultadoLocucion } from '../../src/audio/locutor.ts';
import { pino } from 'pino';
import type { Logger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';

export interface OpcionesMundo {
  autorizado?: boolean;      // por defecto true: (g, u) autorizado
  locutorLento?: boolean;    // locutar devuelve una promesa que no resuelve
  locutorFalla?: boolean;    // locutar rechaza siempre
  killSwitch?: boolean;      // por defecto false
  modeloDevuelto?: string;   // lo que el proveedor dice haber usado
}

// El estado de voz se sobrescribe como VALOR aunque el puerto lo exponga
// como función: el test dice "este mensaje se escribió desde este sitio".
export type SobrescriturasMensaje =
  Partial<Omit<MensajeEntrante, 'estadoVoz'>> & { estadoVoz?: EstadoVoz };

export interface LocucionEspiada { guildId: string; texto: string; voz: string }
export interface CierreEspiado extends CierreEventoTts { mensajeId: string }

const GUILD = 'g';
const USUARIO = 'u';
const T0 = 1_000_000;

// El saneador recorta a 500 caracteres, así que un mensaje jamás aporta más
// de ~63 palabras a la cola: con el límite real (200) harían falta cuatro
// mensajes para llenarla. El mundo de pruebas usa 100 para que dos mensajes
// largos basten; la semántica de ColaLocuciones es la de producción.
const LIMITE_PALABRAS_TEST = 100;

function clave(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// Logger de verdad (pino, como en producción) con el destino redirigido a
// un array: el formato EXACTO de la línea del paso 10 es un mandato de la
// spec y hay que poder asertarlo. Con MUNDO_LOG_LEVEL puesto, además se ve
// por stdout: `MUNDO_LOG_LEVEL=info rtk node --test test/orquestador.test.ts`.
function loggerCapturador(): { log: Logger; lineas: string[] } {
  const lineas: string[] = [];
  const destino = {
    write: (linea: string) => {
      const msg = (JSON.parse(linea) as { msg?: string }).msg;
      if (msg !== undefined) lineas.push(msg);
      if (process.env.MUNDO_LOG_LEVEL) process.stdout.write(linea);
    },
  };
  return { log: pino({ level: process.env.MUNDO_LOG_LEVEL ?? 'info' }, destino), lineas };
}

function relojFalso(inicio = T0) {
  let t = inicio;
  return { ahora: () => t, avanzar: (ms: number) => { t += ms; } };
}

function configFalsa(): Config {
  return {
    discordToken: 'token', discordAppId: 'app', discordAdminId: 'admin',
    guildAllowlist: [GUILD],
    inworldApiKey: 'Basic clave', inworldModel: 'inworld-tts-2', inworldLanguage: 'es-ES',
    tarifaUsdMillon: { 'inworld-tts-2': 25, 'inworld-tts-2-flash': 15 },
    mysql: { host: 'h', database: 'd', user: 'u', password: 'p' },
    tz: 'UTC', logLevel: 'silent', ttsConcurrencia: 3, ttsKillSwitch: false,
  };
}

function repoSesionesFalso(reloj: { ahora(): number }): RepoSesiones {
  const filas = new Map<string, Sesion>();
  return {
    activar: async (guildId, userId) => {          // INSERT IGNORE: idempotente
      const k = clave(guildId, userId);
      if (filas.has(k)) return;
      filas.set(k, {
        guildId, userId, activadaEn: new Date(reloj.ahora()),
        ultimoMensajeEn: null, ultimosAvisos: {},
      });
    },
    desactivar: async (guildId, userId) => filas.delete(clave(guildId, userId)),
    buscar: async (guildId, userId) => filas.get(clave(guildId, userId)) ?? null,
    listar: async () => [...filas.values()],
    tocarUltimoMensaje: async (guildId, userId, cuando) => {
      const f = filas.get(clave(guildId, userId));
      if (f) f.ultimoMensajeEn = cuando;
    },
    fijarAviso: async (guildId, userId, tipo, cuandoMs) => {
      const f = filas.get(clave(guildId, userId));
      if (f) f.ultimosAvisos[tipo] = cuandoMs;
    },
  };
}

function repoAutorizacionesFalso(reloj: { ahora(): number }, autorizado: boolean): RepoAutorizaciones {
  const filas = new Map<string, Autorizacion>();
  const alta = (guildId: string, userId: string, por: string): Autorizacion => ({
    guildId, userId, estado: 'activa', voz: 'Marta',
    concedidaPor: por, concedidaEn: new Date(reloj.ahora()),
  });
  if (autorizado) filas.set(clave(GUILD, USUARIO), alta(GUILD, USUARIO, 'admin'));
  return {
    autorizar: async (a) => { filas.set(clave(a.guildId, a.userId), alta(a.guildId, a.userId, a.concedidaPor)); },
    revocar: async (guildId, userId) => filas.delete(clave(guildId, userId)),
    buscar: async (guildId, userId) => filas.get(clave(guildId, userId)) ?? null,
    fijarVoz: async (guildId, userId, voz) => {
      const f = filas.get(clave(guildId, userId));
      if (f) f.voz = voz;
    },
    listarActivas: async () => [...filas.values()],
  };
}

export function crearMundo(opciones: OpcionesMundo = {}) {
  const reloj = relojFalso();
  const { log, lineas: logs } = loggerCapturador();
  const config = configFalsa();

  const avisos: string[] = [];
  const reacciones: string[] = [];
  const locuciones: LocucionEspiada[] = [];
  const eventosAbiertos: EventoTtsNuevo[] = [];
  const eventosCerrados: CierreEspiado[] = [];
  let señalesAbortadas = 0;

  // Espía del locutor: registra cada llamada y devuelve lo que pida el test.
  const locutor = {
    locutar: async (guildId: string, texto: string, voz: string, señal: AbortSignal): Promise<ResultadoLocucion> => {
      locuciones.push({ guildId, texto, voz });
      señal.addEventListener('abort', () => { señalesAbortadas++; }, { once: true });
      if (opciones.locutorFalla) throw new Error('el sintetizador no responde');
      if (opciones.locutorLento) return new Promise<ResultadoLocucion>(() => { /* jamás resuelve */ });
      return {
        estado: 'reproducido', msPrimerByte: 120, msAudio: 1_800,
        caracteresProveedor: texto.length, modeloDevuelto: opciones.modeloDevuelto ?? null,
      };
    },
  };

  // Altavoz: no-op; lo que importa del corte se observa en los eventos. Lo
  // único que se cuenta es desconectarTodos(), que es la salida real del bot
  // de los canales de voz en el apagado (5 tramas de silencio + stop(true) +
  // destroy) y no deja rastro en ningún evento de BD.
  let desconexionesAltavoz = 0;
  const altavoz = {
    cortar: () => {},
    desconectarTodos: async () => { desconexionesAltavoz++; },
  };

  // UNIQUE(mensaje_id) del esquema real: la segunda apertura del mismo id
  // devuelve 'duplicado' (pero el intento se registra, como lo registraría
  // el log de MySQL).
  const idsVistos = new Set<string>();
  const repoEventos: RepoTtsEventos = {
    abrir: async (e) => {
      eventosAbiertos.push(e);
      if (idsVistos.has(e.mensajeId)) return 'duplicado';
      idsVistos.add(e.mensajeId);
      return 'nuevo';
    },
    cerrar: async (mensajeId, c) => { eventosCerrados.push({ mensajeId, ...c }); },
  };

  const autorizaciones = new ServicioAutorizaciones(
    repoAutorizacionesFalso(reloj, opciones.autorizado !== false), log);
  // La caché se siembra con una lectura del repo falso (resuelta en el
  // primer microtask); todos los tests que necesitan autorización hacen
  // antes `await orq.activarSesion(...)`.
  void autorizaciones.cargar();

  const sesiones = new ServicioSesiones(repoSesionesFalso(reloj), reloj, log);
  const guardian = new GuardianVoz(reloj);
  const cola = new ColaLocuciones(LIMITE_PALABRAS_TEST);

  const orq = new Orquestador({
    autorizaciones, sesiones, guardian, cola, locutor, altavoz, repoEventos,
    reloj, log, config, killSwitch: () => opciones.killSwitch === true,
  });

  // Estado de voz del mundo: lo que la presentación real leería del caché
  // vivo de discord.js. `estadoVoz()` lo consulta en CADA llamada, así que
  // cambiarlo a media faena (fijarEstadoVoz) es exactamente "el usuario se
  // sale del canal mientras su mensaje espera turno".
  let estadoVozMundo: EstadoVoz = { canalId: 'c1', ensordecido: false };
  const fijarEstadoVoz = (estado: EstadoVoz) => { estadoVozMundo = estado; };

  let siguienteId = 0;
  const mensaje = (overrides: SobrescriturasMensaje = {}): MensajeEntrante => {
    // El override llega como VALOR (así lo escriben los tests) y se expone
    // como función fija; sin override, el mensaje lee el mundo en vivo.
    const { estadoVoz: fijo, ...resto } = overrides;
    return {
      mensajeId: String(++siguienteId),
      guildId: GUILD, userId: USUARIO, nombreUsuario: 'Alba',
      contenido: 'Un mensaje cualquiera del test.',
      estadoVoz: () => fijo ?? estadoVozMundo,
      responder: async (texto: string) => { avisos.push(texto); },
      reaccionar: async (emoji: string) => { reacciones.push(emoji); },
      conectarVoz: async () => {},
      resolutores: { nombreUsuario: () => null, nombreCanal: () => null },
      ...resto,
    };
  };

  return {
    orq,
    servicios: { autorizaciones, sesiones, guardian, cola },
    dobles: {
      mensaje, fijarEstadoVoz, logs,
      locuciones, eventosAbiertos, eventosCerrados, avisos, reacciones, reloj,
      // getter: el contador vive en el cierre y el test lo lee al final.
      get señalesAbortadas() { return señalesAbortadas; },
      get desconexionesAltavoz() { return desconexionesAltavoz; },
    },
  };
}
