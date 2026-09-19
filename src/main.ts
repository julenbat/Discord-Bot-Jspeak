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
