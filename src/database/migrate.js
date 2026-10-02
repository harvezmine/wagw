import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// Arbitrary constant key for pg_advisory_lock, shared by every gateway instance
const MIGRATION_LOCK_KEY = 727274;

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((file) => /^\d+_[\w-]+\.sql$/.test(file))
    .sort()
    .map((file) => ({ version: file.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

/**
 * Applies pending SQL migrations in order, each in its own transaction. An advisory lock keeps two
 * starting instances from migrating at the same time. Returns the versions applied.
 */
export async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version VARCHAR(200) PRIMARY KEY,
         applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    );
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));
    const pending = listMigrations(dir).filter((migration) => !applied.has(migration.version));

    for (const migration of pending) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
        await client.query('COMMIT');
        log(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} failed: ${error.message}`);
      }
    }
    return pending.map((migration) => migration.version);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
