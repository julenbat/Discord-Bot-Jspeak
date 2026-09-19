import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Sesion, RepoSesiones } from '../aplicacion/puertos.ts';

// Un mapeador por repositorio: ningún RowDataPacket sube de esta capa.
// `ultimos_avisos` es JSON; según el driver puede llegar ya parseado (objeto)
// o como texto crudo — se normaliza aquí con JSON.parse cuando toca.
function mapear(f: RowDataPacket): Sesion {
  return {
    guildId: f.guild_id, userId: f.user_id, activadaEn: f.activada_en,
    ultimoMensajeEn: f.ultimo_mensaje_en,
    ultimosAvisos: typeof f.ultimos_avisos === 'string' ? JSON.parse(f.ultimos_avisos) : f.ultimos_avisos,
  };
}

export class RepoSesionesMysql implements RepoSesiones {
  private readonly pool: Pool;
  // Ver comentario equivalente en repo-autorizaciones.ts: `erasableSyntaxOnly`
  // prohíbe parámetros de constructor con modificador de acceso.
  constructor(pool: Pool) { this.pool = pool; }

  async activar(guildId: string, userId: string): Promise<void> {
    // La existencia de la fila ES el estado "activo" (ver migración): INSERT
    // IGNORE vía ON DUPLICATE KEY UPDATE no-op para no pisar una sesión viva
    // (activada_en, ultimos_avisos) si ya existía.
    await this.pool.execute(
      `INSERT INTO sesiones (guild_id, user_id, activada_en, ultimo_mensaje_en, ultimos_avisos)
       VALUES (:guildId, :userId, UTC_TIMESTAMP(3), NULL, '{}')
       ON DUPLICATE KEY UPDATE guild_id=guild_id`, { guildId, userId });
  }

  async desactivar(guildId: string, userId: string): Promise<boolean> {
    const [r] = await this.pool.execute(
      'DELETE FROM sesiones WHERE guild_id=:guildId AND user_id=:userId', { guildId, userId });
    return (r as { affectedRows: number }).affectedRows > 0;
  }

  async buscar(guildId: string, userId: string): Promise<Sesion | null> {
    const [filas] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM sesiones WHERE guild_id=:guildId AND user_id=:userId', { guildId, userId });
    return filas[0] ? mapear(filas[0]) : null;
  }

  async listar(): Promise<Sesion[]> {
    const [filas] = await this.pool.execute<RowDataPacket[]>('SELECT * FROM sesiones');
    return filas.map(mapear);
  }

  async tocarUltimoMensaje(guildId: string, userId: string, cuando: Date): Promise<void> {
    await this.pool.execute(
      'UPDATE sesiones SET ultimo_mensaje_en=:cuando WHERE guild_id=:guildId AND user_id=:userId',
      { guildId, userId, cuando });
  }

  async fijarAviso(guildId: string, userId: string, tipo: string, cuandoMs: number): Promise<void> {
    await this.pool.execute(
      `UPDATE sesiones SET ultimos_avisos = JSON_SET(ultimos_avisos, CONCAT('$.', :tipo), :cuandoMs)
       WHERE guild_id=:guildId AND user_id=:userId`, { guildId, userId, tipo, cuandoMs });
  }
}
