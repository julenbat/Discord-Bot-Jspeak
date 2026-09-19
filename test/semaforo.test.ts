import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaforo } from '../src/audio/semaforo.ts';

test('limita la concurrencia y respeta el orden FIFO', async () => {
  const s = new Semaforo(2);
  const l1 = await s.adquirir();
  const l2 = await s.adquirir();
  let tercero = false;
  const p3 = s.adquirir().then((l) => { tercero = true; return l; });
  await new Promise((r) => setImmediate(r));
  assert.equal(tercero, false);
  assert.equal(s.esperando(), 1);
  l1();
  l1(); // liberar dos veces no abre hueco extra
  const l3 = await p3;
  assert.equal(tercero, true);
  assert.equal(s.enUso(), 2);
  l2(); l3();
  assert.equal(s.enUso(), 0);
});
