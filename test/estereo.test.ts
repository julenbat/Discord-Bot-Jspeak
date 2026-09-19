import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monoAEstereo, BYTES_TRAMA } from '../src/audio/estereo.ts';

test('duplica cada muestra de 16 bits', () => {
  const mono = Buffer.from([0x01, 0x02, 0x03, 0x04]); // muestras 0x0201, 0x0403
  assert.deepEqual([...monoAEstereo(mono)], [0x01, 0x02, 0x01, 0x02, 0x03, 0x04, 0x03, 0x04]);
});

test('byte impar sobrante se descarta', () => {
  assert.equal(monoAEstereo(Buffer.from([1, 2, 3])).length, 4);
});

test('la constante de trama es la de Discord', () => {
  assert.equal(BYTES_TRAMA, 48000 / 1000 * 20 * 2 * 2); // 48 kHz · 20 ms · 16 bits · 2 canales
});
