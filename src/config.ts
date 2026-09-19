// Configuración por entorno, patrón heredado del voice-agent: si falta algo
// indispensable se aborta con mensaje claro. La pausa previa al exit evita
// que `restart: unless-stopped` haga girar el contenedor sin parar.

export class ErrorConfig extends Error {}

export interface Config {
  discordToken: string;
  discordAppId: string;
  discordAdminId: string;
  guildAllowlist: string[];
  inworldApiKey: string;
  inworldModel: string;
  inworldLanguage: string;
  tarifaUsdMillon: Record<string, number>;
  mysql: { host: string; database: string; user: string; password: string };
  tz: string;
  logLevel: string;
  ttsConcurrencia: number;
  ttsKillSwitch: boolean;
}

const OBLIGATORIAS = [
  'DISCORD_TOKEN',
  'DISCORD_APP_ID',
  'DISCORD_ADMIN_ID',
  'GUILD_ALLOWLIST',
  'INWORLD_API_KEY',
  'MYSQL_HOST',
  'MYSQL_DATABASE',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
] as const;

export function cargarConfig(env: NodeJS.ProcessEnv): Config {
  const faltan = OBLIGATORIAS.filter((k) => !env[k]);
  if (faltan.length) {
    throw new ErrorConfig(
      `Faltan variables de entorno: ${faltan.join(', ')}. Copia .env.example a .env y rellénalas.`,
    );
  }

  const clave = env.INWORLD_API_KEY!.trim();

  return {
    discordToken: env.DISCORD_TOKEN!,
    discordAppId: env.DISCORD_APP_ID!,
    discordAdminId: env.DISCORD_ADMIN_ID!,
    guildAllowlist: env.GUILD_ALLOWLIST!.split(',').map((s) => s.trim()).filter(Boolean),
    inworldApiKey: /^(Basic|Bearer) /.test(clave) ? clave : `Basic ${clave}`,
    inworldModel: env.INWORLD_MODEL || 'inworld-tts-2',
    inworldLanguage: env.INWORLD_LANGUAGE || 'es-ES',
    tarifaUsdMillon: {
      'inworld-tts-2': Number(env.TARIFA_USD_MILLON_TTS2 || 25),
      'inworld-tts-2-flash': Number(env.TARIFA_USD_MILLON_FLASH || 15),
    },
    mysql: {
      host: env.MYSQL_HOST!,
      database: env.MYSQL_DATABASE!,
      user: env.MYSQL_USER!,
      password: env.MYSQL_PASSWORD!,
    },
    tz: env.TZ || 'Europe/Madrid',
    logLevel: env.LOG_LEVEL || 'info',
    ttsConcurrencia: Number(env.TTS_CONCURRENCIA || 3),
    ttsKillSwitch: env.TTS_KILL_SWITCH === 'true',
  };
}
