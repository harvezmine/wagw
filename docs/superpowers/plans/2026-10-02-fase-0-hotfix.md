# Fase 0 Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menutup 8 masalah P0 di wagw: process crash, socket ganda per sesi, loop reconnect, lubang keamanan, nomor `08xx`, webhook URL basi, auth state yang menelan error, dan konfigurasi Baileys yang tidak sesuai rekomendasi resmi.

**Architecture:** Logika murni dipisah ke modul kecil yang bisa di-unit-test (`src/utils/*`, `reconnectPolicy`, `webhookUrlResolver`). `sessionManager` dirombak supaya:
- start/stop per sesi diserialisasi lewat keyed lock, sehingga satu sesi hanya punya satu socket;
- event dari socket lama diabaikan;
- semua handler dibungkus try/catch;
- keputusan reconnect diambil oleh policy per kode disconnect.

Keamanan:
- API key wajib di production dan hanya lewat header;
- halaman QR memakai signed link yang kedaluwarsa;
- URL keluar (media dan webhook) dicek terhadap jaringan privat saat connect.

**Tech Stack:** Node.js 20+ (ESM), Express 4, `@whiskeysockets/baileys` 6.7.24, PostgreSQL 16 (`pg`), axios 1.x, `node:test` (test runner bawaan, tanpa dependency baru).

---

## Ruang lingkup

Di dalam scope (dari laporan analisa):
1. Try/catch di semua event handler, plus handler `unhandledRejection`.
2. Satu socket per sesi: lock per sesi, `end()` socket lama, dan pakai ulang socket yang sedang `connecting`/`qr_ready`/`connected`.
3. Reconnect per kode: stop pada 401/403/440/411/405; backoff eksponensial + jitter; sesi yang belum di-pair tidak membuat QR selamanya.
4. Keamanan:
   - API key wajib di production;
   - `?apiKey` dihapus;
   - HTML di-escape;
   - `GET /qr` tidak membuat sesi;
   - port Postgres hanya bind ke localhost;
   - guard SSRF.
5. Normalisasi `0` → `62` lewat `countryCode` / `DEFAULT_COUNTRY_CODE`.
6. Webhook URL dibaca dari DB (dengan cache), tidak lagi dari closure.
7. Auth state: transaction, error dilempar (tidak ditelan), `makeCacheableSignalKeyStore`.
8. Konfigurasi Baileys:
   - `getMessage` dari DB;
   - `msgRetryCounterCache` dan `cachedGroupMetadata`;
   - `markOnlineOnConnect: false`;
   - `Browsers.macOS('Google Chrome')`;
   - versi WA bisa di-override lewat env.

Perbaikan kecil di kode yang memang sedang disentuh:
- `custom_name` tidak lagi terhapus;
- `media_url` tidak lagi menyimpan base64;
- `delayMs`, `limit` dan `offset` divalidasi;
- error klien dibalas 4xx, bukan 500;
- `/api/webhook-test` tidak di-mount di production;
- `.env` dan `.DS_Store` masuk `.gitignore`;
- ada `.dockerignore` supaya `.env` tidak ikut masuk image.

Di luar scope (Fase 1): antrian kirim, status ack, retry dan HMAC webhook, upgrade ke Baileys v7, graceful shutdown, perbaikan Dockerfile lainnya.

## Struktur file

| File | Status | Tanggung jawab |
|---|---|---|
| `src/utils/errors.js` | baru | `AppError(status, message)` + `sendError(res, error, context)` |
| `src/utils/validation.js` | baru | Validasi `sessionId`, parse integer opsional, `router.param` validator |
| `src/utils/phone.js` | baru | `normalizePhoneNumber`, `normalizeTarget` |
| `src/utils/html.js` | baru | `escapeHtml` |
| `src/utils/ttlCache.js` | baru | Cache TTL yang memenuhi interface `CacheStore` Baileys |
| `src/utils/keyedLock.js` | baru | Serialisasi operasi async per key |
| `src/utils/netGuard.js` | baru | Deteksi IP privat, `assertSafeUrl`, `safeLookup`, `fetchRemoteFile` |
| `src/services/reconnectPolicy.js` | baru | `decideReconnect`, `backoffDelay` |
| `src/services/webhookUrlResolver.js` | baru | Resolusi URL webhook dengan cache + invalidasi |
| `src/views/sessionPages.js` | baru | Halaman HTML QR/status (escaped) |
| `src/config/index.js` | ubah | Env baru + `validateConfig` + `parseWaVersion` |
| `src/middlewares/auth.js` | ubah | Header-only, timing-safe, signed QR link |
| `src/database/db.js` | ubah | `createDb(pool)` dengan `withTransaction`; migrasi `disconnect_reason` |
| `src/database/schema.sql` | ubah | Kolom `disconnect_reason` |
| `src/database/postgresAuthState.js` | ubah | Batch upsert/delete dalam transaction, error dilempar |
| `src/services/webhookService.js` | ubah | Pakai resolver + guard SSRF |
| `src/services/sessionManager.js` | ubah | Lock, policy reconnect, konfigurasi Baileys, pairing, restore, send hardening |
| `src/controllers/*.js`, `src/routes/*.js` | ubah | Status code, validasi, QR link, urutan auth |
| `src/index.js` | ubah | `validateConfig`, `unhandledRejection`, log tanpa query string |
| `docker-compose.yml`, `.env.example`, `.gitignore`, `.dockerignore`, `README.md`, `package.json` | ubah/baru | Konfigurasi dan dokumentasi |
| `test/*.test.js` | baru | Unit test (`node --test`) + integration test auth state (opsional, butuh Postgres) |

Catatan environment untuk engineer:
- Node dari Homebrew di mesin ini rusak (`libsimdjson` hilang). Pakai Node 22 dari nvm:
  ```bash
  export PATH=$HOME/.nvm/versions/node/v22.21.1/bin:/usr/local/bin:$PATH
  ```
- Docker tersedia lewat OrbStack di `/usr/local/bin/docker`.

---

### Task 1: Test harness, error, dan validasi

**Files:**
- Modify: `package.json` (script `test`, floor Baileys)
- Create: `src/utils/errors.js`, `src/utils/validation.js`
- Test: `test/validation.test.js`

- [ ] **Step 1: Tambah script test dan naikkan floor Baileys (CVE-2026-48063 mengenai < 6.7.22)**

Di `package.json`:
```json
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "test": "node --test test/*.test.js"
  },
```
dan `"@whiskeysockets/baileys": "^6.7.24"`. Lalu jalankan `npm install` supaya `package-lock.json` sinkron.

- [ ] **Step 2: Tulis test yang gagal** — `test/validation.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSessionId, parseOptionalInt } from '../src/utils/validation.js';

test('assertSessionId accepts letters, digits, dot, underscore and dash', () => {
  assert.equal(assertSessionId('sales-01'), 'sales-01');
  assert.equal(assertSessionId('device_1.main'), 'device_1.main');
});

test('assertSessionId rejects HTML, spaces, empty and overly long ids', () => {
  for (const value of ['<script>alert(1)</script>', 'has space', '', 'a'.repeat(65), undefined]) {
    assert.throws(() => assertSessionId(value), { status: 400 });
  }
});

test('parseOptionalInt returns the default for missing values', () => {
  assert.equal(parseOptionalInt(undefined, { name: 'limit', min: 1, max: 200, defaultValue: 50 }), 50);
  assert.equal(parseOptionalInt('', { name: 'limit', min: 1, max: 200, defaultValue: 50 }), 50);
});

test('parseOptionalInt parses numeric strings within range', () => {
  assert.equal(parseOptionalInt('2000', { name: 'delayMs', min: 0, max: 15000 }), 2000);
  assert.equal(parseOptionalInt(0, { name: 'delayMs', min: 0, max: 15000 }), 0);
});

test('parseOptionalInt rejects out-of-range and non-integer values', () => {
  for (const value of ['abc', '1.5', -1, 15001]) {
    assert.throws(() => parseOptionalInt(value, { name: 'delayMs', min: 0, max: 15000 }), { status: 400 });
  }
});
```

- [ ] **Step 3: Jalankan, pastikan gagal**

Run: `npm test` → FAIL (`Cannot find module '../src/utils/validation.js'`).

- [ ] **Step 4: Implementasi** — `src/utils/errors.js`

```js
/**
 * Error with an HTTP status code. Anything else that reaches a controller is treated as a 500.
 */
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export function sendError(res, error, context) {
  const status = error instanceof AppError ? error.status : 500;
  if (status >= 500) {
    console.error(`[${context}]`, error);
  }
  return res.status(status).json({ success: false, error: error.message });
}
```

`src/utils/validation.js`

```js
import { AppError, sendError } from './errors.js';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new AppError(400, 'Invalid sessionId: use 1-64 characters of letters, digits, ".", "_" or "-".');
  }
  return value;
}

/**
 * Parses an optional integer request field. Returns `defaultValue` when the field is absent.
 */
export function parseOptionalInt(value, { name, min, max, defaultValue = undefined }) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(400, `${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Express `router.param` handler that rejects malformed :sessionId values before any handler runs.
 */
export function validateSessionIdParam(req, res, next, value) {
  try {
    assertSessionId(value);
    next();
  } catch (error) {
    sendError(res, error, 'Validation');
  }
}
```

- [ ] **Step 5: Jalankan, pastikan lulus** — `npm test` → PASS.

- [ ] **Step 6: Commit** — `git add package.json package-lock.json src/utils/errors.js src/utils/validation.js test/validation.test.js && git commit -m "test: add node:test harness, AppError and request validation"`

---

### Task 2: Konfigurasi baru + validasi startup

**Files:**
- Modify: `src/config/index.js`
- Create: `.env.example`
- Test: `test/config.test.js`

- [ ] **Step 1: Test** — `test/config.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWaVersion, validateConfig } from '../src/config/index.js';

const base = { nodeEnv: 'production', apiKey: 'a-very-long-api-key-123', defaultCountryCode: '62' };

test('validateConfig accepts a production config with a strong API key', () => {
  assert.doesNotThrow(() => validateConfig(base));
});

test('validateConfig rejects production without a strong API key', () => {
  assert.throws(() => validateConfig({ ...base, apiKey: '' }), /API_KEY is required/);
  assert.throws(() => validateConfig({ ...base, apiKey: 'short' }), /API_KEY is required/);
});

test('validateConfig allows an empty API key outside production', () => {
  assert.doesNotThrow(() => validateConfig({ ...base, nodeEnv: 'development', apiKey: '' }));
});

test('validateConfig rejects a malformed default country code', () => {
  assert.throws(() => validateConfig({ ...base, defaultCountryCode: '+62' }), /DEFAULT_COUNTRY_CODE/);
  assert.throws(() => validateConfig({ ...base, defaultCountryCode: '0' }), /DEFAULT_COUNTRY_CODE/);
});

test('parseWaVersion parses a dotted version and rejects garbage', () => {
  assert.equal(parseWaVersion(''), null);
  assert.deepEqual(parseWaVersion('2.3000.1043857760'), [2, 3000, 1043857760]);
  assert.throws(() => parseWaVersion('2.3000'), /Invalid WA_VERSION/);
  assert.throws(() => parseWaVersion('2..3'), /Invalid WA_VERSION/);
});
```

- [ ] **Step 2: Run** `npm test` → FAIL (`validateConfig` is not exported).

- [ ] **Step 3: Implementasi** — ganti isi `src/config/index.js`:

```js
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
```

`.env.example`:

```dotenv
# --- Server ---
PORT=3000
HOST=0.0.0.0
NODE_ENV=production

# --- Security ---
# Required when NODE_ENV=production (min. 16 characters). Send it in the x-api-key header.
API_KEY=change-me-to-a-long-random-string
# Lifetime of signed QR page links returned by POST /api/sessions/init and /:sessionId/qr-link
QR_LINK_TTL_SECONDS=600
# Allow media/webhook URLs that resolve to private or local addresses (e.g. an n8n container on the same network)
ALLOW_PRIVATE_URLS=false
# Max size of media downloaded from imageUrl/attachmentUrl (bytes)
MEDIA_MAX_BYTES=52428800

# --- Database ---
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=whatsapp_gateway
DB_SSL=false

# --- WhatsApp ---
# Country code that replaces the leading 0 of local numbers (08123... -> 628123...)
DEFAULT_COUNTRY_CODE=62
# Optional WA Web version override, only when WhatsApp rejects the bundled one (disconnect code 405)
WA_VERSION=
# Reconnect backoff for paired sessions (exponential with jitter)
RECONNECT_BASE_DELAY_MS=2000
RECONNECT_MAX_DELAY_MS=300000
# Delay between sessions restored at startup
RESTORE_STAGGER_MS=1500

# --- Webhook ---
GLOBAL_WEBHOOK_URL=

# --- Typing simulation ---
MIN_TYPING_DELAY_MS=1200
MAX_TYPING_DELAY_MS=3000
# Upper bound for the per-request delayMs field
MAX_REQUEST_DELAY_MS=15000
AUTO_READ_MESSAGES=false
```

- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(config): validate production config and add Fase 0 settings"`

---

### Task 3: Normalisasi nomor tujuan

**Files:**
- Create: `src/utils/phone.js`
- Test: `test/phone.test.js`

- [ ] **Step 1: Test** — `test/phone.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber, normalizeTarget } from '../src/utils/phone.js';

test('replaces the leading 0 of a local number with the country code', () => {
  assert.equal(normalizePhoneNumber('08123456789', '62'), '628123456789');
  assert.equal(normalizePhoneNumber('0812-3456-789', '62'), '628123456789');
  assert.equal(normalizePhoneNumber('(0812) 3456 789', '62'), '628123456789');
});

test('keeps numbers that already carry a country code', () => {
  assert.equal(normalizePhoneNumber('628123456789', '62'), '628123456789');
  assert.equal(normalizePhoneNumber('+60 12-345 6789', '62'), '60123456789');
});

test('countryCode 0 disables local-number conversion', () => {
  assert.equal(normalizePhoneNumber('60123456789', '0'), '60123456789');
  assert.throws(() => normalizePhoneNumber('08123456789', '0'), { status: 400 });
});

test('rejects letters, too-short numbers and invalid country codes', () => {
  assert.throws(() => normalizePhoneNumber('abc123', '62'), { status: 400 });
  assert.throws(() => normalizePhoneNumber('0812', '62'), { status: 400 });
  assert.throws(() => normalizePhoneNumber('08123456789', '+62'), { status: 400 });
});

test('normalizeTarget turns numbers into personal JIDs', () => {
  assert.equal(normalizeTarget('08123456789', '62'), '628123456789@s.whatsapp.net');
});

test('normalizeTarget passes through valid JIDs', () => {
  assert.equal(normalizeTarget('120363023456789012@g.us', '62'), '120363023456789012@g.us');
  assert.equal(normalizeTarget('628123456789@s.whatsapp.net', '62'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeTarget('123456789012345@lid', '62'), '123456789012345@lid');
});

test('normalizeTarget rejects malformed JIDs and empty targets', () => {
  for (const value of ['abc@s.whatsapp.net', 'foo@example.com', '', '<script>@g.us']) {
    assert.throws(() => normalizeTarget(value, '62'), { status: 400 });
  }
});
```

- [ ] **Step 2: Run** → FAIL (module not found).

- [ ] **Step 3: Implementasi** — `src/utils/phone.js`

```js
import { AppError } from './errors.js';

const JID_PATTERNS = [
  ['@s.whatsapp.net', /^\d{8,15}$/],
  ['@g.us', /^\d+(-\d+)?$/],
  ['@lid', /^\d+$/],
  ['@newsletter', /^\d+$/],
  ['@broadcast', /^(status|\d+)$/]
];

/**
 * Normalises a phone number to international digits (e.g. "0812-3456-789" -> "628123456789").
 * A leading "0" is replaced by `countryCode`; a leading "+" marks the number as already international.
 * countryCode "0" disables the replacement (same semantics as Fonnte's countryCode=0).
 */
export function normalizePhoneNumber(input, countryCode) {
  const code = String(countryCode ?? '');
  if (!/^\d{1,4}$/.test(code)) {
    throw new AppError(400, `Invalid countryCode "${code}": use digits only, e.g. 62.`);
  }
  const raw = String(input ?? '').trim();
  const isInternational = raw.startsWith('+');
  let digits = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) {
    throw new AppError(400, `Invalid phone number "${raw}": use digits only, e.g. 08123456789 or 628123456789.`);
  }
  if (!isInternational && digits.startsWith('0') && code !== '0') {
    digits = code + digits.slice(1);
  }
  if (digits.startsWith('0') || digits.length < 8 || digits.length > 15) {
    throw new AppError(400, `Invalid phone number "${raw}": expected 8-15 digits including the country code.`);
  }
  return digits;
}

/**
 * Converts a send target into a WhatsApp JID. Accepts phone numbers in local or international
 * format and pre-formed JIDs (personal, group, LID, newsletter, broadcast).
 */
export function normalizeTarget(target, countryCode) {
  const raw = String(target ?? '').trim().toLowerCase();
  if (!raw) {
    throw new AppError(400, 'Target number is required.');
  }
  if (raw.includes('@')) {
    const match = JID_PATTERNS.find(([suffix]) => raw.endsWith(suffix));
    if (!match || !match[1].test(raw.slice(0, -match[0].length))) {
      throw new AppError(400, `Invalid WhatsApp JID "${target}".`);
    }
    return raw;
  }
  return `${normalizePhoneNumber(raw, countryCode)}@s.whatsapp.net`;
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat: normalize local phone numbers (08xx -> 628xx) and validate JIDs"`

---

### Task 4: Escape HTML + halaman sesi

**Files:**
- Create: `src/utils/html.js`, `src/views/sessionPages.js`
- Test: `test/html.test.js`

- [ ] **Step 1: Test** — `test/html.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../src/utils/html.js';
import { renderMessagePage, renderQrPage } from '../src/views/sessionPages.js';

test('escapeHtml escapes markup characters', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')">&`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
  assert.equal(escapeHtml(null), '');
});

test('session pages never render the session id unescaped', () => {
  const evil = '<script>alert(1)</script>';
  assert.ok(!renderQrPage(evil, 'data:image/png;base64,AAAA').includes(evil));
  assert.ok(!renderMessagePage(evil, { title: 'x', message: evil }).includes(evil));
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/utils/html.js`

```js
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
```

`src/views/sessionPages.js`

```js
import { escapeHtml } from '../utils/html.js';

const BASE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
  .card { background: #111b21; padding: 2.5rem 2rem; border-radius: 16px; box-shadow: 0 4px 25px rgba(0,0,0,0.6); text-align: center; max-width: 380px; width: 90%; }
  h2 { margin: 0 0 10px; color: #25d366; }
  p { font-size: 0.9rem; color: #8696a0; line-height: 1.5; }
  .badge { background: #005c4b; color: #25d366; padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; display: inline-block; margin-bottom: 15px; }
  .icon { font-size: 3rem; margin-bottom: 0.8rem; color: #25d366; }
  .phone-box { background: #202c33; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 1.1rem; color: #25d366; }
  .spinner { width: 48px; height: 48px; border: 4px solid #202c33; border-top: 4px solid #25d366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  img { width: 260px; height: 260px; border-radius: 8px; background: #fff; padding: 8px; margin: 15px 0; }
`;

function renderPage({ title, body, refreshMs = null }) {
  const refresh = refreshMs ? `<script>setTimeout(() => location.reload(), ${Number(refreshMs)});</script>` : '';
  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${BASE_STYLE}</style>
  ${refresh}
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

const badge = (sessionId) => `<span class="badge">Session: ${escapeHtml(sessionId)}</span>`;

export function renderConnectedPage(sessionId, phoneNumber) {
  return renderPage({
    title: `WhatsApp Connected - ${sessionId}`,
    body: `<div class="icon">✓</div>${badge(sessionId)}
      <h2>WhatsApp Connected</h2>
      <p>Your WhatsApp device is successfully linked and active.</p>
      <div class="phone-box">${phoneNumber ? `+${escapeHtml(phoneNumber)}` : 'Device Connected'}</div>`
  });
}

export function renderInitializingPage(sessionId) {
  return renderPage({
    title: `Starting WhatsApp Session - ${sessionId}`,
    refreshMs: 2000,
    body: `${badge(sessionId)}<div class="spinner"></div>
      <h2>Initializing WhatsApp...</h2>
      <p>Starting connection and preparing QR code. This page will refresh automatically in 2 seconds.</p>`
  });
}

export function renderQrPage(sessionId, qrCode) {
  return renderPage({
    title: `Scan WhatsApp QR - ${sessionId}`,
    refreshMs: 15000,
    body: `${badge(sessionId)}
      <h2>Scan WhatsApp QR</h2>
      <img src="${escapeHtml(qrCode)}" alt="WhatsApp QR Code" />
      <p>1. Open WhatsApp on your phone<br>2. Tap Menu / Settings &gt; Linked Devices<br>3. Tap Link a Device and point your camera here</p>`
  });
}

export function renderMessagePage(sessionId, { title, message, refreshMs = null }) {
  return renderPage({
    title: `${title} - ${sessionId}`,
    refreshMs,
    body: `${badge(sessionId)}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`
  });
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "fix(security): escape session pages to prevent reflected XSS"`

---

### Task 5: TTL cache dan keyed lock

**Files:**
- Create: `src/utils/ttlCache.js`, `src/utils/keyedLock.js`
- Test: `test/ttlCache.test.js`, `test/keyedLock.test.js`

- [ ] **Step 1: Test** — `test/ttlCache.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../src/utils/ttlCache.js';

test('returns stored values until they expire', () => {
  let time = 0;
  const cache = createTtlCache({ ttlMs: 100, now: () => time });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  time = 99;
  assert.equal(cache.get('a'), 1);
  time = 100;
  assert.equal(cache.get('a'), undefined);
});

test('del and flushAll remove entries', () => {
  const cache = createTtlCache({ ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.del('a');
  assert.equal(cache.get('a'), undefined);
  cache.flushAll();
  assert.equal(cache.get('b'), undefined);
});

test('evicts the oldest entries beyond maxEntries', () => {
  const cache = createTtlCache({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});
```

`test/keyedLock.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedLock } from '../src/utils/keyedLock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('runs tasks for the same key one at a time, in order', async () => {
  const lock = createKeyedLock();
  const events = [];
  const task = (name, ms) => lock.run('s1', async () => {
    events.push(`start:${name}`);
    await sleep(ms);
    events.push(`end:${name}`);
    return name;
  });
  assert.deepEqual(await Promise.all([task('a', 30), task('b', 0)]), ['a', 'b']);
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('runs different keys in parallel', async () => {
  const lock = createKeyedLock();
  const events = [];
  await Promise.all([
    lock.run('s1', async () => { events.push('start:s1'); await sleep(30); events.push('end:s1'); }),
    lock.run('s2', async () => { events.push('start:s2'); events.push('end:s2'); })
  ]);
  assert.deepEqual(events, ['start:s1', 'start:s2', 'end:s2', 'end:s1']);
});

test('a failing task does not block the next one', async () => {
  const lock = createKeyedLock();
  await assert.rejects(lock.run('s1', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lock.run('s1', async () => 'ok'), 'ok');
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/utils/ttlCache.js`

```js
/**
 * Minimal TTL cache implementing Baileys' CacheStore interface (get/set/del/flushAll).
 * Expired entries are dropped lazily; the oldest entries are evicted beyond `maxEntries`.
 */
export function createTtlCache({ ttlMs, maxEntries = 10000, now = Date.now }) {
  const entries = new Map();

  const sweepExpired = () => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      if (entries.size > maxEntries) {
        sweepExpired();
        while (entries.size > maxEntries) {
          entries.delete(entries.keys().next().value);
        }
      }
    },
    del(key) {
      entries.delete(key);
    },
    flushAll() {
      entries.clear();
    }
  };
}
```

`src/utils/keyedLock.js`

```js
/**
 * Runs async functions one at a time per key. Used so a WhatsApp session can never be
 * started, restarted or logged out concurrently (which would create duplicate sockets).
 */
export function createKeyedLock() {
  const tails = new Map();

  return {
    run(key, fn) {
      const previous = tails.get(key) || Promise.resolve();
      const result = previous.then(() => fn());
      const tail = result.then(() => undefined, () => undefined);
      tails.set(key, tail);
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    }
  };
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat: add TTL cache and per-key async lock utilities"`

---

### Task 6: Policy reconnect

**Files:**
- Create: `src/services/reconnectPolicy.js`
- Test: `test/reconnectPolicy.test.js`

- [ ] **Step 1: Test** — `test/reconnectPolicy.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, decideReconnect } from '../src/services/reconnectPolicy.js';

const opts = { attempt: 0, registered: true, baseDelayMs: 2000, maxDelayMs: 300000, random: () => 1 };

test('logged out sessions are cleared', () => {
  assert.deepEqual(decideReconnect({ ...opts, statusCode: 401 }), { action: 'logout', reason: 'logged_out' });
});

test('conflict, ban, device mismatch and rejected client version stop without reconnecting', () => {
  const reasons = { 440: 'connection_replaced', 403: 'forbidden', 411: 'multidevice_mismatch', 405: 'client_version_rejected' };
  for (const [code, reason] of Object.entries(reasons)) {
    assert.deepEqual(decideReconnect({ ...opts, statusCode: Number(code) }), { action: 'stop', reason });
  }
});

test('restart required reconnects immediately, even before pairing finished', () => {
  assert.deepEqual(decideReconnect({ ...opts, registered: false, statusCode: 515 }), { action: 'reconnect', reason: 'restart_required', delayMs: 0 });
});

test('unpaired sessions stop instead of regenerating QR codes forever', () => {
  assert.deepEqual(decideReconnect({ ...opts, registered: false, statusCode: 408 }), { action: 'stop', reason: 'pairing_timeout' });
});

test('paired sessions reconnect with exponential backoff', () => {
  assert.deepEqual(decideReconnect({ ...opts, statusCode: 428 }), { action: 'reconnect', reason: 'connection_lost', delayMs: 2000 });
  assert.equal(decideReconnect({ ...opts, attempt: 3, statusCode: 503 }).delayMs, 16000);
  assert.equal(decideReconnect({ ...opts, attempt: 3, statusCode: undefined }).delayMs, 16000);
});

test('backoff is capped and jittered between half and full ceiling', () => {
  const cfg = { baseDelayMs: 2000, maxDelayMs: 300000 };
  assert.equal(backoffDelay(50, { ...cfg, random: () => 1 }), 300000);
  assert.equal(backoffDelay(50, { ...cfg, random: () => 0 }), 150000);
  assert.equal(backoffDelay(0, { ...cfg, random: () => 0 }), 1000);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/services/reconnectPolicy.js`

```js
import { DisconnectReason } from '@whiskeysockets/baileys';

// Disconnects where reconnecting cannot help and would only hammer WhatsApp or fight another socket
const STOP_REASONS = new Map([
  [DisconnectReason.forbidden, 'forbidden'],
  [DisconnectReason.connectionReplaced, 'connection_replaced'],
  [DisconnectReason.multideviceMismatch, 'multidevice_mismatch'],
  [405, 'client_version_rejected']
]);

/**
 * Exponential backoff with "equal jitter": a random delay between half and all of the capped ceiling.
 */
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs, random = Math.random }) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Decides what to do after a Baileys connection closes.
 * @returns {{ action: 'reconnect' | 'stop' | 'logout', reason: string, delayMs?: number }}
 */
export function decideReconnect({ statusCode, attempt, registered, baseDelayMs, maxDelayMs, random = Math.random }) {
  if (statusCode === DisconnectReason.loggedOut) {
    return { action: 'logout', reason: 'logged_out' };
  }
  if (STOP_REASONS.has(statusCode)) {
    return { action: 'stop', reason: STOP_REASONS.get(statusCode) };
  }
  if (statusCode === DisconnectReason.restartRequired) {
    return { action: 'reconnect', reason: 'restart_required', delayMs: 0 };
  }
  if (!registered) {
    // Unpaired socket closed (QR refs exhausted, pairing timed out): wait for an explicit /init
    return { action: 'stop', reason: 'pairing_timeout' };
  }
  return {
    action: 'reconnect',
    reason: 'connection_lost',
    delayMs: backoffDelay(attempt, { baseDelayMs, maxDelayMs, random })
  };
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat: reconnect policy per disconnect code with exponential backoff"`

---

### Task 7: Guard SSRF

**Files:**
- Create: `src/utils/netGuard.js`
- Test: `test/netGuard.test.js`

- [ ] **Step 1: Test** — `test/netGuard.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertSafeUrl, fetchRemoteFile, guardRedirect, isPrivateAddress, safeLookup } from '../src/utils/netGuard.js';

test('isPrivateAddress flags internal IPv4 and IPv6 ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('isPrivateAddress allows public addresses and ignores hostnames', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', 'example.com']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('assertSafeUrl enforces http(s) and blocks literal private hosts', () => {
  assert.equal(assertSafeUrl('https://example.com/a.png').hostname, 'example.com');
  for (const url of ['ftp://example.com/x', 'not a url', 'http://localhost:5432', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/latest/meta-data']) {
    assert.throws(() => assertSafeUrl(url), { status: 400 }, url);
  }
  assert.doesNotThrow(() => assertSafeUrl('http://127.0.0.1/x', { allowPrivate: true }));
});

test('safeLookup refuses hostnames that resolve to private addresses', async () => {
  const error = await new Promise((resolve) => safeLookup('localhost', { all: true }, (err) => resolve(err)));
  assert.equal(error?.code, 'EPRIVATEADDRESS');
});

test('guardRedirect blocks redirects to literal private IPs', () => {
  assert.throws(() => guardRedirect({ hostname: '127.0.0.1' }), /Blocked redirect/);
  assert.doesNotThrow(() => guardRedirect({ hostname: 'example.com' }));
});

test('fetchRemoteFile blocks private URLs and enforces the size limit', async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'image/png; charset=binary');
    res.end(Buffer.alloc(req.url === '/big' ? 2048 : 16, 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await assert.rejects(fetchRemoteFile(`${base}/small`, { maxBytes: 1024 }), { status: 400 });

  const file = await fetchRemoteFile(`${base}/small`, { allowPrivate: true, maxBytes: 1024 });
  assert.equal(file.buffer.length, 16);
  assert.equal(file.contentType, 'image/png');

  await assert.rejects(fetchRemoteFile(`${base}/big`, { allowPrivate: true, maxBytes: 1024 }), /maxContentLength/);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/utils/netGuard.js`

```js
import dns from 'node:dns';
import net from 'node:net';
import axios from 'axios';
import { AppError } from './errors.js';

const PRIVATE_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];
const PRIVATE_IPV6 = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
];

const blockList = new net.BlockList();
for (const [network, prefix] of PRIVATE_IPV4) blockList.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of PRIVATE_IPV6) blockList.addSubnet(network, prefix, 'ipv6');

/**
 * True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public
 * addresses (IPv4, IPv6 and IPv4-mapped IPv6). Hostnames return false.
 */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  return blockList.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function isBlockedHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host);
}

/**
 * Validates the scheme and rejects literal private hosts. Hostnames are checked at connect time
 * by safeLookup, which also covers DNS rebinding.
 */
export function assertSafeUrl(rawUrl, { allowPrivate = false, label = 'URL' } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, `${label} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, `${label} must use http or https.`);
  }
  if (!allowPrivate && isBlockedHost(url.hostname)) {
    throw new AppError(400, `${label} points to a private or local network address.`);
  }
  return url;
}

/**
 * dns.lookup replacement that refuses to connect to private addresses. It runs for every hop,
 * so redirects to internal hostnames are blocked as well.
 */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const blocked = addresses.find(({ address }) => isPrivateAddress(address));
    if (blocked) {
      const blockedError = new Error(`Blocked connection to private address ${blocked.address} (${hostname}).`);
      blockedError.code = 'EPRIVATEADDRESS';
      return callback(blockedError);
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * Redirect hook: literal IP redirect targets skip DNS lookup, so they are checked here.
 */
export function guardRedirect(options) {
  if (isBlockedHost(options.hostname || '')) {
    throw new Error(`Blocked redirect to private address ${options.hostname}.`);
  }
}

/**
 * Extra axios options that enforce the private-network policy.
 */
export function safeRequestOptions({ allowPrivate = false } = {}) {
  return allowPrivate ? {} : { lookup: safeLookup, beforeRedirect: guardRedirect };
}

/**
 * Downloads a remote file into memory with SSRF protection, a size cap and a timeout.
 */
export async function fetchRemoteFile(rawUrl, { allowPrivate = false, maxBytes, timeoutMs = 30000 }) {
  assertSafeUrl(rawUrl, { allowPrivate, label: 'Media URL' });
  try {
    const response = await axios.get(rawUrl, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxRedirects: 5,
      ...safeRequestOptions({ allowPrivate })
    });
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim();
    return { buffer: Buffer.from(response.data), contentType: contentType || null };
  } catch (error) {
    throw new AppError(400, `Failed to download media URL: ${error.message}`);
  }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "fix(security): block SSRF to private networks for media and webhook URLs"`

---

### Task 8: Auth API key (header saja) + signed QR link

**Files:**
- Modify: `src/middlewares/auth.js` (ganti seluruh isi)
- Test: `test/auth.test.js`

- [ ] **Step 1: Test** — `test/auth.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiKeyAuth, createQrLinkToken, createQrPageAuth, verifyQrLinkToken } from '../src/middlewares/auth.js';

const API_KEY = 'test-api-key-0123456789';

function runMiddleware(middleware, { headers = {}, query = {}, params = {} } = {}) {
  const req = { query, params, get: (name) => headers[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { nextCalled, res };
}

test('accepts the API key from the x-api-key header', () => {
  assert.equal(runMiddleware(createApiKeyAuth({ apiKey: API_KEY }), { headers: { 'x-api-key': API_KEY } }).nextCalled, true);
});

test('rejects a wrong key and no longer accepts ?apiKey= in the query string', () => {
  const auth = createApiKeyAuth({ apiKey: API_KEY });
  assert.equal(runMiddleware(auth, { headers: { 'x-api-key': 'wrong' } }).res.statusCode, 401);
  const viaQuery = runMiddleware(auth, { query: { apiKey: API_KEY } });
  assert.equal(viaQuery.nextCalled, false);
  assert.equal(viaQuery.res.statusCode, 401);
});

test('passes everything through when no API key is configured', () => {
  assert.equal(runMiddleware(createApiKeyAuth({ apiKey: '' })).nextCalled, true);
});

test('QR link tokens are bound to one session and expire', () => {
  const now = () => 1_000_000_000_000;
  const { token } = createQrLinkToken('sales-01', { secret: API_KEY, ttlSeconds: 600, now });
  assert.equal(verifyQrLinkToken('sales-01', token, { secret: API_KEY, now }), true);
  assert.equal(verifyQrLinkToken('other', token, { secret: API_KEY, now }), false);
  assert.equal(verifyQrLinkToken('sales-01', token, { secret: 'different-secret', now }), false);
  assert.equal(verifyQrLinkToken('sales-01', token, { secret: API_KEY, now: () => now() + 601_000 }), false);
  assert.equal(verifyQrLinkToken('sales-01', 'garbage', { secret: API_KEY, now }), false);
});

test('QR page auth accepts either the header or a valid signed token', () => {
  const auth = createQrPageAuth({ apiKey: API_KEY });
  const { token } = createQrLinkToken('sales-01', { secret: API_KEY });
  assert.equal(runMiddleware(auth, { params: { sessionId: 'sales-01' }, query: { token } }).nextCalled, true);
  assert.equal(runMiddleware(auth, { params: { sessionId: 'sales-01' }, headers: { 'x-api-key': API_KEY } }).nextCalled, true);
  assert.equal(runMiddleware(auth, { params: { sessionId: 'other' }, query: { token } }).res.statusCode, 401);
});
```

- [ ] **Step 2: Run** → FAIL (`createApiKeyAuth` is not exported).

- [ ] **Step 3: Implementasi** — `src/middlewares/auth.js`

```js
import crypto from 'node:crypto';
import { config } from '../config/index.js';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Hashing first yields equal-length buffers, so timingSafeEqual never leaks the key length
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function signQr(sessionId, expiresAt, secret) {
  return crypto.createHmac('sha256', secret).update(`qr:${sessionId}:${expiresAt}`).digest('base64url');
}

function unauthorized(res) {
  return res.status(401).json({
    success: false,
    error: 'Unauthorized: missing or invalid x-api-key header.'
  });
}

/**
 * Signed, short-lived token that lets a browser open one session's QR page without the API key.
 */
export function createQrLinkToken(sessionId, { secret = config.apiKey, ttlSeconds = config.qrLinkTtlSeconds, now = Date.now } = {}) {
  const expiresAt = Math.floor(now() / 1000) + ttlSeconds;
  return {
    token: `${expiresAt}.${signQr(sessionId, expiresAt, secret)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

export function verifyQrLinkToken(sessionId, token, { secret = config.apiKey, now = Date.now } = {}) {
  if (typeof token !== 'string') return false;
  const [expiresAtRaw, signature] = token.split('.');
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || !signature || expiresAt < Math.floor(now() / 1000)) {
    return false;
  }
  return safeEqual(signature, signQr(sessionId, expiresAt, secret));
}

/**
 * API key auth via the `x-api-key` header only (query-string keys leak into logs and browser history).
 * Without a configured key (allowed outside production only, see validateConfig) requests pass through.
 */
export function createApiKeyAuth({ apiKey }) {
  return (req, res, next) => {
    if (!apiKey) return next();
    const provided = req.get('x-api-key');
    if (provided && safeEqual(provided, apiKey)) return next();
    return unauthorized(res);
  };
}

/**
 * Like createApiKeyAuth, but also accepts a signed QR link token (?token=) for the session in the URL.
 */
export function createQrPageAuth({ apiKey }) {
  const apiKeyAuth = createApiKeyAuth({ apiKey });
  return (req, res, next) => {
    if (apiKey && verifyQrLinkToken(req.params.sessionId, req.query.token, { secret: apiKey })) {
      return next();
    }
    return apiKeyAuth(req, res, next);
  };
}

export const apiKeyAuth = createApiKeyAuth({ apiKey: config.apiKey });
export const qrPageAuth = createQrPageAuth({ apiKey: config.apiKey });
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "fix(security): header-only timing-safe API key auth and signed QR page links"`

---

### Task 9: Resolver URL webhook + guard di webhookService

**Files:**
- Create: `src/services/webhookUrlResolver.js`
- Modify: `src/services/webhookService.js` (import, resolver, signature `sendWebhookEvent`, opsi axios)
- Test: `test/webhookUrlResolver.test.js`

- [ ] **Step 1: Test** — `test/webhookUrlResolver.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookUrlResolver } from '../src/services/webhookUrlResolver.js';

function fakeQuery(urls) {
  const calls = [];
  const query = async (sql, [sessionId]) => {
    calls.push(sessionId);
    return { rows: sessionId in urls ? [{ webhook_url: urls[sessionId] }] : [] };
  };
  return { query, calls };
}

test('returns the session webhook URL and caches it', async () => {
  const { query, calls } = fakeQuery({ s1: 'https://hooks.example.com/s1' });
  const resolver = createWebhookUrlResolver({ query, globalWebhookUrl: 'https://global.example.com' });
  assert.equal(await resolver.resolve('s1'), 'https://hooks.example.com/s1');
  assert.equal(await resolver.resolve('s1'), 'https://hooks.example.com/s1');
  assert.deepEqual(calls, ['s1']);
});

test('falls back to the global webhook URL', async () => {
  const { query } = fakeQuery({ s1: null });
  const resolver = createWebhookUrlResolver({ query, globalWebhookUrl: 'https://global.example.com' });
  assert.equal(await resolver.resolve('s1'), 'https://global.example.com');
  assert.equal(await resolver.resolve('missing'), 'https://global.example.com');
});

test('invalidate makes a changed URL visible immediately', async () => {
  const urls = { s1: 'https://old.example.com' };
  const { query } = fakeQuery(urls);
  const resolver = createWebhookUrlResolver({ query });
  assert.equal(await resolver.resolve('s1'), 'https://old.example.com');
  urls.s1 = 'https://new.example.com';
  assert.equal(await resolver.resolve('s1'), 'https://old.example.com');
  resolver.invalidate('s1');
  assert.equal(await resolver.resolve('s1'), 'https://new.example.com');
});

test('cached entries expire after the TTL', async () => {
  let time = 0;
  const { query, calls } = fakeQuery({ s1: 'https://hooks.example.com' });
  const resolver = createWebhookUrlResolver({ query, ttlMs: 1000, now: () => time });
  await resolver.resolve('s1');
  time = 1000;
  await resolver.resolve('s1');
  assert.deepEqual(calls, ['s1', 's1']);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/services/webhookUrlResolver.js`

```js
import { createTtlCache } from '../utils/ttlCache.js';

/**
 * Resolves a session's webhook URL (falling back to the global one) behind a short cache, so URL
 * changes made through the API take effect without restarting the session.
 */
export function createWebhookUrlResolver({ query, globalWebhookUrl = '', ttlMs = 30000, now = Date.now }) {
  const cache = createTtlCache({ ttlMs, now });
  return {
    async resolve(sessionId) {
      let entry = cache.get(sessionId);
      if (!entry) {
        const res = await query('SELECT webhook_url FROM sessions WHERE id = $1', [sessionId]);
        entry = { url: res.rows[0]?.webhook_url || null };
        cache.set(sessionId, entry);
      }
      return entry.url || globalWebhookUrl || null;
    },
    invalidate(sessionId) {
      cache.del(sessionId);
    }
  };
}
```

Di `src/services/webhookService.js`:
- ganti import di bagian atas menjadi:
  ```js
  import axios from 'axios';
  import { query } from '../database/db.js';
  import { config } from '../config/index.js';
  import { createWebhookUrlResolver } from './webhookUrlResolver.js';
  import { assertSafeUrl, safeRequestOptions } from '../utils/netGuard.js';

  const webhookUrlResolver = createWebhookUrlResolver({ query, globalWebhookUrl: config.globalWebhookUrl });

  /**
   * Drops the cached webhook URL of a session after it was changed.
   */
  export function invalidateWebhookUrl(sessionId) {
    webhookUrlResolver.invalidate(sessionId);
  }
  ```
- ganti awal `sendWebhookEvent` (resolusi URL) menjadi:
  ```js
  /**
   * Dispatches webhook event to the session's webhook URL (or the global one). Never throws.
   */
  export async function sendWebhookEvent(sessionId, eventType, payload) {
    let targetUrl;
    try {
      targetUrl = await webhookUrlResolver.resolve(sessionId);
    } catch (err) {
      console.error(`[Webhook] Failed to resolve webhook URL for ${sessionId}:`, err.message);
      targetUrl = config.globalWebhookUrl || null;
    }

    if (!targetUrl) {
      return; // No webhook configured
    }
  ```
- di blok `try` pengiriman, tambahkan guard dan opsi axios:
  ```js
    try {
      assertSafeUrl(targetUrl, { allowPrivate: config.allowPrivateUrls, label: 'Webhook URL' });
      const response = await axios.post(targetUrl, body, {
        timeout: 10000,
        maxRedirects: 0,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Gateway-Webhook/1.0'
        },
        ...safeRequestOptions({ allowPrivate: config.allowPrivateUrls })
      });
  ```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "fix: resolve webhook URL from DB with cache instead of a stale closure"`

---

### Task 10: DB helper + auth state transactional

**Files:**
- Modify: `src/database/db.js`, `src/database/schema.sql`, `src/database/postgresAuthState.js`
- Test: `test/postgresAuthState.test.js` (sebagian butuh Postgres)

- [ ] **Step 1: Test** — `test/postgresAuthState.test.js`

```js
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { createDb } from '../src/database/db.js';
import { clearAuthState, usePostgresAuthState } from '../src/database/postgresAuthState.js';

// Integration tests need a disposable PostgreSQL, e.g.:
//   docker run -d --name wagw-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:56999:5432 postgres:16-alpine
//   DB_TEST=1 DB_HOST=127.0.0.1 DB_PORT=56999 DB_USER=postgres DB_PASSWORD=test DB_NAME=postgres npm test
const skip = process.env.DB_TEST === '1' ? false : 'set DB_TEST=1 and DB_* env vars to run against PostgreSQL';
const SESSION = 'test-auth-state';
let pool;
let db;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  await pool.query(fs.readFileSync(new URL('../src/database/schema.sql', import.meta.url), 'utf8'));
  db = createDb(pool);
  await clearAuthState(SESSION, db);
});

after(async () => {
  if (!pool) return;
  await clearAuthState(SESSION, db);
  await pool.end();
});

test('read failures are thrown instead of silently generating new creds', async () => {
  const brokenDb = {
    query: async () => { throw new Error('connection refused'); },
    withTransaction: async () => {}
  };
  await assert.rejects(usePostgresAuthState(SESSION, brokenDb), /connection refused/);
});

test('creates fresh creds and persists them with saveCreds', { skip }, async () => {
  const first = await usePostgresAuthState(SESSION, db);
  assert.equal(first.state.creds.registered, false);
  await first.saveCreds();
  const second = await usePostgresAuthState(SESSION, db);
  assert.ok(Buffer.isBuffer(second.state.creds.noiseKey.public));
  assert.deepEqual(second.state.creds.noiseKey.public, first.state.creds.noiseKey.public);
});

test('keys.set writes and deletes in one batch and keys.get revives Buffers', { skip }, async () => {
  const { state } = await usePostgresAuthState(SESSION, db);
  await state.keys.set({
    'pre-key': {
      1: { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) },
      2: { public: Buffer.from([5]), private: Buffer.from([6]) }
    },
    session: { 'abc.0': Buffer.from('session-data') }
  });
  let keys = await state.keys.get('pre-key', ['1', '2', '3']);
  assert.deepEqual(Object.keys(keys).sort(), ['1', '2']);
  assert.deepEqual(keys['1'].public, Buffer.from([1, 2]));

  await state.keys.set({ 'pre-key': { 1: null } });
  keys = await state.keys.get('pre-key', ['1', '2']);
  assert.deepEqual(Object.keys(keys), ['2']);

  const sessions = await state.keys.get('session', ['abc.0']);
  assert.equal(sessions['abc.0'].toString(), 'session-data');
});

test('write failures are thrown instead of swallowed', { skip }, async () => {
  const failingDb = { query: db.query, withTransaction: async () => { throw new Error('db down'); } };
  const { state } = await usePostgresAuthState(SESSION, failingDb);
  await assert.rejects(
    state.keys.set({ 'pre-key': { 9: { public: Buffer.from([9]), private: Buffer.from([9]) } } }),
    /db down/
  );
});
```

- [ ] **Step 2: Run** → FAIL (`createDb` is not exported).

- [ ] **Step 3: Implementasi** — `src/database/db.js` (ganti `pool`/`query`, tambah `createDb`, migrasi):

```js
import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config/index.js';
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
  console.error('[PostgreSQL] Unexpected error on idle client:', err);
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

    console.log('[PostgreSQL] Database tables initialized and verified successfully.');
  } catch (error) {
    console.error('[PostgreSQL] Failed to initialize database tables:', error.message);
    throw error;
  }
}
```

Di `src/database/schema.sql`, tabel `sessions`:
```sql
    status VARCHAR(50) DEFAULT 'disconnected', -- disconnected, connecting, qr_ready, connected, reconnecting
    disconnect_reason VARCHAR(100), -- why the session last stopped (logged_out, connection_replaced, pairing_timeout, ...)
```

`src/database/postgresAuthState.js` (ganti seluruh isi):

```js
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { db as defaultDb } from './db.js';

const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (value) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

const UPSERT_SQL = `
  INSERT INTO baileys_auth_store (session_id, data_type, data_id, value, updated_at)
  SELECT $1, t.data_type, t.data_id, t.value::jsonb, NOW()
  FROM unnest($2::text[], $3::text[], $4::text[]) AS t(data_type, data_id, value)
  ON CONFLICT (session_id, data_type, data_id)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;

const DELETE_SQL = `
  DELETE FROM baileys_auth_store a
  USING unnest($2::text[], $3::text[]) AS t(data_type, data_id)
  WHERE a.session_id = $1 AND a.data_type = t.data_type AND a.data_id = t.data_id`;

/**
 * PostgreSQL Auth State Adapter for Baileys.
 * Database errors are thrown, never swallowed: returning "no data" on a failed read would make
 * Baileys generate fresh credentials, and a silently failed key write desynchronises the Signal
 * sessions (Bad MAC). Key writes are applied atomically in one transaction.
 */
export async function usePostgresAuthState(sessionId, db = defaultDb) {
  const credsRes = await db.query(
    `SELECT value FROM baileys_auth_store WHERE session_id = $1 AND data_type = 'creds' AND data_id = 'creds'`,
    [sessionId]
  );
  const creds = credsRes.rows[0]?.value ? deserialize(credsRes.rows[0].value) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          const res = await db.query(
            `SELECT data_id, value FROM baileys_auth_store
             WHERE session_id = $1 AND data_type = $2 AND data_id = ANY($3::text[])`,
            [sessionId, type, ids]
          );
          for (const row of res.rows) {
            if (!row.value) continue;
            let value = deserialize(row.value);
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[row.data_id] = value;
          }
          return data;
        },
        set: async (data) => {
          const upserts = [];
          const deletes = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) {
                upserts.push([type, id, serialize(value)]);
              } else {
                deletes.push([type, id]);
              }
            }
          }
          if (!upserts.length && !deletes.length) return;

          // Stable row order keeps concurrent transactions from deadlocking on each other
          const byKey = (a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1);
          upserts.sort(byKey);
          deletes.sort(byKey);

          await db.withTransaction(async (client) => {
            if (upserts.length) {
              await client.query(UPSERT_SQL, [
                sessionId,
                upserts.map(([type]) => type),
                upserts.map(([, id]) => id),
                upserts.map(([, , value]) => value)
              ]);
            }
            if (deletes.length) {
              await client.query(DELETE_SQL, [
                sessionId,
                deletes.map(([type]) => type),
                deletes.map(([, id]) => id)
              ]);
            }
          });
        }
      }
    },
    saveCreds: async () => {
      await db.query(UPSERT_SQL, [sessionId, ['creds'], ['creds'], [serialize(creds)]]);
    },
    clearState: () => clearAuthState(sessionId, db)
  };
}

/**
 * Deletes every stored credential and Signal key of a session.
 */
export async function clearAuthState(sessionId, db = defaultDb) {
  await db.query(`DELETE FROM baileys_auth_store WHERE session_id = $1`, [sessionId]);
}
```

- [ ] **Step 4: Run** `npm test` → PASS (test DB di-skip). Lalu jalankan integration test dengan Postgres sekali pakai:
```bash
docker run -d --name wagw-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:56999:5432 postgres:16-alpine
DB_TEST=1 DB_HOST=127.0.0.1 DB_PORT=56999 DB_USER=postgres DB_PASSWORD=test DB_NAME=postgres npm test
```
Expected: semua PASS, tanpa skip.

- [ ] **Step 5: Commit** — `git commit -m "fix: transactional Postgres auth state that never swallows DB errors"`

---

### Task 11: Rombak sessionManager

**Files:**
- Modify: `src/services/sessionManager.js` (ganti seluruh isi)

Perubahan perilaku:
- **Lock & reuse:** `initSession` dijalankan lewat `sessionLocks`. Sesi dengan socket yang masih `connecting`/`qr_ready`/`connected` dipakai ulang. Socket lama di-`end()` setelah ditandai `stopped`, sehingga event-nya diabaikan.
- **Error handling:** semua handler event dibungkus try/catch lewat `on(...)`.
- **Reconnect:** `decideReconnect` menentukan aksi. Status baru `reconnecting` untuk sesi yang menunggu backoff, dan `disconnect_reason` disimpan.
- **Opsi Baileys:**
  - `makeCacheableSignalKeyStore`;
  - `getMessage` dari tabel `messages`;
  - `msgRetryCounterCache` dan `cachedGroupMetadata` per sesi;
  - `markOnlineOnConnect: false`;
  - `Browsers.macOS('Google Chrome')`;
  - versi bawaan Baileys (bisa di-override `WA_VERSION`).
- **Pairing code:** menunggu event QR pertama (socket siap) sebelum `requestPairingCode`, nomor dinormalisasi, dan sesi yang sudah di-pair ditolak.
- **Restore:** hanya sesi yang sudah di-pair (`creds.account` ada). Status lain di-reset ke `disconnected`. Restore dijalankan bertahap.
- **Kirim pesan:**
  - target dinormalisasi;
  - media URL di-download sendiri lewat `fetchRemoteFile`;
  - `media_url` hanya menyimpan URL http(s);
  - `delayMs: 0` dihormati;
  - kegagalan simpan ke DB tidak menggagalkan respons.
- **Webhook:** `sendWebhookEvent` tidak lagi menerima URL dari closure.
- **`custom_name`:** tidak lagi terhapus, karena nilai `null` dipertahankan oleh `COALESCE`.

- [ ] **Step 1: Ganti seluruh isi `src/services/sessionManager.js`:**

```js
import makeWASocket, {
  Browsers,
  delay,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  proto
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { query } from '../database/db.js';
import { clearAuthState, usePostgresAuthState } from '../database/postgresAuthState.js';
import { extractMessageData, invalidateWebhookUrl, sendWebhookEvent } from './webhookService.js';
import { backoffDelay, decideReconnect } from './reconnectPolicy.js';
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import { normalizePhoneNumber, normalizeTarget } from '../utils/phone.js';
import { createKeyedLock } from '../utils/keyedLock.js';
import { createTtlCache } from '../utils/ttlCache.js';
import { assertSafeUrl, fetchRemoteFile } from '../utils/netGuard.js';

// Map of active in-memory sessions (at most one socket per session)
const activeSessions = new Map();

// Start, restart and logout of one session run one at a time, so a session never owns two sockets
const sessionLocks = createKeyedLock();

// Per-session caches that outlive individual sockets. Baileys requires msgRetryCounterCache to live
// outside the socket to avoid decrypt/encrypt retry loops across restarts.
const msgRetryCaches = new Map();
const groupMetadataCaches = new Map();

const RUNNING_STATUSES = new Set(['connecting', 'qr_ready', 'connected']);
const PAIRING_READY_TIMEOUT_MS = 20000;

// Pino logger for Baileys (silent/error level to keep terminal clean)
const logger = pino({ level: 'error' });

function getSessionCache(caches, sessionId, ttlMs) {
  if (!caches.has(sessionId)) {
    caches.set(sessionId, createTtlCache({ ttlMs }));
  }
  return caches.get(sessionId);
}

function phoneFromJid(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : null;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AppError(504, message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeSession(sessionData, message) {
  return {
    sessionId: sessionData.sessionId,
    status: sessionData.status,
    phoneNumber: sessionData.phoneNumber,
    message
  };
}

/**
 * Anti-ban simulation: sends typing indicator for a natural duration before sending actual message
 */
async function sendWithHumanSimulation(sock, jid, messageContent, customDelayMs = null) {
  try {
    // 1. Presence update - Typing / Recording
    const isAudio = messageContent.audio || messageContent.voice;
    await sock.sendPresenceUpdate(isAudio ? 'recording' : 'composing', jid);

    // 2. Calculate natural delay (an explicit delayMs, including 0, wins)
    let delayTime = customDelayMs;
    if (delayTime === null || delayTime === undefined) {
      const textLen = (messageContent.text || messageContent.caption || '').length;
      const baseDelay = config.antiBan.minTypingDelayMs;
      const variableDelay = Math.min(textLen * 35, config.antiBan.maxTypingDelayMs - baseDelay);
      const randomJitter = Math.floor(Math.random() * 400);
      delayTime = baseDelay + Math.max(0, variableDelay) + randomJitter;
    }

    await delay(delayTime);

    // 3. Pause typing indicator
    await sock.sendPresenceUpdate('paused', jid);

    // 4. Send the actual payload
    return await sock.sendMessage(jid, messageContent);
  } catch (error) {
    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}
    throw error;
  }
}

/**
 * Message lookup for Baileys retry requests and poll decryption (the `getMessage` socket option).
 */
async function loadStoredMessage(sessionId, key) {
  try {
    const res = await query(
      `SELECT raw_payload -> 'message' AS message FROM messages WHERE session_id = $1 AND message_id = $2`,
      [sessionId, key.id]
    );
    const message = res.rows[0]?.message;
    return message ? proto.Message.fromObject(message) : undefined;
  } catch (error) {
    console.error(`[Session ${sessionId}] getMessage lookup failed for ${key.id}:`, error.message);
    return undefined;
  }
}

/**
 * Closes a socket without triggering reconnect logic: its handlers ignore events once `stopped`.
 */
function teardownSocket(sessionData) {
  sessionData.stopped = true;
  clearTimeout(sessionData.reconnectTimer);
  sessionData.reconnectTimer = null;
  try {
    sessionData.sock.end(undefined);
  } catch (_) {}
}

function scheduleReconnect(sessionData, delayMs) {
  const { sessionId } = sessionData;
  sessionData.reconnectTimer = setTimeout(async () => {
    try {
      await initSession(sessionId, { isReconnect: true });
    } catch (error) {
      console.error(`[Session ${sessionId}] Reconnect attempt failed:`, error.message);
      // No new socket took over: keep retrying with backoff
      if (activeSessions.get(sessionId) === sessionData) {
        sessionData.reconnectAttempts += 1;
        scheduleReconnect(sessionData, backoffDelay(sessionData.reconnectAttempts, config.reconnect));
      }
    }
  }, delayMs);
}

async function handleQr(sessionData, qr) {
  const { sessionId } = sessionData;
  const qrCode = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
  Object.assign(sessionData, { qrCode, qrRaw: qr, status: 'qr_ready' });
  sessionData.resolveQrReady();

  await query(
    `UPDATE sessions SET qr_code = $1, status = 'qr_ready', updated_at = NOW() WHERE id = $2`,
    [qrCode, sessionId]
  );

  sendWebhookEvent(sessionId, 'connection.update', {
    status: 'qr_ready',
    qrRaw: qr,
    qrCode
  });
}

async function handleOpen(sessionData) {
  const { sessionId, sock } = sessionData;
  const phone = phoneFromJid(sock.user?.id);
  Object.assign(sessionData, {
    status: 'connected',
    qrCode: null,
    qrRaw: null,
    pairingCode: null,
    phoneNumber: phone,
    reconnectAttempts: 0
  });

  await query(
    `UPDATE sessions SET status = 'connected', qr_code = NULL, disconnect_reason = NULL, phone_number = $1, updated_at = NOW() WHERE id = $2`,
    [phone, sessionId]
  );

  console.log(`[Session ${sessionId}] Connected successfully! Phone: ${phone}`);

  sendWebhookEvent(sessionId, 'connection.update', {
    status: 'connected',
    phoneNumber: phone,
    user: sock.user
  });
}

async function handleClose(sessionData, lastDisconnect) {
  const { sessionId } = sessionData;
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  const decision = decideReconnect({
    statusCode,
    attempt: sessionData.reconnectAttempts,
    registered: sessionData.isRegistered(),
    ...config.reconnect
  });
  const status = decision.action === 'reconnect' ? 'reconnecting' : 'disconnected';
  Object.assign(sessionData, { status, qrCode: null, qrRaw: null });

  console.warn(
    `[Session ${sessionId}] Connection closed (code: ${statusCode}) -> ${decision.action} (${decision.reason})` +
      (decision.action === 'reconnect' ? ` in ${decision.delayMs}ms` : '')
  );

  // Act before touching the database so a DB outage cannot block the reconnect
  if (decision.action === 'reconnect') {
    sessionData.reconnectAttempts += 1;
    scheduleReconnect(sessionData, decision.delayMs);
  } else {
    sessionData.stopped = true;
    activeSessions.delete(sessionId);
    if (decision.action === 'logout') {
      console.log(`[Session ${sessionId}] Logged out. Clearing session auth keys.`);
      await clearAuthState(sessionId);
    }
  }

  await query(
    `UPDATE sessions SET status = $1, disconnect_reason = $2, qr_code = NULL, updated_at = NOW() WHERE id = $3`,
    [status, decision.reason, sessionId]
  );

  sendWebhookEvent(sessionId, 'connection.update', {
    status,
    statusCode,
    reason: lastDisconnect?.error?.message || 'Connection closed',
    disconnectReason: decision.reason,
    retryInMs: decision.delayMs ?? null
  });
}

async function handleIncomingMessage(sessionData, msg) {
  const { sessionId, sock } = sessionData;
  if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

  const remoteJid = msg.key.remoteJid;
  const fromMe = Boolean(msg.key.fromMe);
  const messageId = msg.key.id;
  const pushName = msg.pushName || '';
  const senderJid = msg.key.participant || remoteJid;

  // Extract and normalize message type and content
  const parsed = extractMessageData(msg);

  // Auto mark as read if configured and not from me
  if (!fromMe && config.antiBan.autoReadMessages) {
    try {
      await sock.readMessages([msg.key]);
    } catch (_) {}
  }

  // Store message in PostgreSQL
  await query(
    `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, push_name, message_type, content, raw_payload, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     ON CONFLICT (session_id, message_id) DO UPDATE
     SET status = EXCLUDED.status, updated_at = NOW()`,
    [
      sessionId,
      messageId,
      remoteJid,
      senderJid,
      fromMe,
      pushName,
      parsed.messageType,
      parsed.content,
      JSON.stringify(msg),
      fromMe ? 'sent' : 'received'
    ]
  );

  // Add direct download endpoint URL if message has media
  if (parsed.media) {
    parsed.media.downloadUrl = `/api/messages/${sessionId}/download/${messageId}`;
  }

  // Trigger Webhook Event with rich structured payload
  sendWebhookEvent(sessionId, 'message.received', {
    messageId,
    remoteJid,
    senderJid,
    fromMe,
    pushName,
    isGroup: remoteJid.endsWith('@g.us'),
    messageType: parsed.messageType,
    rawType: parsed.rawType,
    content: parsed.content,
    media: parsed.media,
    contextInfo: parsed.contextInfo,
    timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString()
  });
}

/**
 * Creates or retrieves a WhatsApp Session Socket. Safe to call repeatedly: a session that already
 * has a running socket keeps it instead of opening a second one.
 */
export function initSession(sessionId, options = {}) {
  return sessionLocks.run(sessionId, () => startSession(sessionId, options));
}

async function startSession(sessionId, { customName = null, webhookUrl = null, isReconnect = false } = {}) {
  const existing = activeSessions.get(sessionId);
  if (existing && !existing.stopped && RUNNING_STATUSES.has(existing.status)) {
    return describeSession(existing, 'Session is already running.');
  }
  if (webhookUrl) {
    assertSafeUrl(webhookUrl, { allowPrivate: config.allowPrivateUrls, label: 'webhookUrl' });
  }

  const reconnectAttempts = isReconnect && existing ? existing.reconnectAttempts : 0;
  if (existing) {
    teardownSocket(existing);
  }

  // Initialize DB record for session (NULL keeps the stored name/webhook)
  await query(
    `INSERT INTO sessions (id, custom_name, webhook_url, status, disconnect_reason, updated_at)
     VALUES ($1, $2, $3, 'connecting', NULL, NOW())
     ON CONFLICT (id) DO UPDATE
     SET custom_name = COALESCE(EXCLUDED.custom_name, sessions.custom_name),
         webhook_url = COALESCE(EXCLUDED.webhook_url, sessions.webhook_url),
         status = 'connecting',
         disconnect_reason = NULL,
         updated_at = NOW()`,
    [sessionId, customName || null, webhookUrl || null]
  );
  if (webhookUrl) {
    invalidateWebhookUrl(sessionId);
  }

  const { state, saveCreds } = await usePostgresAuthState(sessionId);
  const groupCache = getSessionCache(groupMetadataCaches, sessionId, 5 * 60 * 1000);

  const sock = makeWASocket({
    // Use the WA Web version bundled with Baileys; WA_VERSION overrides it if WhatsApp rejects it (405)
    ...(config.waVersion ? { version: config.waVersion } : {}),
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // A realistic browser is required for pairing codes and does not advertise automation
    browser: Browsers.macOS('Google Chrome'),
    // Keeps the phone receiving notifications
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache: getSessionCache(msgRetryCaches, sessionId, 60 * 60 * 1000),
    getMessage: (key) => loadStoredMessage(sessionId, key),
    // Without this every group send refetches participants (rate limits, potential bans)
    cachedGroupMetadata: async (jid) => {
      let metadata = groupCache.get(jid);
      if (!metadata) {
        metadata = await sock.groupMetadata(jid);
        groupCache.set(jid, metadata);
      }
      return metadata;
    }
  });

  let resolveQrReady;
  const sessionData = {
    sessionId,
    sock,
    status: 'connecting',
    qrCode: null,
    qrRaw: null,
    pairingCode: null,
    phoneNumber: phoneFromJid(state.creds.me?.id),
    reconnectAttempts,
    reconnectTimer: null,
    stopped: false,
    // Resolves on the first QR event, i.e. once the socket can accept a pairing-code request
    qrReady: new Promise((resolve) => {
      resolveQrReady = resolve;
    }),
    resolveQrReady: () => resolveQrReady(),
    isRegistered: () => Boolean(state.creds.account)
  };

  activeSessions.set(sessionId, sessionData);

  // Each handler is wrapped: an async error here would otherwise be an unhandled rejection that
  // kills the process and every session with it. Events from replaced sockets are ignored.
  const on = (event, handler) => {
    sock.ev.on(event, async (payload) => {
      if (sessionData.stopped || activeSessions.get(sessionId) !== sessionData) return;
      try {
        await handler(payload);
      } catch (error) {
        console.error(`[Session ${sessionId}] Error handling ${event}:`, error);
      }
    });
  };

  // Credentials updated listener
  on('creds.update', async () => {
    await saveCreds();
    const phone = phoneFromJid(sock.user?.id);
    if (phone && phone !== sessionData.phoneNumber) {
      sessionData.phoneNumber = phone;
      await query(`UPDATE sessions SET phone_number = $1, updated_at = NOW() WHERE id = $2`, [phone, sessionId]);
    }
  });

  // Connection update listener
  on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) await handleQr(sessionData, qr);
    if (connection === 'open') await handleOpen(sessionData);
    if (connection === 'close') await handleClose(sessionData, lastDisconnect);
  });

  // Incoming messages listener
  on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleIncomingMessage(sessionData, msg);
      } catch (err) {
        console.error(`[Session ${sessionId}] Error processing message:`, err);
      }
    }
  });

  // Group changes invalidate cached metadata; it is refetched lazily on the next group send
  on('groups.update', async (updates) => {
    for (const update of updates) groupCache.del(update.id);
  });
  on('group-participants.update', async ({ id }) => {
    groupCache.del(id);
  });

  return describeSession(sessionData, 'Session initialization triggered.');
}

/**
 * True when the session has a live socket (connecting, waiting for QR scan, or connected).
 */
export function isSessionRunning(sessionId) {
  const session = activeSessions.get(sessionId);
  return Boolean(session && !session.stopped && RUNNING_STATUSES.has(session.status));
}

/**
 * Requests an 8-digit WhatsApp pairing code (pair without scanning QR)
 */
export async function requestPairingCode(sessionId, phoneNumber, { countryCode } = {}) {
  const phone = normalizePhoneNumber(phoneNumber, countryCode ?? config.defaultCountryCode);

  let session = activeSessions.get(sessionId);
  if (!isSessionRunning(sessionId)) {
    await initSession(sessionId);
    session = activeSessions.get(sessionId);
  }
  if (!session) {
    throw new AppError(503, `Session "${sessionId}" failed to start.`);
  }
  if (session.status === 'connected' || session.isRegistered()) {
    throw new AppError(409, 'Device is already paired. Logout first to pair another number.');
  }

  // The socket accepts pairing requests only after the WhatsApp handshake (signalled by the first QR)
  await withTimeout(session.qrReady, PAIRING_READY_TIMEOUT_MS, 'Timed out waiting for WhatsApp to accept a pairing request.');

  const code = await session.sock.requestPairingCode(phone);
  session.pairingCode = code;
  return { code, phoneNumber: phone };
}

function getConnectedSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(409, `Session "${sessionId}" is not connected.`);
  }
  return session;
}

/**
 * Turns a URL, base64 data URL or Buffer into a Buffer. Remote URLs are downloaded here (SSRF guard,
 * size cap, timeout) instead of letting Baileys fetch arbitrary URLs.
 */
async function resolveMediaInput(input, label) {
  if (Buffer.isBuffer(input)) {
    return { buffer: input, contentType: null, sourceUrl: null };
  }
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    const { buffer, contentType } = await fetchRemoteFile(input, {
      allowPrivate: config.allowPrivateUrls,
      maxBytes: config.mediaMaxBytes
    });
    return { buffer, contentType, sourceUrl: input };
  }
  if (typeof input === 'string' && input.startsWith('data:')) {
    const commaIndex = input.indexOf(',');
    const meta = commaIndex === -1 ? '' : input.slice(5, commaIndex);
    if (!meta.endsWith(';base64')) {
      throw new AppError(400, `Invalid ${label}: data URLs must be base64 encoded.`);
    }
    return {
      buffer: Buffer.from(input.slice(commaIndex + 1), 'base64'),
      contentType: meta.slice(0, -';base64'.length) || null,
      sourceUrl: null
    };
  }
  throw new AppError(400, `Invalid ${label}: expected an http(s) URL, a base64 data URL, or a file upload.`);
}

async function saveOutgoingMessage(session, jid, result, { messageType, content, mediaUrl = null }) {
  if (!result?.key?.id) return;
  try {
    await query(
      `INSERT INTO messages (session_id, message_id, remote_jid, sender_jid, from_me, message_type, content, media_url, status, raw_payload)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, 'sent', $8::jsonb)
       ON CONFLICT (session_id, message_id) DO NOTHING`,
      [session.sessionId, result.key.id, jid, session.sock.user?.id || '', messageType, content, mediaUrl, JSON.stringify(result)]
    );
  } catch (error) {
    // Already sent: report success rather than inviting the client to retry and send a duplicate
    console.error(`[Session ${session.sessionId}] Failed to store sent message ${result.key.id}:`, error.message);
  }
}

/**
 * Send WhatsApp Text Message with simulated anti-ban typing presence
 */
export async function sendTextMessage(sessionId, to, text, options = {}) {
  const jid = normalizeTarget(to, options.countryCode ?? config.defaultCountryCode);
  const session = getConnectedSession(sessionId);

  const result = await sendWithHumanSimulation(session.sock, jid, { text }, options.delayMs);
  await saveOutgoingMessage(session, jid, result, { messageType: 'text', content: text });

  return {
    success: true,
    messageId: result.key.id,
    remoteJid: jid,
    status: 'sent'
  };
}

/**
 * Send WhatsApp Image Message with simulated anti-ban typing presence
 */
export async function sendImageMessage(sessionId, to, imageInput, caption = '', options = {}) {
  const jid = normalizeTarget(to, options.countryCode ?? config.defaultCountryCode);
  const session = getConnectedSession(sessionId);
  const media = await resolveMediaInput(imageInput, 'image');

  const result = await sendWithHumanSimulation(session.sock, jid, { image: media.buffer, caption }, options.delayMs);
  await saveOutgoingMessage(session, jid, result, { messageType: 'image', content: caption, mediaUrl: media.sourceUrl });

  return {
    success: true,
    messageId: result.key.id,
    remoteJid: jid,
    status: 'sent'
  };
}

/**
 * Send WhatsApp Attachment / Document with simulated anti-ban typing presence
 */
export async function sendAttachmentMessage(sessionId, to, docInput, fileName = 'file', mimetype = null, caption = '', options = {}) {
  const jid = normalizeTarget(to, options.countryCode ?? config.defaultCountryCode);
  const session = getConnectedSession(sessionId);
  const media = await resolveMediaInput(docInput, 'attachment');
  const resolvedMimetype = mimetype || media.contentType || 'application/octet-stream';

  const result = await sendWithHumanSimulation(
    session.sock,
    jid,
    { document: media.buffer, fileName, mimetype: resolvedMimetype, caption },
    options.delayMs
  );
  await saveOutgoingMessage(session, jid, result, {
    messageType: 'document',
    content: caption || fileName,
    mediaUrl: media.sourceUrl
  });

  return {
    success: true,
    messageId: result.key.id,
    remoteJid: jid,
    fileName,
    status: 'sent'
  };
}

/**
 * Retrieves session status and QR details
 */
export async function getSessionStatus(sessionId) {
  const memorySession = activeSessions.get(sessionId);
  const dbRes = await query(`SELECT * FROM sessions WHERE id = $1`, [sessionId]);

  if (dbRes.rows.length === 0) {
    return { exists: false, status: 'not_found' };
  }

  const row = dbRes.rows[0];
  return {
    exists: true,
    sessionId: row.id,
    customName: row.custom_name,
    status: memorySession ? memorySession.status : row.status,
    disconnectReason: row.disconnect_reason,
    phoneNumber: memorySession ? memorySession.phoneNumber : row.phone_number,
    qrCode: memorySession ? memorySession.qrCode : row.qr_code,
    pairingCode: memorySession ? memorySession.pairingCode : null,
    webhookUrl: row.webhook_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Returns all saved sessions
 */
export async function getAllSessions() {
  const res = await query(
    `SELECT id, phone_number, status, disconnect_reason, webhook_url, custom_name, created_at, updated_at FROM sessions ORDER BY created_at ASC`
  );
  return res.rows.map((row) => {
    const mem = activeSessions.get(row.id);
    return {
      ...row,
      status: mem ? mem.status : row.status,
      phoneNumber: mem ? mem.phoneNumber : row.phone_number
    };
  });
}

/**
 * Updates (or clears, with an empty value) the webhook URL of a session. Takes effect immediately.
 */
export async function setSessionWebhookUrl(sessionId, webhookUrl) {
  const url = webhookUrl ? String(webhookUrl).trim() : null;
  if (url) {
    assertSafeUrl(url, { allowPrivate: config.allowPrivateUrls, label: 'webhookUrl' });
  }
  const res = await query(`UPDATE sessions SET webhook_url = $1, updated_at = NOW() WHERE id = $2`, [url, sessionId]);
  if (res.rowCount === 0) {
    throw new AppError(404, `Session "${sessionId}" not found.`);
  }
  invalidateWebhookUrl(sessionId);
  return url;
}

/**
 * Logs out and clears a session
 */
export function logoutSession(sessionId) {
  return sessionLocks.run(sessionId, async () => {
    const session = activeSessions.get(sessionId);
    if (session) {
      // Mark first so the close event triggered by logout() is not treated as a disconnect
      session.stopped = true;
      clearTimeout(session.reconnectTimer);
      try {
        await session.sock.logout();
      } catch (_) {}
      teardownSocket(session);
      activeSessions.delete(sessionId);
    }
    await clearAuthState(sessionId);
    msgRetryCaches.delete(sessionId);
    groupMetadataCaches.delete(sessionId);
    await query(
      `UPDATE sessions SET status = 'disconnected', disconnect_reason = 'logged_out', qr_code = NULL, phone_number = NULL, updated_at = NOW() WHERE id = $1`,
      [sessionId]
    );
    return { success: true, message: `Session ${sessionId} logged out.` };
  });
}

/**
 * Deletes a session completely from DB
 */
export async function deleteSession(sessionId) {
  await logoutSession(sessionId);
  await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  invalidateWebhookUrl(sessionId);
  return { success: true, message: `Session ${sessionId} deleted.` };
}

/**
 * Auto-restore paired sessions on system startup, one at a time to avoid a connection burst
 */
export async function restoreSessions() {
  try {
    const res = await query(
      `SELECT s.id FROM sessions s
       WHERE s.status IN ('connected', 'connecting', 'reconnecting')
         AND EXISTS (
           SELECT 1 FROM baileys_auth_store a
           WHERE a.session_id = s.id AND a.data_type = 'creds' AND a.data_id = 'creds' AND a.value ? 'account'
         )
       ORDER BY s.created_at ASC`
    );
    const sessionIds = res.rows.map((row) => row.id);

    // Statuses left over from the previous process are stale; unpaired sessions wait for an explicit /init
    await query(
      `UPDATE sessions
       SET status = 'disconnected', qr_code = NULL, disconnect_reason = COALESCE(disconnect_reason, 'not_restored'), updated_at = NOW()
       WHERE status <> 'disconnected' AND NOT (id = ANY($1::text[]))`,
      [sessionIds]
    );

    console.log(`[Restore] Found ${sessionIds.length} paired session(s) to restore.`);

    (async () => {
      for (const [index, sessionId] of sessionIds.entries()) {
        if (index > 0) await delay(config.restoreStaggerMs);
        console.log(`[Restore] Restoring session: ${sessionId}`);
        try {
          await initSession(sessionId);
        } catch (err) {
          console.error(`[Restore] Failed to restore session ${sessionId}:`, err.message);
        }
      }
    })();
  } catch (error) {
    console.error('[Restore] Error restoring sessions from database:', error.message);
  }
}

/**
 * Decrypts and downloads binary media (image, video, document, audio, etc.) by messageId
 */
export async function downloadMediaByMessageId(sessionId, messageId) {
  const dbRes = await query(
    `SELECT raw_payload, message_type FROM messages WHERE session_id = $1 AND message_id = $2`,
    [sessionId, messageId]
  );

  if (dbRes.rows.length === 0 || !dbRes.rows[0].raw_payload) {
    throw new AppError(404, `Message "${messageId}" not found in session "${sessionId}" or has no raw payload.`);
  }

  // ... (sisa fungsi tidak berubah dari versi lama)
}
```

Catatan: bagian akhir `downloadMediaByMessageId` (blok `try { const buffer = await downloadMediaMessage(...)` sampai akhir) disalin persis dari versi lama.

- [ ] **Step 2: Cek sintaks** — `node --check src/services/sessionManager.js` → tidak ada output.
- [ ] **Step 3: Commit** — `git commit -m "fix: single socket per session, reconnect policy, crash-proof handlers, recommended Baileys config"`

---

### Task 12: Controller dan route

**Files:**
- Modify: `src/controllers/sessionController.js`, `src/controllers/messageController.js`, `src/routes/index.js`, `src/routes/sessionRoutes.js`, `src/routes/messageRoutes.js`

- [ ] **Step 1: `src/controllers/sessionController.js` (ganti seluruh isi)**

```js
import {
  initSession as initSessionService,
  getSessionStatus,
  getAllSessions,
  isSessionRunning,
  requestPairingCode as requestPairingCodeService,
  logoutSession,
  deleteSession as deleteSessionService,
  setSessionWebhookUrl
} from '../services/sessionManager.js';
import { createQrLinkToken } from '../middlewares/auth.js';
import { config } from '../config/index.js';
import { AppError, sendError } from '../utils/errors.js';
import { assertSessionId } from '../utils/validation.js';
import { renderConnectedPage, renderInitializingPage, renderMessagePage, renderQrPage } from '../views/sessionPages.js';

/**
 * Browser link to the QR page. With an API key configured it carries a signed token that only
 * works for this session and expires after QR_LINK_TTL_SECONDS.
 */
function buildQrPageLink(sessionId) {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/qr?format=html`;
  if (!config.apiKey) {
    return { url: path, expiresAt: null };
  }
  const { token, expiresAt } = createQrLinkToken(sessionId);
  return { url: `${path}&token=${encodeURIComponent(token)}`, expiresAt };
}

export async function initSession(req, res) {
  try {
    const { sessionId, customName, webhookUrl } = req.body;
    assertSessionId(sessionId);

    await initSessionService(sessionId, { customName, webhookUrl });

    // Allow quick delay for initial QR generation
    await new Promise((r) => setTimeout(r, 1000));
    const status = await getSessionStatus(sessionId);

    return res.status(200).json({
      success: true,
      message: 'Session initialization triggered.',
      session: status,
      qrPage: buildQrPageLink(sessionId)
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function createQrLink(req, res) {
  try {
    const { sessionId } = req.params;
    const status = await getSessionStatus(sessionId);
    if (!status.exists) {
      throw new AppError(404, `Session "${sessionId}" not found.`);
    }
    return res.status(200).json({ success: true, sessionId, qrPage: buildQrPageLink(sessionId) });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function getQrCode(req, res) {
  try {
    const { sessionId } = req.params;
    const wantsHtml = req.query.format === 'html' || req.query.format === 'image';
    let status = await getSessionStatus(sessionId);

    if (!status.exists) {
      const error = `Session "${sessionId}" not found. Create it first with POST /api/sessions/init.`;
      return wantsHtml
        ? res.status(404).send(renderMessagePage(sessionId, { title: 'Session not found', message: error }))
        : res.status(404).json({ success: false, error });
    }

    // Reading the QR never starts a session. A running one gets up to 3 seconds to produce a QR.
    if (!isSessionRunning(sessionId)) {
      const error = status.status === 'reconnecting'
        ? 'Session is reconnecting. Try again shortly.'
        : 'Session is not running. Start it with POST /api/sessions/init.';
      return wantsHtml
        ? res.status(409).send(renderMessagePage(sessionId, { title: 'Session not running', message: error, refreshMs: 5000 }))
        : res.status(409).json({ success: false, status: status.status, disconnectReason: status.disconnectReason, error });
    }

    for (let attempt = 0; attempt < 6 && status.status !== 'connected' && !status.qrCode; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      status = await getSessionStatus(sessionId);
    }

    if (status.status === 'connected') {
      return wantsHtml
        ? res.send(renderConnectedPage(sessionId, status.phoneNumber))
        : res.status(200).json({
          success: true,
          status: 'connected',
          phoneNumber: status.phoneNumber,
          message: 'Device is already connected. QR code is not needed.'
        });
    }

    if (!status.qrCode) {
      return wantsHtml
        ? res.send(renderInitializingPage(sessionId))
        : res.status(200).json({
          success: true,
          status: status.status || 'connecting',
          message: 'Session is initializing. QR code is not ready yet. Try again in 2 seconds.',
          qrCode: null
        });
    }

    return wantsHtml
      ? res.send(renderQrPage(sessionId, status.qrCode))
      : res.status(200).json({ success: true, sessionId, status: status.status, qrCode: status.qrCode });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function requestPairingCode(req, res) {
  try {
    const { sessionId } = req.params;
    const { phoneNumber, countryCode } = req.body;

    if (!phoneNumber) {
      throw new AppError(400, 'phoneNumber is required (e.g. 08123456789 or 628123456789).');
    }

    const { code, phoneNumber: normalizedPhone } = await requestPairingCodeService(sessionId, phoneNumber, { countryCode });

    return res.status(200).json({
      success: true,
      sessionId,
      phoneNumber: normalizedPhone,
      pairingCode: code,
      instruction: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link with phone number.'
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function getStatus(req, res) {
  try {
    const { sessionId } = req.params;
    const status = await getSessionStatus(sessionId);
    return res.status(status.exists ? 200 : 404).json({
      success: status.exists,
      session: status
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function listSessions(req, res) {
  try {
    const sessions = await getAllSessions();
    return res.status(200).json({
      success: true,
      count: sessions.length,
      sessions
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function updateWebhook(req, res) {
  try {
    const { sessionId } = req.params;
    const webhookUrl = await setSessionWebhookUrl(sessionId, req.body.webhookUrl);

    return res.status(200).json({
      success: true,
      message: `Webhook updated for session ${sessionId}`,
      webhookUrl
    });
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function logout(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await logoutSession(sessionId);
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}

export async function deleteSession(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await deleteSessionService(sessionId);
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'SessionController');
  }
}
```

- [ ] **Step 2: `src/controllers/messageController.js` (ganti seluruh isi)**

```js
import {
  sendTextMessage,
  sendImageMessage,
  sendAttachmentMessage,
  requestPairingCode,
  downloadMediaByMessageId
} from '../services/sessionManager.js';
import { query } from '../database/db.js';
import { config } from '../config/index.js';
import { AppError, sendError } from '../utils/errors.js';
import { assertSessionId, parseOptionalInt } from '../utils/validation.js';

function parseSendOptions(body) {
  return {
    delayMs: parseOptionalInt(body.delayMs, { name: 'delayMs', min: 0, max: config.antiBan.maxRequestDelayMs }),
    countryCode: body.countryCode === undefined || body.countryCode === '' ? undefined : String(body.countryCode)
  };
}

export async function sendText(req, res) {
  try {
    const { sessionId, to, text } = req.body;

    if (!sessionId || !to || !text) {
      throw new AppError(400, 'Required fields missing: sessionId, to, text are required.');
    }
    assertSessionId(sessionId);

    const result = await sendTextMessage(sessionId, to, text, parseSendOptions(req.body));
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function sendImage(req, res) {
  try {
    const { sessionId, to, caption, imageUrl } = req.body;
    // Support multipart file upload as fallback
    const imageInput = req.file ? req.file.buffer : imageUrl;

    if (!sessionId || !to || !imageInput) {
      throw new AppError(400, 'Required fields missing: sessionId, to, and imageUrl (or file upload) are required.');
    }
    assertSessionId(sessionId);

    const result = await sendImageMessage(sessionId, to, imageInput, caption || '', parseSendOptions(req.body));
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function sendAttachment(req, res) {
  try {
    const { sessionId, to, attachmentUrl, fileName, mimetype, caption } = req.body;
    const docInput = req.file ? req.file.buffer : attachmentUrl;

    if (!sessionId || !to || !docInput) {
      throw new AppError(400, 'Required fields missing: sessionId, to, and attachmentUrl (or file upload) are required.');
    }
    assertSessionId(sessionId);

    const result = await sendAttachmentMessage(
      sessionId,
      to,
      docInput,
      fileName || req.file?.originalname || 'file',
      mimetype || req.file?.mimetype || null,
      caption || '',
      parseSendOptions(req.body)
    );
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function sendPairingCode(req, res) {
  try {
    const { sessionId, phoneNumber, countryCode } = req.body;

    if (!sessionId || !phoneNumber) {
      throw new AppError(400, 'sessionId and phoneNumber are required.');
    }
    assertSessionId(sessionId);

    const { code, phoneNumber: normalizedPhone } = await requestPairingCode(sessionId, phoneNumber, { countryCode });

    return res.status(200).json({
      success: true,
      sessionId,
      phoneNumber: normalizedPhone,
      pairingCode: code,
      message: 'WhatsApp pairing code generated successfully.'
    });
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function getMessages(req, res) {
  try {
    const { sessionId } = req.params;
    const { remoteJid, type } = req.query;
    const limit = parseOptionalInt(req.query.limit, { name: 'limit', min: 1, max: 200, defaultValue: 50 });
    const offset = parseOptionalInt(req.query.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 });

    let sql = `SELECT * FROM messages WHERE session_id = $1`;
    const params = [sessionId];

    if (remoteJid) {
      params.push(`%${remoteJid}%`);
      sql += ` AND remote_jid LIKE $${params.length}`;
    }

    if (type) {
      params.push(type);
      sql += ` AND message_type = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    return res.status(200).json({
      success: true,
      sessionId,
      count: result.rows.length,
      messages: result.rows
    });
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}

export async function downloadMedia(req, res) {
  try {
    const { sessionId, messageId } = req.params;
    const { format, base64 } = req.query;

    const media = await downloadMediaByMessageId(sessionId, messageId);

    if (base64 === 'true' || format === 'json' || format === 'base64') {
      return res.status(200).json({
        success: true,
        sessionId,
        messageId,
        fileName: media.fileName,
        mimetype: media.mimetype,
        fileLength: media.fileLength,
        base64: `data:${media.mimetype};base64,${media.buffer.toString('base64')}`
      });
    }

    res.setHeader('Content-Type', media.mimetype);
    res.setHeader('Content-Length', media.fileLength);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(media.fileName)}"`);
    return res.send(media.buffer);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}
```

- [ ] **Step 3: Routes.**

`src/routes/sessionRoutes.js`:
```js
import express from 'express';
import {
  initSession,
  getQrCode,
  createQrLink,
  requestPairingCode,
  getStatus,
  listSessions,
  updateWebhook,
  logout,
  deleteSession
} from '../controllers/sessionController.js';
import { apiKeyAuth, qrPageAuth } from '../middlewares/auth.js';
import { validateSessionIdParam } from '../utils/validation.js';

const router = express.Router();

router.param('sessionId', validateSessionIdParam);

// The QR page can be opened in a browser with a signed ?token= link instead of the API key header
router.get('/:sessionId/qr', qrPageAuth, getQrCode);

// Every other session route requires the x-api-key header
router.use(apiKeyAuth);
router.post('/init', initSession);
router.get('/', listSessions);
router.get('/:sessionId/status', getStatus);
router.post('/:sessionId/qr-link', createQrLink);
router.post('/:sessionId/pairing-code', requestPairingCode);
router.put('/:sessionId/webhook', updateWebhook);
router.post('/:sessionId/logout', logout);
router.delete('/:sessionId', deleteSession);

export default router;
```

`src/routes/messageRoutes.js`: tambahkan import `validateSessionIdParam` dan `router.param('sessionId', validateSessionIdParam);` tepat setelah `const router = express.Router();`.

`src/routes/index.js`:
```js
import express from 'express';
import sessionRoutes from './sessionRoutes.js';
import messageRoutes from './messageRoutes.js';
import { apiKeyAuth } from '../middlewares/auth.js';
import { config } from '../config/index.js';

const router = express.Router();

// Health Check
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Unauthenticated test webhook receiver for local debugging only
if (config.nodeEnv !== 'production') {
  router.post('/webhook-test', (req, res) => {
    console.log('----------------------------------------------------');
    console.log('[Webhook Test Receiver] Received Payload:');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('----------------------------------------------------');
    res.status(200).json({ received: true });
  });
}

// Session routes apply auth themselves (the QR page also accepts signed links)
router.use('/sessions', sessionRoutes);
router.use('/messages', apiKeyAuth, messageRoutes);

export default router;
```

- [ ] **Step 4: Cek sintaks** — `for f in src/controllers/*.js src/routes/*.js; do node --check $f; done`. Lalu `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "fix: 4xx errors, input validation, QR page links and route-level auth"`

---

### Task 13: Entry point, Docker, dan dokumentasi

**Files:**
- Modify: `src/index.js`, `docker-compose.yml`, `.gitignore`, `README.md`
- Create: `.dockerignore`

- [ ] **Step 1: `src/index.js`**
  - import `validateConfig` dari `./config/index.js`;
  - log HTTP memakai `req.originalUrl.split('?')[0]`;
  - error handler memakai `err.status || err.statusCode || 500` (JSON rusak dibalas 400, body terlalu besar 413);
  - landing page menyebut `qr-link`;
  - tambahkan di atas `startServer`:

```js
// Last line of defence: log stray promise rejections instead of letting Node kill every session
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});
```
dan di awal `startServer()` (di dalam `try`):
```js
    validateConfig();
    if (!config.apiKey) {
      console.warn('[Security] API_KEY is not set: the API is unauthenticated. Only acceptable for local development.');
    }
```

- [ ] **Step 2: `docker-compose.yml`**
  - port Postgres → `"127.0.0.1:${DB_PORT:-5432}:5432"`;
  - `API_KEY: ${API_KEY:?Set API_KEY (min. 16 characters) in .env}`;
  - env baru: `DEFAULT_COUNTRY_CODE`, `ALLOW_PRIVATE_URLS`, `WA_VERSION`, `MEDIA_MAX_BYTES`, `QR_LINK_TTL_SECONDS`.

- [ ] **Step 3: `.gitignore` dan `.dockerignore`**
  - `.gitignore` → `/node_modules`, `.env`, `.DS_Store`;
  - `.dockerignore` → `node_modules`, `.git`, `.env`, `.DS_Store`, `test`, `docs`;
  - `git rm --cached src/.DS_Store`.

- [ ] **Step 4: README** — tambahkan:
  - bagian Autentikasi: header `x-api-key`, signed QR link;
  - instruksi QR yang baru;
  - normalisasi nomor dan `countryCode`;
  - `delayMs` 0–15000;
  - status `reconnecting` + tabel `disconnectReason`;
  - tabel env baru, dengan catatan `ALLOW_PRIVATE_URLS` untuk webhook internal (misalnya n8n).

- [ ] **Step 5: Commit** — `git commit -m "chore: enforce config at startup, lock down compose, document Fase 0 changes"`

---

### Task 14: Verifikasi end-to-end

- [ ] **Step 1: Unit + integration test**
```bash
DB_TEST=1 DB_HOST=127.0.0.1 DB_PORT=56999 DB_USER=postgres DB_PASSWORD=test DB_NAME=postgres npm test
```
Expected: semua PASS, 0 skip.

- [ ] **Step 2: Smoke test server** (Postgres test, `API_KEY` 24+ karakter, `NODE_ENV=production`, `PORT=3999`). Expected:

| Request | Expected |
|---|---|
| `NODE_ENV=production` tanpa `API_KEY` | Proses keluar dengan pesan `API_KEY is required` |
| `GET /api/health` | 200 |
| `POST /api/sessions/init` tanpa header | 401; dengan `?apiKey=` juga 401 |
| `POST /api/sessions/init` dengan header | 200 + `qrPage.url` |
| `POST /api/sessions/init` kedua kali | Socket tidak bertambah (`Session is already running.`) |
| `GET qrPage.url` (tanpa header) | 200, HTML berisi QR |
| `GET qrPage.url` dengan token diubah | 401 |
| `GET /api/sessions/%3Cscript%3E/qr` | 400 |
| `GET /api/sessions/tidak-ada/qr` (dengan header) | 404, tanpa row baru di `sessions` |
| `send-text` ke sesi yang belum connect | 409 |
| `send-text` dengan `to: "abc"` | 400 |
| `PUT /webhook` ke `http://127.0.0.1:9/x` | 400 |
| `docker pause` Postgres selama sesi `qr_ready` | Proses tetap hidup (error di-log); setelah `unpause`, `GET /api/health` 200 |
| `DELETE /api/sessions/:id` | 200, socket ditutup |

- [ ] **Step 3: Bersihkan** — `docker rm -f wagw-test-pg`, matikan server.
