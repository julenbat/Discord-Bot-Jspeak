# Plan 3/3 — Comportamiento del bot: comandos, sesiones y constraints

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El bot completo: `!tts user enable|disable`, `/jspeak enable|disable|voice list|voice set`, pipeline de mensajes con saneado, validaciones C1, colas por usuario con límite de 200 palabras, avisos C2/C5 y contabilidad en MySQL.

**Architecture:** Capa de presentación (handlers de Discord, finos: traducen y delegan) sobre la capa de aplicación (servicios con TODAS las reglas, testeados con dobles y `Reloj` inyectado) sobre infra y audio de los planes 1-2. Estado en memoria con dueño único por servicio; MySQL es la verdad al arrancar y el registro al terminar.

**Tech Stack:** discord.js (ya instalado en plan 2), `emoji-regex` (única dependencia nueva).

**Spec:** `ESPECIFICACION.md` — §§1-4 completos, §5 filas Intents/Registro de comandos/Cancelación, §6 supuestos adoptados: cerrojo por guild primero-que-habla (P1), solo el chat integrado del canal de voz (P2), sesiones persistentes con caducidad 30 min sin escribir / 10 min fuera de voz (P5), admin único global (P7), self-deaf termina la frase en curso (P8).

## Global Constraints

- Las de los planes 1-2 (rtk, castellano, imports `.ts`, snowflakes `string`, epoch en los callbacks).
- Literales de usuario SOLO en `src/plantillas.ts` — incluidos "@usuario TTS activado babygirl" y el recordatorio con ```/jspeak disable``` en bloque de código.
- Interacciones: responder SIEMPRE; `MessageFlags.Ephemeral`, nunca `ephemeral: true`; `deferReply` antes de tocar red/BD.
- `message.content` de no-habilitados no llega ni al logger ni a la BD (primera línea del handler).
- Cero `setTimeout` en C2/C5: comparaciones puras con `Reloj`.
- Los mensajes del bot jamás se sintetizan.
- Log de locución (ESPECIFICACION §8): `El usuario {nombre} <-> {id} : Ha generado el tts: {texto}`.

---

### Task 1: Plantillas de mensajes

**Files:**
- Create: `src/plantillas.ts`
- Test: `test/plantillas.test.ts`

**Interfaces:**
- Produces: funciones puras que TODOS los handlers usan; ningún literal de usuario fuera de aquí:

```ts
export const plantillas = {
  ttsActivado: (userId: string) => `<@${userId}> TTS activado babygirl`,
  ttsDesactivado: () => 'TTS desactivado. Hasta la próxima.',
  recordatorio: (userId: string) =>
    `<@${userId}> El tts sigue habilitado, babygirl. Si no quieres continuar utilizandolo recuerda ejecutar\n\`\`\`\n/jspeak disable\n\`\`\``,
  noAutorizado: () => 'No tienes el TTS habilitado en este servidor.',
  colaLlena: (limite: number) => `Cola llena (más de ${limite} palabras pendientes). Mensaje descartado; espera a que termine de sonar lo anterior.`,
  fueraDeCanal: () => 'Tienes que estar en un canal de voz para que locute tus mensajes.',
  ensordecido: () => 'Estás ensordecido: el TTS se pausa hasta que actives el audio.',
  falloTts: () => 'El sintetizador está fallando; lo reintento en unos segundos.',
  canalOcupado: (canalNombre: string) => `Ahora mismo estoy locutando en **${canalNombre}**; tu mensaje se descarta.`,
  vozFijada: (voz: string) => `Voz fijada: **${voz}**.`,
  vozNoExiste: (voz: string, parecidas: string[]) =>
    `La voz **${voz}** no existe. ¿Querías decir: ${parecidas.join(', ')}?`,
  listaVoces: (voces: { voiceId: string; description: string }[]) =>
    voces.map((v) => `**${v.voiceId}** — ${v.description}`).join('\n').slice(0, 1900),
  soloEnServidor: () => 'Este comando solo funciona dentro de un servidor.',
  sesionCaducada: (userId: string) => `<@${userId}> El TTS se ha desactivado por inactividad.`,
} as const;
```

- [ ] **Step 1: Test que falla** — el recordatorio lleva el bloque de código y la mención:

```ts
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
```

- [ ] **Step 2: Verificar que falla** → **Step 3: Implementar** (el bloque de arriba es la implementación completa) → **Step 4: `rtk node --test test/plantillas.test.ts` PASS** → **Step 5: Commit** `rtk git commit -am "feat: plantillas de mensajes centralizadas"`

---

### Task 2: Saneador de texto

**Files:**
- Create: `src/aplicacion/saneador.ts`
- Test: `test/saneador.test.ts`

**Interfaces:**
- Produces: `sanear(texto: string, resolutores: Resolutores): string | null` — `null` = descartar el mensaje. `interface Resolutores { nombreUsuario(id: string): string | null; nombreCanal(id: string): string | null }` (la presentación los saca del caché de discord.js; los tests los fingen).
- Produces: `contarPalabras(texto: string): number` — para el límite de 200 (Task 5).
- Constante: `MAX_CARACTERES = 500`.

- [ ] **Step 1: Test de tabla que falla** (el orden de las reglas es load-bearing)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanear, contarPalabras } from '../src/aplicacion/saneador.ts';

const res = { nombreUsuario: (id: string) => (id === '7' ? 'Alba' : null), nombreCanal: () => 'general' };
const casos: Array<[string, string, string | null]> = [
  ['mención a displayName sin arroba', 'hola <@7> y <@!7>', 'hola Alba y Alba'],
  ['mención desconocida', 'ey <@999>', 'ey alguien'],
  ['everyone neutralizado', 'aviso @everyone y @here', 'aviso todos y todos'],
  ['canal', 'mira <#5>', 'mira general'],
  ['bloque de código entero fuera (antes que las demás reglas)', 'antes ```js\n<@7> peligro\n``` después', 'antes después'],
  ['spoiler fuera', 'esto ||secreto|| queda', 'esto queda'],
  ['emoji custom y unicode fuera', 'jaja <:lol:123> <a:baila:9> 😂😂', 'jaja'],
  ['enlace enmascarado se queda con la etiqueta', 'mira [este vídeo](https://x.com/largo)', 'mira este vídeo'],
  ['URL suelta → enlace', 'pásate por https://example.com/a/b?c=d', 'pásate por enlace'],
  ['markdown fuera', '**fuerte** *suave* __sub__ ~~tachado~~ `código`', 'fuerte suave sub tachado código'],
  ['repeticiones colapsadas a 3', 'jaaaaaaaja holaaaaa', 'jaaaja holaaa'],
  ['vacío tras sanear → null', '😂😂😂', null],
  ['solo un bloque de código → null', '```\nnada\n```', null],
];
for (const [nombre, entrada, esperado] of casos) {
  test(nombre, () => assert.equal(sanear(entrada, res), esperado));
}

test('recorte a 500 por frontera de frase', () => {
  const texto = ('Frase de relleno que ocupa bastante. '.repeat(20)).trim(); // ~740 chars
  const r = sanear(texto, res)!;
  assert.ok(r.length <= 500);
  assert.ok(r.endsWith('.')); // corta en frontera, no a mitad de palabra
});

test('más del 20% no latino → null', () => {
  assert.equal(sanear('Привет как дела сегодня друг', res), null);
});

test('contarPalabras', () => assert.equal(contarPalabras('  dos   palabras '), 2));
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/saneador.test.ts` → FAIL.

- [ ] **Step 3: Implementación**

Primero `rtk npm install emoji-regex`, después:

```ts
import emojiRegex from 'emoji-regex';

export interface Resolutores {
  nombreUsuario(id: string): string | null;
  nombreCanal(id: string): string | null;
}

export const MAX_CARACTERES = 500;

export function contarPalabras(texto: string): number {
  return texto.split(/\s+/).filter(Boolean).length;
}

// Pipeline de saneado con ORDEN FIJO: los bloques de código pueden contener
// menciones y markdown falsos, así que caen ENTEROS antes que todo lo demás.
export function sanear(texto: string, res: Resolutores): string | null {
  let t = texto;
  t = t.replace(/```[\s\S]*?```/g, ' ');                       // 1 bloques de código enteros
  t = t.replace(/\|\|[\s\S]*?\|\|/g, ' ');                     // 2 spoilers
  t = t.replace(/<@!?(\d+)>/g, (_, id) => res.nombreUsuario(id) ?? 'alguien'); // 3 menciones
  t = t.replace(/<@&\d+>/g, 'un rol');
  t = t.replace(/<#(\d+)>/g, (_, id) => res.nombreCanal(id) ?? 'un canal');
  t = t.replace(/@(everyone|here)/g, 'todos');
  t = t.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1');    // 4 enlaces enmascarados
  t = t.replace(/https?:\/\/\S+/g, 'enlace');                  // 5 URLs sueltas
  t = t.replace(/<a?:\w+:\d+>/g, ' ');                         // 6 emojis custom
  t = t.replace(emojiRegex(), ' ');                            //   y unicode
  t = t.replace(/(\*\*|__|~~|\*|_|`)/g, '');                   // 7 markdown restante
  t = t.normalize('NFKC')                                      // 8 unicode raro
    .replace(/[ -​-‏‪-‮]/g, '')
    .replace(/(.)\1{3,}/g, '$1$1$1');                          //   repeticiones a 3
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Alfabeto: la voz es castellana; leer cirílico letra a letra suena a avería.
  const letras = [...t].filter((c) => /\p{L}/u.test(c));
  if (letras.length > 0) {
    const latinas = letras.filter((c) => /\p{Script=Latin}/u.test(c)).length;
    if (latinas / letras.length < 0.8) return null;
  }

  if (t.length > MAX_CARACTERES) {                             // 9 recorte por frontera de frase
    const corte = t.slice(0, MAX_CARACTERES);
    const ultimoPunto = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '));
    t = ultimoPunto > 100 ? corte.slice(0, ultimoPunto + 1) : corte;
  }
  return t || null;
}
```

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/saneador.test.ts` → PASS. Ajustar los casos de tabla si alguna regla los contradice: la tabla es el contrato, no el regex.
- [ ] **Step 5: Commit** — `rtk git commit -am "feat: saneador de texto con pipeline de orden fijo y test de tabla"`

---

### Task 3: Servicios de autorización y sesión

**Files:**
- Create: `src/aplicacion/autorizaciones.ts`, `src/aplicacion/sesiones.ts`
- Test: `test/autorizaciones.test.ts`, `test/sesiones.test.ts` (con repos falsos en memoria)

**Interfaces:**
- Consumes: `RepoAutorizaciones`, `RepoSesiones` (plan 1), `Reloj`.
- Produces:

```ts
export class ServicioAutorizaciones {
  constructor(repo: RepoAutorizaciones, log: Logger) {}
  cargar(): Promise<void>;                       // llena la caché al arrancar (listarActivas)
  estaAutorizado(guildId: string, userId: string): boolean;  // SÍNCRONO: lee caché (MySQL caído no calla al bot)
  vozDe(guildId: string, userId: string): string;
  autorizar(guildId: string, userId: string, por: string): Promise<void>;
  revocar(guildId: string, userId: string, por: string): Promise<boolean>; // el orquestador encadena la desactivación
  fijarVoz(guildId: string, userId: string, voz: string): Promise<void>;
}
export interface SesionViva {
  guildId: string; userId: string;
  ultimoMensajeAceptadoMs: number;      // reloj de C2
  ultimosAvisosMs: Record<string, number>; // relojes de C5, por tipo
  epoch: number;                        // cancelación: los callbacks viejos no empujan audio
}
export class ServicioSesiones {
  constructor(repo: RepoSesiones, reloj: Reloj, log: Logger) {}
  cargar(caducidadArranqueMs: number): Promise<string[]>; // barrido al arrancar: caduca inactivas, devuelve las caducadas
  activar(guildId: string, userId: string): Promise<'nueva' | 'ya-activa'>;
  desactivar(guildId: string, userId: string): Promise<boolean>; // epoch++ incluido
  buscar(guildId: string, userId: string): SesionViva | null;
  tocaRecordatorio(s: SesionViva): boolean;      // C2: hueco > 60 s desde el último ACEPTADO
  marcarMensajeAceptado(s: SesionViva): void;    // actualiza reloj + persiste en fire-and-forget
  tocaAviso(s: SesionViva, tipo: string): boolean; // C5: > 300 s desde el último de ESE tipo, y techo global 10 s
  marcarAviso(s: SesionViva, tipo: string): void;
  caducadas(sinEscribirMs: number): SesionViva[]; // para el barrido perezoso del orquestador
}
```

- [ ] **Step 1: Tests que fallan** — los relojes son el corazón; con `Reloj` falso no hay ningún sleep:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServicioSesiones } from '../src/aplicacion/sesiones.ts';
import { crearLogger } from '../src/logger.ts';

function relojFalso(inicio = 1_000_000) {
  let t = inicio;
  return { ahora: () => t, avanzar: (ms: number) => { t += ms; } };
}
function repoFalso() {
  return {
    activar: async () => {}, desactivar: async () => true, buscar: async () => null,
    listar: async () => [], tocarUltimoMensaje: async () => {}, fijarAviso: async () => {},
  };
}

test('C2: recordatorio con hueco > 60 s, una vez por hueco', async () => {
  const reloj = relojFalso();
  const s = new ServicioSesiones(repoFalso(), reloj, crearLogger('silent', 'UTC'));
  await s.activar('g', 'u');
  const viva = s.buscar('g', 'u')!;
  s.marcarMensajeAceptado(viva);
  reloj.avanzar(61_000);
  assert.equal(s.tocaRecordatorio(viva), true);
  s.marcarMensajeAceptado(viva);          // el mensaje que dispara el aviso resetea el hueco
  assert.equal(s.tocaRecordatorio(viva), false);
  reloj.avanzar(61_000);
  assert.equal(s.tocaRecordatorio(viva), true); // segundo hueco legítimo → segundo aviso
});

test('C5: cubos independientes por tipo + techo global de 10 s', async () => {
  const reloj = relojFalso();
  const s = new ServicioSesiones(repoFalso(), reloj, crearLogger('silent', 'UTC'));
  await s.activar('g', 'u');
  const viva = s.buscar('g', 'u')!;
  assert.equal(s.tocaAviso(viva, 'cola_llena'), true);
  s.marcarAviso(viva, 'cola_llena');
  assert.equal(s.tocaAviso(viva, 'cola_llena'), false);   // mismo tipo: 300 s de veda
  assert.equal(s.tocaAviso(viva, 'ensordecido'), false);  // otro tipo, pero techo global 10 s
  reloj.avanzar(11_000);
  assert.equal(s.tocaAviso(viva, 'ensordecido'), true);   // otro cubo: pasa
  reloj.avanzar(290_000);
  assert.equal(s.tocaAviso(viva, 'cola_llena'), true);    // pasaron los 300 s
});

test('desactivar incrementa el epoch', async () => {
  const s = new ServicioSesiones(repoFalso(), relojFalso(), crearLogger('silent', 'UTC'));
  await s.activar('g', 'u');
  const antes = s.buscar('g', 'u')!.epoch;
  await s.desactivar('g', 'u');
  await s.activar('g', 'u');
  assert.ok(s.buscar('g', 'u')!.epoch > antes);
});
```

Para `ServicioAutorizaciones`, test análogo con repo falso: `cargar()` llena la caché, `estaAutorizado` es síncrono, `revocar` la vacía.

- [ ] **Step 2: Verificar que falla** → **Step 3: Implementación.** Lo no obvio:
  - `ServicioSesiones` guarda las vivas en `Map<'guild:user', SesionViva>`; el epoch es un contador del servicio que sobrevive a la sesión (nunca se reutiliza un valor).
  - `tocaAviso`: `ahora - (ultimosAvisosMs[tipo] ?? 0) > 300_000 && ahora - maxAvisoCualquierTipo > 10_000`.
  - `marcarMensajeAceptado` / `marcarAviso` actualizan memoria y persisten con `.catch(log.warn)`: MySQL caído no bloquea el audio.
  - `cargar(caducidadMs)`: `repo.listar()`, descarta y desactiva en BD las de `ultimoMensajeEn` más viejo que el TTL, devuelve los ids caducados (el orquestador NO avisa de estos: el recordatorio de C2 hará de aviso cuando vuelvan a escribir).
- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/sesiones.test.ts test/autorizaciones.test.ts` → PASS.
- [ ] **Step 5: Commit** — `rtk git commit -am "feat: servicios de autorización (caché) y sesión (relojes C2/C5, epoch)"`

---

### Task 4: Guardián de voz (validaciones C1) y cerrojo de canal

**Files:**
- Create: `src/aplicacion/guardian.ts`
- Test: `test/guardian.test.ts`

**Interfaces:**
- Produces:

```ts
export interface EstadoVoz { canalId: string | null; ensordecido: boolean } // lo extrae la presentación del VoiceState vivo
export type VeredictoVoz =
  | { ok: true; canalId: string }
  | { ok: false; motivo: 'fuera_de_canal' | 'ensordecido' | 'canal_ocupado' };
export class GuardianVoz {
  constructor(reloj: Reloj) {}
  // C1 + cerrojo por guild "primero que habla" (supuesto P1 de la spec):
  // el bot queda atado al canal del primer usuario; se libera con
  // cola vacía + 10 s de silencio (lo notifica el orquestador con liberarSiOcioso).
  evaluar(guildId: string, userId: string, voz: EstadoVoz): VeredictoVoz;
  ocupar(guildId: string, canalId: string): void;
  liberarSiOcioso(guildId: string, colaVacia: boolean): void;
  canalOcupado(guildId: string): string | null;
}
```

- [ ] **Step 1: Test que falla**

```ts
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
```

- [ ] **Step 2: Verificar que falla** → **Step 3: Implementación** (Map por guild con `{canalId, ociosoDesdeMs|null}`; `ocupar` borra `ociosoDesdeMs`; `liberarSiOcioso(colaVacia=false)` también lo borra) → **Step 4: PASS** → **Step 5: Commit** `rtk git commit -am "feat: guardián C1 con cerrojo de canal primero-que-habla"`

---

### Task 5: Cola de locuciones con límite de 200 palabras

**Files:**
- Create: `src/aplicacion/cola-locuciones.ts`
- Test: `test/cola-locuciones.test.ts`

**Interfaces:**
- Consumes: `contarPalabras` (Task 2).
- Produces:

```ts
export interface Locucion { mensajeId: string; guildId: string; userId: string; texto: string; voz: string; epoch: number }
export type ResultadoEncolar = { ok: true } | { ok: false; motivo: 'cola_llena' };
export class ColaLocuciones {
  constructor(limitePalabras?: number /* 200 */, limiteLocuciones?: number /* 20 */) {}
  // Cuenta TODO lo no reproducido: encolado + la locución en curso (su resto
  // lo aporta el orquestador al arrancarla con enCurso()).
  encolar(l: Locucion): ResultadoEncolar;
  siguiente(guildId: string, userId: string): Locucion | null; // FIFO por usuario
  enCurso(l: Locucion | null, guildId: string, userId: string): void;
  palabrasPendientes(guildId: string, userId: string): number;
  vaciar(guildId: string, userId: string): number;             // devuelve cuántas descartó
  vacia(guildId: string): boolean;                             // ¿nada pendiente en todo el guild? (cerrojo)
}
```

- [ ] **Step 1: Test que falla**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColaLocuciones } from '../src/aplicacion/cola-locuciones.ts';

const l = (id: string, palabras: number) => ({
  mensajeId: id, guildId: 'g', userId: 'u', voz: 'Marta', epoch: 1,
  texto: 'palabra '.repeat(palabras).trim(),
});

test('rechaza el mensaje NUEVO al superar 200 palabras pendientes', () => {
  const cola = new ColaLocuciones(200);
  assert.equal(cola.encolar(l('1', 150)).ok, true);
  assert.equal(cola.encolar(l('2', 40)).ok, true);   // 190: cabe
  assert.deepEqual(cola.encolar(l('3', 30)), { ok: false, motivo: 'cola_llena' }); // 220: fuera el nuevo
  assert.equal(cola.palabrasPendientes('g', 'u'), 190); // lo viejo intacto: causalidad
});

test('la locución en curso cuenta hasta que termina', () => {
  const cola = new ColaLocuciones(200);
  cola.encolar(l('1', 150));
  const enCurso = cola.siguiente('g', 'u')!;
  cola.enCurso(enCurso, 'g', 'u');
  assert.equal(cola.palabrasPendientes('g', 'u'), 150); // sonando pero no reproducida del todo
  cola.enCurso(null, 'g', 'u');                          // terminó
  assert.equal(cola.palabrasPendientes('g', 'u'), 0);
});

test('FIFO por usuario y vaciar', () => {
  const cola = new ColaLocuciones(200);
  cola.encolar(l('1', 5)); cola.encolar(l('2', 5));
  assert.equal(cola.siguiente('g', 'u')!.mensajeId, '1');
  assert.equal(cola.vaciar('g', 'u'), 1); // quedaba la '2'
  assert.equal(cola.vacia('g'), true);
});
```

- [ ] **Step 2: Verificar que falla** → **Step 3: Implementación** (Map `'guild:user'` → `{cola: Locucion[], enCurso: Locucion | null}`; `palabrasPendientes` suma `contarPalabras` de cola + en curso) → **Step 4: PASS** → **Step 5: Commit** `rtk git commit -am "feat: cola de locuciones con límite de palabras no reproducidas"`

---

### Task 6: Orquestador (une todo) con circuit breaker

**Files:**
- Create: `src/aplicacion/orquestador.ts`
- Test: `test/orquestador.test.ts` (dobles de todo; es el test más valioso del proyecto)

**Interfaces:**
- Consumes: TODOS los servicios anteriores + `Locutor`, `Altavoz`, `RepoTtsEventos`, `plantillas`, `Reloj`, `Config`.
- Produces (lo que la presentación llama):

```ts
export interface MensajeEntrante {
  mensajeId: string; guildId: string; userId: string; nombreUsuario: string;
  contenido: string; estadoVoz: EstadoVoz;
  // La presentación entrega funciones, no objetos de discord.js: la capa de
  // aplicación no importa discord.js.
  responder(texto: string, autoborradoMs?: number): Promise<void>;
  reaccionar(emoji: string): Promise<void>;
  conectarVoz(): Promise<void>;   // envuelve altavoz.conectar(canal) con el canal resuelto
  resolutores: Resolutores;
}
export class Orquestador {
  constructor(deps: {/* servicios, locutor, altavoz, repoEventos, reloj, log, killSwitch: () => boolean */}) {}
  procesarMensaje(m: MensajeEntrante): Promise<void>;   // el pipeline entero de ESPECIFICACION §3
  activarSesion(guildId: string, userId: string): Promise<'nueva' | 'ya-activa'>;
  desactivarSesion(guildId: string, userId: string): Promise<boolean>;  // pararTodo incluido
  revocarAutorizacion(guildId: string, userId: string, por: string): Promise<boolean>; // revoca + desactiva + aborta
  apagar(): Promise<void>;  // el orden de ESPECIFICACION §5 fila Apagado
}
```

- [ ] **Step 1: Tests que fallan** — los caminos que la spec exige:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Fábrica de orquestador con dobles: cada test cablea lo mínimo.
// (En el fichero real: función crearMundo() que devuelve {orq, dobles} con
// espías: locutor.locutar registra llamadas y resuelve 'reproducido';
// repoEventos.abrir devuelve 'nuevo'; sesiones/autorizaciones reales con
// repos falsos y reloj falso — son baratos y el comportamiento es el real.)
import { crearMundo } from './ayudas/mundo.ts';

test('camino feliz: mensaje → locutado + registrado + log con el formato de la spec', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Hola mundo desde el test.' }));
  assert.equal(dobles.locuciones.length, 1);
  assert.equal(dobles.eventosAbiertos[0]!.estado, 'encolado');
  assert.equal(dobles.eventosCerrados[0]!.estado, 'reproducido');
});

test('no autorizado: ni locuta, ni registra, ni el contenido toca nada', async () => {
  const { orq, dobles } = crearMundo({ autorizado: false });
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'secreto' }));
  assert.equal(dobles.locuciones.length, 0);
  assert.equal(dobles.eventosAbiertos.length, 0);
});

test('duplicado (RESUME del gateway): la segunda entrega no suena', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  const m = dobles.mensaje({ mensajeId: '55', contenido: 'Frase que llega dos veces.' });
  await orq.procesarMensaje(m);
  await orq.procesarMensaje(m);
  assert.equal(dobles.locuciones.length, 1);
});

test('C1 al encolar: fuera de canal → aviso con cooldown, sin locutar', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  const m = dobles.mensaje({ estadoVoz: { canalId: null, ensordecido: false } });
  await orq.procesarMensaje(m);
  await orq.procesarMensaje(m);                 // segundo intento inmediato
  assert.equal(dobles.avisos.length, 1);        // C5: un solo aviso
  assert.equal(dobles.eventosAbiertos.filter((e) => e.estado === 'descartado').length, 2);
});

test('C2: hueco de 61 s → recordatorio antes de locutar', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Primer mensaje del día.' }));
  dobles.reloj.avanzar(61_000);
  await orq.procesarMensaje(dobles.mensaje({ mensajeId: '2', contenido: 'Después del hueco largo.' }));
  assert.ok(dobles.avisos.some((a) => a.includes('/jspeak disable')));
});

test('cola llena → reacción en el mensaje, no un texto por mensaje', async () => {
  const { orq, dobles } = crearMundo({ locutorLento: true }); // locutar no resuelve: todo queda en cola
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'palabra '.repeat(150) }));
  await orq.procesarMensaje(dobles.mensaje({ mensajeId: '2', contenido: 'palabra '.repeat(60) }));
  assert.equal(dobles.reacciones.length, 1);
});

test('desactivar con audio sonando: aborta la síntesis y vacía la cola', async () => {
  const { orq, dobles } = crearMundo({ locutorLento: true });
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Frase que se queda a medias.' }));
  await orq.desactivarSesion('g', 'u');
  assert.equal(dobles.señalesAbortadas, 1);
  assert.equal(dobles.eventosCerrados.at(-1)!.estado, 'abortado');
});

test('revocar desactiva en cascada', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.revocarAutorizacion('g', 'u', 'admin');
  await orq.procesarMensaje(dobles.mensaje({ mensajeId: '9', contenido: 'Ya no debería sonar.' }));
  assert.equal(dobles.locuciones.length, 0);
});

test('circuit breaker: 3 fallos seguidos → 30 s sin sintetizar en el guild + un aviso', async () => {
  const { orq, dobles } = crearMundo({ locutorFalla: true });
  await orq.activarSesion('g', 'u');
  for (let i = 0; i < 4; i++) {
    await orq.procesarMensaje(dobles.mensaje({ mensajeId: String(i), contenido: `Mensaje número ${i} del test.` }));
  }
  assert.equal(dobles.locuciones.length, 3);    // el cuarto ni lo intenta
  assert.equal(dobles.avisos.filter((a) => a.includes('sintetizador')).length, 1);
  dobles.reloj.avanzar(31_000);
  await orq.procesarMensaje(dobles.mensaje({ mensajeId: '9', contenido: 'Tras la veda vuelve a intentar.' }));
  assert.equal(dobles.locuciones.length, 4);
});
```

- [ ] **Step 2: Verificar que falla** — Run: `rtk node --test test/orquestador.test.ts` → FAIL.

- [ ] **Step 3: Implementación.** El flujo de `procesarMensaje`, en orden estricto:

```
1  killSwitch() → return
2  ¿autorizado Y sesión activa? → return (el contenido muere aquí)
3  LRU de mensajeId (500) → duplicado: return
4  C2: sesiones.tocaRecordatorio → responder(plantillas.recordatorio, autoborrado 60 s)
5  sesiones.marcarMensajeAceptado
6  sanear() → null: repoEventos.abrir(descartado, 'texto_vacio'); return
7  guardian.evaluar(estadoVoz) → ko: abrir(descartado, motivo) + aviso si tocaAviso(tipo); return
8  cola.encolar → cola_llena: abrir(descartado) + reaccionar('🚫') + aviso si toca; return
9  repoEventos.abrir(encolado) → 'duplicado': return (idempotencia de BD)
10 log.info(`El usuario ${nombre} <-> ${id} : Ha generado el tts: ${textoSaneado}`)
11 bombear(guildId, userId): si no hay bombeo en marcha para ese usuario,
   bucle: cola.siguiente → guardian re-evalúa (C1 otra vez, JUSTO antes de
   reproducir; si ko → cerrar(abortado)) → breaker abierto → cerrar(fallido)
   → conectarVoz() + guardian.ocupar → locutar(con AbortSignal de la sesión;
   epoch comprobado en onPcm) → cerrar(estado del resultado, métricas, coste
   = caracteres × tarifa/1e6 con origen 'estimado') → siguiente
12 al vaciarse: guardian.liberarSiOcioso(guildId, cola.vacia(guildId))
```

El breaker es un Map por guild `{fallos, vedaHastaMs}`; `desactivarSesion` = `pararTodo`: abort del controller de la sesión, `altavoz.cortar`, `cola.vaciar` (cada descarte → `cerrar(abortado)`), epoch++ vía `sesiones.desactivar`. El coste: `caracteres * tarifaUsdMillon[modelo] / 1_000_000`, `costeOrigen: 'estimado'`.

- [ ] **Step 4: Verificar que pasa** — Run: `rtk node --test test/orquestador.test.ts && rtk npm run check` → PASS.
- [ ] **Step 5: Commit** — `rtk git commit -am "feat: orquestador con pipeline completo, breaker y pararTodo"`

---

### Task 7: Presentación — comandos y eventos de Discord

**Files:**
- Create: `src/discord/cliente.ts`, `src/discord/comando-tts-admin.ts`, `src/discord/comando-jspeak.ts`, `src/discord/eventos.ts`, `scripts/desplegar-comandos.ts`
- Test: `test/comando-tts-admin.test.ts` (el parseo es puro; el resto se verifica en la Task 8)

**Interfaces:**
- Consumes: `Orquestador`, `ServicioAutorizaciones`, `ClienteInworld.listarVoces`, `plantillas`, `Config`.
- Produces: `arrancarDiscord(deps): Promise<Client>` — crea el cliente con los intents exactos, registra los handlers y hace `login`.

- [ ] **Step 1: Test del parseo de `!tts` que falla**

```ts
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
```

- [ ] **Step 2: Verificar que falla** → implementar:

```ts
export function parsearTtsAdmin(contenido: string): { accion: 'enable' | 'disable'; userId: string } | null {
  const m = contenido.match(/^!tts\s+user\s+(enable|disable)\s+(?:<@!?(\d{17,20})>|(\d{17,20}))\s*$/);
  return m ? { accion: m[1] as 'enable' | 'disable', userId: (m[2] ?? m[3])! } : null;
}
```

- [ ] **Step 3: `cliente.ts` y `eventos.ts`.** Lo esencial:

```ts
// cliente.ts — los CUATRO intents de la spec, ni uno más
const client = new Client({ intents: [
  GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
]});
```

`eventos.ts` registra:
- `Events.MessageCreate` → descartes de presentación (`message.author.bot`, `!message.inGuild()`, webhooks, sin contenido, allowlist, **supuesto P2**: `message.channelId` debe ser el chat del canal de voz donde está el autor, es decir `message.channelId === estadoVoz.canalId`); comando admin: si `author.id === config.discordAdminId` y `parsearTtsAdmin` devuelve algo → `orquestador` autoriza/revoca y responde; si parsea pero el autor NO es el admin → **return silencioso con `log.debug` del intento** (la spec lo pide así). Resto → construir `MensajeEntrante` (con `estadoVoz` del `VoiceState` vivo: `{canalId: vs?.channelId ?? null, ensordecido: vs?.deaf ?? false}`) y `orquestador.procesarMensaje`.
- `Events.InteractionCreate` → router de `/jspeak`: `deferReply({flags: MessageFlags.Ephemeral})` primero; `enable|disable` → orquestador (no autorizado → `plantillas.noAutorizado()`); `voice list` → `listarVoces` cacheadas → `plantillas.listaVoces`; `voice set` → validar contra catálogo, no existe → 3 parecidas por distancia de inclusión (`voces.filter(v => v.voiceId.toLowerCase().includes(txt) || txt.includes(v.voiceId.toLowerCase()))` + primeras alfabéticas hasta 3); autocompletado (`interaction.isAutocomplete()`) → 25 primeras coincidencias del catálogo.
- `Events.GuildCreate` → si no está en `guildAllowlist`: `guild.leave()` + log.
- `Events.ClientReady` → `log.info(generateDependencyReport())` + chequeo de que los guilds de la allowlist están.

- [ ] **Step 4: `scripts/desplegar-comandos.ts`** — construye `/jspeak` con `SlashCommandBuilder` (subcomandos `enable`, `disable` + grupo `voice` con `list` y `set`; en `set`, opción string `voz` con `setAutocomplete(true)`; `setDMPermission(false)`) y hace `PUT applications/{appId}/guilds/{guildId}/commands` por cada guild de la allowlist con `REST` de discord.js. Se ejecuta a mano: `rtk node scripts/desplegar-comandos.ts`.

- [ ] **Step 5: Verificar** — Run: `rtk node --test test/comando-tts-admin.test.ts && rtk npm run check` → PASS.
- [ ] **Step 6: Commit** — `rtk git commit -am "feat: presentación Discord: comandos, eventos y despliegue de /jspeak"`

---

### Task 8: Cablearlo todo en `main.ts` + humo de extremo a extremo

**Files:**
- Modify: `src/main.ts` (extiende el del plan 1 en los puntos marcados)
- Test: humo manual guiado (checklist de abajo) — es la verificación de integración real

**Interfaces:**
- Consumes: todo. `main.ts` es el único fichero que importa de las cuatro capas a la vez.

- [ ] **Step 1: Cableado en `main.ts`** — tras `migrar(...)` del plan 1:

```ts
const autorizaciones = new ServicioAutorizaciones(new RepoAutorizacionesMysql(pool), log);
const sesiones = new ServicioSesiones(new RepoSesionesMysql(pool), relojSistema, log);
await autorizaciones.cargar();
await sesiones.cargar(10 * 60_000);   // barrido de arranque: TTL 10 min (supuesto P5)

const tts = new ClienteInworld({ apiKey: config.inworldApiKey, modelo: config.inworldModel, idioma: config.inworldLanguage });
await tts.listarVoces();              // valida la credencial con una petición real ANTES del gateway

const altavoz = new Altavoz(log);
const orquestador = new Orquestador({
  autorizaciones, sesiones,
  guardian: new GuardianVoz(relojSistema),
  cola: new ColaLocuciones(),
  locutor: new Locutor(tts, new Semaforo(config.ttsConcurrencia), altavoz, log),
  altavoz, repoEventos: new RepoTtsEventosMysql(pool),
  reloj: relojSistema, log, config,
  killSwitch: () => config.ttsKillSwitch,
});
const client = await arrancarDiscord({ config, log, orquestador, autorizaciones, tts });
```

Y dentro de `apagar()`, en el hueco marcado en el plan 1: `client.removeAllListeners(Events.MessageCreate); await orquestador.apagar(); await client.destroy();` antes del `pool.end()`.

- [ ] **Step 2: Checklist de humo en el servidor de pruebas** (cada línea se ejecuta de verdad; "debería" no vale):

```
[ ] rtk node scripts/desplegar-comandos.ts        → /jspeak aparece en el cliente
[ ] rtk docker compose up --build -d              → logs: dependencias, "base de datos lista", READY
[ ] /jspeak enable sin autorizar                  → efímero "No tienes el TTS habilitado"
[ ] !tts user enable <id> desde OTRA cuenta       → silencio absoluto (log.debug en el bot)
[ ] !tts user enable <id> desde el admin          → confirmación
[ ] /jspeak enable ya autorizado                  → efímero + "@usuario TTS activado babygirl" público
[ ] escribir en el chat del canal de voz          → el bot entra y locuta; log con el formato de la spec
[ ] escribir en OTRO canal de texto               → no suena (supuesto P2)
[ ] mención + emoji + URL en el mensaje           → se oye "Alba ... enlace", sin basura
[ ] ensordecerse y escribir                       → no suena + aviso; desensordecer → vuelve solo
[ ] esperar 65 s y escribir                       → recordatorio con /jspeak disable en bloque de código
[ ] pegar 3 mensajes de 100 palabras seguidos     → al tercero, reacción 🚫
[ ] /jspeak voice list                            → voces en español
[ ] /jspeak voice set Curro                       → confirmación; el siguiente mensaje suena con Curro
[ ] /jspeak voice set NoExiste                    → sugerencias
[ ] /jspeak disable con audio sonando             → se corta al instante
[ ] rtk docker compose stop MIENTRAS habla        → "apagado ordenado", exit 0, sin fantasma en el canal
[ ] rtk docker compose start                      → sesiones caducadas por el barrido; el bot NO entra a ningún canal
[ ] SELECT * FROM tts_eventos ORDER BY id DESC    → filas con estado, métricas y coste estimado
```

- [ ] **Step 3: Commit final** — `rtk git add -A && rtk git commit -m "feat: bot completo cableado; humo de extremo a extremo verificado"`

---

## Self-Review (hecho al escribir el plan)

- Cobertura de spec §§1-4: vocabulario (T3), comandos (T7), pipeline §3 completo (T6 paso a paso), C1 doble validación (T4 + reevaluación en el bombeo de T6), C2/C5 (T3, cubos y techo global), C4 con la semántica corregida (T5), avisos con autoborrado y reacción (T6/T7), idempotencia (LRU + UNIQUE, T6), logs §8 (T6 paso 10).
- Supuestos P1/P2/P5/P7/P8 de la spec: implementados en T4 (cerrojo), T7 (filtro de canal), T8 (barrido+TTL), T7 (admin único + silencio), T6 (abort por señal termina la frase en curso al reevaluar C1 — el `AbortSignal` de sesión no se dispara por ensordecerse: simplemente la siguiente locución no pasa el guardián, que es exactamente "terminar la frase e ignorar nuevas").
- Tipos: `MensajeEntrante`/`EstadoVoz`/`VeredictoVoz`/`Locucion` definidos una vez y consumidos por nombre en T6-T7; `Resolutores` viene de T2; los puertos de BD, del plan 1.
- Pendiente a decisión del autor (pregunta 3 de la spec): presupuesto mensual/diario. El hueco está previsto: `killSwitch` ya corta y `tts_eventos` ya acumula coste por usuario y día; el tope es una consulta + un if en el paso 1 del pipeline cuando haya números.
