export interface Reloj { ahora(): number }
export const relojSistema: Reloj = { ahora: () => Date.now() };
