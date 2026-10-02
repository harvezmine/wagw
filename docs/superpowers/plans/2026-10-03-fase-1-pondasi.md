# Fase 1 — Pondasi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun pondasi produksi wagw:
- antrian kirim per sesi (rate limit, jadwal, idempotency, cancel/reschedule);
- pelacakan status pesan (sent/delivered/read/failed);
- webhook v2 (outbox, retry + backoff, HMAC, filter event, retensi);
- log terstruktur, migrasi DB, graceful shutdown, Dockerfile yang benar;
- upgrade ke Baileys v7 (LID, tctoken, endpoint limit akun).

**Architecture:**
- **Antrian kirim:**
  - Semua pesan keluar masuk tabel `outbound_messages`.
  - `queueRunner` mengirim satu pesan per sesi pada satu waktu, dengan jeda acak antar pesan. Sesi-sesi diproses paralel.
  - Endpoint kirim yang lama tetap kompatibel: request menunggu sampai pesan terkirim (maksimal `SEND_WAIT_TIMEOUT_MS`), lalu membalas 200. Kalau belum terkirim, `async` diminta, atau pesan dijadwalkan, balasannya 202 + `queueId`.
- **Webhook:** setiap event disimpan dulu di `webhook_deliveries` (outbox), lalu `webhookDispatcher` mengirimkannya dengan retry (at-least-once).
- **Struktur kode:** logika murni dipisah ke modul yang bisa di-unit-test dengan fake. Repository Postgres diuji dengan database sementara.

**Tech Stack:** Node.js 22, Express 4, `@whiskeysockets/baileys` 7.0.0-rc14, PostgreSQL 16 (`pg`), pino, axios, `node:test`.

---

## Keputusan desain

| Topik | Keputusan | Alasan |
|---|---|---|
| Queue backend | Tabel Postgres + `FOR UPDATE SKIP LOCKED`, tanpa Redis/BullMQ | Tidak menambah infrastruktur; aman terhadap konsumen paralel |
| Kompatibilitas endpoint kirim | Default menunggu hasil (200 seperti sebelumnya). `async: true`, `scheduleAt`, atau timeout → 202 | Klien lama tetap jalan; klien baru bisa fire-and-forget |
| Pacing | Jeda acak `SEND_INTERVAL_MIN_MS`–`SEND_INTERVAL_MAX_MS` (default 2–6 detik) antar pesan per sesi; pesan pertama langsung | Kecepatan kirim adalah sinyal ban yang terdokumentasi |
| Retry kirim | Error transien diulang (maks 3x, jeda 30 detik × percobaan). Error 4xx (input buruk) langsung gagal | Mencegah loop pada input yang memang salah |
| Crash di tengah kirim | Baris `processing` saat startup ditandai `failed`, tidak dikirim ulang | Lebih baik gagal daripada pesan dobel |
| Media di antrian | URL disimpan lalu di-download saat kirim; upload/base64 disimpan sebagai `BYTEA` dan dihapus setelah selesai | Tanpa object storage (S3 baru di Fase 3) |
| Webhook | Outbox + dispatcher. Retry untuk 5xx/408/429/error jaringan, 4xx lain langsung gagal. Backoff 10 detik s/d 1 jam, maks 10 percobaan. URL & secret dibaca saat kirim | URL yang diperbaiki langsung dipakai untuk retry |
| Signature | `X-Webhook-Signature: sha256=HMAC(secret, "<timestamp>.<body>")` + `X-Webhook-Timestamp`, `X-Webhook-Id` | Penerima bisa menolak replay dan dedupe |
| Migrasi | Runner SQL sendiri (`schema_migrations` + advisory lock); `001` identik dengan schema lama (idempotent) | DB lama ter-upgrade tanpa langkah manual |
| Baileys v7 | Pin `7.0.0-rc14` (tag npm `latest`). `fromObject`/`toJSON` masih ada di rc14, jadi auth state dan `getMessage` tidak berubah | tctoken/LID mengurangi error 463; `libsignal` dari npm (bukan git) |

Di luar scope (Fase 2+): endpoint kirim terpadu, multi-target/variabel, tipe pesan baru, grup, multi-tenant, autoreply, S3, Redis, sharding replica.

## Struktur file

| File | Status | Tanggung jawab |
|---|---|---|
| `src/utils/logger.js` | baru | Logger pino aplikasi |
| `src/utils/jid.js` | baru | `phoneFromJid`, `describeMessageAddress` (LID ↔ nomor) |
| `src/database/migrate.js` | baru | Runner migrasi SQL |
| `src/database/migrations/001_initial.sql` | baru (dari `schema.sql`) | Skema dasar |
| `src/database/migrations/002_queue_and_webhooks.sql` | baru | Tabel antrian, outbox webhook, kolom webhook sesi, index |
| `src/database/migrations/003_lid_columns.sql` | baru | Kolom JID alternatif (LID) |
| `src/services/messageStatus.js` | baru | Mapping ack → status, transisi maju, penjelasan kode error |
| `src/services/outboundQueue.js` | baru | Repository antrian |
| `src/services/queueRunner.js` | baru | Worker antrian per sesi |
| `src/services/messageService.js` | baru | Submit/cancel/reschedule + instance runner |
| `src/services/webhookSigner.js` | baru | Tanda tangan HMAC |
| `src/services/webhookConfigResolver.js` | baru (ganti `webhookUrlResolver.js`) | URL, secret, filter event per sesi |
| `src/services/webhookOutbox.js` | baru | Repository outbox webhook |
| `src/services/webhookDispatcher.js` | baru | Pengirim webhook + retry |
| `src/controllers/queueController.js`, `src/routes/queueRoutes.js` | baru | API `/api/queue` |
| `src/database/db.js`, `src/database/schema.sql` | ubah / hapus | Migrasi menggantikan `schema.sql` |
| `src/services/sessionManager.js` | ubah | Logger, ack, pengiriman dari antrian, shutdown, LID, limit akun |
| `src/services/webhookService.js` | ubah | Outbox + dispatcher |
| `src/controllers/*`, `src/routes/*`, `src/index.js` | ubah | API baru, wiring, graceful shutdown |
| `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, `package.json` | ubah | Ops dan dokumentasi |
| `test/helpers/testDb.js` + test baru | baru | Database sementara per file test |

Environment lokal:
- Node: `export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:/usr/local/bin:$PATH`.
- Postgres test:
  ```bash
  docker run -d --name wagw-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:56999:5432 postgres:16-alpine
  ```
- Test DB: `DB_TEST=1 DB_HOST=127.0.0.1 DB_PORT=56999 DB_USER=postgres DB_PASSWORD=test DB_NAME=postgres npm test`.

---

### Task 1: Logger terstruktur (pino)

**Files:**
- Create: `src/utils/logger.js`
- Modify: `src/config/index.js` (bagian `logLevel`, `logPretty`, `baileysLogLevel`), `src/index.js`, `src/database/db.js`, `src/utils/errors.js`, `src/routes/index.js`, `package.json`

- [ ] **Step 1: Tambah field config** (di objek `config`, dengan `const nodeEnv = process.env.NODE_ENV || 'development';` di atasnya, dan `nodeEnv,` menggantikan baris lama):
```js
  logLevel: process.env.LOG_LEVEL || 'info',
  logPretty: parseBoolean(process.env.LOG_PRETTY, nodeEnv !== 'production'),
  baileysLogLevel: process.env.BAILEYS_LOG_LEVEL || 'error',
```

- [ ] **Step 2: `src/utils/logger.js`**
```js
import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Application logger: one JSON object per line in production, human-readable when LOG_PRETTY=true.
 * Add context with child loggers, e.g. logger.child({ module: 'queue' }).
 */
export const logger = pino({
  level: config.logLevel,
  ...(config.logPretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
    : {})
});
```

- [ ] **Step 3: Ganti `console.*`**
  - **`src/utils/errors.js`:** `if (status >= 500) logger.error({ err: error, context }, 'Request failed');`
  - **`src/database/db.js`:** `pool.on('error', (err) => logger.error({ err }, 'Unexpected error on idle PostgreSQL client'));`
  - **`src/routes/index.js`:** receiver webhook test → `logger.info({ payload: req.body }, 'Webhook test receiver got a payload');`
  - **`src/index.js`:**
    - log HTTP → `logger.info({ method: req.method, path, status: res.statusCode, durationMs: Date.now() - start }, 'HTTP request');`
    - error middleware → `logger.error({ err }, 'Unhandled request error')`
    - `unhandledRejection` → `logger.error({ err: reason }, 'Unhandled promise rejection')`
    - log startup → `logger.info`/`logger.warn`/`logger.fatal`

  `sessionManager.js` dan `webhookService.js` dikonversi di Task 7 dan Task 8, saat file itu memang disentuh.

- [ ] **Step 4: Script test** — `"test": "LOG_LEVEL=silent LOG_PRETTY=false node --test test/*.test.js"`.
- [ ] **Step 5: Run** `npm test` → semua PASS. **Commit** `chore: structured logging with pino`.

---

### Task 2: Migrasi database

**Files:**
- Create: `src/database/migrate.js`, `src/database/migrations/001_initial.sql`, `src/database/migrations/002_queue_and_webhooks.sql`, `test/helpers/testDb.js`, `test/migrate.test.js`
- Modify: `src/database/db.js` (`initDatabase`), `test/postgresAuthState.test.js`
- Delete: `src/database/schema.sql`

- [ ] **Step 1: Test** — `test/helpers/testDb.js`
```js
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
```

`test/migrate.test.js`
```js
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
```

`test/postgresAuthState.test.js`: ganti setup `pg.Pool` + `schema.sql` dengan helper:
```js
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { usePostgresAuthState } from '../src/database/postgresAuthState.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

const SESSION = 'test-auth-state';
let database;
let db;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  db = database.db;
});

after(async () => {
  if (database) await database.drop();
});
```
Isi test-nya tetap.

- [ ] **Step 2: Run** → FAIL (`migrate.js` belum ada).

- [ ] **Step 3: Implementasi** — `src/database/migrate.js`
```js
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
```

- `001_initial.sql` = isi `schema.sql` saat ini, diawali komentar `-- Base schema. Idempotent, so databases created before migrations existed upgrade cleanly.`, ditambah empat baris `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` dari `initDatabase()` lama. Setelah itu `git rm src/database/schema.sql`.

- `002_queue_and_webhooks.sql`:
```sql
-- Outbound message queue: every message sent through the API is queued here first
CREATE TABLE IF NOT EXISTS outbound_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(200),
    target_jid VARCHAR(150) NOT NULL,
    message_type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    media_data BYTEA, -- uploaded/base64 media until the message is sent
    status VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued, processing, sent, delivered, read, played, failed, cancelled, expired
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts INT NOT NULL DEFAULT 0,
    message_id VARCHAR(150),
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_idempotency
    ON outbound_messages(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_due
    ON outbound_messages(session_id, scheduled_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_outbound_message_id
    ON outbound_messages(session_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_created ON outbound_messages(created_at DESC);

-- Webhook outbox: events are stored first, then delivered (with retries) by the dispatcher
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, delivered, failed
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_url TEXT,
    last_status_code INT,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_webhook_due ON webhook_deliveries(next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_session_created ON webhook_deliveries(session_id, created_at DESC);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhook_events TEXT[];

-- Message history is always filtered by session and sorted by time
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at DESC);
```

`src/database/db.js` — `initDatabase` (hapus import `fs`, `path`, `url`):
```js
export async function initDatabase() {
  const applied = await runMigrations(pool, {
    log: (version) => logger.info({ migration: version }, 'Applied database migration')
  });
  logger.info({ applied: applied.length }, 'Database schema is up to date');
}
```

- [ ] **Step 4: Run test DB** → PASS. **Commit** `feat(db): SQL migration runner replacing schema.sql`.

---

### Task 3: Konfigurasi antrian & webhook

**Files:** Modify `src/config/index.js`, `test/config.test.js`

- [ ] **Step 1: Test** — di `test/config.test.js`, `base` menjadi:
```js
const base = {
  nodeEnv: 'production',
  apiKey: 'a-very-long-api-key-123',
  defaultCountryCode: '62',
  queue: { sendIntervalMinMs: 2000, sendIntervalMaxMs: 6000 },
  webhook: { secret: '' }
};
```
lalu tambahkan:
```js
test('validateConfig rejects an inverted send interval', () => {
  assert.throws(() => validateConfig({ ...base, queue: { sendIntervalMinMs: 5000, sendIntervalMaxMs: 1000 } }), /SEND_INTERVAL/);
});

test('validateConfig rejects a short webhook secret', () => {
  assert.throws(() => validateConfig({ ...base, webhook: { secret: 'short' } }), /WEBHOOK_SECRET/);
  assert.doesNotThrow(() => validateConfig({ ...base, webhook: { secret: 'a-long-enough-secret-1' } }));
});
```

- [ ] **Step 2: Implementasi** — helper dan field baru:
```js
function envInt(name, defaultValue) {
  return parseInt(process.env[name] || String(defaultValue), 10);
}
```
```js
  shutdownTimeoutMs: envInt('SHUTDOWN_TIMEOUT_MS', 15000),
  queue: {
    sendIntervalMinMs: envInt('SEND_INTERVAL_MIN_MS', 2000),
    sendIntervalMaxMs: envInt('SEND_INTERVAL_MAX_MS', 6000),
    pollMs: envInt('QUEUE_POLL_MS', 1000),
    maxAttempts: envInt('QUEUE_MAX_ATTEMPTS', 3),
    retryDelayMs: envInt('QUEUE_RETRY_DELAY_MS', 30000),
    maxAgeMs: envInt('QUEUE_MAX_AGE_HOURS', 24) * 60 * 60 * 1000,
    sendWaitTimeoutMs: envInt('SEND_WAIT_TIMEOUT_MS', 60000)
  },
  webhook: {
    secret: process.env.WEBHOOK_SECRET || '',
    timeoutMs: envInt('WEBHOOK_TIMEOUT_MS', 10000),
    maxAttempts: envInt('WEBHOOK_MAX_ATTEMPTS', 10),
    retryBaseDelayMs: envInt('WEBHOOK_RETRY_BASE_DELAY_MS', 10000),
    retryMaxDelayMs: envInt('WEBHOOK_RETRY_MAX_DELAY_MS', 60 * 60 * 1000),
    retentionDays: envInt('WEBHOOK_RETENTION_DAYS', 7),
    failedRetentionDays: envInt('WEBHOOK_FAILED_RETENTION_DAYS', 30)
  },
```
dan di `validateConfig`:
```js
  if (cfg.queue.sendIntervalMinMs < 0 || cfg.queue.sendIntervalMaxMs < cfg.queue.sendIntervalMinMs) {
    throw new Error('SEND_INTERVAL_MIN_MS must be >= 0 and SEND_INTERVAL_MAX_MS must be >= SEND_INTERVAL_MIN_MS.');
  }
  if (cfg.webhook.secret && cfg.webhook.secret.length < 16) {
    throw new Error('WEBHOOK_SECRET must be at least 16 characters long.');
  }
```
- [ ] **Step 3: Run** → PASS. **Commit** `feat(config): queue and webhook settings`.

---

### Task 4: Status pesan + parser input antrian

**Files:**
- Create: `src/services/messageStatus.js`
- Modify: `src/utils/validation.js`
- Test: `test/messageStatus.test.js`, `test/validation.test.js`

- [ ] **Step 1: Test** — `test/messageStatus.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackToStatus, allowedPreviousStatuses, describeAckError } from '../src/services/messageStatus.js';

test('maps Baileys ack values to delivery statuses', () => {
  assert.equal(ackToStatus(0), 'failed');
  assert.equal(ackToStatus(1), null);
  assert.equal(ackToStatus(2), 'sent');
  assert.equal(ackToStatus(3), 'delivered');
  assert.equal(ackToStatus(4), 'read');
  assert.equal(ackToStatus(5), 'played');
  assert.equal(ackToStatus(undefined), null);
});

test('only allows forward transitions', () => {
  assert.deepEqual(allowedPreviousStatuses('sent'), []);
  assert.deepEqual(allowedPreviousStatuses('delivered'), ['sent']);
  assert.deepEqual(allowedPreviousStatuses('read'), ['sent', 'delivered']);
  assert.deepEqual(allowedPreviousStatuses('played'), ['sent', 'delivered', 'read']);
  assert.deepEqual(allowedPreviousStatuses('failed'), ['sent', 'delivered']);
});

test('explains known WhatsApp rejection codes', () => {
  assert.match(describeAckError('463'), /463.*restricted/);
  assert.equal(describeAckError('999'), 'WhatsApp error 999');
  assert.equal(describeAckError(undefined), 'WhatsApp rejected the message');
});
```
Tambahan di `test/validation.test.js` (import `parseOptionalBool`, `parseScheduleAt`, `parseIdempotencyKey`):
```js
test('parseOptionalBool accepts booleans and their string forms', () => {
  const opts = { name: 'async', defaultValue: false };
  assert.equal(parseOptionalBool(undefined, opts), false);
  assert.equal(parseOptionalBool('true', opts), true);
  assert.equal(parseOptionalBool(true, opts), true);
  assert.equal(parseOptionalBool('0', opts), false);
  assert.throws(() => parseOptionalBool('yes', opts), { status: 400 });
});

test('parseScheduleAt accepts ISO dates and unix seconds; past times mean now', () => {
  const now = () => Date.parse('2026-10-02T00:00:00Z');
  assert.equal(parseScheduleAt(undefined, { now }), null);
  assert.equal(parseScheduleAt('2026-10-03T08:00:00+07:00', { now }).toISOString(), '2026-10-03T01:00:00.000Z');
  assert.equal(parseScheduleAt(String(now() / 1000 + 3600), { now }).getTime(), now() + 3600000);
  assert.equal(parseScheduleAt('2020-01-01T00:00:00Z', { now }), null);
});

test('parseScheduleAt rejects garbage and dates more than a year ahead', () => {
  const now = () => Date.parse('2026-10-02T00:00:00Z');
  assert.throws(() => parseScheduleAt('tomorrow', { now }), { status: 400 });
  assert.throws(() => parseScheduleAt('2030-01-01T00:00:00Z', { now }), { status: 400 });
});

test('parseIdempotencyKey accepts short visible keys', () => {
  assert.equal(parseIdempotencyKey(undefined), null);
  assert.equal(parseIdempotencyKey('order-123'), 'order-123');
  assert.throws(() => parseIdempotencyKey('has space'), { status: 400 });
  assert.throws(() => parseIdempotencyKey('x'.repeat(201)), { status: 400 });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/services/messageStatus.js`
```js
// Baileys WAMessageStatus values carried by `messages.update` for our own messages
const ACK_TO_STATUS = { 0: 'failed', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'played' };

// Delivery progress only moves forward
const PROGRESS = ['sent', 'delivered', 'read', 'played'];

// WhatsApp NACK codes worth explaining to API clients
const ACK_ERRORS = {
  463: 'account restricted from starting new chats (reach-out timelock or missing privacy token)',
  475: 'new chat message limit reached',
  479: 'rejected by WhatsApp (stale device session or invalid addressing)'
};

export const QUEUE_STATUSES = ['queued', 'processing', 'sent', 'delivered', 'read', 'played', 'failed', 'cancelled', 'expired'];

export function ackToStatus(ack) {
  return ACK_TO_STATUS[ack] ?? null;
}

/**
 * Statuses a message may currently have for `status` to be applied (forward-only transitions).
 * A failure can only follow a server ack.
 */
export function allowedPreviousStatuses(status) {
  if (status === 'failed') return ['sent', 'delivered'];
  const index = PROGRESS.indexOf(status);
  return index > 0 ? PROGRESS.slice(0, index) : [];
}

export function describeAckError(code) {
  if (!code) return 'WhatsApp rejected the message';
  return ACK_ERRORS[code] ? `WhatsApp error ${code}: ${ACK_ERRORS[code]}` : `WhatsApp error ${code}`;
}
```
Tambahan di `src/utils/validation.js`:
```js
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export function parseOptionalBool(value, { name, defaultValue }) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  throw new AppError(400, `${name} must be true or false.`);
}

/**
 * Parses scheduleAt (ISO-8601 string or unix timestamp in seconds). Past times mean "send now" (null).
 */
export function parseScheduleAt(value, { now = Date.now } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const date = /^\d+$/.test(String(value)) ? new Date(Number(value) * 1000) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'scheduleAt must be an ISO-8601 date or a unix timestamp in seconds.');
  }
  if (date.getTime() - now() > MAX_SCHEDULE_AHEAD_MS) {
    throw new AppError(400, 'scheduleAt cannot be more than 365 days ahead.');
  }
  return date.getTime() <= now() ? null : date;
}

export function parseIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value);
  if (key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new AppError(400, 'idempotencyKey must be 1-200 visible ASCII characters.');
  }
  return key;
}
```
- [ ] **Step 4: Run** → PASS. **Commit** `feat: message status transitions and queue input parsers`.

---

### Task 5: Repository antrian (`outboundQueue`)

**Files:**
- Create: `src/services/outboundQueue.js`
- Test: `test/outboundQueue.test.js`

- [ ] **Step 1: Test**
```js
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundQueue } from '../src/services/outboundQueue.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

let database;
let queue;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  queue = createOutboundQueue(database.db);
  await database.pool.query(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`);
});

after(async () => {
  if (database) await database.drop();
});

beforeEach(async () => {
  if (database) await database.pool.query('DELETE FROM outbound_messages');
});

const text = (overrides = {}) => ({
  sessionId: 's1',
  targetJid: '628123456789@s.whatsapp.net',
  messageType: 'text',
  payload: { text: 'hi' },
  ...overrides
});

test('enqueue is idempotent per session and key and never returns media bytes', { skip }, async () => {
  const first = await queue.enqueue(text({ idempotencyKey: 'order-1', mediaData: Buffer.from('img') }));
  assert.equal(first.created, true);
  assert.equal(first.item.status, 'queued');
  assert.equal('media_data' in first.item, false);

  const again = await queue.enqueue(text({ idempotencyKey: 'order-1', payload: { text: 'other' } }));
  assert.equal(again.created, false);
  assert.equal(again.item.id, first.item.id);

  assert.equal((await queue.enqueue(text({ sessionId: 's2', idempotencyKey: 'order-1' }))).created, true);
});

test('claimNext hands out due messages in order and skips scheduled ones', { skip }, async () => {
  const later = await queue.enqueue(text({ scheduledAt: new Date(Date.now() + 3600000) }));
  const a = await queue.enqueue(text({ payload: { text: 'a' }, mediaData: Buffer.from('bytes') }));
  const b = await queue.enqueue(text({ payload: { text: 'b' } }));
  assert.deepEqual(await queue.dueSessionIds(), ['s1']);

  const first = await queue.claimNext('s1');
  assert.equal(first.id, a.item.id);
  assert.equal(first.attempts, 1);
  assert.deepEqual(first.media_data, Buffer.from('bytes'));
  assert.equal((await queue.claimNext('s1')).id, b.item.id);
  assert.equal(await queue.claimNext('s1'), null);
  assert.equal((await queue.get(later.item.id)).status, 'queued');
});

test('concurrent claims never return the same message twice', { skip }, async () => {
  await queue.enqueue(text());
  const claims = await Promise.all([queue.claimNext('s1'), queue.claimNext('s1'), queue.claimNext('s1')]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('requeue and markSent update the row', { skip }, async () => {
  const { item } = await queue.enqueue(text());
  const claimed = await queue.claimNext('s1');
  await queue.requeue(claimed.id, 'Connection Closed', 0);
  let row = await queue.get(item.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.last_error, 'Connection Closed');

  await queue.claimNext('s1');
  await queue.markSent(item.id, 'WAMSG1');
  row = await queue.get(item.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.message_id, 'WAMSG1');
  assert.equal(row.attempts, 2);
  assert.ok(row.sent_at);
});

test('cancel and reschedule only change queued messages', { skip }, async () => {
  const { item } = await queue.enqueue(text());
  const when = new Date(Date.now() + 60000);
  assert.equal((await queue.reschedule(item.id, when)).scheduled_at.getTime(), when.getTime());
  assert.equal((await queue.cancel(item.id)).status, 'cancelled');
  assert.equal(await queue.cancel(item.id), null);
  assert.equal(await queue.reschedule(item.id, null), null);
});

test('applyAck only moves the status forward', { skip }, async () => {
  const { item } = await queue.enqueue(text());
  await queue.claimNext('s1');
  await queue.markSent(item.id, 'WAMSG2');
  assert.ok(await queue.applyAck('s1', 'WAMSG2', 'read', ['sent', 'delivered']));
  assert.equal(await queue.applyAck('s1', 'WAMSG2', 'delivered', ['sent']), null);
  assert.equal((await queue.get(item.id)).status, 'read');
});

test('recoverInterrupted fails in-flight rows; expireStale expires old queued rows', { skip }, async () => {
  const stuck = await queue.enqueue(text());
  await queue.claimNext('s1');
  const old = await queue.enqueue(text({ scheduledAt: new Date(Date.now() + 60000) }));
  await database.pool.query(`UPDATE outbound_messages SET scheduled_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [old.item.id]);

  assert.equal(await queue.recoverInterrupted(), 1);
  assert.equal((await queue.get(stuck.item.id)).status, 'failed');

  const expired = await queue.expireStale(24 * 60 * 60 * 1000);
  assert.deepEqual(expired.map((row) => row.id), [old.item.id]);
  assert.equal((await queue.get(old.item.id)).status, 'expired');
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/services/outboundQueue.js`
```js
import { db as defaultDb } from '../database/db.js';

// Columns returned to API clients (never the media bytes)
const PUBLIC_COLUMNS = `id, session_id, idempotency_key, target_jid, message_type, payload, status,
  scheduled_at, attempts, message_id, last_error, created_at, updated_at, sent_at`;

/**
 * Postgres-backed outbound message queue. Rows move queued -> processing -> sent
 * (-> delivered -> read -> played) or end as failed / cancelled / expired.
 */
export function createOutboundQueue(db = defaultDb) {
  return {
    async enqueue({ sessionId, idempotencyKey = null, targetJid, messageType, payload, mediaData = null, scheduledAt = null }) {
      const inserted = await db.query(
        `INSERT INTO outbound_messages (session_id, idempotency_key, target_jid, message_type, payload, media_data, scheduled_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, COALESCE($7::timestamptz, NOW()))
         ON CONFLICT (session_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING ${PUBLIC_COLUMNS}`,
        [sessionId, idempotencyKey, targetJid, messageType, JSON.stringify(payload), mediaData, scheduledAt]
      );
      if (inserted.rows[0]) {
        return { item: inserted.rows[0], created: true };
      }
      const existing = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM outbound_messages WHERE session_id = $1 AND idempotency_key = $2`,
        [sessionId, idempotencyKey]
      );
      return { item: existing.rows[0], created: false };
    },

    /** Sessions that have at least one message due now. */
    async dueSessionIds() {
      const res = await db.query(
        `SELECT DISTINCT session_id FROM outbound_messages WHERE status = 'queued' AND scheduled_at <= NOW()`
      );
      return res.rows.map((row) => row.session_id);
    },

    /** Atomically claims the next due message of a session; safe with concurrent workers. */
    async claimNext(sessionId) {
      const res = await db.query(
        `UPDATE outbound_messages SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
         WHERE id = (
           SELECT id FROM outbound_messages
           WHERE session_id = $1 AND status = 'queued' AND scheduled_at <= NOW()
           ORDER BY scheduled_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, session_id, target_jid, message_type, payload, media_data, attempts`,
        [sessionId]
      );
      return res.rows[0] || null;
    },

    async markSent(id, messageId) {
      await db.query(
        `UPDATE outbound_messages
         SET status = 'sent', message_id = $2, sent_at = NOW(), media_data = NULL, last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [id, messageId]
      );
    },

    async markFailed(id, error) {
      await db.query(
        `UPDATE outbound_messages SET status = 'failed', last_error = $2, media_data = NULL, updated_at = NOW() WHERE id = $1`,
        [id, error]
      );
    },

    async requeue(id, error, delayMs) {
      await db.query(
        `UPDATE outbound_messages
         SET status = 'queued', last_error = $2, scheduled_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE id = $1`,
        [id, error, delayMs]
      );
    },

    async get(id) {
      const res = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM outbound_messages WHERE id = $1`, [id]);
      return res.rows[0] || null;
    },

    async list({ sessionId = null, status = null, limit = 50, offset = 0 } = {}) {
      const res = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM outbound_messages
         WHERE ($1::text IS NULL OR session_id = $1) AND ($2::text IS NULL OR status = $2)
         ORDER BY id DESC LIMIT $3 OFFSET $4`,
        [sessionId, status, limit, offset]
      );
      return res.rows;
    },

    async cancel(id) {
      const res = await db.query(
        `UPDATE outbound_messages SET status = 'cancelled', media_data = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'queued' RETURNING ${PUBLIC_COLUMNS}`,
        [id]
      );
      return res.rows[0] || null;
    },

    async reschedule(id, scheduledAt) {
      const res = await db.query(
        `UPDATE outbound_messages SET scheduled_at = COALESCE($2::timestamptz, NOW()), updated_at = NOW()
         WHERE id = $1 AND status = 'queued' RETURNING ${PUBLIC_COLUMNS}`,
        [id, scheduledAt]
      );
      return res.rows[0] || null;
    },

    /** Applies a delivery receipt when the current status is one of `allowedPrevious`. */
    async applyAck(sessionId, messageId, status, allowedPrevious, error = null) {
      const res = await db.query(
        `UPDATE outbound_messages SET status = $3, last_error = COALESCE($5, last_error), updated_at = NOW()
         WHERE session_id = $1 AND message_id = $2 AND status = ANY($4::text[])
         RETURNING id`,
        [sessionId, messageId, status, allowedPrevious, error]
      );
      return res.rows[0] || null;
    },

    /** Messages left "processing" by a crash may or may not have been sent: fail them, never resend. */
    async recoverInterrupted() {
      const res = await db.query(
        `UPDATE outbound_messages
         SET status = 'failed', media_data = NULL, updated_at = NOW(),
             last_error = 'Interrupted by a restart while sending; not retried to avoid a duplicate.'
         WHERE status = 'processing'`
      );
      return res.rowCount;
    },

    async expireStale(maxAgeMs) {
      const res = await db.query(
        `UPDATE outbound_messages
         SET status = 'expired', media_data = NULL, updated_at = NOW(),
             last_error = 'Not sent before the queue expiry (session offline for too long).'
         WHERE status = 'queued' AND scheduled_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
         RETURNING id, session_id, target_jid`,
        [maxAgeMs]
      );
      return res.rows;
    }
  };
}

export const outboundQueue = createOutboundQueue();
```
- [ ] **Step 4: Run test DB** → PASS. **Commit** `feat(queue): Postgres-backed outbound message queue`.

---

### Task 6: Queue runner

**Files:**
- Create: `src/services/queueRunner.js`
- Test: `test/queueRunner.test.js`

- [ ] **Step 1: Test**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueueRunner } from '../src/services/queueRunner.js';
import { AppError } from '../src/utils/errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

function createFakeQueue(items) {
  const rows = items.map((item) => ({ status: 'queued', attempts: 0, dueAt: 0, target_jid: '62811@s.whatsapp.net', ...item }));
  const find = (id) => rows.find((row) => row.id === id);
  const isDue = (row) => row.status === 'queued' && row.dueAt <= Date.now();
  return {
    rows,
    find,
    async dueSessionIds() {
      return [...new Set(rows.filter(isDue).map((row) => row.session_id))];
    },
    async claimNext(sessionId) {
      const row = rows.find((candidate) => candidate.session_id === sessionId && isDue(candidate));
      if (!row) return null;
      row.status = 'processing';
      row.attempts += 1;
      return { ...row };
    },
    async markSent(id, messageId) { Object.assign(find(id), { status: 'sent', messageId }); },
    async markFailed(id, error) { Object.assign(find(id), { status: 'failed', error }); },
    async requeue(id, error, delayMs) { Object.assign(find(id), { status: 'queued', error, dueAt: Date.now() + delayMs }); },
    async expireStale() { return []; }
  };
}

function createRunner(queue, overrides = {}) {
  return createQueueRunner({
    queue,
    getReadySessionIds: () => ['s1', 's2'],
    sendItem: async (item) => `MSG-${item.id}`,
    sendIntervalMinMs: 0,
    sendIntervalMaxMs: 0,
    pollMs: 5,
    retryDelayMs: 5,
    maxAttempts: 3,
    ...overrides
  });
}

test('sends one message per session at a time with a gap between sends', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }, { id: 2, session_id: 's1' }]);
  const sends = [];
  const runner = createRunner(queue, {
    sendIntervalMinMs: 60,
    sendIntervalMaxMs: 60,
    sendItem: async (item) => {
      sends.push({ id: item.id, at: Date.now() });
      await sleep(10);
      return `MSG-${item.id}`;
    }
  });
  runner.start();
  await waitUntil(() => queue.find(2).status === 'sent');
  await runner.stop();
  assert.deepEqual(sends.map((send) => send.id), [1, 2]);
  assert.ok(sends[1].at - sends[0].at >= 60, `gap was ${sends[1].at - sends[0].at}ms`);
});

test('different sessions are processed in parallel', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }, { id: 2, session_id: 's2' }]);
  const started = [];
  const runner = createRunner(queue, {
    sendItem: async () => {
      started.push(Date.now());
      await sleep(50);
      return 'MSG';
    }
  });
  runner.start();
  await waitUntil(() => queue.rows.every((row) => row.status === 'sent'));
  await runner.stop();
  assert.ok(Math.abs(started[0] - started[1]) < 40);
});

test('skips sessions that are not connected', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const runner = createRunner(queue, { getReadySessionIds: () => [] });
  runner.start();
  await sleep(50);
  await runner.stop();
  assert.equal(queue.find(1).status, 'queued');
});

test('retries transient errors and reports the final result', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const results = [];
  let calls = 0;
  const runner = createRunner(queue, {
    sendItem: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Connection Closed');
      return 'MSG-OK';
    },
    onResult: (result) => results.push(result)
  });
  runner.start();
  const done = await runner.waitFor(1, 2000);
  await runner.stop();
  assert.deepEqual(done, { id: 1, status: 'sent', messageId: 'MSG-OK' });
  assert.equal(queue.find(1).attempts, 2);
  assert.deepEqual(results, [{ id: 1, sessionId: 's1', to: '62811@s.whatsapp.net', status: 'sent', messageId: 'MSG-OK' }]);
});

test('bad input fails immediately; repeated transient errors fail after maxAttempts', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }, { id: 2, session_id: 's2' }]);
  const runner = createRunner(queue, {
    sendItem: async (item) => {
      if (item.id === 1) throw new AppError(400, 'Failed to download media URL');
      throw new Error('Connection Closed');
    }
  });
  runner.start();
  const [bad, flaky] = await Promise.all([runner.waitFor(1, 2000), runner.waitFor(2, 2000)]);
  await runner.stop();
  assert.equal(bad.status, 'failed');
  assert.equal(bad.httpStatus, 400);
  assert.equal(queue.find(1).attempts, 1);
  assert.equal(flaky.status, 'failed');
  assert.equal(queue.find(2).attempts, 3);
});

test('waitFor returns null when nothing finishes in time', async () => {
  const runner = createRunner(createFakeQueue([]));
  assert.equal(await runner.waitFor(99, 20), null);
});

test('stop waits for the message being sent', async () => {
  const queue = createFakeQueue([{ id: 1, session_id: 's1' }]);
  const runner = createRunner(queue, {
    sendItem: async () => {
      await sleep(50);
      return 'MSG';
    }
  });
  runner.start();
  await waitUntil(() => queue.find(1).status === 'processing');
  await runner.stop();
  assert.equal(queue.find(1).status, 'sent');
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/services/queueRunner.js`
```js
import { EventEmitter } from 'node:events';

/**
 * Sends queued messages: at most one message in flight per session, a randomised gap between
 * consecutive sends of the same session, sessions processed in parallel. Transient errors are retried.
 */
export function createQueueRunner({
  queue,
  getReadySessionIds,
  sendItem,
  sendIntervalMinMs,
  sendIntervalMaxMs,
  pollMs = 1000,
  maxAttempts = 3,
  retryDelayMs = 30000,
  maxAgeMs = 0,
  onResult = null,
  now = Date.now,
  random = Math.random,
  logger = null
}) {
  const results = new EventEmitter();
  results.setMaxListeners(0);
  const inFlight = new Map();
  const nextAllowedAt = new Map();
  let timer = null;
  let running = false;
  let ticking = false;
  let lastExpiryCheck = 0;

  const gap = () => Math.round(sendIntervalMinMs + random() * (sendIntervalMaxMs - sendIntervalMinMs));

  function notify(id, result) {
    results.emit(`done:${id}`, { id, ...result });
  }

  function finish(item, result) {
    notify(item.id, result);
    try {
      onResult?.({ id: item.id, sessionId: item.session_id, to: item.target_jid, ...result });
    } catch (error) {
      logger?.error({ err: error }, 'Queue result callback failed');
    }
  }

  async function handleFailure(item, error) {
    // AppError 4xx means bad input (invalid media URL, unsupported type): retrying cannot help
    const retryable = !(error.status >= 400 && error.status < 500);
    if (retryable && item.attempts < maxAttempts) {
      await queue.requeue(item.id, error.message, retryDelayMs * item.attempts);
      logger?.warn({ queueId: item.id, sessionId: item.session_id, attempt: item.attempts, err: error.message }, 'Send failed, message requeued');
      return;
    }
    await queue.markFailed(item.id, error.message);
    logger?.warn({ queueId: item.id, sessionId: item.session_id, err: error.message }, 'Message failed');
    finish(item, { status: 'failed', error: error.message, httpStatus: error.status ?? null });
  }

  async function processItem(item) {
    let messageId;
    try {
      messageId = await sendItem(item);
    } catch (error) {
      await handleFailure(item, error);
      return;
    }
    try {
      await queue.markSent(item.id, messageId);
    } catch (error) {
      // The message is out: never retry it. The row stays "processing" and is failed on restart.
      logger?.error({ queueId: item.id, err: error }, 'Message sent but its queue status could not be updated');
    }
    finish(item, { status: 'sent', messageId });
  }

  async function runSession(sessionId) {
    const item = await queue.claimNext(sessionId);
    if (!item) return false;
    await processItem(item);
    return true;
  }

  async function expireStale() {
    if (!maxAgeMs || now() - lastExpiryCheck < 60000) return;
    lastExpiryCheck = now();
    for (const row of await queue.expireStale(maxAgeMs)) {
      finish(row, { status: 'expired' });
    }
  }

  async function tick() {
    if (!running || ticking) return;
    ticking = true;
    try {
      await expireStale();
      const ready = new Set(getReadySessionIds());
      const due = (await queue.dueSessionIds()).filter((sessionId) => ready.has(sessionId));
      for (const sessionId of due) {
        if (inFlight.has(sessionId) || (nextAllowedAt.get(sessionId) ?? 0) > now()) continue;
        const work = runSession(sessionId)
          .catch((error) => {
            logger?.error({ sessionId, err: error }, 'Queue processing failed');
            return false;
          })
          .then((processed) => {
            if (processed) nextAllowedAt.set(sessionId, now() + gap());
            inFlight.delete(sessionId);
          });
        inFlight.set(sessionId, work);
      }
    } catch (error) {
      logger?.error({ err: error }, 'Queue tick failed');
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setInterval(tick, pollMs);
      setImmediate(tick);
    },
    /** Runs a tick now (e.g. right after enqueueing) instead of waiting for the next poll. */
    wake() {
      if (running) setImmediate(tick);
    },
    /** Stops polling and waits for in-flight sends to finish. */
    async stop() {
      running = false;
      clearInterval(timer);
      await Promise.allSettled([...inFlight.values()]);
    },
    /** Resolves with the final result of a queue item, or null after `timeoutMs`. */
    waitFor(id, timeoutMs) {
      return new Promise((resolve) => {
        const onDone = (result) => {
          clearTimeout(timeout);
          resolve(result);
        };
        const timeout = setTimeout(() => {
          results.off(`done:${id}`, onDone);
          resolve(null);
        }, timeoutMs);
        results.once(`done:${id}`, onDone);
      });
    },
    notify
  };
}
```
- [ ] **Step 4: Run** → PASS. **Commit** `feat(queue): per-session queue runner with pacing and retries`.

---

### Task 7: Kirim lewat antrian + ack + API antrian

**Files:**
- Create: `src/services/messageService.js`, `src/controllers/queueController.js`, `src/routes/queueRoutes.js`
- Modify: `src/services/sessionManager.js`, `src/controllers/messageController.js`, `src/routes/index.js`, `src/index.js`

- [ ] **Step 1: `sessionManager.js`**

  **a. Import & logger.** Tambahkan:
  ```js
  import { logger } from '../utils/logger.js';
  import { outboundQueue } from './outboundQueue.js';
  import { ackToStatus, allowedPreviousStatuses, describeAckError } from './messageStatus.js';
  ```
  Hapus `normalizeTarget` dari import `phone.js`. Ganti `const logger = pino(...)` dengan:
  ```js
  // Application events, and Baileys internals (quiet by default, BAILEYS_LOG_LEVEL)
  const log = logger.child({ module: 'session' });
  const baileysLogger = logger.child({ module: 'baileys' }, { level: config.baileysLogLevel });
  ```
  Setelah itu:
  - pakai `baileysLogger` di `makeWASocket`, `makeCacheableSignalKeyStore`, dan `downloadMediaMessage`;
  - ganti setiap `console.*` dengan `log.*({ sessionId, ... }, 'pesan')`;
  - hapus import `pino`.

  **b. Hapus pengiriman langsung.** Hapus `getConnectedSession`, `resolveMediaInput`, `sendTextMessage`, `sendImageMessage`, dan `sendAttachmentMessage`, lalu tambahkan:
  ```js
  export function isSessionConnected(sessionId) {
    const session = activeSessions.get(sessionId);
    return Boolean(session && !session.stopped && session.status === 'connected');
  }

  export function getConnectedSessionIds() {
    return [...activeSessions.values()]
      .filter((session) => !session.stopped && session.status === 'connected')
      .map((session) => session.sessionId);
  }

  async function loadQueuedMedia(item) {
    if (item.media_data) {
      return { buffer: item.media_data, contentType: item.payload.mimetype || null };
    }
    return fetchRemoteFile(item.payload.url, { allowPrivate: config.allowPrivateUrls, maxBytes: config.mediaMaxBytes });
  }

  /**
   * Sends one claimed queue item (called by the queue runner) and returns the WhatsApp message id.
   * Throws AppError 503 when the session is not connected (retryable) and 4xx for bad input.
   */
  export async function deliverQueuedMessage(item) {
    const session = activeSessions.get(item.session_id);
    if (!session || session.stopped || session.status !== 'connected') {
      throw new AppError(503, `Session "${item.session_id}" is not connected.`);
    }

    const { payload } = item;
    let content;
    let historyContent;
    switch (item.message_type) {
      case 'text':
        content = { text: payload.text };
        historyContent = payload.text;
        break;
      case 'image': {
        const media = await loadQueuedMedia(item);
        content = { image: media.buffer, caption: payload.caption || '' };
        historyContent = payload.caption || '';
        break;
      }
      case 'document': {
        const media = await loadQueuedMedia(item);
        content = {
          document: media.buffer,
          fileName: payload.fileName || 'file',
          mimetype: payload.mimetype || media.contentType || 'application/octet-stream',
          caption: payload.caption || ''
        };
        historyContent = payload.caption || payload.fileName || 'file';
        break;
      }
      default:
        throw new AppError(400, `Unsupported message type "${item.message_type}".`);
    }

    const result = await sendWithHumanSimulation(session.sock, item.target_jid, content, payload.delayMs);
    await saveOutgoingMessage(session, item.target_jid, result, {
      messageType: item.message_type,
      content: historyContent,
      mediaUrl: payload.url || null
    });
    return result.key.id;
  }

  /**
   * Closes every socket without logging out (graceful shutdown). Stored statuses are kept, so the
   * sessions are restored on the next start.
   */
  export function shutdownSessions() {
    for (const session of activeSessions.values()) teardownSocket(session);
    activeSessions.clear();
  }
  ```

  **c. Ack.** Tambahkan fungsi berikut, plus listener-nya di `startSession` (setelah `messages.upsert`):
  ```js
  /**
   * Applies a delivery receipt for one of our messages (forward-only) and emits `message.status`.
   */
  async function handleAck(sessionData, key, update) {
    const status = ackToStatus(update.status);
    const allowedPrevious = status ? allowedPreviousStatuses(status) : [];
    if (!allowedPrevious.length) return;

    const { sessionId } = sessionData;
    const error = status === 'failed' ? describeAckError(update.messageStubParameters?.[0]) : null;
    const [historyRes, queueItem] = await Promise.all([
      query(
        `UPDATE messages SET status = $3, updated_at = NOW()
         WHERE session_id = $1 AND message_id = $2 AND status = ANY($4::text[])`,
        [sessionId, key.id, status, allowedPrevious]
      ),
      outboundQueue.applyAck(sessionId, key.id, status, allowedPrevious, error)
    ]);
    if (!historyRes.rowCount && !queueItem) return;

    if (error) {
      log.warn({ sessionId, messageId: key.id, error }, 'WhatsApp rejected a sent message');
    }
    sendWebhookEvent(sessionId, 'message.status', {
      messageId: key.id,
      queueId: queueItem ? Number(queueItem.id) : null,
      remoteJid: key.remoteJid,
      status,
      error,
      timestamp: new Date().toISOString()
    });
  }
  ```
  ```js
    // Delivery receipts for messages we sent (server ack, delivered, read, played, error)
    on('messages.update', async (updates) => {
      for (const { key, update } of updates) {
        if (!key?.fromMe || update?.status === undefined || update?.status === null) continue;
        try {
          await handleAck(sessionData, key, update);
        } catch (err) {
          log.error({ sessionId, messageId: key.id, err }, 'Failed to apply message status update');
        }
      }
    });
  ```

- [ ] **Step 2: `src/services/messageService.js`**
```js
import { config } from '../config/index.js';
import { query } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import { normalizeTarget } from '../utils/phone.js';
import { assertSafeUrl } from '../utils/netGuard.js';
import { outboundQueue } from './outboundQueue.js';
import { createQueueRunner } from './queueRunner.js';
import { sendWebhookEvent } from './webhookService.js';
import { deliverQueuedMessage, getConnectedSessionIds, isSessionConnected } from './sessionManager.js';

export const queueRunner = createQueueRunner({
  queue: outboundQueue,
  getReadySessionIds: getConnectedSessionIds,
  sendItem: deliverQueuedMessage,
  sendIntervalMinMs: config.queue.sendIntervalMinMs,
  sendIntervalMaxMs: config.queue.sendIntervalMaxMs,
  pollMs: config.queue.pollMs,
  maxAttempts: config.queue.maxAttempts,
  retryDelayMs: config.queue.retryDelayMs,
  maxAgeMs: config.queue.maxAgeMs,
  // sent / failed / expired; delivered and read follow from WhatsApp receipts
  onResult: ({ id, sessionId, to, status, messageId = null, error = null }) => {
    sendWebhookEvent(sessionId, 'message.status', {
      messageId,
      queueId: Number(id),
      remoteJid: to,
      status,
      error,
      timestamp: new Date().toISOString()
    });
  },
  logger: logger.child({ module: 'queue' })
});

export function formatQueueItem(row) {
  return {
    queueId: Number(row.id),
    sessionId: row.session_id,
    to: row.target_jid,
    type: row.message_type,
    content: row.payload,
    status: row.status,
    scheduledAt: row.scheduled_at,
    attempts: row.attempts,
    messageId: row.message_id,
    error: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    sentAt: row.sent_at
  };
}

/**
 * Remote URLs are stored and downloaded at send time; uploads and base64 data URLs are stored as bytes.
 */
function prepareMedia(input, label) {
  if (Buffer.isBuffer(input)) {
    return { mediaData: input, url: null, contentType: null };
  }
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    assertSafeUrl(input, { allowPrivate: config.allowPrivateUrls, label: `${label} URL` });
    return { mediaData: null, url: input, contentType: null };
  }
  if (typeof input === 'string' && input.startsWith('data:')) {
    const commaIndex = input.indexOf(',');
    const meta = commaIndex === -1 ? '' : input.slice(5, commaIndex);
    if (!meta.endsWith(';base64')) {
      throw new AppError(400, `Invalid ${label}: data URLs must be base64 encoded.`);
    }
    return {
      mediaData: Buffer.from(input.slice(commaIndex + 1), 'base64'),
      url: null,
      contentType: meta.slice(0, -';base64'.length) || null
    };
  }
  throw new AppError(400, `Invalid ${label}: expected an http(s) URL, a base64 data URL, or a file upload.`);
}

/**
 * Validates and queues an outgoing message. With `wait`, resolves once it was sent or failed,
 * or after SEND_WAIT_TIMEOUT_MS while it is still queued.
 */
export async function submitMessage({
  sessionId,
  to,
  countryCode,
  type,
  content,
  media = null,
  delayMs,
  scheduleAt = null,
  idempotencyKey = null,
  connectOnly = true,
  wait = true
}) {
  const targetJid = normalizeTarget(to, countryCode ?? config.defaultCountryCode);
  const sessionRes = await query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);
  if (!sessionRes.rowCount) {
    throw new AppError(404, `Session "${sessionId}" not found.`);
  }
  if (connectOnly && !scheduleAt && !isSessionConnected(sessionId)) {
    throw new AppError(409, `Session "${sessionId}" is not connected. Send with connectOnly=false to queue the message until it connects.`);
  }

  const payload = { ...content, ...(delayMs !== undefined ? { delayMs } : {}) };
  let mediaData = null;
  if (media) {
    const prepared = prepareMedia(media.input, type);
    if (prepared.mediaData && prepared.mediaData.length > config.mediaMaxBytes) {
      throw new AppError(413, `Media is larger than MEDIA_MAX_BYTES (${config.mediaMaxBytes} bytes).`);
    }
    mediaData = prepared.mediaData;
    if (prepared.url) payload.url = prepared.url;
    if (!payload.mimetype && prepared.contentType) payload.mimetype = prepared.contentType;
  }

  const { item, created } = await outboundQueue.enqueue({
    sessionId,
    idempotencyKey,
    targetJid,
    messageType: type,
    payload,
    mediaData,
    scheduledAt: scheduleAt
  });
  if (!created) {
    return { item, result: null, duplicate: true };
  }

  // Waiting only makes sense when the message can go out now
  const sendable = !scheduleAt && isSessionConnected(sessionId);
  const pending = wait && sendable ? queueRunner.waitFor(item.id, config.queue.sendWaitTimeoutMs) : null;
  queueRunner.wake();
  return { item, result: pending ? await pending : null, duplicate: false };
}

export async function getQueuedMessage(id) {
  const item = await outboundQueue.get(id);
  if (!item) throw new AppError(404, `Queued message ${id} not found.`);
  return item;
}

export function listQueuedMessages(filters) {
  return outboundQueue.list(filters);
}

export async function cancelQueuedMessage(id) {
  const item = await outboundQueue.cancel(id);
  if (!item) {
    const existing = await getQueuedMessage(id);
    throw new AppError(409, `Only queued messages can be cancelled (current status: ${existing.status}).`);
  }
  queueRunner.notify(id, { status: 'cancelled' });
  return item;
}

export async function rescheduleQueuedMessage(id, scheduleAt) {
  const item = await outboundQueue.reschedule(id, scheduleAt);
  if (!item) {
    const existing = await getQueuedMessage(id);
    throw new AppError(409, `Only queued messages can be rescheduled (current status: ${existing.status}).`);
  }
  queueRunner.wake();
  return item;
}
```

- [ ] **Step 3: `messageController.js`**
  - Ganti import `sendTextMessage`, `sendImageMessage`, `sendAttachmentMessage` dengan `import { formatQueueItem, submitMessage } from '../services/messageService.js';`.
  - Import `parseOptionalBool`, `parseScheduleAt`, `parseIdempotencyKey`.
  - Ganti `parseSendOptions` dengan:
  ```js
  function parseQueueOptions(req) {
    const { body } = req;
    return {
      delayMs: parseOptionalInt(body.delayMs, { name: 'delayMs', min: 0, max: config.antiBan.maxRequestDelayMs }),
      countryCode: body.countryCode === undefined || body.countryCode === '' ? undefined : String(body.countryCode),
      scheduleAt: parseScheduleAt(body.scheduleAt),
      idempotencyKey: parseIdempotencyKey(body.idempotencyKey ?? req.get('idempotency-key')),
      connectOnly: parseOptionalBool(body.connectOnly, { name: 'connectOnly', defaultValue: true }),
      wait: !parseOptionalBool(body.async, { name: 'async', defaultValue: false })
    };
  }

  /**
   * 200 when the message was sent within SEND_WAIT_TIMEOUT_MS; 202 while it is queued or scheduled;
   * the failure status (4xx for bad input, 502 otherwise) when sending failed.
   */
  function respondToSubmission(res, { item, result, duplicate }, extra = {}) {
    const queued = formatQueueItem(item);
    if (duplicate) {
      return res.status(200).json({ success: true, duplicate: true, ...queued });
    }
    if (result?.status === 'sent') {
      return res.status(200).json({ success: true, messageId: result.messageId, remoteJid: queued.to, status: 'sent', queueId: queued.queueId, ...extra });
    }
    if (result?.status === 'failed') {
      const status = result.httpStatus >= 400 && result.httpStatus < 500 ? result.httpStatus : 502;
      return res.status(status).json({ success: false, status: 'failed', error: result.error, queueId: queued.queueId });
    }
    return res.status(202).json({
      success: true,
      status: result?.status ?? queued.status,
      queueId: queued.queueId,
      remoteJid: queued.to,
      scheduledAt: queued.scheduledAt,
      message: 'Message accepted. Track it with GET /api/queue/:queueId or the message.status webhook.'
    });
  }
  ```
  - `sendText`:
    ```js
    const submission = await submitMessage({ sessionId, to, type: 'text', content: { text }, ...parseQueueOptions(req) });
    return respondToSubmission(res, submission);
    ```
  - `sendImage`:
    ```js
    submitMessage({ sessionId, to, type: 'image', content: { caption: caption || '' }, media: { input: imageInput }, ...parseQueueOptions(req) })
    ```
  - `sendAttachment`:
    ```js
    const resolvedFileName = fileName || req.file?.originalname || 'file';
    const resolvedMimetype = mimetype || req.file?.mimetype || null;
    const submission = await submitMessage({
      sessionId,
      to,
      type: 'document',
      content: { fileName: resolvedFileName, caption: caption || '', ...(resolvedMimetype ? { mimetype: resolvedMimetype } : {}) },
      media: { input: docInput },
      ...parseQueueOptions(req)
    });
    return respondToSubmission(res, submission, { fileName: resolvedFileName });
    ```

- [ ] **Step 4: `src/controllers/queueController.js`**
```js
import {
  cancelQueuedMessage,
  formatQueueItem,
  getQueuedMessage,
  listQueuedMessages,
  rescheduleQueuedMessage
} from '../services/messageService.js';
import { QUEUE_STATUSES } from '../services/messageStatus.js';
import { AppError, sendError } from '../utils/errors.js';
import { assertSessionId, parseOptionalInt, parseScheduleAt } from '../utils/validation.js';

function parseQueueId(value) {
  return parseOptionalInt(value, { name: 'queueId', min: 1, max: Number.MAX_SAFE_INTEGER });
}

export async function getQueueItem(req, res) {
  try {
    const item = await getQueuedMessage(parseQueueId(req.params.queueId));
    return res.status(200).json({ success: true, item: formatQueueItem(item) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}

export async function listQueue(req, res) {
  try {
    const { sessionId, status } = req.query;
    if (sessionId) assertSessionId(sessionId);
    if (status && !QUEUE_STATUSES.includes(status)) {
      throw new AppError(400, `status must be one of: ${QUEUE_STATUSES.join(', ')}.`);
    }
    const items = await listQueuedMessages({
      sessionId: sessionId || null,
      status: status || null,
      limit: parseOptionalInt(req.query.limit, { name: 'limit', min: 1, max: 200, defaultValue: 50 }),
      offset: parseOptionalInt(req.query.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 })
    });
    return res.status(200).json({ success: true, count: items.length, items: items.map(formatQueueItem) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}

export async function cancelQueueItem(req, res) {
  try {
    const item = await cancelQueuedMessage(parseQueueId(req.params.queueId));
    return res.status(200).json({ success: true, item: formatQueueItem(item) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}

export async function rescheduleQueueItem(req, res) {
  try {
    const item = await rescheduleQueuedMessage(parseQueueId(req.params.queueId), parseScheduleAt(req.body.scheduleAt));
    return res.status(200).json({ success: true, item: formatQueueItem(item) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}
```

`src/routes/queueRoutes.js`:
```js
import express from 'express';
import { cancelQueueItem, getQueueItem, listQueue, rescheduleQueueItem } from '../controllers/queueController.js';

const router = express.Router();

router.get('/', listQueue);
router.get('/:queueId', getQueueItem);
router.delete('/:queueId', cancelQueueItem);
router.patch('/:queueId', rescheduleQueueItem);

export default router;
```
Di `src/routes/index.js`: `router.use('/queue', apiKeyAuth, queueRoutes);`.

Di `src/index.js` (`startServer`, setelah `initDatabase()` dan sebelum `restoreSessions()`):
```js
    const interrupted = await outboundQueue.recoverInterrupted();
    if (interrupted) {
      logger.warn({ count: interrupted }, 'Marked messages interrupted by the previous shutdown as failed');
    }
```
dan setelah `restoreSessions()`: `queueRunner.start();`.

- [ ] **Step 5: Cek** — `node --check` semua file yang diubah dan `npm test` → PASS. **Commit** `feat: send through the queue, delivery receipts, queue API`.

---

### Task 8: Webhook v2

**Files:**
- Create: `src/services/webhookSigner.js`, `src/services/webhookConfigResolver.js`, `src/services/webhookOutbox.js`, `src/services/webhookDispatcher.js`
- Delete: `src/services/webhookUrlResolver.js`, `test/webhookUrlResolver.test.js`
- Modify: `src/services/webhookService.js`, `src/services/sessionManager.js`, `src/controllers/sessionController.js`, `src/routes/sessionRoutes.js`, `src/index.js`
- Test: `test/webhookSigner.test.js`, `test/webhookConfigResolver.test.js`, `test/webhookDispatcher.test.js`, `test/webhookOutbox.test.js`

- [ ] **Step 1: Test** — `test/webhookSigner.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signWebhook, verifyWebhookSignature } from '../src/services/webhookSigner.js';

const SECRET = 'secret-0123456789abcdef';

test('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update('1790899200.{"a":1}').digest('hex');
  assert.equal(signWebhook(SECRET, 1790899200, '{"a":1}'), expected);
});

test('verifyWebhookSignature rejects tampered bodies, timestamps and missing signatures', () => {
  const signature = signWebhook(SECRET, 1790899200, '{"a":1}');
  assert.equal(verifyWebhookSignature(SECRET, '1790899200', '{"a":1}', signature), true);
  assert.equal(verifyWebhookSignature(SECRET, 1790899200, '{"a":2}', signature), false);
  assert.equal(verifyWebhookSignature(SECRET, 1790899201, '{"a":1}', signature), false);
  assert.equal(verifyWebhookSignature(SECRET, 1790899200, '{"a":1}', undefined), false);
});
```
`test/webhookConfigResolver.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookConfigResolver } from '../src/services/webhookConfigResolver.js';

function fakeQuery(rows) {
  const calls = [];
  const query = async (sql, [sessionId]) => {
    calls.push(sessionId);
    return { rows: rows[sessionId] ? [rows[sessionId]] : [] };
  };
  return { query, calls };
}

const GLOBALS = { globalWebhookUrl: 'https://global.example.com', globalSecret: 'global-secret-123456' };

test('returns the session webhook settings and caches them', async () => {
  const { query, calls } = fakeQuery({
    s1: { webhook_url: 'https://hooks.example.com/s1', webhook_secret: 'session-secret-123456', webhook_events: ['message.received'] }
  });
  const resolver = createWebhookConfigResolver({ query, ...GLOBALS });
  assert.deepEqual(await resolver.resolve('s1'), {
    url: 'https://hooks.example.com/s1',
    secret: 'session-secret-123456',
    events: ['message.received']
  });
  await resolver.resolve('s1');
  assert.deepEqual(calls, ['s1']);
});

test('uses the global URL with the global secret when the session has no URL', async () => {
  const { query } = fakeQuery({ s1: { webhook_url: null, webhook_secret: 'session-secret-123456', webhook_events: null } });
  const resolver = createWebhookConfigResolver({ query, ...GLOBALS });
  const expected = { url: 'https://global.example.com', secret: 'global-secret-123456', events: null };
  assert.deepEqual(await resolver.resolve('s1'), expected);
  assert.deepEqual(await resolver.resolve('missing'), expected);
});

test('invalidate makes a changed configuration visible immediately', async () => {
  const rows = { s1: { webhook_url: 'https://old.example.com', webhook_secret: null, webhook_events: null } };
  const { query } = fakeQuery(rows);
  const resolver = createWebhookConfigResolver({ query });
  assert.equal((await resolver.resolve('s1')).url, 'https://old.example.com');
  rows.s1 = { ...rows.s1, webhook_url: 'https://new.example.com' };
  assert.equal((await resolver.resolve('s1')).url, 'https://old.example.com');
  resolver.invalidate('s1');
  assert.equal((await resolver.resolve('s1')).url, 'https://new.example.com');
});

test('cached entries expire after the TTL', async () => {
  let time = 0;
  const { query, calls } = fakeQuery({ s1: { webhook_url: 'https://hooks.example.com', webhook_secret: null, webhook_events: null } });
  const resolver = createWebhookConfigResolver({ query, ttlMs: 1000, now: () => time });
  await resolver.resolve('s1');
  time = 1000;
  await resolver.resolve('s1');
  assert.deepEqual(calls, ['s1', 's1']);
});
```
`test/webhookDispatcher.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebhookDispatcher, createWebhookPoster } from '../src/services/webhookDispatcher.js';
import { verifyWebhookSignature } from '../src/services/webhookSigner.js';

const SECRET = 'dispatcher-secret-0123456789';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

async function startReceiver(t, statuses) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      res.statusCode = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/hook`, requests };
}

function createFakeOutbox(rows) {
  const state = rows.map((row) => ({ status: 'pending', attempts: 0, dueAt: 0, ...row }));
  const find = (id) => state.find((row) => row.id === id);
  return {
    find,
    async claimDue(limit, leaseMs) {
      const due = state.filter((row) => row.status === 'pending' && row.dueAt <= Date.now()).slice(0, limit);
      for (const row of due) {
        row.attempts += 1;
        row.dueAt = Date.now() + leaseMs;
      }
      return due.map((row) => ({ ...row }));
    },
    async markDelivered(id, info) { Object.assign(find(id), { status: 'delivered', ...info }); },
    async markRetry(id, info) { Object.assign(find(id), info, { dueAt: Date.now() + info.delayMs }); },
    async markFailed(id, info) { Object.assign(find(id), { status: 'failed', ...info }); },
    async purge() { return 0; }
  };
}

const delivery = (id) => ({
  id,
  session_id: 's1',
  event_type: 'message.received',
  payload: { event: 'message.received', sessionId: 's1', data: { id } }
});

function createDispatcher(outbox, url, overrides = {}) {
  return createWebhookDispatcher({
    outbox,
    resolveTarget: async () => ({ url, secret: SECRET, events: null }),
    post: createWebhookPoster({ allowPrivate: true }),
    maxAttempts: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 10,
    timeoutMs: 2000,
    pollMs: 5,
    ...overrides
  });
}

test('delivers events with a verifiable signature and delivery headers', async (t) => {
  const receiver = await startReceiver(t, [200]);
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, receiver.url);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'delivered');
  await dispatcher.stop();

  const [request] = receiver.requests;
  assert.deepEqual(JSON.parse(request.body), delivery(1).payload);
  assert.equal(request.headers['x-webhook-id'], '1');
  assert.equal(request.headers['x-webhook-event'], 'message.received');
  assert.equal(request.headers['x-webhook-attempt'], '1');
  assert.equal(
    verifyWebhookSignature(SECRET, request.headers['x-webhook-timestamp'], request.body, request.headers['x-webhook-signature']),
    true
  );
});

test('retries server errors until delivered', async (t) => {
  const receiver = await startReceiver(t, [500, 503, 200]);
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, receiver.url);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'delivered');
  await dispatcher.stop();
  assert.equal(receiver.requests.length, 3);
  assert.equal(outbox.find(1).attempts, 3);
});

test('does not retry client errors other than 408 and 429', async (t) => {
  const receiver = await startReceiver(t, [404]);
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, receiver.url);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'failed');
  await dispatcher.stop();
  assert.equal(receiver.requests.length, 1);
  assert.equal(outbox.find(1).statusCode, 404);
});

test('gives up after maxAttempts when the receiver is unreachable', async () => {
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, 'http://127.0.0.1:9/hook');
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'failed');
  await dispatcher.stop();
  assert.equal(outbox.find(1).attempts, 3);
});

test('fails deliveries when no webhook URL is configured anymore', async () => {
  const outbox = createFakeOutbox([delivery(1)]);
  const dispatcher = createDispatcher(outbox, null);
  dispatcher.start();
  await waitUntil(() => outbox.find(1).status === 'failed');
  await dispatcher.stop();
  assert.match(outbox.find(1).error, /No webhook URL/);
});
```
`test/webhookOutbox.test.js`
```js
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookOutbox } from '../src/services/webhookOutbox.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

let database;
let outbox;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  outbox = createWebhookOutbox(database.db);
  await database.pool.query(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`);
});

after(async () => {
  if (database) await database.drop();
});

beforeEach(async () => {
  if (database) await database.pool.query('DELETE FROM webhook_deliveries');
});

const event = (sessionId = 's1') => ({ sessionId, eventType: 'message.received', payload: { event: 'message.received', data: { n: 1 } } });

test('claimDue leases due deliveries so they are not handed out twice', { skip }, async () => {
  await outbox.enqueue(event());
  await outbox.enqueue(event());
  const claimed = await outbox.claimDue(10, 60000);
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((row) => row.attempts), [1, 1]);
  assert.deepEqual(claimed[0].payload, event().payload);
  assert.deepEqual(await outbox.claimDue(10, 60000), []);
});

test('markRetry reschedules; markDelivered and markFailed finalize', { skip }, async () => {
  const first = await outbox.enqueue(event());
  const second = await outbox.enqueue(event());
  await outbox.claimDue(10, 60000);
  await outbox.markRetry(first, { url: 'https://h.example.com', statusCode: 500, error: 'HTTP 500', delayMs: 0 });
  const retried = await outbox.claimDue(10, 60000);
  assert.deepEqual(retried.map((row) => [row.id, row.attempts]), [[first, 2]]);

  await outbox.markDelivered(first, { url: 'https://h.example.com', statusCode: 200 });
  await outbox.markFailed(second, { url: 'https://h.example.com', statusCode: 404, error: 'HTTP 404' });
  const rows = await outbox.list({ sessionId: 's1' });
  assert.deepEqual(rows.map((row) => [row.id, row.status, row.last_status_code]), [[second, 'failed', 404], [first, 'delivered', 200]]);
});

test('retry re-queues a failed delivery of the same session only', { skip }, async () => {
  const id = await outbox.enqueue(event());
  await outbox.claimDue(10, 60000);
  await outbox.markFailed(id, { url: null, statusCode: null, error: 'boom' });
  assert.equal(await outbox.retry(id, 's2'), null);
  assert.ok(await outbox.retry(id, 's1'));
  const [row] = await outbox.list({ sessionId: 's1', status: 'pending' });
  assert.equal(row.attempts, 0);
});

test('purge removes old delivered and failed deliveries', { skip }, async () => {
  const oldDelivered = await outbox.enqueue(event());
  const oldFailed = await outbox.enqueue(event());
  const recent = await outbox.enqueue(event());
  await database.pool.query(`UPDATE webhook_deliveries SET status = 'delivered', created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [oldDelivered]);
  await database.pool.query(`UPDATE webhook_deliveries SET status = 'failed', created_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [oldFailed]);
  assert.equal(await outbox.purge({ deliveredDays: 7, failedDays: 30 }), 2);
  assert.deepEqual((await outbox.list({ sessionId: 's1' })).map((row) => row.id), [recent]);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/services/webhookSigner.js`
```js
import crypto from 'node:crypto';

/**
 * Signature sent as `X-Webhook-Signature`: HMAC-SHA256 over "<timestamp>.<raw body>". Receivers should
 * recompute it from the raw body and reject old timestamps (replay protection).
 */
export function signWebhook(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyWebhookSignature(secret, timestamp, body, signature) {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const provided = Buffer.from(signature);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}
```
`src/services/webhookConfigResolver.js`
```js
import { createTtlCache } from '../utils/ttlCache.js';

/**
 * Resolves where and how a session's webhook events are delivered (URL, signing secret, event filter)
 * behind a short cache, so changes made through the API apply without restarting the session.
 * The session secret only signs requests to the session URL; the global URL uses the global secret.
 */
export function createWebhookConfigResolver({ query, globalWebhookUrl = '', globalSecret = '', ttlMs = 30000, now = Date.now }) {
  const cache = createTtlCache({ ttlMs, now });
  return {
    async resolve(sessionId) {
      let entry = cache.get(sessionId);
      if (!entry) {
        const res = await query('SELECT webhook_url, webhook_secret, webhook_events FROM sessions WHERE id = $1', [sessionId]);
        const row = res.rows[0];
        entry = { url: row?.webhook_url || null, secret: row?.webhook_secret || null, events: row?.webhook_events || null };
        cache.set(sessionId, entry);
      }
      return {
        url: entry.url || globalWebhookUrl || null,
        secret: (entry.url ? entry.secret : null) || globalSecret || null,
        events: entry.events
      };
    },
    invalidate(sessionId) {
      cache.del(sessionId);
    }
  };
}
```
`src/services/webhookOutbox.js`
```js
import { db as defaultDb } from '../database/db.js';

/**
 * Postgres outbox for webhook events. Rows move pending -> delivered, or pending -> failed after
 * the last attempt (retryable through the API).
 */
export function createWebhookOutbox(db = defaultDb) {
  return {
    async enqueue({ sessionId, eventType, payload }) {
      const res = await db.query(
        `INSERT INTO webhook_deliveries (session_id, event_type, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [sessionId, eventType, JSON.stringify(payload)]
      );
      return res.rows[0].id;
    },

    /** Claims due deliveries and leases them for `leaseMs`, so a crash mid-delivery only delays a retry. */
    async claimDue(limit, leaseMs) {
      const res = await db.query(
        `UPDATE webhook_deliveries
         SET attempts = attempts + 1, next_attempt_at = NOW() + ($2::double precision * INTERVAL '1 millisecond')
         WHERE id IN (
           SELECT id FROM webhook_deliveries
           WHERE status = 'pending' AND next_attempt_at <= NOW()
           ORDER BY next_attempt_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, session_id, event_type, payload, attempts`,
        [limit, leaseMs]
      );
      return res.rows.sort((a, b) => Number(a.id) - Number(b.id));
    },

    async markDelivered(id, { url, statusCode }) {
      await db.query(
        `UPDATE webhook_deliveries
         SET status = 'delivered', delivered_at = NOW(), last_url = $2, last_status_code = $3, last_error = NULL
         WHERE id = $1`,
        [id, url, statusCode]
      );
    },

    async markRetry(id, { url, statusCode, error, delayMs }) {
      await db.query(
        `UPDATE webhook_deliveries
         SET next_attempt_at = NOW() + ($5::double precision * INTERVAL '1 millisecond'),
             last_url = $2, last_status_code = $3, last_error = $4
         WHERE id = $1`,
        [id, url, statusCode, error, delayMs]
      );
    },

    async markFailed(id, { url, statusCode, error }) {
      await db.query(
        `UPDATE webhook_deliveries SET status = 'failed', last_url = $2, last_status_code = $3, last_error = $4 WHERE id = $1`,
        [id, url, statusCode, error]
      );
    },

    async list({ sessionId, status = null, limit = 50, offset = 0 }) {
      const res = await db.query(
        `SELECT id, event_type, status, attempts, next_attempt_at, last_url, last_status_code, last_error,
                created_at, delivered_at, payload
         FROM webhook_deliveries
         WHERE session_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY id DESC LIMIT $3 OFFSET $4`,
        [sessionId, status, limit, offset]
      );
      return res.rows;
    },

    async retry(id, sessionId) {
      const res = await db.query(
        `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL
         WHERE id = $1 AND session_id = $2 AND status = 'failed' RETURNING id`,
        [id, sessionId]
      );
      return res.rows[0] || null;
    },

    /** Retention: drops old delivered/failed deliveries and old rows of the legacy webhook_logs table. */
    async purge({ deliveredDays, failedDays }) {
      const res = await db.query(
        `DELETE FROM webhook_deliveries
         WHERE (status = 'delivered' AND created_at < NOW() - ($1::int * INTERVAL '1 day'))
            OR (status = 'failed' AND created_at < NOW() - ($2::int * INTERVAL '1 day'))`,
        [deliveredDays, failedDays]
      );
      await db.query(`DELETE FROM webhook_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [failedDays]);
      return res.rowCount;
    }
  };
}

export const webhookOutbox = createWebhookOutbox();
```
Ket.: `id` BIGSERIAL dikembalikan `pg` sebagai string. `enqueue` mengembalikan string, dan test membandingkan dengan string dari `list` ✓.

`src/services/webhookDispatcher.js`
```js
import axios from 'axios';
import { backoffDelay } from './reconnectPolicy.js';
import { signWebhook } from './webhookSigner.js';
import { assertSafeUrl, safeRequestOptions } from '../utils/netGuard.js';

// Answers that will not change on retry (bad URL, auth, gone) fail immediately
const isRetryableStatus = (status) => status >= 500 || status === 408 || status === 429;

/**
 * HTTP POST used for webhook deliveries: the raw JSON string is sent byte-for-byte (it is what the
 * signature covers), redirects are not followed and private addresses are blocked unless allowed.
 */
export function createWebhookPoster({ allowPrivate }) {
  return async (url, body, { headers, timeoutMs }) => {
    assertSafeUrl(url, { allowPrivate, label: 'Webhook URL' });
    const response = await axios.post(url, body, {
      headers,
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: () => true,
      transformRequest: [(data) => data],
      ...safeRequestOptions({ allowPrivate })
    });
    return { status: response.status };
  };
}

/**
 * Delivers outbox rows with retries (exponential backoff with jitter), at-least-once.
 * Receivers should dedupe on X-Webhook-Id; events of one session may arrive out of order.
 */
export function createWebhookDispatcher({
  outbox,
  resolveTarget,
  post,
  maxAttempts,
  retryBaseDelayMs,
  retryMaxDelayMs,
  timeoutMs,
  batchSize = 20,
  pollMs = 2000,
  leaseMs = 5 * 60 * 1000,
  retention = null,
  now = Date.now,
  random = Math.random,
  logger = null
}) {
  const inFlight = new Set();
  let timer = null;
  let running = false;
  let ticking = false;
  let lastPurge = 0;

  async function fail(row, { url, statusCode, error, retryable }) {
    if (retryable && row.attempts < maxAttempts) {
      const delayMs = backoffDelay(row.attempts - 1, { baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs, random });
      await outbox.markRetry(row.id, { url, statusCode, error, delayMs });
      return;
    }
    await outbox.markFailed(row.id, { url, statusCode, error });
    logger?.warn({ deliveryId: row.id, sessionId: row.session_id, event: row.event_type, statusCode, error }, 'Webhook delivery failed permanently');
  }

  async function deliver(row) {
    let url = null;
    try {
      const target = await resolveTarget(row.session_id);
      url = target.url;
      if (!url) {
        await outbox.markFailed(row.id, { url: null, statusCode: null, error: 'No webhook URL configured.' });
        return;
      }
      const body = JSON.stringify(row.payload);
      const timestamp = Math.floor(now() / 1000);
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-Gateway-Webhook/2.0',
        'X-Webhook-Id': String(row.id),
        'X-Webhook-Event': row.event_type,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Attempt': String(row.attempts)
      };
      if (target.secret) {
        headers['X-Webhook-Signature'] = signWebhook(target.secret, timestamp, body);
      }

      const response = await post(url, body, { headers, timeoutMs });
      if (response.status >= 200 && response.status < 300) {
        await outbox.markDelivered(row.id, { url, statusCode: response.status });
        return;
      }
      await fail(row, { url, statusCode: response.status, error: `Receiver responded with HTTP ${response.status}`, retryable: isRetryableStatus(response.status) });
    } catch (error) {
      await fail(row, { url, statusCode: null, error: error.message, retryable: true }).catch((dbError) => {
        // The lease expires and the delivery is retried later
        logger?.error({ deliveryId: row.id, err: dbError }, 'Could not record webhook delivery failure');
      });
    }
  }

  async function tick() {
    if (!running || ticking) return;
    ticking = true;
    try {
      if (retention && now() - lastPurge >= 60 * 60 * 1000) {
        lastPurge = now();
        const purged = await outbox.purge(retention);
        if (purged) logger?.info({ purged }, 'Purged old webhook deliveries');
      }
      const capacity = batchSize - inFlight.size;
      if (capacity <= 0) return;
      for (const row of await outbox.claimDue(capacity, leaseMs)) {
        const work = deliver(row).finally(() => inFlight.delete(work));
        inFlight.add(work);
      }
    } catch (error) {
      logger?.error({ err: error }, 'Webhook dispatcher tick failed');
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setInterval(tick, pollMs);
      setImmediate(tick);
    },
    wake() {
      if (running) setImmediate(tick);
    },
    async stop() {
      running = false;
      clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    }
  };
}
```
`src/services/webhookService.js`: import, resolver, dan `sendWebhookEvent` diganti. `extractMessageData` tidak berubah.
```js
import { query } from '../database/db.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { createWebhookConfigResolver } from './webhookConfigResolver.js';
import { webhookOutbox } from './webhookOutbox.js';
import { createWebhookDispatcher, createWebhookPoster } from './webhookDispatcher.js';

export const WEBHOOK_EVENTS = ['connection.update', 'message.received', 'message.status', 'account.restriction'];

const log = logger.child({ module: 'webhook' });

const webhookConfigResolver = createWebhookConfigResolver({
  query,
  globalWebhookUrl: config.globalWebhookUrl,
  globalSecret: config.webhook.secret
});

export const webhookDispatcher = createWebhookDispatcher({
  outbox: webhookOutbox,
  resolveTarget: (sessionId) => webhookConfigResolver.resolve(sessionId),
  post: createWebhookPoster({ allowPrivate: config.allowPrivateUrls }),
  maxAttempts: config.webhook.maxAttempts,
  retryBaseDelayMs: config.webhook.retryBaseDelayMs,
  retryMaxDelayMs: config.webhook.retryMaxDelayMs,
  timeoutMs: config.webhook.timeoutMs,
  retention: { deliveredDays: config.webhook.retentionDays, failedDays: config.webhook.failedRetentionDays },
  logger: log
});

/**
 * Drops the cached webhook settings of a session after they changed.
 */
export function invalidateWebhookConfig(sessionId) {
  webhookConfigResolver.invalidate(sessionId);
}
```
```js
/**
 * Stores a webhook event in the outbox; the dispatcher delivers it with retries. Never throws.
 */
export async function sendWebhookEvent(sessionId, eventType, payload) {
  try {
    const target = await webhookConfigResolver.resolve(sessionId);
    if (!target.url || (target.events && !target.events.includes(eventType))) {
      return;
    }
    await webhookOutbox.enqueue({
      sessionId,
      eventType,
      payload: { event: eventType, sessionId, timestamp: new Date().toISOString(), data: payload }
    });
    webhookDispatcher.wake();
  } catch (error) {
    log.error({ sessionId, event: eventType, err: error }, 'Failed to queue webhook event');
  }
}
```
`sessionManager.js`:
- ganti `invalidateWebhookUrl` → `invalidateWebhookConfig`;
- import `WEBHOOK_EVENTS`;
- ganti `setSessionWebhookUrl` dengan:
```js
/**
 * Updates the webhook settings of a session. Absent fields stay unchanged; null or "" clears a value.
 */
export async function setSessionWebhookConfig(sessionId, { webhookUrl, webhookSecret, events }) {
  const assignments = [];
  const params = [sessionId];
  const assign = (column, value) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (webhookUrl !== undefined) {
    const url = webhookUrl ? String(webhookUrl).trim() : null;
    if (url) assertSafeUrl(url, { allowPrivate: config.allowPrivateUrls, label: 'webhookUrl' });
    assign('webhook_url', url);
  }
  if (webhookSecret !== undefined) {
    const secret = webhookSecret ? String(webhookSecret) : null;
    if (secret && secret.length < 16) {
      throw new AppError(400, 'webhookSecret must be at least 16 characters long.');
    }
    assign('webhook_secret', secret);
  }
  if (events !== undefined) {
    if (events !== null && (!Array.isArray(events) || events.some((event) => !WEBHOOK_EVENTS.includes(event)))) {
      throw new AppError(400, `events must be null (all events) or an array of: ${WEBHOOK_EVENTS.join(', ')}.`);
    }
    assign('webhook_events', events);
  }

  const res = await query(
    `UPDATE sessions SET ${[...assignments, 'updated_at = NOW()'].join(', ')} WHERE id = $1
     RETURNING webhook_url, webhook_secret IS NOT NULL AS webhook_secret_set, webhook_events`,
    params
  );
  if (res.rowCount === 0) {
    throw new AppError(404, `Session "${sessionId}" not found.`);
  }
  invalidateWebhookConfig(sessionId);
  const row = res.rows[0];
  return { webhookUrl: row.webhook_url, webhookSecretSet: row.webhook_secret_set, events: row.webhook_events };
}
```
dan tambahkan `webhookSecretSet: Boolean(row.webhook_secret)` serta `webhookEvents: row.webhook_events` ke `getSessionStatus`.

`sessionController.js`:
- `updateWebhook` memanggil `setSessionWebhookConfig(sessionId, { webhookUrl, webhookSecret, events })` (dari `req.body`) dan membalas `{ success, message, ...webhook }`;
- tambahkan:
```js
const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'];

function formatDelivery(row) {
  return {
    deliveryId: Number(row.id),
    event: row.event_type,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.status === 'pending' ? row.next_attempt_at : null,
    lastUrl: row.last_url,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    payload: row.payload
  };
}

export async function listWebhookDeliveries(req, res) {
  try {
    const { sessionId } = req.params;
    const { status } = req.query;
    if (status && !DELIVERY_STATUSES.includes(status)) {
      throw new AppError(400, `status must be one of: ${DELIVERY_STATUSES.join(', ')}.`);
    }
    const deliveries = await webhookOutbox.list({
      sessionId,
      status: status || null,
      limit: parseOptionalInt(req.query.limit, { name: 'limit', min: 1, max: 200, defaultValue: 50 }),
      offset: parseOptionalInt(req.query.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 })
    });
    return res.status(200).json({ success: true, count: deliveries.length, deliveries: deliveries.map(formatDelivery) });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function retryWebhookDelivery(req, res) {
  try {
    const { sessionId } = req.params;
    const deliveryId = parseOptionalInt(req.params.deliveryId, { name: 'deliveryId', min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!(await webhookOutbox.retry(deliveryId, sessionId))) {
      throw new AppError(404, `No failed delivery ${deliveryId} for session "${sessionId}".`);
    }
    webhookDispatcher.wake();
    return res.status(200).json({ success: true, deliveryId, status: 'pending' });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}
```
`sessionRoutes.js` (setelah `router.use(apiKeyAuth)`):
```js
router.get('/:sessionId/webhook-deliveries', listWebhookDeliveries);
router.post('/:sessionId/webhook-deliveries/:deliveryId/retry', retryWebhookDelivery);
```
`src/index.js`: `webhookDispatcher.start();` setelah `queueRunner.start();`.

- [ ] **Step 4: Run** → PASS. **Commit** `feat(webhook): outbox with retries, HMAC signatures and event filters`.

---

### Task 9: Graceful shutdown + Docker

**Files:** Modify `src/index.js`, `Dockerfile`, `docker-compose.yml`

- [ ] **Step 1: `src/index.js`.** Simpan server di `let server = null;` (`server = app.listen(...)`), lalu tambahkan:
```js
let shuttingDown = false;

/**
 * SIGTERM/SIGINT: stop accepting requests, finish the message being sent, close WhatsApp sockets
 * without logging out (they are restored on the next start), flush webhooks, close the DB pool.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    server?.close();
    await queueRunner.stop();
    shutdownSessions();
    await webhookDispatcher.stop();
    server?.closeAllConnections();
    await pool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```
Import: `pool` dari `./database/db.js`, `shutdownSessions` dari `./services/sessionManager.js`, `queueRunner` dari `./services/messageService.js`, `webhookDispatcher` dari `./services/webhookService.js`, `outboundQueue` dari `./services/outboundQueue.js`.

- [ ] **Step 2: `Dockerfile`**
```dockerfile
# Node 20 reached end-of-life in April 2026
FROM node:22-alpine

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Install production dependencies exactly as locked
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code (see .dockerignore)
COPY --chown=node:node . .

# Run as the unprivileged user shipped with the node image
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# node directly (not npm) so SIGTERM reaches the app and triggers the graceful shutdown
CMD ["node", "src/index.js"]
```
- [ ] **Step 3: `docker-compose.yml`** — di service `whatsapp-gateway` tambahkan `stop_grace_period: 30s` dan env baru: `LOG_LEVEL`, `WEBHOOK_SECRET`, `SEND_INTERVAL_MIN_MS`, `SEND_INTERVAL_MAX_MS`, `SEND_WAIT_TIMEOUT_MS`, `QUEUE_MAX_AGE_HOURS`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETENTION_DAYS`.
- [ ] **Step 4: Commit** `feat(ops): graceful shutdown, Node 22 non-root image`.

---

### Task 10: Baileys v7, LID, dan limit akun

**Files:**
- Create: `src/utils/jid.js`, `src/database/migrations/003_lid_columns.sql`, `test/jid.test.js`
- Modify: `package.json`/lockfile, `src/services/sessionManager.js`, `src/services/webhookService.js` (`extractMessageData`), `src/controllers/sessionController.js`, `src/controllers/messageController.js` (`getMessages`), `src/routes/sessionRoutes.js`

- [ ] **Step 1: Upgrade** — `npm install --save-exact @whiskeysockets/baileys@7.0.0-rc14`.

- [ ] **Step 2: Test** — `test/jid.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMessageAddress, phoneFromJid } from '../src/utils/jid.js';

test('phoneFromJid strips the server and device parts', () => {
  assert.equal(phoneFromJid('628123456789:12@s.whatsapp.net'), '628123456789');
  assert.equal(phoneFromJid(null), null);
});

test('phone-number chats keep their JID and expose the phone', () => {
  assert.deepEqual(describeMessageAddress({ remoteJid: '628111@s.whatsapp.net' }), {
    remoteJid: '628111@s.whatsapp.net',
    remoteJidAlt: null,
    senderJid: '628111@s.whatsapp.net',
    senderJidAlt: null,
    senderPhone: '628111',
    isGroup: false
  });
});

test('LID chats take the phone number from remoteJidAlt', () => {
  const address = describeMessageAddress({ remoteJid: '123456789@lid', remoteJidAlt: '628222@s.whatsapp.net' });
  assert.equal(address.senderJid, '123456789@lid');
  assert.equal(address.senderJidAlt, '628222@s.whatsapp.net');
  assert.equal(address.senderPhone, '628222');
});

test('group messages use participant and participantAlt', () => {
  const address = describeMessageAddress({ remoteJid: '1203@g.us', participant: '999@lid', participantAlt: '628333@s.whatsapp.net' });
  assert.equal(address.isGroup, true);
  assert.equal(address.remoteJidAlt, null);
  assert.equal(address.senderJid, '999@lid');
  assert.equal(address.senderPhone, '628333');
});
```

- [ ] **Step 3: Implementasi** — `src/utils/jid.js`
```js
export function phoneFromJid(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : null;
}

/**
 * Baileys v7 may address chats and group participants by LID (`…@lid`); the phone-number JID then
 * arrives in remoteJidAlt / participantAlt. Returns both forms and the sender's phone when known.
 */
export function describeMessageAddress(key) {
  const isGroup = Boolean(key.remoteJid?.endsWith('@g.us'));
  const senderJid = key.participant || key.remoteJid;
  const remoteJidAlt = isGroup ? null : key.remoteJidAlt || null;
  const senderJidAlt = (isGroup ? key.participantAlt : remoteJidAlt) || null;
  const phoneJid = [senderJid, senderJidAlt].find((jid) => jid?.endsWith('@s.whatsapp.net'));
  return {
    remoteJid: key.remoteJid,
    remoteJidAlt,
    senderJid,
    senderJidAlt,
    senderPhone: phoneJid ? phoneFromJid(phoneJid) : null,
    isGroup
  };
}
```
`003_lid_columns.sql`
```sql
-- WhatsApp LID addressing (Baileys v7): keep the phone-number JID next to a LID JID
ALTER TABLE messages ADD COLUMN IF NOT EXISTS remote_jid_alt VARCHAR(150);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_jid_alt VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_messages_remote_jid_alt ON messages(remote_jid_alt);
```
`sessionManager.js`:
- `phoneFromJid` diimpor dari `../utils/jid.js` (definisi lokal dihapus) bersama `describeMessageAddress`;
- `toNumber` diimpor dari Baileys;
- `handleIncomingMessage`:
  - `const address = describeMessageAddress(msg.key);`
  - INSERT menyertakan `remote_jid_alt` / `sender_jid_alt`;
  - payload webhook menambah `remoteJidAlt`, `senderJidAlt`, `senderPhone`;
  - timestamp memakai `toNumber(msg.messageTimestamp)`;
- di handler `connection.update` tambahkan:
```js
    if (update.reachoutTimeLock) {
      sendWebhookEvent(sessionId, 'account.restriction', update.reachoutTimeLock);
    }
```
  (destructure `update` utuh: `on('connection.update', async (update) => { const { connection, lastDisconnect, qr } = update; ... })`);
- tambahkan:
```js
/**
 * Current WhatsApp restrictions of the account (Baileys v7): new-chat message cap and reach-out timelock.
 */
export async function getSessionLimits(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(409, `Session "${sessionId}" is not connected.`);
  }
  const { sock } = session;
  if (typeof sock.fetchNewChatMessageCap !== 'function' || typeof sock.fetchAccountReachoutTimelock !== 'function') {
    throw new AppError(501, 'Account limits require Baileys v7.');
  }
  const [newChatMessageCap, reachoutTimelock] = await Promise.allSettled([
    sock.fetchNewChatMessageCap(),
    sock.fetchAccountReachoutTimelock()
  ]);
  const unwrap = (result) => (result.status === 'fulfilled' ? result.value : { error: result.reason?.message || 'Request failed' });
  return { newChatMessageCap: unwrap(newChatMessageCap), reachoutTimelock: unwrap(reachoutTimelock) };
}
```
- `extractMessageData` (`webhookService.js`): bungkus `fileLength`, `seconds`, `pageCount` dengan `toNumber(...)`, karena field 64-bit protobuf berupa objek Long yang kalau di-serialize jadi `{low, high}`.
- `getMessages`: filter `remoteJid` → `(remote_jid LIKE $n OR remote_jid_alt LIKE $n)`.
- `sessionController.getLimits` + `router.get('/:sessionId/limits', getLimits);`.

- [ ] **Step 4: Run** test (semua, termasuk DB) → PASS. Smoke: init sesi dengan v7, QR muncul. **Commit** `feat: Baileys v7 with LID addressing and account limits`.

---

### Task 11: Dokumentasi

- [ ] **`.env.example`:** variabel baru `LOG_LEVEL`, `LOG_PRETTY`, `BAILEYS_LOG_LEVEL`, `SHUTDOWN_TIMEOUT_MS`, `SEND_*`, `QUEUE_*`, `WEBHOOK_*`.
- [ ] **README:**
  - antrian (perilaku 200/202, `async`, `scheduleAt`, `idempotencyKey`, `connectOnly`, pacing) dan API `/api/queue`;
  - status pesan + webhook `message.status`;
  - webhook v2: header, contoh verifikasi signature, filter `events`, retry, at-least-once, endpoint deliveries;
  - `account.restriction` + `/limits`;
  - field LID di webhook;
  - migrasi, log, graceful shutdown, Docker Node 22;
  - daftar perubahan yang breaking.
- [ ] **Commit** `docs: Fase 1 queue, webhooks, ops and Baileys v7`.

---

### Task 12: Verifikasi

- [ ] **Unit + integration:** `DB_TEST=1 ... npm test` → semua PASS, 0 skip.
- [ ] **Smoke** (server dengan Postgres test, `ALLOW_PRIVATE_URLS=true`, receiver webhook lokal yang memverifikasi signature):

| Skenario | Expected |
|---|---|
| Start dengan DB baru | Migrasi 001–003 diterapkan; start ulang tidak menerapkan apa-apa |
| Init sesi (v7) | QR muncul; webhook `connection.update` tiba dengan signature valid |
| Receiver membalas 500 sekali | Delivery diulang lalu `delivered` (cek `/webhook-deliveries`) |
| `send-text` ke sesi belum connect | 409 |
| `send-text` dengan `connectOnly=false` | 202 + `queueId`, status `queued` |
| `send-text` + `scheduleAt` | 202, `scheduledAt` sesuai |
| Kirim ulang dengan `idempotencyKey` yang sama | 200 `duplicate: true`, `queueId` sama |
| `PATCH /api/queue/:id`, `DELETE /api/queue/:id` | Reschedule/cancel OK; cancel kedua kali → 409 |
| `PUT /webhook` dengan `events: ["message.status"]` | Event `connection.update` berikutnya tidak dikirim |
| SIGTERM | Exit 0, log "Shutdown complete"; status sesi di DB tetap untuk restore |
| `docker build` | Image berhasil dibangun (tanpa git) dan berjalan sebagai user `node` |
