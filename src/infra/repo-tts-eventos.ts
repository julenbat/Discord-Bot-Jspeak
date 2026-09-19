import type { Pool } from 'mysql2/promise';
import type { EventoTtsNuevo, CierreEventoTts, RepoTtsEventos } from '../aplicacion/puertos.ts';

// mysql2 con namedPlaceholders no acepta `undefined` en el binding (lanza
// "Bind parameters must not contain undefined"): los campos opcionales del
// puerto se normalizan aquí a `null` antes de ejecutar.
export class RepoTtsEventosMysql implements RepoTtsEventos {
  private readonly pool: Pool;
  // Ver comentario equivalente en repo-autorizaciones.ts: `erasableSyntaxOnly`
  // prohíbe parámetros de constructor con modificador de acceso.
  constructor(pool: Pool) { this.pool = pool; }

  async abrir(e: EventoTtsNuevo): Promise<'nuevo' | 'duplicado'> {
    try {
      await this.pool.execute(
        `INSERT INTO tts_eventos
           (mensaje_id, guild_id, user_id, canal_voz_id, estado, motivo_descarte,
            texto_original, texto_saneado, caracteres, voz, creado_en)
         VALUES
           (:mensajeId, :guildId, :userId, :canalVozId, :estado, :motivoDescarte,
            :textoOriginal, :textoSaneado, :caracteres, :voz, UTC_TIMESTAMP(3))`,
        {
          mensajeId: e.mensajeId, guildId: e.guildId, userId: e.userId, canalVozId: e.canalVozId,
          estado: e.estado, motivoDescarte: e.motivoDescarte ?? null,
          textoOriginal: e.textoOriginal, textoSaneado: e.textoSaneado,
          caracteres: e.caracteres, voz: e.voz,
        });
      return 'nuevo';
    } catch (err) {
      // UNIQUE(mensaje_id) es el portero de idempotencia contra la reentrega
      // de MESSAGE_CREATE en RESUME (ver comentario en la migración).
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return 'duplicado';
      throw err;
    }
  }

  async cerrar(mensajeId: string, c: CierreEventoTts): Promise<void> {
    await this.pool.execute(
      `UPDATE tts_eventos SET
         estado=:estado, caracteres_proveedor=:caracteresProveedor, modelo=:modelo,
         ms_primer_byte=:msPrimerByte, ms_primer_audio=:msPrimerAudio, ms_audio=:msAudio,
         underruns=:underruns, coste_usd=:costeUsd, tarifa_usd_por_millon=:tarifaUsdPorMillon,
         coste_origen=:costeOrigen, terminado_en=UTC_TIMESTAMP(3)
       WHERE mensaje_id=:mensajeId`,
      {
        mensajeId, estado: c.estado,
        caracteresProveedor: c.caracteresProveedor ?? null, modelo: c.modelo ?? null,
        msPrimerByte: c.msPrimerByte ?? null, msPrimerAudio: c.msPrimerAudio ?? null,
        msAudio: c.msAudio ?? null, underruns: c.underruns ?? null,
        costeUsd: c.costeUsd ?? null, tarifaUsdPorMillon: c.tarifaUsdPorMillon ?? null,
        costeOrigen: c.costeOrigen,
      });
  }
}
