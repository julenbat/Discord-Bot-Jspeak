import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plantillas } from '../src/plantillas.ts';

test('recordatorio: mención + /jspeak disable en bloque de código', () => {
  const t = plantillas.recordatorio('42');
  assert.ok(t.startsWith('<@42>'));
  assert.match(t, /```\n\/jspeak disable\n```/);
});
test('activación literal de la spec', () => {
  assert.equal(plantillas.ttsActivado('42'), '<@42> TTS activado babygirl');
});
