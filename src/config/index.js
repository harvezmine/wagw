import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKey: process.env.API_KEY || '',
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
    autoReadMessages: process.env.AUTO_READ_MESSAGES === 'true'
  }
};
