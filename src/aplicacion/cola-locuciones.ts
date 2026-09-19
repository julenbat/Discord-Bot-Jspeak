import { contarPalabras } from './saneador.ts';

const LIMITE_PALABRAS_POR_DEFECTO = 200;
const LIMITE_LOCUCIONES_POR_DEFECTO = 20;

export interface Locucion {
  mensajeId: string; guildId: string; userId: string; texto: string; voz: string; epoch: number;
}
export type ResultadoEncolar = { ok: true } | { ok: false; motivo: 'cola_llena' };

interface ColaUsuario { cola: Locucion[]; enCurso: Locucion | null }

function clave(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// Map 'guild:user' → cola FIFO + locución en curso. Vive en memoria: el
// orquestador es quien decide cuándo arrancar/terminar la que está sonando.
export class ColaLocuciones {
  readonly #limitePalabras: number;
  readonly #limiteLocuciones: number;
  #colas = new Map<string, ColaUsuario>();

  constructor(limitePalabras = LIMITE_PALABRAS_POR_DEFECTO, limiteLocuciones = LIMITE_LOCUCIONES_POR_DEFECTO) {
    this.#limitePalabras = limitePalabras;
    this.#limiteLocuciones = limiteLocuciones;
  }

  #obtener(guildId: string, userId: string): ColaUsuario {
    const k = clave(guildId, userId);
    let c = this.#colas.get(k);
    if (!c) {
      c = { cola: [], enCurso: null };
      this.#colas.set(k, c);
    }
    return c;
  }

  // Cuenta TODO lo no reproducido (encolado + lo que queda de la que está
  // sonando): rechaza el NUEVO mensaje si lo haría superar el límite. Lo
  // que ya estaba en cola se queda intacto: causalidad, no se desaloja a
  // nadie por culpa de un mensaje que llega después.
  encolar(l: Locucion): ResultadoEncolar {
    const c = this.#obtener(l.guildId, l.userId);
    if (c.cola.length >= this.#limiteLocuciones) return { ok: false, motivo: 'cola_llena' };
    const pendientes = this.palabrasPendientes(l.guildId, l.userId);
    if (pendientes + contarPalabras(l.texto) > this.#limitePalabras) return { ok: false, motivo: 'cola_llena' };
    c.cola.push(l);
    return { ok: true };
  }

  siguiente(guildId: string, userId: string): Locucion | null {
    const c = this.#obtener(guildId, userId);
    return c.cola.shift() ?? null;
  }

  enCurso(l: Locucion | null, guildId: string, userId: string): void {
    this.#obtener(guildId, userId).enCurso = l;
  }

  palabrasPendientes(guildId: string, userId: string): number {
    const c = this.#obtener(guildId, userId);
    const enColaPalabras = c.cola.reduce((suma, x) => suma + contarPalabras(x.texto), 0);
    const enCursoPalabras = c.enCurso ? contarPalabras(c.enCurso.texto) : 0;
    return enColaPalabras + enCursoPalabras;
  }

  // Descarta lo encolado (no toca la que está sonando); devuelve cuántas.
  vaciar(guildId: string, userId: string): number {
    const c = this.#obtener(guildId, userId);
    const n = c.cola.length;
    c.cola = [];
    return n;
  }

  // ¿Nada pendiente en todo el guild? (cola vacía y nada sonando, para
  // cualquier usuario de ese guild). Lo usa el cerrojo del guardián.
  vacia(guildId: string): boolean {
    const prefijo = `${guildId}:`;
    for (const [k, c] of this.#colas) {
      if (!k.startsWith(prefijo)) continue;
      if (c.cola.length > 0 || c.enCurso !== null) return false;
    }
    return true;
  }
}
