// Limitador FIFO delante del proveedor de TTS: la cuenta de Inworld tiene un
// tope de peticiones simultáneas y superarlo es un 429 sin procesar.
export class Semaforo {
  #enUso = 0;
  #cola: Array<() => void> = [];
  private limite: number;

  constructor(limite: number) {
    this.limite = limite;
  }

  enUso(): number { return this.#enUso; }
  esperando(): number { return this.#cola.length; }

  async adquirir(): Promise<() => void> {
    if (this.#enUso < this.limite) this.#enUso++;
    else await new Promise<void>((r) => this.#cola.push(r));
    let liberado = false;
    return () => {
      if (liberado) return; liberado = true;
      const siguiente = this.#cola.shift();
      if (siguiente) siguiente();      // el hueco pasa directo al siguiente
      else this.#enUso--;
    };
  }
}
