import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardianVoz } from '../src/aplicacion/guardian.ts';

function relojFalso() { let t = 0; return { ahora: () => t, avanzar: (ms: number) => { t += ms; } }; }

test('C1: fuera de canal y ensordecido bloquean', () => {
  const g = new GuardianVoz(relojFalso());
  assert.deepEqual(g.evaluar('g', 'u', { canalId: null, ensordecido: false }),
    { ok: false, motivo: 'fuera_de_canal' });
  assert.deepEqual(g.evaluar('g', 'u', { canalId: 'c1', ensordecido: true }),
    { ok: false, motivo: 'ensordecido' });
});

test('cerrojo primero-que-habla: otro canal → ocupado; se libera tras 10 s ocioso', () => {
  const reloj = relojFalso();
  const g = new GuardianVoz(reloj);
  assert.equal(g.evaluar('g', 'u1', { canalId: 'c1', ensordecido: false }).ok, true);
  g.ocupar('g', 'c1');
  assert.deepEqual(g.evaluar('g', 'u2', { canalId: 'c2', ensordecido: false }),
    { ok: false, motivo: 'canal_ocupado' });
  // mismo canal: pasa aunque esté ocupado
  assert.equal(g.evaluar('g', 'u2', { canalId: 'c1', ensordecido: false }).ok, true);
  g.liberarSiOcioso('g', true);          // marca el inicio del silencio
  reloj.avanzar(9_000);
  g.liberarSiOcioso('g', true);
  assert.equal(g.canalOcupado('g'), 'c1'); // aún no: faltan segundos
  reloj.avanzar(2_000);
  g.liberarSiOcioso('g', true);
  assert.equal(g.canalOcupado('g'), null); // 10 s de silencio: libre
  assert.equal(g.evaluar('g', 'u2', { canalId: 'c2', ensordecido: false }).ok, true);
});
