import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearPool } from '../../src/infra/bd.ts';
import { migrar } from '../../src/infra/migrador.ts';
import { crearLogger } from '../../src/logger.ts';
import { RepoAutorizacionesMysql } from '../../src/infra/repo-autorizaciones.ts';
import { RepoSesionesMysql } from '../../src/infra/repo-sesiones.ts';
import { RepoTtsEventosMysql } from '../../src/infra/repo-tts-eventos.ts';

const pool = crearPool({ host: '127.0.0.1', database: process.env.MYSQL_DATABASE!,
  user: process.env.MYSQL_USER!, password: process.env.MYSQL_PASSWORD! });
const G = '111111111111111111', U = '222222222222222222';

before(async () => {
  await migrar(pool, crearLogger('silent', 'UTC'));
  await pool.query('DELETE FROM tts_eventos'); await pool.query('DELETE FROM autorizaciones');
});
after(() => pool.end());

test('autorizar → activar → revocar en cascada', async () => {
  const autorizaciones = new RepoAutorizacionesMysql(pool);
  const sesiones = new RepoSesionesMysql(pool);
  await autorizaciones.autorizar({ guildId: G, userId: U, concedidaPor: '3' });
  await sesiones.activar(G, U);
  await sesiones.activar(G, U); // idempotente: no lanza
  assert.ok(await sesiones.buscar(G, U));
  assert.equal(await autorizaciones.revocar(G, U, '3'), true);
  assert.equal((await autorizaciones.buscar(G, U))?.estado, 'revocada');
  // re-autorizar reactiva la fila revocada (UPSERT), conservando la voz
  await autorizaciones.fijarVoz(G, U, 'Curro');
  await autorizaciones.autorizar({ guildId: G, userId: U, concedidaPor: '3' });
  const a = await autorizaciones.buscar(G, U);
  assert.equal(a?.estado, 'activa'); assert.equal(a?.voz, 'Curro');
});

test('idempotencia de tts_eventos por mensaje_id', async () => {
  const eventos = new RepoTtsEventosMysql(pool);
  const e = { mensajeId: '999999999999999999', guildId: G, userId: U, canalVozId: null,
    estado: 'encolado' as const, textoOriginal: 'hola', textoSaneado: 'hola', caracteres: 4, voz: 'Marta' };
  assert.equal(await eventos.abrir(e), 'nuevo');
  assert.equal(await eventos.abrir(e), 'duplicado'); // segunda vez: el UNIQUE la para
  await eventos.cerrar(e.mensajeId, { estado: 'reproducido', msAudio: 5080,
    costeUsd: 0.0001, tarifaUsdPorMillon: 25, costeOrigen: 'estimado' });
});
