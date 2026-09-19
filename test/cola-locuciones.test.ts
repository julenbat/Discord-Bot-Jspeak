import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColaLocuciones } from '../src/aplicacion/cola-locuciones.ts';

const l = (id: string, palabras: number) => ({
  mensajeId: id, guildId: 'g', userId: 'u', voz: 'Marta', epoch: 1,
  texto: 'palabra '.repeat(palabras).trim(),
});

test('rechaza el mensaje NUEVO al superar 200 palabras pendientes', () => {
  const cola = new ColaLocuciones(200);
  assert.equal(cola.encolar(l('1', 150)).ok, true);
  assert.equal(cola.encolar(l('2', 40)).ok, true);   // 190: cabe
  assert.deepEqual(cola.encolar(l('3', 30)), { ok: false, motivo: 'cola_llena' }); // 220: fuera el nuevo
  assert.equal(cola.palabrasPendientes('g', 'u'), 190); // lo viejo intacto: causalidad
});

test('la locución en curso cuenta hasta que termina', () => {
  const cola = new ColaLocuciones(200);
  cola.encolar(l('1', 150));
  const enCurso = cola.siguiente('g', 'u')!;
  cola.enCurso(enCurso, 'g', 'u');
  assert.equal(cola.palabrasPendientes('g', 'u'), 150); // sonando pero no reproducida del todo
  cola.enCurso(null, 'g', 'u');                          // terminó
  assert.equal(cola.palabrasPendientes('g', 'u'), 0);
});

test('FIFO por usuario y vaciar', () => {
  const cola = new ColaLocuciones(200);
  cola.encolar(l('1', 5)); cola.encolar(l('2', 5));
  assert.equal(cola.siguiente('g', 'u')!.mensajeId, '1');
  assert.equal(cola.vaciar('g', 'u'), 1); // quedaba la '2'
  assert.equal(cola.vacia('g'), true);
});
