import { createPool, type Pool } from 'mysql2/promise';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';

export function crearPool(cfg: Config['mysql']): Pool {
  return createPool({
    host: cfg.host, database: cfg.database, user: cfg.user, password: cfg.password,
    connectionLimit: 8, maxIdle: 4, enableKeepAlive: true,
    timezone: 'Z',              // el pool habla UTC; la legibilidad la pone el logger
    namedPlaceholders: true,
    charset: 'utf8mb4_unicode_ci',
    supportBigNumbers: true, bigNumberStrings: true,
  });
}

// `depends_on: service_healthy` solo cubre el primer arranque; si MySQL se
// reinicia en caliente el bot debe reencontrarlo solo.
const ESCALA_S = [1, 2, 4, 8, 16, 30];
export async function esperarBd(pool: Pool, log: Logger, señal?: AbortSignal): Promise<void> {
  for (let intento = 0; ; intento++) {
    if (señal?.aborted) throw new Error('espera de BD abortada');
    try { await pool.query('SELECT 1'); return; }
    catch (err) {
      const s = ESCALA_S[Math.min(intento, ESCALA_S.length - 1)]!;
      log.warn({ err: (err as Error).message, reintentoEnS: s }, 'MySQL no disponible');
      await new Promise((r) => setTimeout(r, s * 1000));
    }
  }
}
