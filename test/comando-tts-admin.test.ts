import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearTtsAdmin } from '../src/discord/comando-tts-admin.ts';

test('formas válidas', () => {
  assert.deepEqual(parsearTtsAdmin('!tts user enable 123456789012345678'),
    { accion: 'enable', userId: '123456789012345678' });
  assert.deepEqual(parsearTtsAdmin('!tts user disable <@123456789012345678>'),
    { accion: 'disable', userId: '123456789012345678' });
});
test('formas inválidas → null (se responde error de sintaxis SOLO al admin)', () => {
  assert.equal(parsearTtsAdmin('!tts user enable'), null);
  assert.equal(parsearTtsAdmin('!tts otra cosa'), null);
  assert.equal(parsearTtsAdmin('hola normal'), null);
});
