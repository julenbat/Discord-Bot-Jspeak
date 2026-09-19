import type { RepoSesiones } from './puertos.ts';
import type { Reloj } from '../reloj.ts';
import type { Logger } from '../logger.ts';

const RECORDATORIO_MS = 60_000;       // C2: hueco desde el último mensaje ACEPTADO
const AVISO_VEDA_MS = 300_000;        // C5: veda por tipo de aviso
const AVISO_TECHO_GLOBAL_MS = 10_000; // C5: techo global entre avisos de cualquier tipo

export interface SesionViva {
  guildId: string; userId: string;
  ultimoMensajeAceptadoMs: number;      // reloj de C2
  ultimosAvisosMs: Record<string, number>; // relojes de C5, por tipo
  epoch: number;                        // cancelación: los callbacks viejos no empujan audio
}

function clave(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// Vivas en memoria (Map guild:user → SesionViva); la BD es el respaldo para
// sobrevivir un reinicio, no la fuente de verdad en caliente: los relojes de
// C2/C5 se leen y escriben aquí, síncronos, sin ida y vuelta a MySQL.
export class ServicioSesiones {
  readonly #repo: RepoSesiones;
  readonly #reloj: Reloj;
  readonly #log: Logger;
  #vivas = new Map<string, SesionViva>();
  // Contador propio del servicio: el epoch de una sesión desactivada nunca
  // se reutiliza, así que no puede derivarse del Map (que la borra al
  // desactivar). Empieza en 1 para que epoch > 0 signifique "sesión real".
  #siguienteEpoch = 1;

  constructor(repo: RepoSesiones, reloj: Reloj, log: Logger) {
    this.#repo = repo;
    this.#reloj = reloj;
    this.#log = log;
  }

  // Barrido al arrancar: carga lo que había en BD, descarta (en memoria) y
  // desactiva (en BD) lo que ya lleva más que el TTL sin escribir, y deja el
  // resto vivo con sus relojes reanudados desde donde iban. Devuelve los ids
  // de las caducadas para que el orquestador las reporte si quiere; el propio
  // aviso de C2 se encarga cuando el usuario vuelva a escribir, así que aquí
  // no se notifica nada activamente.
  async cargar(caducidadArranqueMs: number): Promise<string[]> {
    const filas = await this.#repo.listar();
    const ahora = this.#reloj.ahora();
    const caducadas: string[] = [];
    for (const fila of filas) {
      const ultimoMs = fila.ultimoMensajeEn ? fila.ultimoMensajeEn.getTime() : fila.activadaEn.getTime();
      if (ahora - ultimoMs > caducidadArranqueMs) {
        caducadas.push(clave(fila.guildId, fila.userId));
        await this.#repo.desactivar(fila.guildId, fila.userId);
        continue;
      }
      this.#vivas.set(clave(fila.guildId, fila.userId), {
        guildId: fila.guildId, userId: fila.userId,
        ultimoMensajeAceptadoMs: ultimoMs, ultimosAvisosMs: { ...fila.ultimosAvisos },
        epoch: this.#siguienteEpoch++,
      });
    }
    return caducadas;
  }

  async activar(guildId: string, userId: string): Promise<'nueva' | 'ya-activa'> {
    const k = clave(guildId, userId);
    if (this.#vivas.has(k)) return 'ya-activa';
    await this.#repo.activar(guildId, userId);
    this.#vivas.set(k, {
      guildId, userId, ultimoMensajeAceptadoMs: this.#reloj.ahora(),
      ultimosAvisosMs: {}, epoch: this.#siguienteEpoch++,
    });
    return 'nueva';
  }

  async desactivar(guildId: string, userId: string): Promise<boolean> {
    // Se borra de memoria pase lo que pase en BD (mismo patrón que
    // ServicioAutorizaciones.revocar): una sesión que el orquestador ya dio
    // por muerta no debe seguir viva en caché. El epoch queda "quemado":
    // el próximo activar() mintará uno nuevo y más alto (#siguienteEpoch
    // nunca retrocede), así que cualquier callback en vuelo con el epoch
    // antiguo deja de reconocerse como vigente.
    this.#vivas.delete(clave(guildId, userId));
    return this.#repo.desactivar(guildId, userId);
  }

  buscar(guildId: string, userId: string): SesionViva | null {
    return this.#vivas.get(clave(guildId, userId)) ?? null;
  }

  tocaRecordatorio(s: SesionViva): boolean {
    return this.#reloj.ahora() - s.ultimoMensajeAceptadoMs > RECORDATORIO_MS;
  }

  marcarMensajeAceptado(s: SesionViva): void {
    const ahora = this.#reloj.ahora();
    s.ultimoMensajeAceptadoMs = ahora;
    // Fire-and-forget: MySQL caído no debe bloquear el audio ni la
    // conversación; si falla, queda constancia en el log y listo.
    this.#repo.tocarUltimoMensaje(s.guildId, s.userId, new Date(ahora))
      .catch((err) => this.#log.warn({ err: (err as Error).message, guildId: s.guildId, userId: s.userId },
        'no se pudo persistir el último mensaje de la sesión'));
  }

  tocaAviso(s: SesionViva, tipo: string): boolean {
    const ahora = this.#reloj.ahora();
    const maxAvisoCualquierTipo = Math.max(0, ...Object.values(s.ultimosAvisosMs));
    return ahora - (s.ultimosAvisosMs[tipo] ?? 0) > AVISO_VEDA_MS
      && ahora - maxAvisoCualquierTipo > AVISO_TECHO_GLOBAL_MS;
  }

  marcarAviso(s: SesionViva, tipo: string): void {
    const ahora = this.#reloj.ahora();
    s.ultimosAvisosMs[tipo] = ahora;
    this.#repo.fijarAviso(s.guildId, s.userId, tipo, ahora)
      .catch((err) => this.#log.warn({ err: (err as Error).message, guildId: s.guildId, userId: s.userId, tipo },
        'no se pudo persistir el aviso de la sesión'));
  }

  // Barrido perezoso en caliente (a diferencia de cargar(), NO toca la BD:
  // el orquestador decide qué hacer con cada una, típicamente desactivar()).
  caducadas(sinEscribirMs: number): SesionViva[] {
    const ahora = this.#reloj.ahora();
    return [...this.#vivas.values()].filter((s) => ahora - s.ultimoMensajeAceptadoMs > sinEscribirMs);
  }
}
