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

// ── Añadidos a los nueve del brief: el resto de la API pública se quedaba
// sin una sola línea de cobertura, y es la que corre con SIGTERM de por medio.

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

test('kill switch del operador: el mensaje ni se mira', async () => {
  const { orq, dobles } = crearMundo({ killSwitch: true });
  await orq.activarSesion('g', 'u');
  await orq.procesarMensaje(dobles.mensaje({ contenido: 'No debería sonar.' }));
  assert.equal(dobles.locuciones.length, 0);
  assert.equal(dobles.eventosAbiertos.length, 0);
});
