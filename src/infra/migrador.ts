import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.ts';

// El DDL de MySQL hace commit implícito: no hay transacción que valga.
// Por eso cada fichero es pequeño y de un solo propósito, y el runner
// serializa procesos con GET_LOCK para que dos réplicas no se pisen.
export async function migrar(pool: Pool, log: Logger, dir = 'migrations'): Promise<number> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migraciones (
    nombre VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL,
    aplicada_en DATETIME(3) NOT NULL)`);
  const [cerrojo] = await pool.query("SELECT GET_LOCK('albas_migraciones', 30) AS ok");
  // El pool usa bigNumberStrings (necesario para los snowflakes de otras
  // tablas), así que GET_LOCK() —BIGINT en MySQL— vuelve como '1', no 1.
  if (Number((cerrojo as { ok: number | string }[])[0]?.ok) !== 1) {
    throw new Error('no se pudo obtener el cerrojo de migraciones');
  }
  try {
    const [filas] = await pool.query('SELECT nombre, checksum FROM schema_migraciones');
    const aplicadas = new Map((filas as { nombre: string; checksum: string }[])
      .map((f) => [f.nombre, f.checksum]));
    const ficheros = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    let aplicadasAhora = 0;
    for (const fichero of ficheros) {
      const sql = await readFile(join(dir, fichero), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previa = aplicadas.get(fichero);
      if (previa !== undefined) {
        // Avisar y seguir: un checksum cambiado suele ser un retoque de
        // comentarios; abortar aquí dejaría el bot sin arrancar por nada.
        if (previa !== checksum) log.warn({ fichero }, 'migración ya aplicada con contenido distinto');
        continue;
      }
      for (const sentencia of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
        await pool.query(sentencia);
      }
      await pool.execute(
        'INSERT INTO schema_migraciones (nombre, checksum, aplicada_en) VALUES (:nombre, :checksum, UTC_TIMESTAMP(3))',
        { nombre: fichero, checksum });
      log.info({ fichero }, 'migración aplicada');
      aplicadasAhora++;
    }
    return aplicadasAhora;
  } finally {
    await pool.query("SELECT RELEASE_LOCK('albas_migraciones')");
  }
}
