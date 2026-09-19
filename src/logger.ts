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
