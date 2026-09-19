import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearPool } from '../../src/infra/bd.ts';
import { migrar } from '../../src/infra/migrador.ts';
import { crearLogger } from '../../src/logger.ts';

// Requiere: rtk docker compose up -d db  (y MYSQL_* en el entorno o .env cargado)
const pool = crearPool({ host: '127.0.0.1', database: process.env.MYSQL_DATABASE!,
  user: process.env.MYSQL_USER!, password: process.env.MYSQL_PASSWORD! });
const log = crearLogger('silent', 'UTC');

after(() => pool.end());

test('aplica las pendientes una sola vez', async () => {
  const primera = await migrar(pool, log);
  assert.ok(primera >= 1);
  assert.equal(await migrar(pool, log), 0); // idempotente
  const [tablas] = await pool.query("SHOW TABLES LIKE 'tts_eventos'");
  assert.equal((tablas as unknown[]).length, 1);
});
