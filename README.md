# albas_discord_tts

> Un bot de Discord que permite a un usuario concreto hablar por TTS en un canal de voz,
> generando y **streameando el audio en tiempo real desde nuestro propio servidor**.

---

## 0. Quién trabaja en esto (rol del asistente)

Cuando Claude trabaje en este repositorio, adopta este perfil y **no lo abandona**:

**Ingeniero de software senior, pragmático, especializado en agentes de IA y audio en tiempo real.**

| Principio | Qué significa aquí |
|---|---|
| **Pragmatismo sobre elegancia** | La solución que funciona con menos piezas gana. No se introduce una dependencia, un servicio ni una capa de abstracción sin un problema concreto que la justifique. |
| **Medir antes de opinar** | En audio en tiempo real, "va rápido" no es un dato. Los números que importan: *time-to-first-byte* del TTS, latencia de primer audio audible, huecos (underruns) por locución. Se instrumentan desde el día uno. |
| **Reaprovechar lo que ya funciona** | Ya existe un pipeline de TTS en streaming en producción (§4). Se parte de ahí, no de cero. |
| **Fallar pronto y en voz alta** | Configuración incompleta → el proceso se para con un mensaje claro. Nada de defaults silenciosos que luego se pagan a las 3 de la mañana. |
| **Proceso, no heroísmo** | Brainstorming → plan escrito → TDD → revisión. Las skills de §8 no son decorativas: se usan. |
| **Honestidad técnica** | Si una decisión tiene un coste (latencia, dinero, complejidad), se dice antes de tomarla, no después. Si algo no se ha probado, se dice que no se ha probado. |

**Idioma:** el código, los comentarios y la documentación van en **castellano**, igual que el resto de
proyectos de este autor. Los comentarios explican *por qué*, no *qué*.

---

## 1. El proyecto en una frase

Un bot de Discord que permite comunicarse por TTS a un usuario concreto que decidamos,
streameando el audio a través de nuestro propio servidor.

### Las tres piezas

| # | Pieza | Responsabilidad |
|---|---|---|
| **1** | **Bot de comandos** | Escucha los comandos de Discord, aplica las restricciones (quién puede hablar, dónde, cuándo) y decide qué texto se locuta. |
| **2** | **Servicio de TTS** | Convierte texto en audio. Emite **por trozos, según se generan**, no al terminar. Abortable a mitad. |
| **3** | **Bot de voz** | Entra en el canal de voz y reproduce el audio del TTS en tiempo real, con el ritmo correcto. |

> Las piezas 1 y 3 **pueden ser el mismo proceso de Node** (una sola sesión de gateway, una sola
> identidad de bot). Separarlas en dos procesos es una decisión de despliegue, no de arquitectura,
> y se toma en el plan — no aquí.

### Flujo

```
Usuario autorizado                 Nuestro servidor                    Discord
        |                                  |                              |
        |-- comando (texto) -------------> |                              |
        |                          [1] bot de comandos                    |
        |                            valida + trocea                      |
        |                                  v                              |
        |                          [2] TTS en streaming                   |
        |                       (PCM 48 kHz según llega)                  |
        |                                  v                              |
        |                          [3] cola + reloj de 20 ms              |
        |                             + encoder Opus                      |
        |                                  |-- Opus/RTP cifrado --------> | canal de voz
```

---

## 2. Veredicto técnico: ¿el TTS se puede hacer solo con Node.js?

**Sí.** Verificado sobre el código que ya corre en producción en `217.160.248.29` (§4).

El módulo de TTS de ese servicio son ~130 líneas que usan **únicamente `fetch` y `Buffer` nativos de
Node** contra los endpoints HTTP de streaming del proveedor. Cero dependencias, cero binarios,
cero `node-gyp`. Ya entrega PCM por trozos conforme llegan y ya soporta cancelación con
`AbortSignal`. Ese módulo es portable a este proyecto **casi tal cual**.

Lo único que Discord añade sobre lo que ya tenemos:

| Requisito de Discord | ¿Node puro? | Cómo |
|---|---|---|
| Audio en **Opus, 48 kHz, estéreo, tramas de 20 ms** | ✅ | `opusscript` es un port de libopus a **WebAssembly con Emscripten**: se instala sin compilar nada. (`@discordjs/opus` es nativo y va más rápido; es la optimización posterior, no el punto de partida.) |
| **Cifrado** del RTP (`aead_aes256_gcm_rtpsize`) | ✅ | `node:crypto` trae `aes-256-gcm`. Comprobable con `require('node:crypto').getCiphers().includes('aes-256-gcm')`. Solo hace falta una librería externa si ese cifrado no está disponible — y como fallback existe `@noble/ciphers`, también JS puro. |
| **FFmpeg** | ✅ no hace falta | FFmpeg solo es necesario para *decodificar* formatos de fichero. Nosotros generamos PCM crudo y lo entregamos como `StreamType.Raw`: el pipeline de decodificación no se toca. |
| Resampleo 8/16 kHz → 48 kHz | ✅ evitable | Pedimos el audio **ya a 48 kHz al proveedor**. Deepgram acepta `linear16` con `sample_rate=48000` y `container=none`; Inworld acepta `PCM` con `sampleRateHertz` hasta 48000. Sin conversión de frecuencia no hay ni coste de CPU ni pérdida de calidad. |
| Mono → estéreo | ✅ trivial | Duplicar cada muestra de 16 bits. Es un bucle sobre un `Buffer`, no una dependencia. |

**Conclusión:** todo el camino texto → audio en el canal se hace con Node.js, sin binarios externos.
La única pieza compilada *opcional* es el encoder de Opus, y solo si el perfilado demuestra que
hace falta.

### Lo que sí hay que respetar de Discord

Restricciones duras del protocolo, no opinables:

- El audio va en **Opus a 48 kHz, 2 canales**. Trama de 20 ms = **960 muestras/canal** = **3840 bytes**
  de PCM `s16le` estéreo antes de codificar.
- El ritmo de envío lo marcamos nosotros: **una trama cada 20 ms**, con corrección de deriva. Si nos
  adelantamos o atrasamos, se oye.
- Hay que mandar **Speaking (opcode 5)** antes de emitir audio, y el modo no puede ser 0.
- Al terminar de hablar, **cinco tramas de silencio** (`0xF8 0xFF 0xFE`) para que Opus no interpole
  basura con la siguiente locución.
- Modos de cifrado vigentes: `aead_aes256_gcm_rtpsize` (preferido) y `aead_xchacha20_poly1305_rtpsize`
  (obligatorio soportarlo). Los modos antiguos están retirados.

---

## 3. Stack

Decidido por el autor; no se renegocia sin motivo técnico duro.

| Capa | Elección | Por qué |
|---|---|---|
| Runtime | **Node.js v24**, ESM | `fetch` nativo, `AbortSignal.any()`, `node --test` sin framework. |
| Lenguaje | **TypeScript** | Tipos sobre los payloads de Discord y sobre los buffers de audio, donde un error de unidades se paga caro. |
| Diseño | **Orientado a objetos, arquitectura por capas** | El core es simple. **Nada de hexagonal ni DDD**: no hay dominio suficiente para pagar esa ceremonia. Abstracción solo donde resuelve un problema real. |
| Despliegue | **Docker**, con **`docker compose`** | Un contenedor para el bot, otro para MySQL. |
| Persistencia | **MySQL** en contenedor aparte | Histórico de TTS (usuario, timestamp, coste) y estado de autorización. |
| Discord | **`discord.js`** + **`@discordjs/voice`** | Gateway, comandos de aplicación y ciclo de vida de la conexión de voz resueltos. |
| Opus | **`opusscript`** (WASM) → `@discordjs/opus` si el perfilado lo exige | Empezar sin toolchain de compilación. Afecta a la elección de imagen base. |
| TTS | **Inworld**, tras una interfaz que permita cambiar de proveedor | Es lo que ya está en producción en el servicio hermano. |
| Cifrado | **`node:crypto`** | Ver §2. |
| Tests | **`node --test`** | Sin dependencias de test. |
| Logs | **`pino`**, con timestamp legible | Requisito explícito: los logs se leen, no solo se indexan. |

**No entra en el stack** salvo que algo lo exija: FFmpeg, ORM pesado, framework web, contenedor de
inyección de dependencias, broker de mensajes.

### Capas

```
Presentación   comandos y eventos de Discord — traduce entre Discord y el dominio
     |
Aplicación     autorización, sesiones, colas, antispam — aquí viven las reglas
     |
Infraestructura  cliente TTS, repositorios MySQL, logger — hablan con el mundo
     |
Audio          síntesis en streaming, reloj de tramas, Opus, reproducción
```

La regla es de una sola dirección: **las capas de arriba conocen a las de abajo, nunca al revés.**

> El detalle (árbol de ficheros, clases, estrategia de compilación de TS, imagen base) se fija en el
> plan, no aquí.

---

## 4. Herencia: el agente de voz de `ionos`

En `217.160.248.29` (alias `ionos`, usuario `julen`) vive **`~/voice-agent`**: un agente conversacional
telefónico en producción — Asterisk → AudioSocket → Deepgram STT → OpenAI → Inworld TTS → llamada.
Es un repo de Node sin dependencias nativas, y **resuelve ya casi todos los problemas difíciles** de
este proyecto.

Qué se reaprovecha, y qué cambia:

| Fichero | Qué aporta | Cambio para Discord |
|---|---|---|
| `src/tts.js` | Síntesis en streaming (Inworld/Deepgram) + `TtsQueue`, la cola que garantiza que las frases suenan **en orden** aunque se generen más rápido de lo que se sintetizan. Abortable. | Pedir 48 kHz en vez de 8/16 kHz. Poco más. |
| `src/player.js` | **La joya.** Reloj de tramas con *deriva corregida*: el siguiente tick apunta al instante teórico, no a `ahora + 20 ms`, para que los retrasos no se acumulen. Incluye pre-buffer configurable y contador de underruns. | Trama de 3840 bytes en vez de 320; la salida va al encoder de Opus en vez de al socket. La lógica de temporización es idéntica. |
| `src/sentences.js` | Trocea el texto en frases **según se genera**, arrastrando las frases muy cortas a la siguiente, y parte las parrafadas sin puntuación por la última coma. | Reutilizable tal cual. |
| `src/config.js` | Configuración por entorno que **falla con mensaje claro** si falta una clave. | Reutilizable como patrón. |
| `src/audiosocket.js` | Protocolo binario de Asterisk. | **No se reutiliza** — lo sustituye el transporte de Discord. |
| `src/stt.js`, `src/llm.js` | Transcripción y respuestas del LLM. | **Fuera de alcance** por ahora: aquí el texto lo pone un humano, no un modelo. |

**Dos lecciones del código de ese servicio que aquí valen dinero:**

1. **El pre-buffer no es opcional.** Si se empieza a reproducir con el primer trozo que llega, el
   reproductor adelanta al sintetizador y se queda seco a mitad de frase. Hay que acumular audio
   antes de arrancar, y eso es latencia deliberada que se paga a cambio de que no haya cortes.
   Encontrar ese número es trabajo empírico.
2. **Cancelar de verdad.** Para callar al bot al instante no basta con vaciar la cola: hay que abortar
   *también* la síntesis en curso. En el servicio hermano esto fue un bug real y está comentado en el
   código.

### Cómo mirarlo

```bash
echo y | "C:/Program Files/PuTTY/plink.exe" -ssh julen@217.160.248.29 -pw '<pw en puttyConnections/ionos.cmd>' \
  "cat ~/voice-agent/src/player.js"
```

Estado de la máquina a 2026-09-19: 2 vCPU, 8 GB de RAM, 47 GB libres, Docker 29.1.3, Node del host
v20.20.2 (el servicio corre en contenedor con Node 22). Puertos ya ocupados: 22, 3478 (STUN/TURN),
5001, 9099, 9092/9093 del agente de voz. **Hay sitio de sobra para este bot; elegir puertos que no
choquen.**

---

## 5. Convenciones del repositorio

- **Todo comando de shell va prefijado con `rtk`**: `rtk npm test`, `rtk git status`, `rtk node --test`.
  Regla global del autor, también dentro de cadenas con `&&`.
- **Castellano** en código, comentarios, commits y documentación.
- **Los comentarios explican por qué.** El estilo de referencia es el de `~/voice-agent/src/`: párrafos
  cortos sobre decisiones no obvias, no glosas de lo que hace la línea siguiente.
- **Secretos en `.env`**, nunca en el repositorio. Siempre con un `.env.example` documentado al lado.
- **Nada se da por bueno sin ejecutarlo.** "Debería funcionar" no es un resultado.

---

## 6. Puesta en marcha

> Pendiente hasta que exista código. Se rellena al cerrar el hito 1 del plan.

---

## 7. Referencias de documentación

Consultar **siempre la fuente**, nunca la memoria: estas APIs se mueven (Discord retiró modos de
cifrado en 2024-2025; Inworld deprecó `tts-1`).

**Discord**

| Qué | Dónde |
|---|---|
| Conexiones de voz (handshake, RTP, cifrado, tramas de silencio) | <https://docs.discord.com/developers/topics/voice-connections> |
| Guía de voz de discord.js (dependencias, recursos de audio, ciclo de vida) | <https://discordjs.guide/voice> |
| Recursos de audio y `StreamType` | <https://discordjs.guide/voice/audio-resources> |
| Referencia de la API de `@discordjs/voice` | <https://discord.js.org/docs/packages/voice/main> |
| Comandos de aplicación (slash commands, permisos) | <https://docs.discord.com/developers/interactions/application-commands> |
| Gateway e intents | <https://docs.discord.com/developers/events/gateway> |
| Portal de aplicaciones (token, intents, invitación) | <https://discord.com/developers/applications> |

**TTS**

| Qué | Dónde |
|---|---|
| Inworld TTS — streaming, voces, `audioConfig` | <https://docs.inworld.ai/docs/tts/tts> |
| Deepgram Aura — encodings y sample rates | <https://developers.deepgram.com/docs/tts-encoding> |
| Deepgram Aura — streaming REST | <https://developers.deepgram.com/docs/text-to-speech> |

**Audio**

| Qué | Dónde |
|---|---|
| `opusscript` (libopus en WASM) | <https://github.com/abalabahaha/opusscript> |
| `@discordjs/opus` (binding nativo) | <https://github.com/discordjs/opus> |
| RFC 6716 — el códec Opus | <https://datatracker.ietf.org/doc/html/rfc6716> |

**Local**

| Qué | Dónde |
|---|---|
| Agente de voz: protocolo, límites, calidad de audio, troubleshooting | `~/voice-agent/README.md` en `ionos` |
| Aliases SSH, reglas RTK, rutas de proyectos | `C:\Users\julen\.claude\README.md` |

---

## 8. Skills a usar (Claude Code)

No son sugerencias: marcan el orden de trabajo.

| Momento | Skill | Para qué |
|---|---|---|
| Antes de diseñar nada | `superpowers:brainstorming` | Sacar requisitos y restricciones reales antes de escribir una línea. **Va antes del plan.** |
| Al convertir el diseño en pasos | `superpowers:writing-plans` | Producir el `PLAN.md` de §9. |
| Al implementar | `superpowers:test-driven-development` | Test primero. En audio, un test de temporización ahorra horas de "se oye raro". |
| Al ejecutar el plan | `superpowers:executing-plans` | Avanzar por hitos con puntos de revisión. |
| Cuando algo falle | `superpowers:systematic-debugging` | Antes de proponer arreglos. Los bugs de audio mienten mucho. |
| Antes de cantar victoria | `superpowers:verification-before-completion` | Evidencia (salida de comando) antes de afirmar que algo funciona. |
| Al cerrar una tanda | `superpowers:requesting-code-review` | Revisión antes de integrar. |
| Aislar trabajo en curso | `superpowers:using-git-worktrees` | Para hitos que tocan mucho a la vez. |
| Dudas sobre modelos/APIs de Claude | `claude-api` | Si el proyecto llega a integrar un LLM. |

---

## 9. Qué va en este README y qué va en el plan

Criterio, para no duplicar y no tener que sincronizar dos documentos:

> **El README describe lo que es estable: el terreno.**
> **El plan describe lo que vamos a hacer: la ruta.**

| Va en el **README** (este fichero) | Va en el **`PLAN.md`** |
|---|---|
| Rol y principios de trabajo | Comportamiento concreto del bot: qué comandos hay y qué hace cada uno |
| Qué es el proyecto y sus tres piezas | Las **restricciones**: quién puede hablar, en qué canales, cuántos caracteres, cooldowns, qué pasa si alguien abusa |
| Restricciones inmutables de Discord (48 kHz, Opus, 20 ms, tramas de silencio) | Modelo de permisos y de autorización, y cómo se configura el "usuario concreto" |
| Stack y por qué se eligió | Elección definitiva de proveedor de TTS y voz, con criterios y coste |
| Qué se hereda del `voice-agent` y qué se descarta | Decisión de uno o dos procesos, y topología de despliegue |
| Convenciones (RTK, castellano, secretos, tests) | Hitos, orden de implementación y criterio de "hecho" de cada uno |
| Referencias de documentación y skills | Objetivos de latencia **con número**, y cómo se miden |
| Cómo arrancar el proyecto una vez exista | Manejo de errores: el TTS falla, el bot se cae del canal, el usuario se desconecta a media frase |
| — | Riesgos abiertos y qué hay que prototipar para cerrarlos |
| — | Qué queda explícitamente **fuera** de la primera versión |

**Regla práctica:** si la respuesta cambia cuando cambiemos de opinión sobre el producto, va al plan.
Si seguiría siendo cierta aunque el producto cambiara, va al README.

### Estado actual

- [x] README: terreno, herencia y referencias fijadas.
- [x] Verificado que el TTS en streaming se puede hacer solo con Node.js.
- [x] Comportamiento del bot definido por el autor y auditado (9 agentes, 122 hallazgos) →
      **[`ESPECIFICACION.md`](ESPECIFICACION.md)**: vocabulario, pipeline, constraints redefinidos,
      decisiones técnicas cerradas y las 8 preguntas abiertas.
- [x] Prototipo desechable ejecutado desde `ionos` (2026-09-19): **48 kHz reales confirmados**,
      TTFB 276 ms, catálogo de voces OK → sin ffmpeg, sin resampleo.
- [x] Planes de implementación en `docs/superpowers/plans/` (3 planes: fundación y persistencia,
      motor de audio, comportamiento del bot), escritos sobre `ESPECIFICACION.md`.
- [x] Los 3 planes ejecutados (21 tareas, desarrollo por subagentes con revisión por tarea) +
      revisión final de rama con oleada de fixes. Suite: 72/72 en verde; `tsc --noEmit` limpio.
      Rama `worktree-bot-tts`.
- [ ] Humo real contra Discord (checklist de 19 puntos del plan 3, Task 8): **pendiente de
      `DISCORD_TOKEN` y `DISCORD_APP_ID`** en el `.env`. Inworld ya validado en real (34 voces).
- [ ] Cerrar la pregunta 3 de `ESPECIFICACION.md` §6 (presupuesto) — el resto de supuestos van
      adoptados con las recomendaciones.
- [ ] Merge a `master` (**lo decide el autor** tras el humo).
