import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Locutor } from '../src/audio/locutor.ts';
import { Semaforo } from '../src/audio/semaforo.ts';
import { crearLogger } from '../src/logger.ts';

// Altavoz falso: acumula lo empujado, remata al instante.
function altavozFalso() {
  const empujado: Buffer[] = [];
  return {
    empujado,
    empujar: (_g: string, pcm: Buffer) => { empujado.push(pcm); },
    rematarLocucion: async () => {}, cortar: () => {},
    conectar: async () => {}, desconectar: async () => {}, canalActualId: () => 'c',
  };
}

test('trocea en frases, sintetiza en orden y convierte a estéreo', async () => {
  const llamadas: string[] = [];
  const tts = {
    async sintetizar(texto: string, _v: string, onPcm: (b: Buffer) => void) {
      llamadas.push(texto);
      onPcm(Buffer.from([1, 0, 2, 0])); // 2 muestras mono
      return { caracteresProveedor: texto.length, modeloDevuelto: 'm', msPrimerByte: 5 };
    },
  };
  const alt = altavozFalso();
  const locutor = new Locutor(tts, new Semaforo(1), alt as never, crearLogger('silent', 'UTC'));
  const r = await locutor.locutar('g', 'Primera frase completa aquí. Segunda frase completa aquí.', 'Marta', new AbortController().signal);
  assert.equal(r.estado, 'reproducido');
  assert.equal(llamadas.length, 2);
  assert.equal(alt.empujado[0]!.length, 8); // estéreo: 2 muestras → 8 bytes
});

test('el fallo con audio ya emitido NO se reintenta', async () => {
  let intentos = 0;
  const tts = {
    async sintetizar(_t: string, _v: string, onPcm: (b: Buffer) => void) {
      intentos++;
      onPcm(Buffer.from([1, 0]));
      throw Object.assign(new Error('corte a mitad'), { status: 500 });
    },
  };
  const locutor = new Locutor(tts, new Semaforo(1), altavozFalso() as never, crearLogger('silent', 'UTC'));
  const r = await locutor.locutar('g', 'Frase única suficientemente larga.', 'Marta', new AbortController().signal);
  assert.equal(r.estado, 'fallido');
  assert.equal(intentos, 1); // sin reintento: ya sonó media frase
});

test('abortar devuelve estado abortado sin seguir sintetizando', async () => {
  const control = new AbortController();
  const tts = {
    async sintetizar(_t: string, _v: string, _onPcm: (b: Buffer) => void, señal: AbortSignal) {
      control.abort(); // se aborta durante la primera frase
      señal.throwIfAborted();
      return { caracteresProveedor: 0, modeloDevuelto: null, msPrimerByte: 0 };
    },
  };
  const locutor = new Locutor(tts, new Semaforo(1), altavozFalso() as never, crearLogger('silent', 'UTC'));
  const r = await locutor.locutar('g', 'Primera frase completa aquí. Segunda que no debe llegar.', 'Marta', control.signal);
  assert.equal(r.estado, 'abortado');
});
