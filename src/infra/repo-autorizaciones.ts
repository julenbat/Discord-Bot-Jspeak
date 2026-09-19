import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Autorizacion, RepoAutorizaciones } from '../aplicacion/puertos.ts';

// Un mapeador por repositorio: ningún RowDataPacket sube de esta capa.
function mapear(f: RowDataPacket): Autorizacion {
  return { guildId: f.guild_id, userId: f.user_id, estado: f.estado,
    voz: f.voz, concedidaPor: f.concedida_por, concedidaEn: f.concedida_en };
}

export class RepoAutorizacionesMysql implements RepoAutorizaciones {
  private readonly pool: Pool;
  // Parámetro de constructor con modificador de acceso: prohibido por
  // `erasableSyntaxOnly` en tsconfig.json (requiere transformación, no solo
  // borrado de tipos). Campo + asignación explícita en su lugar.
  constructor(pool: Pool) { this.pool = pool; }

  async autorizar(a: { guildId: string; userId: string; concedidaPor: string }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO autorizaciones (guild_id, user_id, estado, concedida_por, concedida_en)
       VALUES (:guildId, :userId, 'activa', :concedidaPor, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE estado='activa', concedida_por=:concedidaPor,
         concedida_en=UTC_TIMESTAMP(3), revocada_en=NULL, revocada_por=NULL`, a);
  }

  async revocar(guildId: string, userId: string, por: string): Promise<boolean> {
    const [r] = await this.pool.execute(
      `UPDATE autorizaciones SET estado='revocada', revocada_en=UTC_TIMESTAMP(3), revocada_por=:por
       WHERE guild_id=:guildId AND user_id=:userId AND estado='activa'`, { guildId, userId, por });
    return (r as { affectedRows: number }).affectedRows > 0;
  }

  async buscar(guildId: string, userId: string): Promise<Autorizacion | null> {
    const [filas] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM autorizaciones WHERE guild_id=:guildId AND user_id=:userId', { guildId, userId });
    return filas[0] ? mapear(filas[0]) : null;
  }

  async fijarVoz(guildId: string, userId: string, voz: string): Promise<void> {
    await this.pool.execute(
      'UPDATE autorizaciones SET voz=:voz WHERE guild_id=:guildId AND user_id=:userId',
      { guildId, userId, voz });
  }

  async listarActivas(): Promise<Autorizacion[]> {
    const [filas] = await this.pool.execute<RowDataPacket[]>(
      "SELECT * FROM autorizaciones WHERE estado='activa'");
    return filas.map(mapear);
  }
}
