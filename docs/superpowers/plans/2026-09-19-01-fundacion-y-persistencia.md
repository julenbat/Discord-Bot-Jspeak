# Plan 1/3 — Fundación y persistencia

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Esqueleto TypeScript ejecutable con Node 24 sin build, configuración fail-fast, logger con timestamp legible, MySQL en compose con healthcheck correcto, migraciones y los tres repositorios — un contenedor que arranca, migra y persiste.

**Architecture:** Arquitectura por capas (README §3). Este plan cubre la capa de infraestructura completa y los cimientos transversales (config, logger, reloj). Sin Discord ni audio todavía: el `main.ts` de este plan arranca, migra y se queda esperando SIGTERM.

**Tech Stack:** Node 24 (type stripping nativo, sin build), TypeScript ~5.9.3 (`tsc --noEmit` como puerta), mysql2/promise, pino, Docker multi-stage, MySQL 8.4.11.

**Spec:** `ESPECIFICACION.md` (raíz del repo) — §5 filas Intents/TypeScript/Imagen/MySQL/Degradación/Acceso a datos, §7 y §8.

## Global Constraints

- Todo comando de shell prefijado con `rtk` (CLAUDE.md global del autor).
- Código, comentarios, commits y logs en castellano; los comentarios explican *por qué*.
- Prohibidos en TS: `enum`, `namespace`, decoradores, parameter properties (`erasableSyntaxOnly` los convierte en error).
- Imports relativos SIEMPRE con extensión `.ts` (lo exige el type stripping de Node).
- Snowflakes de Discord: `VARCHAR(20) ascii_bin` en MySQL, `string` en TS. Nunca `number`/`BIGINT`.
- Fechas en BD: `DATETIME(3)` en UTC. Dinero: `DECIMAL(12,6)`.
- Secretos solo en `.env` (git-ignored) con `.env.example` documentado al lado.
- Ningún ORM; `pool.execute()` con `namedPlaceholders`, jamás interpolación de SQL.
- Node del host: el autor ejecuta en Windows; los tests corren con `rtk node --test`.

---

### Task 1: Esqueleto del proyecto y puerta de tipos

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`, `src/main.ts`
- Test: la puerta es `tsc --noEmit` + arranque real

**Interfaces:**
- Produces: convenciones de proyecto que consumen todas las tareas: ESM (`"type":"module"`), imports con `.ts`, scripts `npm run check` y `npm test`.

- [ ] **Step 1: package.json**

```json
{
  "name": "albas-discord-tts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/main.ts",
    "check": "tsc --noEmit",
    "test": "node --test test/"
  },
  "dependencies": {
    "mysql2": "^3.11.0",
    "pino": "^9.7.0"
  },
  "devDependencies": {
    "typescript": "~5.9.3",
    "@types/node": "^24.0.0"
  }
}
```

(discord.js, @discordjs/voice y opusscript entran en los planes 2 y 3, cada uno donde se usa.)

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: .gitignore y .dockerignore**

`.gitignore`:
```
node_modules/
.env
*.log
```
`.dockerignore`:
```
node_modules
.git
.env
docs
test
```

- [ ] **Step 4: main.ts mínimo que demuestra el type stripping**

```ts
// Punto de entrada. En este plan solo demuestra que Node 24 ejecuta .ts
// sin build; las piezas reales se enchufan aquí en los planes siguientes.
const version: string = process.version;
console.log(`albas-discord-tts arrancando con Node ${version}`);
```

- [ ] **Step 5: Instalar y verificar**

Run: `rtk npm install && rtk npm run check && rtk node src/main.ts`
Expected: `check` sin errores; el arranque imprime la versión de Node y sale.

- [ ] **Step 6: Commit**

```bash
rtk git add -A && rtk git commit -m "chore: esqueleto TypeScript con type stripping de Node 24"
```

---

### Task 2: Configuración fail-fast (`config.ts`)

**Files:**
- Create: `src/config.ts`, `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `cargarConfig(env: NodeJS.ProcessEnv): Config` y el tipo `Config` con estos campos exactos, que consumen TODOS los planes:
  `discordToken, discordAppId, discordAdminId, guildAllowlist: string[], inworldApiKey (normalizada con "Basic "/"Bearer "), inworldModel, inworldLanguage, tarifaUsdMillon: Record<string, number>, mysql: {host, database, user, password}, tz, logLevel, ttsConcurrencia: number, ttsKillSwitch: boolean`
- Produces: `class ErrorConfig extends Error` con la lista de variables que faltan.

- [ ] **Step 1: Test que falla**

```ts
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
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/config.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementación**

```ts
// Configuración por entorno, patrón heredado del voice-agent: si falta algo
// indispensable se aborta con mensaje claro. La pausa previa al exit evita
// que `restart: unless-stopped` haga girar el contenedor sin parar.
export class ErrorConfig extends Error {}

export interface Config {
  discordToken: string; discordAppId: string; discordAdminId: string;
  guildAllowlist: string[];
  inworldApiKey: string; inworldModel: string; inworldLanguage: string;
  tarifaUsdMillon: Record<string, number>;
  mysql: { host: string; database: string; user: string; password: string };
  tz: string; logLevel: string;
  ttsConcurrencia: number; ttsKillSwitch: boolean;
}

const OBLIGATORIAS = ['DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_ADMIN_ID',
  'GUILD_ALLOWLIST', 'INWORLD_API_KEY',
  'MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'] as const;

export function cargarConfig(env: NodeJS.ProcessEnv): Config {
  const faltan = OBLIGATORIAS.filter((k) => !env[k]);
  if (faltan.length) {
    throw new ErrorConfig(`Faltan variables de entorno: ${faltan.join(', ')}. Copia .env.example a .env y rellénalas.`);
  }
  const clave = env.INWORLD_API_KEY!.trim();
  return {
    discordToken: env.DISCORD_TOKEN!, discordAppId: env.DISCORD_APP_ID!,
    discordAdminId: env.DISCORD_ADMIN_ID!,
    guildAllowlist: env.GUILD_ALLOWLIST!.split(',').map((s) => s.trim()).filter(Boolean),
    inworldApiKey: /^(Basic|Bearer) /.test(clave) ? clave : `Basic ${clave}`,
    inworldModel: env.INWORLD_MODEL || 'inworld-tts-2',
    inworldLanguage: env.INWORLD_LANGUAGE || 'es-ES',
    tarifaUsdMillon: {
      'inworld-tts-2': Number(env.TARIFA_USD_MILLON_TTS2 || 25),
      'inworld-tts-2-flash': Number(env.TARIFA_USD_MILLON_FLASH || 15),
    },
    mysql: { host: env.MYSQL_HOST!, database: env.MYSQL_DATABASE!,
             user: env.MYSQL_USER!, password: env.MYSQL_PASSWORD! },
    tz: env.TZ || 'Europe/Madrid',
    logLevel: env.LOG_LEVEL || 'info',
    ttsConcurrencia: Number(env.TTS_CONCURRENCIA || 3),
    ttsKillSwitch: env.TTS_KILL_SWITCH === 'true',
  };
}
```

`.env.example`: copiar el borrador de `ESPECIFICACION.md` §7 tal cual, con un comentario por variable.

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/config.test.ts` → PASS.

- [ ] **Step 5: Commit** — `rtk git add -A && rtk git commit -m "feat: configuración fail-fast con normalización de credencial Inworld"`

---

### Task 3: Logger con timestamp legible y reloj inyectable

**Files:**
- Create: `src/logger.ts`, `src/reloj.ts`
- Test: `test/logger.test.ts`

**Interfaces:**
- Produces: `crearLogger(nivel: string, tz: string): Logger` (tipo `Logger` de pino, se re-exporta).
- Produces: `formatoLegible(epochMs: number, tz: string): string` → `"2026-09-19 14:03:22.117"`.
- Produces: `interface Reloj { ahora(): number }` y `const relojSistema: Reloj` — TODO código que mida tiempo (C2, C5, sesiones) recibe un `Reloj`, nunca llama a `Date.now()` directo: es lo que hace testeables los cooldowns sin dormir.

- [ ] **Step 1: Test que falla**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatoLegible } from '../src/logger.ts';

test('timestamp legible en la zona pedida, con milisegundos', () => {
  // 2026-01-15T12:00:00.117Z → 13:00:00.117 en Madrid (invierno, UTC+1)
  assert.equal(formatoLegible(Date.UTC(2026, 0, 15, 12, 0, 0, 117), 'Europe/Madrid'),
    '2026-01-15 13:00:00.117');
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/logger.test.ts` → FAIL.

- [ ] **Step 3: Implementación**

`src/reloj.ts`:
```ts
export interface Reloj { ahora(): number }
export const relojSistema: Reloj = { ahora: () => Date.now() };
```

`src/logger.ts`:
```ts
import { pino, type Logger } from 'pino';
export type { Logger };

// El requisito es leer los logs a ojo (ESPECIFICACION §8): timestamp legible
// SIN pino-pretty en producción. 'sv-SE' da el formato ISO con guiones que
// queremos; los milisegundos se añaden a mano porque Intl no los formatea
// con este estilo.
export function formatoLegible(epochMs: number, tz: string): string {
  const fecha = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(epochMs);
  return `${fecha}.${String(epochMs % 1000).padStart(3, '0')}`;
}

export function crearLogger(nivel: string, tz: string): Logger {
  return pino({
    level: nivel,
    timestamp: () => `,"time":"${formatoLegible(Date.now(), tz)}"`,
    formatters: { level: (etiqueta) => ({ nivel: etiqueta }) },
  });
}
```

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/logger.test.ts` → PASS.

- [ ] **Step 5: Commit** — `rtk git commit -am "feat: logger con timestamp legible y reloj inyectable"`

---

### Task 4: Compose con MySQL sano + pool con reintento

**Files:**
- Create: `docker-compose.yml`, `src/infra/bd.ts`
- Test: verificación manual contra el contenedor (los tests de repositorio llegan en la Task 6)

**Interfaces:**
- Produces: `crearPool(cfg: Config['mysql']): Pool` (tipo `Pool` de `mysql2/promise`).
- Produces: `esperarBd(pool: Pool, log: Logger, señal?: AbortSignal): Promise<void>` — backoff 1,2,4,8,16,30,30… s hasta que `SELECT 1` responda. El gateway de Discord NO se toca hasta que esto resuelva.

- [ ] **Step 1: docker-compose.yml**

```yaml
services:
  bot:
    build: .
    init: true
    restart: unless-stopped
    stop_grace_period: 20s
    env_file: .env
    environment:
      TZ: Europe/Madrid
    depends_on:
      db:
        condition: service_healthy
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }

  db:
    image: mysql:8.4.11
    restart: unless-stopped
    command: --default-time-zone=+00:00
    environment:
      TZ: Europe/Madrid
      MYSQL_DATABASE: ${MYSQL_DATABASE}
      MYSQL_USER: ${MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_RANDOM_ROOT_PASSWORD: "yes"
    volumes:
      - datos_mysql:/var/lib/mysql
    # SELECT 1 por TCP, no `mysqladmin ping` por socket: el entrypoint levanta
    # un servidor temporal con --skip-networking durante la inicialización y
    # el ping por socket da OK cuando el puerto aún no acepta a nadie.
    healthcheck:
      test: ["CMD-SHELL", "mysql -h 127.0.0.1 -u$$MYSQL_USER -p$$MYSQL_PASSWORD -e 'SELECT 1' $$MYSQL_DATABASE"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 60s

volumes:
  datos_mysql:
```

(Sin `ports:` en `db`: no se publica fuera de la red de compose.)

- [ ] **Step 2: src/infra/bd.ts**

```ts
import { createPool, type Pool } from 'mysql2/promise';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';

export function crearPool(cfg: Config['mysql']): Pool {
  return createPool({
    host: cfg.host, database: cfg.database, user: cfg.user, password: cfg.password,
    connectionLimit: 8, maxIdle: 4, enableKeepAlive: true,
    timezone: 'Z',              // el pool habla UTC; la legibilidad la pone el logger
    namedPlaceholders: true,
    charset: 'utf8mb4_unicode_ci',
    supportBigNumbers: true, bigNumberStrings: true,
  });
}

// `depends_on: service_healthy` solo cubre el primer arranque; si MySQL se
// reinicia en caliente el bot debe reencontrarlo solo.
const ESCALA_S = [1, 2, 4, 8, 16, 30];
export async function esperarBd(pool: Pool, log: Logger, señal?: AbortSignal): Promise<void> {
  for (let intento = 0; ; intento++) {
    if (señal?.aborted) throw new Error('espera de BD abortada');
    try { await pool.query('SELECT 1'); return; }
    catch (err) {
      const s = ESCALA_S[Math.min(intento, ESCALA_S.length - 1)]!;
      log.warn({ err: (err as Error).message, reintentoEnS: s }, 'MySQL no disponible');
      await new Promise((r) => setTimeout(r, s * 1000));
    }
  }
}
```

- [ ] **Step 3: Verificar contra el contenedor real**

Run: `rtk docker compose up -d db` y después `rtk docker compose ps`
Expected: `db` pasa a `healthy` (tarda ~30 s la primera vez, que es cuando inicializa el datadir).

- [ ] **Step 4: Verificar los tres relojes de zona horaria**

Run: `rtk docker compose exec db mysql -u$MYSQL_USER -p$MYSQL_PASSWORD -e "SELECT NOW(), @@global.time_zone"`
Expected: `NOW()` en UTC y `time_zone = +00:00`.

- [ ] **Step 5: Commit** — `rtk git add -A && rtk git commit -m "feat: compose con MySQL sano y pool con reintento"`

---

### Task 5: Migrador y esquema inicial

**Files:**
- Create: `src/infra/migrador.ts`, `migrations/0001_esquema_inicial.sql`
- Test: `test/integracion/migrador.test.ts` (requiere `db` de compose levantado)

**Interfaces:**
- Produces: `migrar(pool: Pool, log: Logger, dir?: string): Promise<number>` — aplica los `migrations/NNNN_*.sql` pendientes en orden bajo `GET_LOCK`, registra en `schema_migraciones` (nombre, checksum sha256, fecha) y devuelve cuántas aplicó. Checksum distinto de uno ya aplicado → warn, no error.
- Produces: las TRES tablas del proyecto, con estos nombres y columnas exactos que consumen los repositorios (Task 6) y los planes 2-3.

- [ ] **Step 1: migrations/0001_esquema_inicial.sql**

```sql
-- Autorización (admin) ≠ sesión (usuario): dos tablas, ESPECIFICACION §1.
-- Snowflakes como VARCHAR(20): BIGINT + JS redondea por encima de 2^53
-- y autorizaría a otro usuario.
CREATE TABLE autorizaciones (
  guild_id      VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id       VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado        ENUM('activa','revocada') NOT NULL DEFAULT 'activa',
  voz           VARCHAR(64)  NOT NULL DEFAULT 'Marta',
  concedida_por VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  concedida_en  DATETIME(3) NOT NULL,
  revocada_en   DATETIME(3) NULL,
  revocada_por  VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- La existencia de la fila ES el estado "activo". El CASCADE solo salta si se
-- BORRA la autorización; la revocación es lógica y desactiva desde el servicio.
CREATE TABLE sesiones (
  guild_id          VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id           VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  activada_en       DATETIME(3) NOT NULL,
  ultimo_mensaje_en DATETIME(3) NULL,
  ultimos_avisos    JSON NOT NULL,  -- { "cola_llena": epochMs, ... } persistido: reiniciar no resetea el antispam
  PRIMARY KEY (guild_id, user_id),
  CONSTRAINT fk_sesion_autorizacion FOREIGN KEY (guild_id, user_id)
    REFERENCES autorizaciones (guild_id, user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Una fila por locución INTENTADA, insertada antes de sintetizar:
-- UNIQUE(mensaje_id) es el portero de idempotencia contra la reentrega
-- de MESSAGE_CREATE en RESUME.
CREATE TABLE tts_eventos (
  id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mensaje_id            VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  guild_id              VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id               VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  canal_voz_id          VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  estado                ENUM('encolado','reproducido','abortado','fallido','descartado') NOT NULL,
  motivo_descarte       VARCHAR(64) NULL,
  texto_original        TEXT NULL,
  texto_saneado         TEXT NULL,
  caracteres            INT UNSIGNED NOT NULL DEFAULT 0,
  caracteres_proveedor  INT UNSIGNED NULL,   -- usage de Inworld; llegó 0 en streaming: NULL-able por diseño
  modelo                VARCHAR(64) NULL,
  voz                   VARCHAR(64) NULL,
  ms_primer_byte        INT UNSIGNED NULL,
  ms_primer_audio       INT UNSIGNED NULL,
  ms_audio              INT UNSIGNED NULL,
  underruns             SMALLINT UNSIGNED NULL,
  coste_usd             DECIMAL(12,6) NULL,
  tarifa_usd_por_millon DECIMAL(12,6) NULL,  -- copiada en cada fila: recalcular histórico al cambiar de plan
  coste_origen          ENUM('api','estimado','desconocido') NOT NULL DEFAULT 'desconocido',
  creado_en             DATETIME(3) NOT NULL,
  terminado_en          DATETIME(3) NULL,
  UNIQUE KEY uq_mensaje (mensaje_id),
  KEY idx_guild_user_fecha (guild_id, user_id, creado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: Test de integración que falla**

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearPool } from '../../src/infra/bd.ts';
import { migrar } from '../../src/infra/migrador.ts';
import { crearLogger } from '../../src/logger.ts';

// Requiere: rtk docker compose up -d db  (y MYSQL_* en el entorno o .env cargado)
const pool = crearPool({ host: '127.0.0.1', database: process.env.MYSQL_DATABASE!,
  user: process.env.MYSQL_USER!, password: process.env.MYSQL_PASSWORD! });
const log = crearLogger('silent', 'UTC');

after(() => pool.end());

test('aplica las pendientes una sola vez', async () => {
  const primera = await migrar(pool, log);
  assert.ok(primera >= 1);
  assert.equal(await migrar(pool, log), 0); // idempotente
  const [tablas] = await pool.query("SHOW TABLES LIKE 'tts_eventos'");
  assert.equal((tablas as unknown[]).length, 1);
});
```

Nota: para correr este test en local hay que publicar el puerto de `db` temporalmente (`rtk docker compose run --rm -p 3306:3306 db` o un override de desarrollo con `ports: ["3306:3306"]` en `docker-compose.override.yml`, que se añade en este step y se git-ignora si publica el puerto solo en local).

- [ ] **Step 3: Verificar que falla** — Run: `rtk node --test test/integracion/migrador.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 4: Implementación de `migrar`**

```ts
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.ts';

// El DDL de MySQL hace commit implícito: no hay transacción que valga.
// Por eso cada fichero es pequeño y de un solo propósito, y el runner
// serializa procesos con GET_LOCK para que dos réplicas no se pisen.
export async function migrar(pool: Pool, log: Logger, dir = 'migrations'): Promise<number> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migraciones (
    nombre VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL,
    aplicada_en DATETIME(3) NOT NULL)`);
  const [cerrojo] = await pool.query("SELECT GET_LOCK('albas_migraciones', 30) AS ok");
  if ((cerrojo as { ok: number }[])[0]?.ok !== 1) throw new Error('no se pudo obtener el cerrojo de migraciones');
  try {
    const [filas] = await pool.query('SELECT nombre, checksum FROM schema_migraciones');
    const aplicadas = new Map((filas as { nombre: string; checksum: string }[])
      .map((f) => [f.nombre, f.checksum]));
    const ficheros = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    let aplicadasAhora = 0;
    for (const fichero of ficheros) {
      const sql = await readFile(join(dir, fichero), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previa = aplicadas.get(fichero);
      if (previa !== undefined) {
        // Avisar y seguir: un checksum cambiado suele ser un retoque de
        // comentarios; abortar aquí dejaría el bot sin arrancar por nada.
        if (previa !== checksum) log.warn({ fichero }, 'migración ya aplicada con contenido distinto');
        continue;
      }
      for (const sentencia of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
        await pool.query(sentencia);
      }
      await pool.execute(
        'INSERT INTO schema_migraciones (nombre, checksum, aplicada_en) VALUES (:nombre, :checksum, UTC_TIMESTAMP(3))',
        { nombre: fichero, checksum });
      log.info({ fichero }, 'migración aplicada');
      aplicadasAhora++;
    }
    return aplicadasAhora;
  } finally {
    await pool.query("SELECT RELEASE_LOCK('albas_migraciones')");
  }
}
```

- [ ] **Step 5: Verificar que pasa** — Run: `rtk docker compose up -d db && rtk node --test test/integracion/migrador.test.ts` → PASS.

- [ ] **Step 6: Commit** — `rtk git add -A && rtk git commit -m "feat: migrador con GET_LOCK y esquema inicial (autorizaciones, sesiones, tts_eventos)"`

---

### Task 6: Repositorios

**Files:**
- Create: `src/aplicacion/puertos.ts` (interfaces), `src/infra/repo-autorizaciones.ts`, `src/infra/repo-sesiones.ts`, `src/infra/repo-tts-eventos.ts`
- Test: `test/integracion/repos.test.ts`

**Interfaces:**
- Produces (en `puertos.ts`, la capa de aplicación declara y la infra implementa):

```ts
export interface Autorizacion {
  guildId: string; userId: string; estado: 'activa' | 'revocada';
  voz: string; concedidaPor: string; concedidaEn: Date;
}
export interface RepoAutorizaciones {
  autorizar(a: { guildId: string; userId: string; concedidaPor: string }): Promise<void>; // UPSERT que reactiva revocadas
  revocar(guildId: string, userId: string, por: string): Promise<boolean>;
  buscar(guildId: string, userId: string): Promise<Autorizacion | null>;
  fijarVoz(guildId: string, userId: string, voz: string): Promise<void>;
  listarActivas(): Promise<Autorizacion[]>; // para la caché en memoria al arrancar
}
export interface Sesion {
  guildId: string; userId: string; activadaEn: Date;
  ultimoMensajeEn: Date | null; ultimosAvisos: Record<string, number>;
}
export interface RepoSesiones {
  activar(guildId: string, userId: string): Promise<void>;      // INSERT IGNORE: idempotente
  desactivar(guildId: string, userId: string): Promise<boolean>;
  buscar(guildId: string, userId: string): Promise<Sesion | null>;
  listar(): Promise<Sesion[]>;
  tocarUltimoMensaje(guildId: string, userId: string, cuando: Date): Promise<void>;
  fijarAviso(guildId: string, userId: string, tipo: string, cuandoMs: number): Promise<void>;
}
export interface EventoTtsNuevo {
  mensajeId: string; guildId: string; userId: string; canalVozId: string | null;
  estado: 'encolado' | 'descartado'; motivoDescarte?: string;
  textoOriginal: string; textoSaneado: string; caracteres: number; voz: string;
}
export interface CierreEventoTts {
  estado: 'reproducido' | 'abortado' | 'fallido';
  caracteresProveedor?: number; modelo?: string;
  msPrimerByte?: number; msPrimerAudio?: number; msAudio?: number; underruns?: number;
  costeUsd?: number; tarifaUsdPorMillon?: number; costeOrigen: 'api' | 'estimado' | 'desconocido';
}
export interface RepoTtsEventos {
  abrir(e: EventoTtsNuevo): Promise<'nuevo' | 'duplicado'>; // ER_DUP_ENTRY → 'duplicado'
  cerrar(mensajeId: string, c: CierreEventoTts): Promise<void>;
}
```

- [ ] **Step 1: Test de integración que falla** (los casos que de verdad muerden)

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearPool } from '../../src/infra/bd.ts';
import { migrar } from '../../src/infra/migrador.ts';
import { crearLogger } from '../../src/logger.ts';
import { RepoAutorizacionesMysql } from '../../src/infra/repo-autorizaciones.ts';
import { RepoSesionesMysql } from '../../src/infra/repo-sesiones.ts';
import { RepoTtsEventosMysql } from '../../src/infra/repo-tts-eventos.ts';

const pool = crearPool({ host: '127.0.0.1', database: process.env.MYSQL_DATABASE!,
  user: process.env.MYSQL_USER!, password: process.env.MYSQL_PASSWORD! });
const G = '111111111111111111', U = '222222222222222222';

before(async () => {
  await migrar(pool, crearLogger('silent', 'UTC'));
  await pool.query('DELETE FROM tts_eventos'); await pool.query('DELETE FROM autorizaciones');
});
after(() => pool.end());

test('autorizar → activar → revocar en cascada', async () => {
  const autorizaciones = new RepoAutorizacionesMysql(pool);
  const sesiones = new RepoSesionesMysql(pool);
  await autorizaciones.autorizar({ guildId: G, userId: U, concedidaPor: '3' });
  await sesiones.activar(G, U);
  await sesiones.activar(G, U); // idempotente: no lanza
  assert.ok(await sesiones.buscar(G, U));
  assert.equal(await autorizaciones.revocar(G, U, '3'), true);
  assert.equal((await autorizaciones.buscar(G, U))?.estado, 'revocada');
  // re-autorizar reactiva la fila revocada (UPSERT), conservando la voz
  await autorizaciones.fijarVoz(G, U, 'Curro');
  await autorizaciones.autorizar({ guildId: G, userId: U, concedidaPor: '3' });
  const a = await autorizaciones.buscar(G, U);
  assert.equal(a?.estado, 'activa'); assert.equal(a?.voz, 'Curro');
});

test('idempotencia de tts_eventos por mensaje_id', async () => {
  const eventos = new RepoTtsEventosMysql(pool);
  const e = { mensajeId: '999999999999999999', guildId: G, userId: U, canalVozId: null,
    estado: 'encolado' as const, textoOriginal: 'hola', textoSaneado: 'hola', caracteres: 4, voz: 'Marta' };
  assert.equal(await eventos.abrir(e), 'nuevo');
  assert.equal(await eventos.abrir(e), 'duplicado'); // segunda vez: el UNIQUE la para
  await eventos.cerrar(e.mensajeId, { estado: 'reproducido', msAudio: 5080,
    costeUsd: 0.0001, tarifaUsdPorMillon: 25, costeOrigen: 'estimado' });
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/integracion/repos.test.ts` → FAIL.

- [ ] **Step 3: Implementación** (patrón idéntico en los tres; se muestra el de autorizaciones entero y lo específico de los otros dos)

`src/infra/repo-autorizaciones.ts`:
```ts
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Autorizacion, RepoAutorizaciones } from '../aplicacion/puertos.ts';

// Un mapeador por repositorio: ningún RowDataPacket sube de esta capa.
function mapear(f: RowDataPacket): Autorizacion {
  return { guildId: f.guild_id, userId: f.user_id, estado: f.estado,
    voz: f.voz, concedidaPor: f.concedida_por, concedidaEn: f.concedida_en };
}

export class RepoAutorizacionesMysql implements RepoAutorizaciones {
  constructor(private readonly pool: Pool) {}

  async autorizar(a: { guildId: string; userId: string; concedidaPor: string }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO autorizaciones (guild_id, user_id, estado, concedida_por, concedida_en)
       VALUES (:guildId, :userId, 'activa', :concedidaPor, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE estado='activa', concedida_por=:concedidaPor,
         concedida_en=UTC_TIMESTAMP(3), revocada_en=NULL, revocada_por=NULL`, a);
  }

  async revocar(guildId: string, userId: string, por: string): Promise<boolean> {
    const [r] = await this.pool.execute(
      `UPDATE autorizaciones SET estado='revocada', revocada_en=UTC_TIMESTAMP(3), revocada_por=:por
       WHERE guild_id=:guildId AND user_id=:userId AND estado='activa'`, { guildId, userId, por });
    return (r as { affectedRows: number }).affectedRows > 0;
  }

  async buscar(guildId: string, userId: string): Promise<Autorizacion | null> {
    const [filas] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM autorizaciones WHERE guild_id=:guildId AND user_id=:userId', { guildId, userId });
    return filas[0] ? mapear(filas[0]) : null;
  }

  async fijarVoz(guildId: string, userId: string, voz: string): Promise<void> {
    await this.pool.execute(
      'UPDATE autorizaciones SET voz=:voz WHERE guild_id=:guildId AND user_id=:userId',
      { guildId, userId, voz });
  }

  async listarActivas(): Promise<Autorizacion[]> {
    const [filas] = await this.pool.execute<RowDataPacket[]>(
      "SELECT * FROM autorizaciones WHERE estado='activa'");
    return filas.map(mapear);
  }
}
```

`repo-sesiones.ts` — lo no obvio: `activar` con `INSERT ... ON DUPLICATE KEY UPDATE guild_id=guild_id` (no-op) para la idempotencia; `ultimos_avisos` arranca en `'{}'` y `fijarAviso` usa `JSON_SET(ultimos_avisos, CONCAT('$.', :tipo), :cuandoMs)`; el mapeador hace `JSON.parse` si el driver devuelve string.

`repo-tts-eventos.ts` — lo no obvio: `abrir` envuelve el INSERT en try/catch y devuelve `'duplicado'` si `(err as {code?: string}).code === 'ER_DUP_ENTRY'`, relanzando cualquier otro error; `cerrar` es un UPDATE por `mensaje_id` con `terminado_en=UTC_TIMESTAMP(3)`.

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/integracion/repos.test.ts` → PASS. Después `rtk npm run check` → sin errores.

- [ ] **Step 5: Commit** — `rtk git add -A && rtk git commit -m "feat: puertos y repositorios MySQL con idempotencia y revocación lógica"`

---

### Task 7: Dockerfile y arranque orquestado

**Files:**
- Create: `Dockerfile`
- Modify: `src/main.ts` (sustituir el contenido de la Task 1)

**Interfaces:**
- Consumes: `cargarConfig`, `crearLogger`, `crearPool`, `esperarBd`, `migrar`.
- Produces: el orden de arranque que el plan 3 extiende (config → logger → BD → migrar → [Discord, plan 3] → señales).

- [ ] **Step 1: Dockerfile**

```dockerfile
# Multi-stage: deps de producción / puerta de tipos / runtime mínimo.
# Debian slim y no Alpine: tzdata presente (TZ funciona) y glibc para
# cualquier prebuild futuro. CMD en forma exec: npm como PID 1 no propaga
# SIGTERM y el apagado ordenado no llegaría a ejecutarse jamás.
FROM node:24.21.0-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.21.0-trixie-slim AS check
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npx tsc --noEmit

FROM node:24.21.0-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
USER node
CMD ["node", "src/main.ts"]
```

(El stage `check` corre solo `tsc --noEmit`: los tests de integración necesitan MySQL y corren fuera del build.)

- [ ] **Step 2: main.ts real**

```ts
import { cargarConfig, ErrorConfig } from './config.ts';
import { crearLogger } from './logger.ts';
import { crearPool, esperarBd } from './infra/bd.ts';
import { migrar } from './infra/migrador.ts';

// Composition root: TODO se construye y se cablea aquí, a mano.
// Config incompleta → pausa y exit(1): la pausa evita que
// `restart: unless-stopped` haga girar el contenedor sin parar.
let config;
try { config = cargarConfig(process.env); }
catch (err) {
  if (err instanceof ErrorConfig) {
    console.error(err.message);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
    process.exit(1);
  }
  throw err;
}

const log = crearLogger(config.logLevel, config.tz);
const pool = crearPool(config.mysql);
const abortoArranque = new AbortController();

// Nada de Discord hasta tener base: aparecer online prometiendo un servicio
// que no se puede dar es peor que tardar en aparecer. (El gateway se enchufa
// en el plan 3, en este mismo punto.)
await esperarBd(pool, log, abortoArranque.signal);
const aplicadas = await migrar(pool, log);
log.info({ migracionesAplicadas: aplicadas }, 'base de datos lista');

let apagando = false;
async function apagar(señal: string): Promise<void> {
  if (apagando) return; apagando = true;
  log.info({ señal }, 'apagado ordenado');
  // El plan 3 inserta aquí, en este orden: dejar de aceptar eventos →
  // abortar síntesis → vaciar colas → silencio+stop → destroy voz →
  // delete encoder → client.destroy().
  const tope = setTimeout(() => process.exit(1), 8_000);
  await pool.end();
  clearTimeout(tope);
  process.exit(0);
}
process.on('SIGTERM', () => void apagar('SIGTERM'));
process.on('SIGINT', () => void apagar('SIGINT'));

log.info('fundación arrancada; a la espera de señales');
```

- [ ] **Step 3: Verificar el ciclo completo en Docker**

Run: `rtk docker compose up --build -d && rtk docker compose logs bot`
Expected: "base de datos lista" con `migracionesAplicadas` y "fundación arrancada".

- [ ] **Step 4: Verificar el apagado ordenado de verdad**

Run: `rtk docker compose stop bot && rtk docker compose logs --tail 5 bot`
Expected: "apagado ordenado" con `señal: SIGTERM` y salida limpia (exit 0, no el 137 de un SIGKILL).

- [ ] **Step 5: Commit** — `rtk git add -A && rtk git commit -m "feat: imagen multi-stage y arranque orquestado con apagado ordenado"`

---

## Self-Review (hecho al escribir el plan)

- Cobertura de spec: §5 Imagen/MySQL/Degradación/Acceso a datos/TypeScript → Tasks 1-7. Los intents y el resto de §5 pertenecen a los planes 2-3.
- Tipos consistentes: `Config` (T2) lo consumen T4/T7; los puertos (T6) son la fuente única para los planes 2-3.
- `puertos.ts` vive en `src/aplicacion/` aunque este plan no tenga más aplicación: es la dirección de dependencia correcta (infra implementa lo que aplicación declara) y evita moverlo después.
