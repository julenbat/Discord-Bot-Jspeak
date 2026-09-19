import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServicioSesiones } from '../src/aplicacion/sesiones.ts';
import { crearLogger } from '../src/logger.ts';

function relojFalso(inicio = 1_000_000) {
  let t = inicio;
  return { ahora: () => t, avanzar: (ms: number) => { t += ms; } };
}
function repoFalso() {
  return {
    activar: async () => {}, desactivar: async () => true, buscar: async () => null,
    listar: async () => [], tocarUltimoMensaje: async () => {}, fijarAviso: async () => {},
  };
}

test('C2: recordatorio con hueco > 60 s, una vez por hueco', async () => {
  const reloj = relojFalso();
  const s = new ServicioSesiones(repoFalso(), reloj, crearLogger('silent', 'UTC'));
  await s.activar('g', 'u');
  const viva = s.buscar('g', 'u')!;
  s.marcarMensajeAceptado(viva);
  reloj.avanzar(61_000);
  assert.equal(s.tocaRecordatorio(viva), true);
  s.marcarMensajeAceptado(viva);          // el mensaje que dispara el aviso resetea el hueco
  assert.equal(s.tocaRecordatorio(viva), false);
  reloj.avanzar(61_000);
  assert.equal(s.tocaRecordatorio(viva), true); // segundo hueco legítimo → segundo aviso
});

test('C5: cubos independientes por tipo + techo global de 10 s', async () => {
  const reloj = relojFalso();
  const s = new ServicioSesiones(repoFalso(), reloj, crearLogger('silent', 'UTC'));
  await s.activar('g', 'u');
  const viva = s.buscar('g', 'u')!;
  assert.equal(s.tocaAviso(viva, 'cola_llena'), true);
  s.marcarAviso(viva, 'cola_llena');
  assert.equal(s.tocaAviso(viva, 'cola_llena'), false);   // mismo tipo: 300 s de veda
  assert.equal(s.tocaAviso(viva, 'ensordecido'), false);  // otro tipo, pero techo global 10 s
  reloj.avanzar(11_000);
  assert.equal(s.tocaAviso(viva, 'ensordecido'), true);   // otro cubo: pasa
  reloj.avanzar(290_000);
  assert.equal(s.tocaAviso(viva, 'cola_llena'), true);    // pasaron los 300 s
});

test('desactivar incrementa el epoch', async () => {
  const s = new ServicioSesiones(repoFalso(), relojFalso(), crearLogger('silent', 'UTC'));
  await s.activar('g', 'u');
  const antes = s.buscar('g', 'u')!.epoch;
  await s.desactivar('g', 'u');
  await s.activar('g', 'u');
  assert.ok(s.buscar('g', 'u')!.epoch > antes);
});
