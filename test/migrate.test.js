import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { listMigrations, runMigrations } from '../src/database/migrate.js';
import { createTestDatabase, dbSkip } from './helpers/testDb.js';

const databases = [];
after(async () => {
  for (const database of databases) await database.drop();
});

test('migration files are numbered and ordered', () => {
  const versions = listMigrations().map((migration) => migration.version);
  assert.ok(versions.length >= 2);
  assert.deepEqual([...versions].sort(), versions);
  assert.match(versions[0], /^001_/);
});

test('applies every migration once on an empty database', { skip: dbSkip }, async () => {
  const database = await createTestDatabase({ migrate: false });
  databases.push(database);
  assert.deepEqual(await runMigrations(database.pool), listMigrations().map((migration) => migration.version));
  assert.deepEqual(await runMigrations(database.pool), []);
  const { rows } = await database.pool.query(
    `SELECT to_regclass('outbound_messages')::text AS queue, to_regclass('webhook_deliveries')::text AS outbox`
  );
  assert.deepEqual(rows[0], { queue: 'outbound_messages', outbox: 'webhook_deliveries' });
});

test('upgrades a database created by the pre-migration schema.sql', { skip: dbSkip }, async () => {
  const database = await createTestDatabase({ migrate: false });
  databases.push(database);
  // What the old initDatabase() executed: the base schema without a schema_migrations table
  await database.pool.query(listMigrations()[0].sql);
  await database.pool.query(`INSERT INTO sessions (id) VALUES ('legacy')`);
  assert.equal((await runMigrations(database.pool)).length, listMigrations().length);
  const { rows } = await database.pool.query('SELECT id FROM sessions');
  assert.deepEqual(rows, [{ id: 'legacy' }]);
});
