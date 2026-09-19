import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParserNdjson } from '../src/audio/ndjson.ts';

const linea = (pcm: Buffer, extra = {}) => JSON.stringify({
  result: { audioContent: pcm.toString('base64'), ...extra } }) + '\n';

test('línea partida entre dos chunks se reconstruye', () => {
  const p = new ParserNdjson();
  const l = linea(Buffer.from([1, 2, 3, 4]));
  const corte = Math.floor(l.length / 2);
  assert.equal(p.alimentar(Buffer.from(l.slice(0, corte))).length, 0);
  const trozos = p.alimentar(Buffer.from(l.slice(corte)));
  assert.deepEqual([...trozos[0]!.pcm!], [1, 2, 3, 4]);
});

test('cabecera RIFF se quita defensivamente', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.from([9, 9])]);
  const p = new ParserNdjson();
  const trozos = p.alimentar(Buffer.from(linea(wav)));
  assert.deepEqual([...trozos[0]!.pcm!], [9, 9]);
});

test('usage y modelId se capturan; rematar vuelca la última línea sin \\n', () => {
  const p = new ParserNdjson();
  const sinSalto = JSON.stringify({ result: { usage: { processedCharactersCount: 42, modelId: 'inworld-tts-2' } } });
  assert.equal(p.alimentar(Buffer.from(sinSalto)).length, 0);
  const trozos = p.rematar();
  assert.equal(trozos[0]!.caracteresProveedor, 42);
  assert.equal(trozos[0]!.modeloDevuelto, 'inworld-tts-2');
});
