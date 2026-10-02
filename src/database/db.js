import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { runMigrations } from './migrate.js';

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
  const applied = await runMigrations(pool, {
    log: (version) => logger.info({ migration: version }, 'Applied database migration')
  });
  logger.info({ applied: applied.length }, 'Database schema is up to date');
}
