import type { Reloj } from '../reloj.ts';

const OCIOSO_LIBERAR_MS = 10_000; // cerrojo primero-que-habla: silencio antes de liberar

// La presentación (discord.js) extrae esto del VoiceState vivo.
export interface EstadoVoz { canalId: string | null; ensordecido: boolean }
export type VeredictoVoz =
  | { ok: true; canalId: string }
  | { ok: false; motivo: 'fuera_de_canal' | 'ensordecido' | 'canal_ocupado' };

interface CerrojoGuild { canalId: string; ociosoDesdeMs: number | null }

// C1 + cerrojo por guild "primero que habla" (supuesto P1 de la spec): el
// bot queda atado al canal del primer usuario que le hace hablar; se libera
// con cola vacía + 10 s de silencio, que el orquestador notifica llamando a
// liberarSiOcioso() en cada barrido.
export class GuardianVoz {
  readonly #reloj: Reloj;
  #cerrojos = new Map<string, CerrojoGuild>();

  constructor(reloj: Reloj) {
    this.#reloj = reloj;
  }

  // Solo veredicto: no ocupa el canal. El orquestador llama a ocupar() aparte
  // cuando decide de verdad atender la locución. userId no entra en la
  // decisión hoy (C1 y el cerrojo son por canal), pero queda en la firma
  // porque la interfaz del brief lo exige explícitamente.
  evaluar(guildId: string, _userId: string, voz: EstadoVoz): VeredictoVoz {
    if (voz.canalId === null) return { ok: false, motivo: 'fuera_de_canal' };
    if (voz.ensordecido) return { ok: false, motivo: 'ensordecido' };
    const cerrojo = this.#cerrojos.get(guildId);
    if (cerrojo && cerrojo.canalId !== voz.canalId) return { ok: false, motivo: 'canal_ocupado' };
    return { ok: true, canalId: voz.canalId };
  }

  ocupar(guildId: string, canalId: string): void {
    this.#cerrojos.set(guildId, { canalId, ociosoDesdeMs: null });
  }

  // colaVacia=false: hay trabajo, borra cualquier marcador de ocio en curso.
  // colaVacia=true: si no había marcador, lo pone ahora; si ya lo había y
  // llevan más de 10 s, libera el cerrojo.
  liberarSiOcioso(guildId: string, colaVacia: boolean): void {
    const cerrojo = this.#cerrojos.get(guildId);
    if (!cerrojo) return;
    if (!colaVacia) {
      cerrojo.ociosoDesdeMs = null;
      return;
    }
    if (cerrojo.ociosoDesdeMs === null) {
      cerrojo.ociosoDesdeMs = this.#reloj.ahora();
      return;
    }
    if (this.#reloj.ahora() - cerrojo.ociosoDesdeMs > OCIOSO_LIBERAR_MS) {
      this.#cerrojos.delete(guildId);
    }
  }

  canalOcupado(guildId: string): string | null {
    return this.#cerrojos.get(guildId)?.canalId ?? null;
  }
}
