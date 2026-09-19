import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarConfig, ErrorConfig } from '../src/config.ts';

const base = {
  DISCORD_TOKEN: 't', DISCORD_APP_ID: '1', DISCORD_ADMIN_ID: '2',
  GUILD_ALLOWLIST: '111, 222', INWORLD_API_KEY: 'abc123',
  MYSQL_HOST: 'db', MYSQL_DATABASE: 'albas_tts', MYSQL_USER: 'bot', MYSQL_PASSWORD: 'x',
};

test('falta una variable → ErrorConfig que la nombra', () => {
  const { DISCORD_TOKEN, ...sinToken } = base;
  assert.throws(() => cargarConfig(sinToken), (e: unknown) =>
    e instanceof ErrorConfig && e.message.includes('DISCORD_TOKEN'));
});

test('la credencial de Inworld se normaliza a "Basic "', () => {
  assert.equal(cargarConfig(base).inworldApiKey, 'Basic abc123');
  // si ya viene con esquema, se respeta: evita el "Basic Basic …" → 401
  assert.equal(cargarConfig({ ...base, INWORLD_API_KEY: 'Basic abc' }).inworldApiKey, 'Basic abc');
  assert.equal(cargarConfig({ ...base, INWORLD_API_KEY: 'Bearer abc' }).inworldApiKey, 'Bearer abc');
});

test('allowlist se trocea y limpia; defaults sanos', () => {
  const c = cargarConfig(base);
  assert.deepEqual(c.guildAllowlist, ['111', '222']);
  assert.equal(c.inworldModel, 'inworld-tts-2');
  assert.equal(c.ttsConcurrencia, 3);
  assert.equal(c.ttsKillSwitch, false);
});
