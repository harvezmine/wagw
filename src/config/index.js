import dotenv from 'dotenv';
dotenv.config();

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  return value === 'true';
}

/**
 * Parses WA_VERSION ("2.3000.1043857760") into Baileys' [major, minor, patch] tuple.
 * Returns null when unset so Baileys uses the WA Web version bundled with the library.
 */
export function parseWaVersion(value) {
  if (!value) return null;
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Invalid WA_VERSION "${value}". Expected a format like 2.3000.1043857760.`);
  }
  return value.split('.').map(Number);
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKey: process.env.API_KEY || '',
  qrLinkTtlSeconds: parseInt(process.env.QR_LINK_TTL_SECONDS || '600', 10),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '62',
  allowPrivateUrls: parseBoolean(process.env.ALLOW_PRIVATE_URLS, false),
  mediaMaxBytes: parseInt(process.env.MEDIA_MAX_BYTES || String(50 * 1024 * 1024), 10),
  waVersion: parseWaVersion(process.env.WA_VERSION),
  reconnect: {
    baseDelayMs: parseInt(process.env.RECONNECT_BASE_DELAY_MS || '2000', 10),
    maxDelayMs: parseInt(process.env.RECONNECT_MAX_DELAY_MS || '300000', 10)
  },
  restoreStaggerMs: parseInt(process.env.RESTORE_STAGGER_MS || '1500', 10),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'whatsapp_gateway',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  },
  globalWebhookUrl: process.env.GLOBAL_WEBHOOK_URL || '',
  antiBan: {
    minTypingDelayMs: parseInt(process.env.MIN_TYPING_DELAY_MS || '1000', 10),
    maxTypingDelayMs: parseInt(process.env.MAX_TYPING_DELAY_MS || '2500', 10),
    maxRequestDelayMs: parseInt(process.env.MAX_REQUEST_DELAY_MS || '15000', 10),
    autoReadMessages: process.env.AUTO_READ_MESSAGES === 'true'
  }
};

/**
 * Fails fast on configuration that would leave the gateway insecure or broken.
 */
export function validateConfig(cfg = config) {
  if (cfg.nodeEnv === 'production' && cfg.apiKey.length < 16) {
    throw new Error('API_KEY is required in production and must be at least 16 characters long.');
  }
  if (!/^[1-9]\d{0,3}$/.test(cfg.defaultCountryCode)) {
    throw new Error(`DEFAULT_COUNTRY_CODE must be a numeric country code such as 62 (got "${cfg.defaultCountryCode}").`);
  }
}
