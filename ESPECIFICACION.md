# Especificación v1 — redefinida tras auditoría

> Redefinición del prompt original del autor (2026-09-19) tras una auditoría multi-agente:
> 6 frentes de investigación (Discord, Inworld, runtime, datos, colas/texto, código heredado)
> + 3 auditorías adversariales (ambigüedad, pre-mortem, arquitectura). 122 hallazgos consolidados.
> Este documento es la entrada del `PLAN.md`; las preguntas de §6 deben cerrarse antes de escribirlo.

---

## 1. Vocabulario (obligatorio en código, logs y mensajes)

La palabra "enable" del prompt original nombra dos estados **ortogonales**. Se separan:

| Estado | Quién lo cambia | Verbo | Vive en |
|---|---|---|---|
| **Autorizado** | El admin, con `!tts user enable\|disable` | autorizar / revocar | tabla `autorizaciones`, persistente |
| **Activo** | El propio usuario, con `/jspeak enable\|disable` | activar / desactivar | tabla `sesiones` (la fila ES el estado) |

Reglas: autorizar **no** activa (el usuario da su consentimiento con `/jspeak`; nadie activa la voz
de otro a su espalda). Revocar **sí** desactiva en cascada y aborta el audio en curso, en una
transacción única. Todo el estado tiene ámbito `(guild_id, user_id)`.

## 2. Comandos

### `!tts user enable|disable {userid}` — admin, comando de prefijo
- Solo lo ejecuta `DISCORD_ADMIN_ID`; de cualquier otro autor **se ignora en silencio** (con log del
  intento). Al admin sí se le responden los errores de sintaxis.
- Acepta `<@id>` y el id crudo; rechaza bots; el userid debe ser miembro del servidor (se verifica
  con `guild.members.fetch()` por REST — sin intent `GuildMembers`).
- Asocia la autorización al servidor donde se ejecutó. En DM se ignora.

### `/jspeak` — slash command, registrado por guild
Estructura (mezclar subcomandos y grupo es legal y está documentado):
```
/jspeak enable          → activa la sesión del invocante
/jspeak disable         → la desactiva
/jspeak voice list      → lista las voces disponibles (catálogo cacheado, filtrado por idioma)
/jspeak voice set <voz> → fija la voz, con autocompletado sobre el catálogo
```
- **Un slash command no se puede ignorar** (3 s o error rojo): a un no-autorizado se le responde
  con efímero ("No tienes el TTS habilitado en este servidor") + log. Patrón general: `deferReply`
  efímero salvo respuestas instantáneas; nunca llamar a Inworld/MySQL antes del ACK;
  `MessageFlags.Ephemeral` (no `ephemeral: true`, deprecado).
- `enable`/`disable` son idempotentes y confirman el estado resultante. En DM se rechazan con mensaje.
- Al activar: confirmación **efímera** al comando **+** mensaje **público** en el canal escuchado:
  "@usuario TTS activado babygirl" con `allowedMentions` acotado a ese usuario. (Un efímero no
  notifica la mención; hacen falta los dos mensajes.)
- `voice list|set` opera sobre **VOCES** de Inworld (`voiceId`: Marta, …). El **modelo**
  (`inworld-tts-2` / `-flash`) lo fija `INWORLD_MODEL` para todo el bot: es palanca de coste y
  latencia del operador, no de producto. Si la voz no existe, se sugieren las 3-5 más parecidas.
- La voz elegida se guarda **por servidor** en `autorizaciones`.

## 3. Pipeline de un mensaje (usuario autorizado + activo)

1. **Descartes duros**: bots, webhooks, mensajes de sistema, DMs, solo-adjunto/sticker/embed,
   mensajes que empiezan por el prefijo `!`, mensajes que empiezan por `\` (válvula de escape para
   escribir sin locutar), ediciones (no se releen). Si el autor no está habilitado, `message.content`
   se descarta **en la primera línea** del handler: el texto de terceros no llega ni al logger ni a la BD.
2. **Idempotencia**: LRU de ~500 ids + `INSERT` en `tts_eventos` con `UNIQUE(mensaje_id)` **antes**
   de sintetizar (el gateway reentrega `MESSAGE_CREATE` en RESUME y discord.js no deduplica).
3. **Validación de voz** (C1): el usuario está en un canal de voz del servidor y no está ensordecido
   (`deaf` = `self_deaf || serverDeaf`; nunca `suppress` ni el mute de micro). Se valida **dos veces**:
   al encolar (rechazo barato) y **justo antes de reproducir** cada locución (con hasta ~80 s de cola,
   la validación de encolado no garantiza nada). Estado leído en vivo de Discord, jamás de la BD.
4. **Saneado** (pipeline puro, orden fijo, test de tabla por regla): bloques ``` ``` enteros fuera →
   spoilers → menciones a `displayName` sin arroba (`@everyone/@here` → "todos") → enlaces
   enmascarados y URLs → "enlace" → markdown fuera → emojis custom y unicode fuera →
   `normalize('NFKC')` + control/ancho-cero/RTL fuera + repeticiones colapsadas a 3 → filtro de
   alfabeto (>20% no-latino → descarte con aviso) → recorte por frontera de frase a 500 caracteres →
   vacío = descarte. Se guardan `texto_original` y `texto_saneado`. Única dependencia nueva: `emoji-regex`.
5. **Cola** (C3): estrictamente secuencial por usuario; encolado atómico con mutex por
   `(guildId, userId)`. Troceo en frases (`sentences.js` heredado) → síntesis Inworld en streaming
   (PCM 48 kHz mono → estéreo duplicando muestras, tramas de 3840 bytes) → encoder Opus → player.
6. **Conexión de voz**: entra/se mueve al canal del usuario, con single-flight por guild
   (`Map<guildId, Promise<VoiceConnection>>`), validación previa de permisos/aforo/tipo (escenario:
   rechazado en v1), `entersState(Ready, 20 s)`. **Nunca** se cambia de canal con audio sonando
   (primero 5 tramas de silencio). Si un moderador lo mueve o expulsa: parar y esperar al siguiente
   mensaje, nunca volver por iniciativa propia. Timeout de inactividad → silencio, `destroy()`,
   `.delete()` del encoder, limpiar el mapa.
7. **Registro**: segunda escritura en `tts_eventos` con estado terminal, métricas
   (`ms_primer_byte`, `ms_primer_audio`, `ms_audio`, `underruns`) y coste. Los rechazos se guardan
   como `descartado` con motivo.

## 4. Constraints redefinidos

- **C2 — recordatorio del minuto**: si `ahora − ultimo_mensaje_aceptado > 60 s`, avisar:
  "@usuario El tts sigue habilitado, babygirl. …" con `/jspeak disable` en bloque de código.
  Se dispara **una vez por hueco** (sin cooldown propio: su disparador ya es el hueco). El hueco se
  mide desde la **recepción** del último mensaje aceptado, no desde el fin del audio.
- **C4 — tope de cola**: 200 palabras contando **todo lo no reproducido** (encolado + sintetizando +
  resto de la locución sonando) + tope secundario de locuciones para acotar memoria. Al superarlo:
  **rechazar el mensaje nuevo entero** (ni truncar ni descartar lo viejo), avisar con **reacción en
  el propio mensaje** (imposible de spamear) + aviso en texto bajo cooldown. Solo se trunca, por
  frontera de frase, si un único mensaje supera el tope por sí solo.
- **C5 — antispam de avisos**: cubos **independientes** por `(guild, user, tipo)` con TTL 300 s
  (`cola_llena`, `fuera_de_canal`, `ensordecido`, `fallo_tts`). C2 no comparte cubo. Techo global:
  un mensaje del bot por usuario cada ~10 s. **Cero `setTimeout`**: comparaciones puras al recibir
  mensaje, con `Reloj` inyectado para testear; relojes persistidos en `sesiones` (reiniciar el bot
  no resetea el antispam).
- **Avisos**: mensajes normales en el canal escuchado, mención real acotada, autoborrado a 60 s.
  Todos los literales en un único módulo de plantillas. Lo que escribe el bot **nunca** se sintetiza.

## 5. Decisiones técnicas cerradas (no renegociar sin dato nuevo)

| Tema | Decisión |
|---|---|
| Intents | Exactamente `Guilds + GuildMessages + MessageContent + GuildVoiceStates`. Chequeo al arrancar: cierre 4014 → log FATAL, nunca fallo mudo. Re-solicitud anual de `MessageContent` (criterio 2026: 10 000 usuarios). |
| Opus | `opusscript@0.0.8` **exacto** (peer de prism-media `^0.0.8`; 0.1.1 rompe `npm ci` solo en Docker). **Un recurso de audio (y por tanto un encoder) por locución**, liberado al terminarla. *Corregido el 2026-09-20:* el encoder de larga vida por guild no era viable — un `AudioResource` no se reutiliza y el player lo da por muerto tras `maxMissedFrames` sin datos, así que en producción solo sonaba la primera locución. No hay fuga de heap WASM: prism-media ejecuta `_final`/`_destroy` → `_cleanup()` → `encoder.delete()` (`src/opus/Opus.js:108-123`) y el player destruye el `playStream` del recurso anterior al cambiar de estado. `@discordjs/opus` descartado en Node 24 (sin prebuilds ABI 137, SIGSEGV #206). |
| TypeScript | Type stripping nativo: `node src/main.ts`, sin build. `tsc --noEmit` como puerta. `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `module nodenext`. Prohibidos: `enum`, `namespace`, decoradores, parameter properties. DI a mano en un composition root (`main.ts`). |
| Imagen | `node:24.21.0-trixie-slim` fijada, multi-stage (deps/check/runtime), `USER node`, CMD exec `["node","src/main.ts"]` — jamás npm como PID 1. `init: true`, `stop_grace_period: 20s`, `restart: unless-stopped`, 1 réplica, `TZ=Europe/Madrid`, logging con rotación. |
| Apagado | SIGTERM/SIGINT idempotente: no aceptar eventos → abort síntesis → vaciar cola → 5 tramas de silencio + stop → `destroy()` por guild → `.delete()` encoder → `client.destroy()` → `pool.end()` → flush pino. Timeout duro 8 s. Probar con `docker compose stop` mientras habla. |
| MySQL | `mysql:8.4.11`, volumen nombrado, puerto sin publicar, `--default-time-zone=+00:00`. Healthcheck `SELECT 1` por **TCP** (`-h 127.0.0.1`, nunca ping por socket: falso positivo en el primer arranque), `start_period 60s`. Migraciones `migrations/NNNN_*.sql` con runner propio (~60 líneas, `GET_LOCK`, tabla de control, checksum). Nada de `initdb.d` para evolucionar esquema. |
| Degradación | Config incompleta → exit(1) con pausa de 15 s. MySQL caído al arrancar → backoff sin conectar al gateway. MySQL caído en caliente → **el bot sigue hablando**: autorizaciones cacheadas, histórico fire-and-forget con volcado a pino. |
| Acceso a datos | `mysql2/promise` con pool (limit 8, `timezone 'Z'`, `namedPlaceholders`, utf8mb4). Repositorio por agregado tras interfaces de la capa de aplicación; siempre `execute()`; ningún ORM. Snowflakes como `VARCHAR(20) ascii_bin` (BIGINT + JS redondea en silencio); fechas `DATETIME(3)` UTC; dinero `DECIMAL(12,6)`. |
| Coste | Inworld **no devuelve ni precio ni tokens, nunca** (solo `usage.processedCharactersCount` y `modelId`). Columnas de tokens NULL por diseño; coste = estimación propia: caracteres locales + los del proveedor + `ms_audio` + `tarifa_usd_por_millon` copiada en la fila + `coste_origen ENUM('api','estimado','desconocido')`. Tarifas por modelo en env. |
| Inworld | `POST /tts/v1/voice:stream`, `audioConfig { audioEncoding:'PCM', sampleRateHertz:48000 }` explícito; NDJSON con residuo; defensa anti-`RIFF`. **Verificado en real (2026-09-19, desde ionos): 48 kHz auténticos (5,08 s calculados = duración real de la frase), sin RIFF, TTFB 276 ms, síntesis ~5× tiempo real → sin ffmpeg.** Catálogo por `GET /tts/v1/voices` (verificado: 200, 282 voces, 34 en `es`, esquema `{languages, voiceId, displayName, description, tags, isCustom}`), cacheado (TTL 6-24 h) y persistido como respaldo. `usage.processedCharactersCount` llegó a `0` en streaming: el conteo local de caracteres es la fuente primaria del coste. Credencial: `INWORLD_API_KEY` normalizada en config (si ya trae `Basic `/`Bearer ` se respeta — evita el `Basic Basic …` → 401 al copiar del servicio hermano) + validación con petición real al arrancar. |
| Concurrencia TTS | Semáforo global de 3 (Inworld On-Demand limita 5/cuenta), pipeline de profundidad 1 (sintetizar como mucho una locución por delante). Reintento por frase: solo si emitió 0 bytes, máx. 2, con backoff+jitter y `Retry-After`; jamás reintentar con audio ya emitido. Circuit breaker: 3 fallos → 30 s de pausa por guild + aviso único. |
| Cancelación | Rutina única `pararTodo(usuario, motivo)`: abort → stop → drenar → vaciar cola → **EPOCH++** → liberar cerrojo → filas terminales. Todo `onPcm` comprueba su epoch. (Lección del hermano: vaciar la cola no calla al bot.) |
| Player | Se hereda del hermano el prebuffer y la disciplina de cancelación; **NO el reloj de 20 ms** (`@discordjs/voice` ya re-pacea; dos relojes con deriva independiente se oyen). `NoSubscriberBehavior.Play`. `maxMissedFrames` **250** (~5 s) desde 2026-09-20: el final de la locución lo marca `tubo.end()`, no las tramas perdidas; ese contador es solo el perro guardián de un stream atascado, y con ~25 cortaba locuciones a medias en cuanto Inworld tardaba medio segundo en la frase siguiente. |
| Registro de comandos | Bulk overwrite (PUT) **por guild**, en script aparte (`npm run deploy-commands`), solo si cambió el hash. `GUILD_ALLOWLIST` + `guild.leave()` en `guildCreate` para servidores no listados (protege el contenido y la factura). |
| Permisos de invitación | `ViewChannel, Connect, Speak, SendMessages, MoveMembers` + scope `applications.commands`. |

## 6. Preguntas abiertas — bloquean el PLAN.md

| # | Pregunta | Recomendación |
|---|---|---|
| 1 | Dos usuarios activos en canales de voz **distintos** del mismo servidor (una sola conexión posible): ¿cerrojo primero-que-habla, FIFO única, o una sola sesión activa por servidor? | Cerrojo por guild; si el bot vivirá en un servidor pequeño, una sola sesión activa es más simple y suficiente |
| 2 | ¿Desde qué canales de texto se locuta? Literal = cualquier canal, incluido uno privado leído en alto a todo el canal de voz (fuga real) | Solo el chat integrado del canal de voz: audiencia de texto y audio coinciden por construcción |
| 3 | Presupuesto: ¿€/mes global, caracteres/día por usuario, y qué plan de Inworld es la cuenta? (la concurrencia del plan dimensiona el semáforo) | Tope global + tope diario por usuario en MySQL, corte duro con aviso, kill switch por env |
| 4 | ~~¿Autorizas una llamada real a Inworld antes de diseñar?~~ **CERRADA 2026-09-19**: prototipo ejecutado desde ionos. 48 kHz reales, sin RIFF, TTFB 276 ms con `inworld-tts-2`, catálogo OK. Sin ffmpeg. | — |
| 5 | Tras reiniciar, ¿las sesiones activas sobreviven? ¿Caducan solas? | Persistir + barrido al arrancar (TTL 10 min) + caducidad en caliente (30 min sin escribir / 10 min fuera de voz) con mensaje único. Nunca reentrar a un canal al arrancar: entrada perezosa con el primer mensaje |
| 6 | Privacidad/ToS: todo el texto va a Inworld (lo almacena; su AUP prohíbe contenido adulto y es la **misma cuenta** que el agente de voz en producción). ¿Cuenta separada? ¿Días de retención del texto en MySQL? | Cuenta/clave separada (protege producción) + purga del texto a 90 días conservando métricas |
| 7 | ¿`DISCORD_ADMIN_ID` único y global para todos los servidores? | Sí tal cual; opcionalmente añadir `/ttsadmin` oculto (`default_member_permissions: 0`) como mejora gratuita manteniendo `!tts` |
| 8 | Self-deafen a mitad de locución: ¿terminar la frase o cortar en seco? (Honestidad: el ensordecido es el único que NO se oye; los demás sí. Es un gesto de pausa, no una garantía) | Terminar la frase en curso y no aceptar nuevas; al desensordecerse, listo sin reactivar |

## 7. Variables de entorno (borrador para `.env.example`)

```
DISCORD_TOKEN=            # token del bot
DISCORD_APP_ID=           # application id (registro de comandos)
DISCORD_ADMIN_ID=         # snowflake del admin global
GUILD_ALLOWLIST=          # ids de servidores permitidos, separados por comas
INWORLD_API_KEY=          # clave del portal (base64); se admite con o sin "Basic "
INWORLD_MODEL=inworld-tts-2
INWORLD_LANGUAGE=es-ES
TARIFA_USD_MILLON_TTS2=25 # tarifas para la estimación de coste
TARIFA_USD_MILLON_FLASH=15
MYSQL_HOST=db
MYSQL_DATABASE=albas_tts
MYSQL_USER=bot
MYSQL_PASSWORD=
TZ=Europe/Madrid
LOG_LEVEL=info
TTS_CONCURRENCIA=3        # semáforo global de síntesis
# Pendientes de la pregunta 3: PRESUPUESTO_MENSUAL_USD, LIMITE_DIARIO_CARACTERES, TTS_KILL_SWITCH
```

## 8. Logs

Formato exigido, con timestamp legible (`Intl` con `timeZone` explícito, sin `pino-pretty` en prod):

```
[2026-09-19 14:03:22.117] El usuario {nombre_usuario} <-> {user_id} : Ha generado el tts: {texto}
```

Vocabulario de §1 obligatorio en los logs (autorizar/revocar vs activar/desactivar).
`generateDependencyReport()` de `@discordjs/voice` al arrancar (diagnóstico de "se conecta pero no se oye").
