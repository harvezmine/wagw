import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Query helpers bound to a pool. `withTransaction` runs `fn(client)` inside BEGIN/COMMIT and
 * rolls back (and rethrows) on any error.
 */
export function createDb(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  ssl: config.db.ssl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
});

export const db = createDb(pool);
export const query = db.query;
export const withTransaction = db.withTransaction;

export async function initDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schemaSql);

    // Auto-migration for existing tables
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_jid VARCHAR(150);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS push_name VARCHAR(150);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS disconnect_reason VARCHAR(100);
    `);

    logger.info('Database tables initialized and verified');
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize database tables');
    throw error;
  }
}
