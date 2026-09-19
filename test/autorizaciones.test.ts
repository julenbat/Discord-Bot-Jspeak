import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServicioAutorizaciones } from '../src/aplicacion/autorizaciones.ts';
import { crearLogger } from '../src/logger.ts';
import type { Autorizacion, RepoAutorizaciones } from '../src/aplicacion/puertos.ts';

function repoFalso(activas: Autorizacion[] = []): RepoAutorizaciones & {
  llamadas: { autorizar: unknown[]; revocar: unknown[]; fijarVoz: unknown[] };
} {
  const llamadas = { autorizar: [] as unknown[], revocar: [] as unknown[], fijarVoz: [] as unknown[] };
  return {
    llamadas,
    async autorizar(a) { llamadas.autorizar.push(a); },
    async revocar(guildId, userId, por) { llamadas.revocar.push({ guildId, userId, por }); return true; },
    async buscar() { return null; },
    async fijarVoz(guildId, userId, voz) { llamadas.fijarVoz.push({ guildId, userId, voz }); },
    async listarActivas() { return activas; },
  };
}

test('cargar() llena la caché desde listarActivas()', async () => {
  const repo = repoFalso([
    { guildId: 'g', userId: 'u', estado: 'activa', voz: 'Elena', concedidaPor: 'admin', concedidaEn: new Date() },
  ]);
  const s = new ServicioAutorizaciones(repo, crearLogger('silent', 'UTC'));
  assert.equal(s.estaAutorizado('g', 'u'), false); // aún no cargada: caché vacía
  await s.cargar();
  assert.equal(s.estaAutorizado('g', 'u'), true);
  assert.equal(s.vozDe('g', 'u'), 'Elena');
});

test('estaAutorizado es síncrono y refleja la caché', async () => {
  const repo = repoFalso();
  const s = new ServicioAutorizaciones(repo, crearLogger('silent', 'UTC'));
  assert.equal(s.estaAutorizado('g', 'u'), false);
  await s.autorizar('g', 'u', 'admin');
  assert.equal(s.estaAutorizado('g', 'u'), true);
  assert.equal(s.estaAutorizado('g', 'otro'), false); // no confunde usuarios
  assert.equal(s.estaAutorizado('otroGuild', 'u'), false); // ni guilds
});

test('autorizar añade a la caché y llama al repo con los datos correctos', async () => {
  const repo = repoFalso();
  const s = new ServicioAutorizaciones(repo, crearLogger('silent', 'UTC'));
  await s.autorizar('g', 'u', 'admin');
  assert.equal(s.estaAutorizado('g', 'u'), true);
  assert.deepEqual(repo.llamadas.autorizar, [{ guildId: 'g', userId: 'u', concedidaPor: 'admin' }]);
});

test('revocar quita de la caché y devuelve lo que diga el repo', async () => {
  const repo = repoFalso();
  const s = new ServicioAutorizaciones(repo, crearLogger('silent', 'UTC'));
  await s.autorizar('g', 'u', 'admin');
  const ok = await s.revocar('g', 'u', 'admin');
  assert.equal(ok, true);
  assert.equal(s.estaAutorizado('g', 'u'), false);
});

test('revocar limpia la caché aunque el repo diga que no había nada que revocar', async () => {
  const repo = repoFalso();
  repo.revocar = async () => false;
  const s = new ServicioAutorizaciones(repo, crearLogger('silent', 'UTC'));
  await s.autorizar('g', 'u', 'admin');
  const ok = await s.revocar('g', 'u', 'admin');
  assert.equal(ok, false);
  assert.equal(s.estaAutorizado('g', 'u'), false);
});

test('vozDe devuelve Marta por defecto para quien no está autorizado', () => {
  const s = new ServicioAutorizaciones(repoFalso(), crearLogger('silent', 'UTC'));
  assert.equal(s.vozDe('g', 'u'), 'Marta');
});

test('vozDe devuelve la voz cacheada tras fijarVoz', async () => {
  const repo = repoFalso();
  const s = new ServicioAutorizaciones(repo, crearLogger('silent', 'UTC'));
  await s.autorizar('g', 'u', 'admin');
  assert.equal(s.vozDe('g', 'u'), 'Marta');
  await s.fijarVoz('g', 'u', 'Elena');
  assert.equal(s.vozDe('g', 'u'), 'Elena');
  assert.deepEqual(repo.llamadas.fijarVoz, [{ guildId: 'g', userId: 'u', voz: 'Elena' }]);
});
