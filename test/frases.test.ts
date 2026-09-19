import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraerFrases } from '../src/audio/frases.ts';

test('corta por puntuación y arrastra frases cortas', () => {
  const r = extraerFrases('Vale. Esto es una frase completa que sí se emite. Y esto queda');
  assert.deepEqual(r.frases, ['Vale. Esto es una frase completa que sí se emite.']);
  assert.equal(r.resto, 'Y esto queda');
});

test('parrafada sin puntuación corta por la última coma pasados 120', () => {
  const largo = 'palabra '.repeat(14) + ', ' + 'palabra '.repeat(14) + 'y sigue sin terminar nunca';
  const r = extraerFrases(largo);
  assert.equal(r.frases.length, 1);
  assert.ok(r.frases[0]!.endsWith(','));
});

test('forzar vuelca el resto', () => {
  assert.deepEqual(extraerFrases('sin puntuacion final', true).frases, ['sin puntuacion final']);
});
