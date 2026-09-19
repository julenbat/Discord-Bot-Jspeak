-- Autorización (admin) ≠ sesión (usuario): dos tablas, ESPECIFICACION §1.
-- Snowflakes como VARCHAR(20): BIGINT + JS redondea por encima de 2^53
-- y autorizaría a otro usuario.
CREATE TABLE autorizaciones (
  guild_id      VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id       VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado        ENUM('activa','revocada') NOT NULL DEFAULT 'activa',
  voz           VARCHAR(64)  NOT NULL DEFAULT 'Marta',
  concedida_por VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  concedida_en  DATETIME(3) NOT NULL,
  revocada_en   DATETIME(3) NULL,
  revocada_por  VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- La existencia de la fila ES el estado "activo". El CASCADE solo salta si se
-- BORRA la autorización; la revocación es lógica y desactiva desde el servicio.
CREATE TABLE sesiones (
  guild_id          VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id           VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  activada_en       DATETIME(3) NOT NULL,
  ultimo_mensaje_en DATETIME(3) NULL,
  ultimos_avisos    JSON NOT NULL,  -- { "cola_llena": epochMs, ... } persistido: reiniciar no resetea el antispam
  PRIMARY KEY (guild_id, user_id),
  CONSTRAINT fk_sesion_autorizacion FOREIGN KEY (guild_id, user_id)
    REFERENCES autorizaciones (guild_id, user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Una fila por locución INTENTADA, insertada antes de sintetizar:
-- UNIQUE(mensaje_id) es el portero de idempotencia contra la reentrega
-- de MESSAGE_CREATE en RESUME.
CREATE TABLE tts_eventos (
  id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mensaje_id            VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  guild_id              VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id               VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  canal_voz_id          VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  estado                ENUM('encolado','reproducido','abortado','fallido','descartado') NOT NULL,
  motivo_descarte       VARCHAR(64) NULL,
  texto_original        TEXT NULL,
  texto_saneado         TEXT NULL,
  caracteres            INT UNSIGNED NOT NULL DEFAULT 0,
  caracteres_proveedor  INT UNSIGNED NULL,   -- usage de Inworld; llegó 0 en streaming: NULL-able por diseño
  modelo                VARCHAR(64) NULL,
  voz                   VARCHAR(64) NULL,
  ms_primer_byte        INT UNSIGNED NULL,
  ms_primer_audio       INT UNSIGNED NULL,
  ms_audio              INT UNSIGNED NULL,
  underruns             SMALLINT UNSIGNED NULL,
  coste_usd             DECIMAL(12,6) NULL,
  tarifa_usd_por_millon DECIMAL(12,6) NULL,  -- copiada en cada fila: recalcular histórico al cambiar de plan
  coste_origen          ENUM('api','estimado','desconocido') NOT NULL DEFAULT 'desconocido',
  creado_en             DATETIME(3) NOT NULL,
  terminado_en          DATETIME(3) NULL,
  UNIQUE KEY uq_mensaje (mensaje_id),
  KEY idx_guild_user_fecha (guild_id, user_id, creado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
