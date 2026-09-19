// Puertos de la capa de aplicación: interfaces que la infra implementa
// (RepoXxxMysql en src/infra/). Nada de mysql2 se importa aquí.

export interface Autorizacion {
  guildId: string; userId: string; estado: 'activa' | 'revocada';
  voz: string; concedidaPor: string; concedidaEn: Date;
}
export interface RepoAutorizaciones {
  autorizar(a: { guildId: string; userId: string; concedidaPor: string }): Promise<void>; // UPSERT que reactiva revocadas
  revocar(guildId: string, userId: string, por: string): Promise<boolean>;
  buscar(guildId: string, userId: string): Promise<Autorizacion | null>;
  fijarVoz(guildId: string, userId: string, voz: string): Promise<void>;
  listarActivas(): Promise<Autorizacion[]>; // para la caché en memoria al arrancar
}
export interface Sesion {
  guildId: string; userId: string; activadaEn: Date;
  ultimoMensajeEn: Date | null; ultimosAvisos: Record<string, number>;
}
export interface RepoSesiones {
  activar(guildId: string, userId: string): Promise<void>;      // INSERT IGNORE: idempotente
  desactivar(guildId: string, userId: string): Promise<boolean>;
  buscar(guildId: string, userId: string): Promise<Sesion | null>;
  listar(): Promise<Sesion[]>;
  tocarUltimoMensaje(guildId: string, userId: string, cuando: Date): Promise<void>;
  fijarAviso(guildId: string, userId: string, tipo: string, cuandoMs: number): Promise<void>;
}
export interface EventoTtsNuevo {
  mensajeId: string; guildId: string; userId: string; canalVozId: string | null;
  estado: 'encolado' | 'descartado'; motivoDescarte?: string;
  textoOriginal: string; textoSaneado: string; caracteres: number; voz: string;
}
export interface CierreEventoTts {
  estado: 'reproducido' | 'abortado' | 'fallido';
  caracteresProveedor?: number; modelo?: string;
  msPrimerByte?: number; msPrimerAudio?: number; msAudio?: number; underruns?: number;
  costeUsd?: number; tarifaUsdPorMillon?: number; costeOrigen: 'api' | 'estimado' | 'desconocido';
}
export interface RepoTtsEventos {
  abrir(e: EventoTtsNuevo): Promise<'nuevo' | 'duplicado'>; // ER_DUP_ENTRY → 'duplicado'
  cerrar(mensajeId: string, c: CierreEventoTts): Promise<void>;
}
