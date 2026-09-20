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

// ── Añadidos a los nueve del brief.

test('C1 en vivo: si se sale del canal entre encolar y sonar, no se locuta', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  // procesarMensaje corre sin ceder el control hasta el INSERT del paso 9,
  // o sea: ya ha leído C1 (en el canal) y ya ha encolado. Aquí es donde el
  // usuario se sale del canal de voz.
  const enVuelo = orq.procesarMensaje(dobles.mensaje({ contenido: 'Se sale del canal antes de sonar.' }));
  dobles.fijarEstadoVoz({ canalId: null, ensordecido: false });
  await enVuelo;
  assert.equal(dobles.locuciones.length, 0);                    // la relectura viva lo caza
  assert.equal(dobles.eventosAbiertos[0]!.estado, 'encolado');  // llegó a encolarse…
  assert.equal(dobles.eventosCerrados[0]!.estado, 'abortado');  // …y murió en la revalidación
});

test('el log del paso 10 sale con el formato EXACTO de la spec', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  // Con markup: lo que se loguea es el texto SANEADO, no el original.
  await orq.procesarMensaje(dobles.mensaje({
    contenido: '**Hola** mundo https://ejemplo.com',
    resolutores: { nombreUsuario: () => null, nombreCanal: () => null },
  }));
  assert.ok(dobles.logs.includes('El usuario Alba <-> u : Ha generado el tts: Hola mundo enlace'),
    `no está la línea esperada; capturadas: ${JSON.stringify(dobles.logs)}`);
});

test('coste estimado: caracteres locales x tarifa del modelo / 1e6', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  const contenido = 'Cuenta los caracteres de esta frase exacta.';
  await orq.procesarMensaje(dobles.mensaje({ contenido }));
  const cierre = dobles.eventosCerrados[0]!;
  assert.equal(cierre.estado, 'reproducido');
  assert.equal(cierre.modelo, 'inworld-tts-2');            // sin modeloDevuelto: el de config
  assert.equal(cierre.tarifaUsdPorMillon, 25);             // copiada en la fila
  assert.equal(cierre.costeUsd, (contenido.length * 25) / 1_000_000);
  assert.equal(cierre.costeOrigen, 'estimado');            // Inworld no da precio jamás
});

test('coste: manda el modelo que devuelve el proveedor, con SU tarifa', async () => {
  const { orq, dobles } = crearMundo({ modeloDevuelto: 'inworld-tts-2-flash' });
  await orq.activarSesion('g', 'u');
  const contenido = 'Otra frase para el modelo flash.';
  await orq.procesarMensaje(dobles.mensaje({ contenido }));
  const cierre = dobles.eventosCerrados[0]!;
  assert.equal(cierre.modelo, 'inworld-tts-2-flash');
  assert.equal(cierre.tarifaUsdPorMillon, 15);
  assert.equal(cierre.costeUsd, (contenido.length * 15) / 1_000_000);
});

test('pararTodo durante conectarVoz: el mensaje NO suena tras el corte', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  let soltarConexion!: () => void;
  const m = dobles.mensaje({
    contenido: 'Cortada mientras entraba al canal.',
    conectarVoz: () => new Promise<void>((resolver) => { soltarConexion = resolver; }),
  });
  await orq.procesarMensaje(m);              // devuelve con el bombeo DENTRO de conectarVoz
  await orq.desactivarSesion('g', 'u');      // pararTodo: aborta, vacía y cierra la fila
  soltarConexion();                          // la conexión llega tarde, ya no vale
  await new Promise((r) => setImmediate(r)); // que el bombeo retome y se encuentre el corte
  assert.equal(dobles.locuciones.length, 0);                    // no se locuta nada
  assert.equal(dobles.eventosCerrados.length, 1);               // ni se cierra dos veces
  assert.equal(dobles.eventosCerrados[0]!.estado, 'abortado');
});

// El resto de la API pública se quedaba sin una sola línea de cobertura,
// y es la que corre con SIGTERM de por medio.

test('apagar: aborta lo que sonaba y deja de aceptar mensajes', async () => {
  const { orq, dobles } = crearMundo({ locutorLento: true });
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Frase cortada por el apagado.' }));
  await orq.apagar();
  assert.equal(dobles.señalesAbortadas, 1);
  assert.equal(dobles.eventosCerrados.at(-1)!.estado, 'abortado');
  await orq.procesarMensaje(dobles.mensaje({ mensajeId: '77', contenido: 'Ya no se acepta nada.' }));
  assert.equal(dobles.locuciones.length, 1);
});

// Regresión: Altavoz.desconectar() no se llamaba NUNCA en producción, así
// que un `docker compose stop` no emitía las 5 tramas de silencio, no hacía
// el player.stop(true) que libera el encoder de opusscript y no destruía la
// conexión: el bot se quedaba tieso dentro del canal hasta que Discord lo
// echaba por timeout.
test('apagar: además de abortar, saca al bot de los canales de voz', async () => {
  const { orq, dobles } = crearMundo({ locutorLento: true });
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Frase cortada por el apagado.' }));
  assert.equal(dobles.desconexionesAltavoz, 0);   // en caliente no se desconecta nada
  await orq.apagar();
  assert.equal(dobles.desconexionesAltavoz, 1);
  await orq.apagar();                             // idempotente: no desconecta dos veces
  assert.equal(dobles.desconexionesAltavoz, 1);
});

test('kill switch del operador: el mensaje ni se mira', async () => {
  const { orq, dobles } = crearMundo({ killSwitch: true });
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'No debería sonar.' }));
  assert.equal(dobles.locuciones.length, 0);
  assert.equal(dobles.eventosAbiertos.length, 0);
});

// Regresión: el cerrojo de canal del guild se quedaba puesto de por vida.
// El `finally` del bucle solo MARCA el inicio del ocio; con nadie hablando ya
// no vuelve a ejecutarse, así que sin un barrido en el paso 7 el segundo
// usuario comía 'canal_ocupado' para siempre.
test('el cerrojo del guild se libera tras 10 s de silencio: otro usuario en otro canal sí suena', async () => {
  const { orq, dobles, servicios } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla en el canal uno.' }));
  assert.equal(dobles.locuciones.length, 1);           // A ocupa c1
  assert.equal(servicios.cola.vacia('g'), true);       // y deja la cola vacía

  // Segundo usuario autorizado y activo, en OTRO canal de voz del mismo guild.
  await servicios.autorizaciones.autorizar('g', 'u2', 'admin');
  await orq.activarSesion('g', 'u2');
  dobles.reloj.avanzar(11_000);                        // > los 10 s de ocio del guardián

  await orq.procesarMensaje(dobles.mensaje({
    mensajeId: '2', userId: 'u2', nombreUsuario: 'Bea',
    contenido: 'Bea habla en el canal dos.',
    estadoVoz: { canalId: 'c2', ensordecido: false },
  }));
  assert.equal(dobles.locuciones.length, 2);           // el cerrojo se soltó: suena
  assert.equal(dobles.eventosCerrados.at(-1)!.estado, 'reproducido');
  assert.equal(servicios.guardian.canalOcupado('g'), 'c2'); // y ahora lo ocupa Bea
});

// ── Paquete de salida: las tres formas de abandonar el canal EN CALIENTE.
// Hasta aquí el bot solo salía al apagar, al ser expulsado o al ser mudado de
// canal (los dos últimos, dentro de Altavoz): se quedaba dentro de un canal
// vacío indefinidamente, ocupando una conexión de voz y figurando en la lista
// de miembros como si estuviera escuchando.

// ── A: el usuario con TTS activo se sale del canal.

test('salida A: se va el último con TTS activo → el bot se va detrás y aborta lo que sonaba', async () => {
  const { orq, dobles } = crearMundo({ locutorLento: true });
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla y el bot entra al canal.' }));
  assert.equal(dobles.canalActual('g'), 'c1');           // el bot está dentro de c1

  await orq.abandonarCanalSiProcede('g', 'u', 'c1', false);
  assert.deepEqual(dobles.desconexionesGuild, ['g']);
  assert.equal(dobles.canalActual('g'), null);
  assert.equal(dobles.señalesAbortadas, 1);              // lo que estaba sonando se corta
  assert.equal(dobles.eventosCerrados.at(-1)!.estado, 'abortado');
  // La SESIÓN sobrevive: si vuelve y escribe, la entrada perezosa del
  // pipeline mete al bot otra vez sin pasar por /jspeak enable.
  assert.deepEqual(orq.sesionesActivasDe('g'), ['u']);
});

test('salida A2: se va uno pero otro con TTS activo sigue en el canal → el bot se queda', async () => {
  const { orq, dobles, servicios } = crearMundo();
  await orq.activarSesion('g', 'u');
  await servicios.autorizaciones.autorizar('g', 'u2', 'admin');
  await orq.activarSesion('g', 'u2');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla y el bot entra al canal.' }));

  await orq.abandonarCanalSiProcede('g', 'u', 'c1', true);
  assert.deepEqual(dobles.desconexionesGuild, []);
  assert.equal(dobles.canalActual('g'), 'c1');
});

test('salida A3: quien no tiene sesión activa no saca al bot del canal al irse', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla y el bot entra al canal.' }));

  await orq.abandonarCanalSiProcede('g', 'u2', 'c1', false);   // u2 nunca activó el TTS
  assert.deepEqual(dobles.desconexionesGuild, []);
  assert.equal(dobles.canalActual('g'), 'c1');
});

test('salida A4: si el bot no estaba en el canal que se deja, no se mueve', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla y el bot entra al canal.' }));

  await orq.abandonarCanalSiProcede('g', 'u', 'c9', false);    // sale de OTRO canal
  assert.deepEqual(dobles.desconexionesGuild, []);
  assert.equal(dobles.canalActual('g'), 'c1');
});

// ── B: /jspeak disable de la última sesión activa del guild.

test('salida B: disable de la última sesión activa → el bot abandona el canal', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla y el bot entra al canal.' }));
  assert.equal(dobles.canalActual('g'), 'c1');

  await orq.desactivarSesion('g', 'u');
  assert.deepEqual(dobles.desconexionesGuild, ['g']);
  assert.equal(dobles.canalActual('g'), null);
});

test('salida B2: disable con otra sesión activa en el guild → el bot se queda', async () => {
  const { orq, dobles, servicios } = crearMundo();
  await orq.activarSesion('g', 'u');
  await servicios.autorizaciones.autorizar('g', 'u2', 'admin');
  await orq.activarSesion('g', 'u2');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla y el bot entra al canal.' }));

  await orq.desactivarSesion('g', 'u');
  assert.deepEqual(dobles.desconexionesGuild, []);
  assert.equal(dobles.canalActual('g'), 'c1');
  assert.deepEqual(orq.sesionesActivasDe('g'), ['u2']);
});

// ── C: barrido de inactividad (el TICK vive en main.ts; aquí, solo la política).

test('salida C: 5 min con la cola vacía y sin locutar → el barrido saca al bot del canal', async () => {
  const { orq, dobles } = crearMundo();
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Alba habla y el bot entra al canal.' }));

  await orq.barrerInactividad();
  assert.deepEqual(dobles.desconexionesGuild, []);       // recién locutado: no toca

  dobles.reloj.avanzar(5 * 60_000 + 1);
  await orq.barrerInactividad();
  assert.deepEqual(dobles.desconexionesGuild, ['g']);
  assert.equal(dobles.canalActual('g'), null);

  dobles.reloj.avanzar(5 * 60_000);
  await orq.barrerInactividad();                         // ya no hay conexión: no insiste
  assert.deepEqual(dobles.desconexionesGuild, ['g']);
});

test('salida C2: con algo pendiente en la cola el barrido no toca la conexión', async () => {
  const { orq, dobles } = crearMundo({ locutorLento: true });
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'Frase que se queda sonando para siempre.' }));

  dobles.reloj.avanzar(10 * 60_000);
  await orq.barrerInactividad();
  assert.deepEqual(dobles.desconexionesGuild, []);
  assert.equal(dobles.canalActual('g'), 'c1');
});

test('sesionesActivasDe: solo los userId con sesión viva de ESE guild', async () => {
  const { orq, servicios } = crearMundo();
  await orq.activarSesion('g', 'u');
  await servicios.autorizaciones.autorizar('g', 'u2', 'admin');
  await orq.activarSesion('g', 'u2');
  await orq.activarSesion('g2', 'u3');
  assert.deepEqual(orq.sesionesActivasDe('g').sort(), ['u', 'u2']);
  assert.deepEqual(orq.sesionesActivasDe('g2'), ['u3']);
  await orq.desactivarSesion('g', 'u');
  assert.deepEqual(orq.sesionesActivasDe('g'), ['u2']);
});
