import type { RepoAutorizaciones } from './puertos.ts';
import type { Logger } from '../logger.ts';

const VOZ_POR_DEFECTO = 'Marta'; // mismo valor que el DEFAULT de la columna en la migración

function clave(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// Caché en memoria (Map guild:user → voz) de quién está autorizado ahora
// mismo. estaAutorizado() es SÍNCRONO a propósito: si MySQL se cae a media
// llamada, el bot debe seguir sabiendo a quién escuchar sin esperar a la BD.
export class ServicioAutorizaciones {
  readonly #repo: RepoAutorizaciones;
  readonly #log: Logger;
  #autorizados = new Map<string, string>();

  constructor(repo: RepoAutorizaciones, log: Logger) {
    this.#repo = repo;
    this.#log = log;
  }

  async cargar(): Promise<void> {
    const activas = await this.#repo.listarActivas();
    this.#autorizados = new Map(activas.map((a) => [clave(a.guildId, a.userId), a.voz]));
  }

  estaAutorizado(guildId: string, userId: string): boolean {
    return this.#autorizados.has(clave(guildId, userId));
  }

  vozDe(guildId: string, userId: string): string {
    return this.#autorizados.get(clave(guildId, userId)) ?? VOZ_POR_DEFECTO;
  }

  async autorizar(guildId: string, userId: string, por: string): Promise<void> {
    await this.#repo.autorizar({ guildId, userId, concedidaPor: por });
    const k = clave(guildId, userId);
    // Si ya estaba en caché (reautorización sin pasar por revocar()), se
    // conserva su voz; si es alta nueva, arranca con la de por defecto.
    if (!this.#autorizados.has(k)) this.#autorizados.set(k, VOZ_POR_DEFECTO);
  }

  async revocar(guildId: string, userId: string, por: string): Promise<boolean> {
    const ok = await this.#repo.revocar(guildId, userId, por);
    this.#autorizados.delete(clave(guildId, userId));
    return ok;
  }

  async fijarVoz(guildId: string, userId: string, voz: string): Promise<void> {
    await this.#repo.fijarVoz(guildId, userId, voz);
    const k = clave(guildId, userId);
    // Solo actualiza la caché de quien ya está autorizado: fijarVoz no debe
    // poder colar a nadie en estaAutorizado() por la puerta de atrás.
    if (this.#autorizados.has(k)) this.#autorizados.set(k, voz);
  }
}
