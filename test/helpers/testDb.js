import pg from 'pg';
import { createDb } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';

// Database tests need a disposable PostgreSQL (see README, "Menjalankan test")
export const dbSkip = process.env.DB_TEST === '1' ? false : 'set DB_TEST=1 and DB_* env vars to run against PostgreSQL';

function poolFor(database) {
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database
  });
}

/**
 * Creates a throwaway database (migrated unless `migrate: false`) and a helper to drop it.
 */
export async function createTestDatabase({ migrate = true } = {}) {
  const admin = poolFor(process.env.DB_NAME);
  const name = `wagw_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = poolFor(name);
  // DROP DATABASE ... WITH (FORCE) may terminate a connection pool.end() is still closing; without a
  // listener that termination surfaces as an uncaught 'error' event
  pool.on('error', () => {});
  if (migrate) await runMigrations(pool);
  return {
    name,
    pool,
    db: createDb(pool),
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  };
}
