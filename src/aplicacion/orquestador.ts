import type { ServicioAutorizaciones } from './autorizaciones.ts';
import type { ColaLocuciones, Locucion } from './cola-locuciones.ts';
import type { EstadoVoz, GuardianVoz } from './guardian.ts';
import type { CierreEventoTts, EventoTtsNuevo, RepoTtsEventos } from './puertos.ts';
import { sanear, type Resolutores } from './saneador.ts';
import type { ServicioSesiones, SesionViva } from './sesiones.ts';
import type { ResultadoLocucion } from '../audio/locutor.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { plantillas } from '../plantillas.ts';
import type { Reloj } from '../reloj.ts';

const LRU_MAX = 500;            // idempotencia barata delante del UNIQUE de BD
const AUTOBORRADO_MS = 60_000;  // lo que escribe el bot se borra solo
const BREAKER_UMBRAL = 3;       // 3 fallos seguidos en el guild…
const BREAKER_VEDA_MS = 30_000; // …y 30 s sin molestar al proveedor
const EMOJI_COLA_LLENA = '🚫';

// Lo que el orquestador necesita del Locutor de src/audio (mismo patrón que
// `SintetizadorTts`): una interfaz estructural permite el doble de test, que
// no puede tipar contra una clase con campos privados `#`.
export interface PuertoLocutor {
  locutar(guildId: string, texto: string, voz: string, señal: AbortSignal): Promise<ResultadoLocucion>;
}
// Del Altavoz solo se usa cortar(): conectar lo hace la presentación, que es
// quien tiene el objeto canal de discord.js (ver `MensajeEntrante.conectarVoz`).
export interface PuertoAltavoz {
  cortar(guildId: string): void;
}

export interface MensajeEntrante {
  mensajeId: string; guildId: string; userId: string; nombreUsuario: string;
  contenido: string;
  // C1 exige leer el estado de voz EN VIVO, nunca de una copia: por eso es
  // una función y no un valor. La presentación la resuelve contra el
  // VoiceState vivo del caché de discord.js en CADA llamada, y el pipeline la
  // invoca dos veces: al encolar (paso 7) y justo antes de locutar (paso 11).
  estadoVoz(): EstadoVoz;
  // La presentación entrega funciones, no objetos de discord.js: la capa de
  // aplicación no importa discord.js.
  responder(texto: string, autoborradoMs?: number): Promise<void>;
  reaccionar(emoji: string): Promise<void>;
  conectarVoz(): Promise<void>;   // envuelve altavoz.conectar(canal) con el canal resuelto
  resolutores: Resolutores;
}

export interface DepsOrquestador {
  autorizaciones: ServicioAutorizaciones;
  sesiones: ServicioSesiones;
  guardian: GuardianVoz;
  cola: ColaLocuciones;
  locutor: PuertoLocutor;
  altavoz: PuertoAltavoz;
  repoEventos: RepoTtsEventos;
  reloj: Reloj;
  log: Logger;
  config: Config;
  killSwitch: () => boolean;
}

interface EstadoBreaker { fallos: number; vedaHastaMs: number }

function clave(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// El pipeline de ESPECIFICACION §3 de principio a fin. Ninguna otra pieza
// conoce el orden; aquí no hay un solo setTimeout (todo tiempo sale del
// `Reloj` inyectado) ni una sola importación de discord.js.
export class Orquestador {
  // `erasableSyntaxOnly` prohíbe parameter properties: campo explícito +
  // asignación en el cuerpo, como en Locutor/Altavoz/Semaforo.
  readonly #autorizaciones: ServicioAutorizaciones;
  readonly #sesiones: ServicioSesiones;
  readonly #guardian: GuardianVoz;
  readonly #cola: ColaLocuciones;
  readonly #locutor: PuertoLocutor;
  readonly #altavoz: PuertoAltavoz;
  readonly #repoEventos: RepoTtsEventos;
  readonly #reloj: Reloj;
  readonly #log: Logger;
  readonly #config: Config;
  readonly #killSwitch: () => boolean;

  #apagando = false;
  #vistos = new Set<string>();                        // LRU de mensajeId (orden de inserción)
  #breaker = new Map<string, EstadoBreaker>();        // por guild
  #abortos = new Map<string, AbortController>();      // por sesión (guild:user)
  #bombeando = new Set<string>();                     // single-flight por sesión
  #enCurso = new Map<string, Locucion>();             // lo que está sonando por sesión
  #contextos = new Map<string, MensajeEntrante>();    // mensajeId → funciones de la presentación

  constructor(deps: DepsOrquestador) {
    this.#autorizaciones = deps.autorizaciones;
    this.#sesiones = deps.sesiones;
    this.#guardian = deps.guardian;
    this.#cola = deps.cola;
    this.#locutor = deps.locutor;
    this.#altavoz = deps.altavoz;
    this.#repoEventos = deps.repoEventos;
    this.#reloj = deps.reloj;
    this.#log = deps.log;
    this.#config = deps.config;
    this.#killSwitch = deps.killSwitch;
  }

  // ───────────────────────── pipeline (ESPECIFICACION §3) ─────────────────────────

  async procesarMensaje(m: MensajeEntrante): Promise<void> {
    // 1 — kill switch del operador (y apagado en curso: ya no se acepta nada).
    if (this.#apagando || this.#killSwitch()) return;

    // 2 — autorizado Y activo. El contenido de terceros muere AQUÍ: ni log,
    // ni saneado, ni BD.
    if (!this.#autorizaciones.estaAutorizado(m.guildId, m.userId)) return;
    const sesion = this.#sesiones.buscar(m.guildId, m.userId);
    if (sesion === null) return;

    // 3 — LRU de mensajeId: reentrega de MESSAGE_CREATE tras un RESUME.
    if (this.#vistos.has(m.mensajeId)) return;

    // 4 — C2: un recordatorio por hueco (sin cubo propio de C5: su
    // disparador ya es el hueco, que el paso 5 resetea).
    if (this.#sesiones.tocaRecordatorio(sesion)) {
      await this.#avisar(m, plantillas.recordatorio(m.userId));
    }

    // 5 — el hueco de C2 se mide desde la RECEPCIÓN del mensaje aceptado.
    this.#sesiones.marcarMensajeAceptado(sesion);

    // 6 — saneado (pipeline puro de orden fijo).
    const voz = this.#autorizaciones.vozDe(m.guildId, m.userId);
    const texto = sanear(m.contenido, m.resolutores);
    if (texto === null) {
      await this.#abrirDescarte(m, m.estadoVoz().canalId, '', 'texto_vacio', voz);
      return;
    }

    // 7 — C1 al encolar (rechazo barato; se vuelve a validar antes de sonar).
    // Primera lectura en vivo del estado de voz; la segunda la hace el bombeo.
    const estadoVoz = m.estadoVoz();
    const veredicto = this.#guardian.evaluar(m.guildId, m.userId, estadoVoz);
    if (!veredicto.ok) {
      await this.#abrirDescarte(m, estadoVoz.canalId, texto, veredicto.motivo, voz);
      await this.#avisarSiToca(m, sesion, veredicto.motivo, this.#textoDeVeredicto(m, veredicto.motivo));
      return;
    }

    // 8 — C4: tope de cola. Se rechaza el mensaje NUEVO entero; reacción en
    // el propio mensaje (imposible de spamear) + aviso bajo cooldown.
    const encolado = this.#cola.encolar({
      mensajeId: m.mensajeId, guildId: m.guildId, userId: m.userId,
      texto, voz, epoch: sesion.epoch,
    });
    if (!encolado.ok) {
      // ColaLocuciones no expone su límite; lo que de verdad le interesa al
      // usuario es cuánto tiene pendiente, que es el número que se le da.
      const pendientes = this.#cola.palabrasPendientes(m.guildId, m.userId);
      await this.#abrirDescarte(m, estadoVoz.canalId, texto, 'cola_llena', voz);
      await this.#reaccionar(m, EMOJI_COLA_LLENA);
      await this.#avisarSiToca(m, sesion, 'cola_llena', plantillas.colaLlena(pendientes));
      return;
    }
    // El contexto se registra ya: el bombeo puede sacar esta locución de la
    // cola durante el `await` del paso 9.
    this.#contextos.set(m.mensajeId, m);

    // 9 — idempotencia dura: UNIQUE(mensaje_id) en BD.
    const apertura = await this.#abrir({
      mensajeId: m.mensajeId, guildId: m.guildId, userId: m.userId,
      canalVozId: veredicto.canalId, estado: 'encolado',
      textoOriginal: m.contenido, textoSaneado: texto, caracteres: texto.length, voz,
    });
    if (apertura === 'duplicado') {
      this.#contextos.delete(m.mensajeId); // el bombeo la saltará al no tener contexto
      return;
    }
    this.#recordar(m.mensajeId);

    // 10 — el log que pide la spec, con su formato exacto.
    this.#log.info(`El usuario ${m.nombreUsuario} <-> ${m.userId} : Ha generado el tts: ${texto}`);

    // 11 — bombeo. No se espera a que suene: se cede un turno del bucle de
    // eventos y, si el bombeo no tiene E/S en vuelo, habrá terminado ya.
    const bombeo = this.#bombear(m.guildId, m.userId);
    await Promise.race([bombeo, this.#cederTurno()]);
  }

  // ───────────────────────── ciclo de vida de sesiones ─────────────────────────

  async activarSesion(guildId: string, userId: string): Promise<'nueva' | 'ya-activa'> {
    const resultado = await this.#sesiones.activar(guildId, userId);
    if (resultado === 'nueva') this.#abortos.set(clave(guildId, userId), new AbortController());
    return resultado;
  }

  // pararTodo del contrato: abort → cortar → vaciar cola → epoch++ →
  // liberar cerrojo → filas terminales (ESPECIFICACION §5, fila Cancelación).
  async desactivarSesion(guildId: string, userId: string): Promise<boolean> {
    const pendientes = this.#pararAudio(guildId, userId, 'desactivar');
    const desactivada = await this.#sesiones.desactivar(guildId, userId); // epoch++
    this.#guardian.liberarSiOcioso(guildId, this.#cola.vacia(guildId));
    await this.#cerrarTodas(pendientes);
    return desactivada;
  }

  // Revocar NO es simétrico de autorizar: arrastra la sesión y el audio.
  async revocarAutorizacion(guildId: string, userId: string, por: string): Promise<boolean> {
    const revocada = await this.#autorizaciones.revocar(guildId, userId, por);
    await this.desactivarSesion(guildId, userId);
    this.#log.info({ guildId, userId, por }, 'autorización revocada; sesión y audio cortados');
    return revocada;
  }

  // Deja de aceptar y mata el audio de todas las sesiones. NO espera a que
  // los bombeos en vuelo devuelvan: ya están abortados, sus filas ya quedaron
  // cerradas aquí y el bucle sale solo al ver que su locución ya no está en
  // curso (esperarlos solo añadiría el riesgo de agotar el tope duro de 8 s
  // de main.ts, que es lo que convierte un apagado limpio en exit(1)).
  // El resto del orden (client.destroy, pool.end, flush) vive en main.ts; y
  // las filas de `sesiones` NO se tocan a propósito: sobreviven al reinicio y
  // es el barrido de arranque quien decide si han caducado.
  async apagar(): Promise<void> {
    if (this.#apagando) return;
    this.#apagando = true;
    const pendientes: Locucion[] = [];
    for (const k of [...this.#abortos.keys()]) {
      const [guildId = '', userId = ''] = k.split(':');
      pendientes.push(...this.#pararAudio(guildId, userId, 'apagado'));
    }
    await this.#cerrarTodas(pendientes);
    this.#log.info({ locucionesAbortadas: pendientes.length },
      'orquestador apagado: síntesis abortada y colas vacías');
  }

  // ───────────────────────── bombeo (paso 11) ─────────────────────────

  // Single-flight por (guild, user): si ya hay bombeo en marcha, encolar basta.
  // La marca se pone y se quita de forma SÍNCRONA (aquí y en el `finally` del
  // bucle), no con un `.finally()` sobre la promesa: si se quitara un
  // microtask más tarde, un mensaje encolado en ese hueco vería la marca
  // todavía puesta, no arrancaría bombeo y se quedaría mudo en la cola.
  async #bombear(guildId: string, userId: string): Promise<void> {
    const k = clave(guildId, userId);
    if (this.#bombeando.has(k)) return;
    this.#bombeando.add(k);
    return this.#bucle(guildId, userId, k);
  }

  async #bucle(guildId: string, userId: string, k: string): Promise<void> {
    try {
      for (;;) {
        const locucion = this.#cola.siguiente(guildId, userId);
        if (locucion === null) break;
        const ctx = this.#contextos.get(locucion.mensajeId);
        if (ctx === undefined) continue;   // anulada por el UNIQUE de BD (paso 9)
        this.#cola.enCurso(locucion, guildId, userId);
        this.#enCurso.set(k, locucion);
        try {
          if (!(await this.#locutarUna(locucion, ctx, k))) break; // la sesión se paró
        } finally {
          if (this.#enCurso.get(k) === locucion) this.#enCurso.delete(k);
          this.#cola.enCurso(null, guildId, userId);
          this.#contextos.delete(locucion.mensajeId);
        }
      }
    } catch (err) {
      this.#log.error({ err: (err as Error).message, guildId, userId }, 'el bombeo se rompió');
    } finally {
      this.#bombeando.delete(k);
      // 12 — cola vacía: el cerrojo del guild puede empezar a enfriarse.
      this.#guardian.liberarSiOcioso(guildId, this.#cola.vacia(guildId));
    }
  }

  // Devuelve false si el bombeo debe parar (la sesión se ha cortado bajo los pies).
  async #locutarUna(l: Locucion, ctx: MensajeEntrante, k: string): Promise<boolean> {
    const sesion = this.#sesiones.buscar(l.guildId, l.userId);
    // C1 OTRA VEZ, justo antes de reproducir: con hasta 80 s de cola, lo que
    // se validó al encolar no garantiza nada. Esta llamada a `estadoVoz()` es
    // la lectura EN VIVO que exige la spec (el usuario ha podido salirse del
    // canal o ensordecerse mientras su mensaje esperaba turno). Y el epoch:
    // una locución de una sesión ya muerta no suena.
    const veredicto = this.#guardian.evaluar(l.guildId, l.userId, ctx.estadoVoz());
    if (sesion === null || sesion.epoch !== l.epoch || !veredicto.ok) {
      await this.#cerrar(l, { estado: 'abortado', costeOrigen: 'estimado' });
      return true;
    }
    if (this.#breakerAbierto(l.guildId)) {
      await this.#cerrar(l, { estado: 'fallido', costeOrigen: 'estimado' });
      return true;
    }

    // Entrar al canal falla a menudo (permisos, aforo, timeout de Ready) y no
    // es culpa del proveedor: se cierra la fila y se sigue con la cola, sin
    // tocar el breaker y sin quedarse con el cerrojo de un canal donde no se
    // ha llegado a entrar.
    try {
      await ctx.conectarVoz();
    } catch (err) {
      if (this.#enCurso.get(k) !== l) return false;   // pararTodo ya cerró la fila
      this.#log.warn({ err: (err as Error).message, guildId: l.guildId, canalId: veredicto.canalId },
        'no se pudo entrar al canal de voz');
      await this.#cerrar(l, { estado: 'fallido', costeOrigen: 'estimado' });
      return true;
    }
    // Entrar al canal es lento (hasta 20 s de `entersState`): pararTodo ha
    // podido pasar por aquí mientras tanto, y ya abortó, vació la cola y
    // cerró esta fila como 'abortado'. Seguir sería locutar DESPUÉS del corte.
    if (this.#enCurso.get(k) !== l) return false;
    this.#guardian.ocupar(l.guildId, veredicto.canalId);

    const señal = this.#señalDe(l.guildId, l.userId);
    let resultado: ResultadoLocucion;
    try {
      resultado = await this.#locutor.locutar(l.guildId, l.texto, l.voz, señal);
    } catch (err) {
      this.#log.warn({ err: (err as Error).message, guildId: l.guildId, mensajeId: l.mensajeId },
        'la locución falló entera');
      resultado = {
        estado: señal.aborted ? 'abortado' : 'fallido',
        msPrimerByte: null, msAudio: 0, caracteresProveedor: null, modeloDevuelto: null,
      };
    }
    // Si pararTodo pasó por aquí mientras sonaba, ya cerró la fila: ni se
    // cierra dos veces ni se sigue con el resto de la cola (ya vaciada).
    if (this.#enCurso.get(k) !== l) return false;
    await this.#anotarEnBreaker(l.guildId, resultado.estado, ctx, sesion);
    await this.#cerrar(l, this.#cierreDe(l, resultado));
    return true;
  }

  // Un turno del bucle de eventos: si el bombeo solo tocó memoria, ya ha
  // terminado cuando esto se resuelve; si hay E/S en vuelo (el caso real),
  // procesarMensaje devuelve y el bombeo sigue por su cuenta.
  #cederTurno(): Promise<void> {
    return new Promise<void>((resolver) => { setImmediate(resolver); });
  }

  // ───────────────────────── circuit breaker (por guild) ─────────────────────────

  #breakerAbierto(guildId: string): boolean {
    const b = this.#breaker.get(guildId);
    if (b === undefined || b.vedaHastaMs === 0) return false;
    if (this.#reloj.ahora() >= b.vedaHastaMs) {   // se cumplió la veda: borrón y cuenta nueva
      b.vedaHastaMs = 0;
      b.fallos = 0;
      return false;
    }
    return true;
  }

  async #anotarEnBreaker(guildId: string, estado: ResultadoLocucion['estado'],
      m: MensajeEntrante, sesion: SesionViva): Promise<void> {
    const b = this.#breaker.get(guildId) ?? { fallos: 0, vedaHastaMs: 0 };
    this.#breaker.set(guildId, b);
    if (estado === 'reproducido') {          // una buena borra la racha
      b.fallos = 0;
      b.vedaHastaMs = 0;
      return;
    }
    if (estado !== 'fallido') return;        // abortar no es culpa del proveedor
    b.fallos++;
    if (b.fallos < BREAKER_UMBRAL) return;
    b.vedaHastaMs = this.#reloj.ahora() + BREAKER_VEDA_MS;
    this.#log.warn({ guildId, fallos: b.fallos, vedaHastaMs: b.vedaHastaMs },
      'circuit breaker abierto: 30 s sin sintetizar en este guild');
    await this.#avisarSiToca(m, sesion, 'fallo_tts', plantillas.falloTts());
  }

  // ───────────────────────── pararTodo y cierres ─────────────────────────

  // Parte síncrona de pararTodo (abort → cortar → drenar): devuelve las
  // locuciones que quedan por cerrar para que el llamante escriba las filas
  // terminales DESPUÉS del epoch++ y de liberar el cerrojo.
  #pararAudio(guildId: string, userId: string, motivo: string): Locucion[] {
    const k = clave(guildId, userId);
    this.#abortos.get(k)?.abort();
    this.#abortos.delete(k);
    this.#altavoz.cortar(guildId);

    const pendientes: Locucion[] = [];
    const sonando = this.#enCurso.get(k);
    if (sonando !== undefined) {
      this.#enCurso.delete(k);
      pendientes.push(sonando);
    }
    for (;;) {
      const l = this.#cola.siguiente(guildId, userId);
      if (l === null) break;
      pendientes.push(l);
    }
    this.#cola.vaciar(guildId, userId);
    this.#cola.enCurso(null, guildId, userId);
    for (const l of pendientes) this.#contextos.delete(l.mensajeId);
    if (pendientes.length > 0) {
      this.#log.info({ guildId, userId, motivo, descartadas: pendientes.length }, 'pararTodo');
    }
    return pendientes;
  }

  async #cerrarTodas(pendientes: Locucion[]): Promise<void> {
    for (const l of pendientes) await this.#cerrar(l, { estado: 'abortado', costeOrigen: 'estimado' });
  }

  #cierreDe(l: Locucion, r: ResultadoLocucion): CierreEventoTts {
    // Inworld no devuelve ni precio ni tokens: el coste es estimación propia
    // sobre los caracteres locales, con la tarifa copiada en la fila.
    const modelo = r.modeloDevuelto ?? this.#config.inworldModel;
    const tarifa = this.#config.tarifaUsdMillon[modelo] ?? 0;
    return {
      estado: r.estado,
      caracteresProveedor: r.caracteresProveedor ?? undefined,
      modelo,
      msPrimerByte: r.msPrimerByte ?? undefined,
      msAudio: r.msAudio,
      costeUsd: (l.texto.length * tarifa) / 1_000_000,
      tarifaUsdPorMillon: tarifa,
      costeOrigen: 'estimado',
    };
  }

  // ───────────────────────── utilidades ─────────────────────────

  // La creación perezosa existe para las sesiones rescatadas por el barrido de
  // arranque, que nunca pasaron por activarSesion(). Lo que NO puede hacer es
  // resucitar un controlador para una sesión que ya no existe: pararTodo borra
  // el suyo al abortar, y devolver ahí uno nuevo «sin abortar» sería dar vía
  // libre al audio que se acababa de cortar.
  #señalDe(guildId: string, userId: string): AbortSignal {
    const k = clave(guildId, userId);
    const existente = this.#abortos.get(k);
    if (existente !== undefined) return existente.signal;
    if (this.#sesiones.buscar(guildId, userId) === null) return AbortSignal.abort();
    const nuevo = new AbortController();
    this.#abortos.set(k, nuevo);
    return nuevo.signal;
  }

  // El id se recuerda solo cuando el mensaje se acepta de verdad: los
  // descartes (C1, cola llena, texto vacío) deben poder repetirse, que es lo
  // que el usuario hace al reintentar.
  #recordar(mensajeId: string): void {
    this.#vistos.add(mensajeId);
    if (this.#vistos.size <= LRU_MAX) return;
    const masViejo = this.#vistos.values().next();
    if (!masViejo.done) this.#vistos.delete(masViejo.value);
  }

  #textoDeVeredicto(m: MensajeEntrante, motivo: 'fuera_de_canal' | 'ensordecido' | 'canal_ocupado'): string {
    if (motivo === 'fuera_de_canal') return plantillas.fueraDeCanal();
    if (motivo === 'ensordecido') return plantillas.ensordecido();
    const canalId = this.#guardian.canalOcupado(m.guildId);
    return plantillas.canalOcupado((canalId && m.resolutores.nombreCanal(canalId)) || 'otro canal');
  }

  async #abrirDescarte(m: MensajeEntrante, canalVozId: string | null,
      textoSaneado: string, motivo: string, voz: string): Promise<void> {
    await this.#abrir({
      mensajeId: m.mensajeId, guildId: m.guildId, userId: m.userId,
      canalVozId, estado: 'descartado', motivoDescarte: motivo,
      textoOriginal: m.contenido, textoSaneado, caracteres: textoSaneado.length, voz,
    });
  }

  // MySQL caído no calla al bot: el histórico es fire-and-forget con volcado
  // al log (ESPECIFICACION §5, fila Degradación).
  async #abrir(e: EventoTtsNuevo): Promise<'nuevo' | 'duplicado'> {
    try {
      return await this.#repoEventos.abrir(e);
    } catch (err) {
      this.#log.warn({ err: (err as Error).message, mensajeId: e.mensajeId }, 'no se pudo abrir el evento de tts');
      return 'nuevo';
    }
  }

  async #cerrar(l: Locucion, c: CierreEventoTts): Promise<void> {
    try {
      await this.#repoEventos.cerrar(l.mensajeId, c);
    } catch (err) {
      this.#log.warn({ err: (err as Error).message, mensajeId: l.mensajeId, estado: c.estado },
        'no se pudo cerrar el evento de tts');
    }
  }

  async #avisarSiToca(m: MensajeEntrante, sesion: SesionViva, tipo: string, texto: string): Promise<void> {
    if (!this.#sesiones.tocaAviso(sesion, tipo)) return;
    this.#sesiones.marcarAviso(sesion, tipo);
    await this.#avisar(m, texto);
  }

  async #avisar(m: MensajeEntrante, texto: string): Promise<void> {
    try {
      await m.responder(texto, AUTOBORRADO_MS);
    } catch (err) {
      this.#log.warn({ err: (err as Error).message, guildId: m.guildId, userId: m.userId },
        'no se pudo enviar el aviso');
    }
  }

  async #reaccionar(m: MensajeEntrante, emoji: string): Promise<void> {
    try {
      await m.reaccionar(emoji);
    } catch (err) {
      this.#log.warn({ err: (err as Error).message, mensajeId: m.mensajeId }, 'no se pudo reaccionar');
    }
  }
}
