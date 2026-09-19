import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatoLegible } from '../src/logger.ts';

test('timestamp legible en la zona pedida, con milisegundos', () => {
  // 2026-01-15T12:00:00.117Z → 13:00:00.117 en Madrid (invierno, UTC+1)
  assert.equal(formatoLegible(Date.UTC(2026, 0, 15, 12, 0, 0, 117), 'Europe/Madrid'),
    '2026-01-15 13:00:00.117');
});
