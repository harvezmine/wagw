# Fase 2 — Setara Fonnte Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menyamai fitur inti Fonnte di atas pondasi Fase 1:
- endpoint kirim terpadu untuk 13 tipe pesan (termasuk reply, mention, reaksi, edit, hapus);
- kirim massal multi-target dengan variabel `{name}`/`{varN}`;
- validasi nomor (cache + throttle) dan API grup;
- pengaturan perilaku per sesi (baca otomatis, tolak panggilan, abaikan grup);
- API key multi-tenant dengan scope sesi dan IP allowlist;
- adapter yang kompatibel dengan API & webhook Fonnte, untuk migrasi tanpa ubah kode klien.

**Architecture:**
- **Validasi & konstruksi pesan:** modul murni yang bisa di-unit-test. `messageContent` memvalidasi input dan membangun konten Baileys; `bulkTargets` mem-parse target dan template.
- **Pengiriman:** tetap lewat antrian Fase 1. `deliverQueuedMessage` memakai builder yang sama, jadi semua tipe pesan mendapat pacing, retry, dan status.
- **Auth:**
  - Master `API_KEY` = admin.
  - Kunci tenant (`wagw_…`) disimpan sebagai hash SHA-256 dan hanya bisa mengakses sesinya.
  - Setiap route ber-`:sessionId` dicek aksesnya secara eksplisit.
- **Adapter Fonnte:** router terpisah di `/fonnte`. Mapping parameter dan transform webhook berupa fungsi murni.

**Tech Stack:** Node.js 22, Express 4, Baileys 7.0.0-rc14, PostgreSQL 16, `node:test`.

---

## Keputusan desain

| Topik | Keputusan | Alasan |
|---|---|---|
| Endpoint kirim | `POST /api/messages/send` untuk semua tipe; `send-text/image/attachment` tetap ada sebagai alias | Satu skema, klien lama tidak rusak |
| Tipe pesan | text, image, video, audio, voice, document, sticker, location, contact, poll, reaction, edit, delete + `replyTo`, `mentions` | Bentuk konten diverifikasi dari tipe Baileys v7 (`AnyMessageContent`) |
| reaction/edit/delete | Target pesan dicari di tabel `messages` lewat `messageId`; `to` diambil dari pesan itu | Butuh key asli (remoteJid, fromMe, participant) |
| Voice note | Selalu `audio/ogg; codecs=opus` + `ptt: true` | WhatsApp hanya memutar voice note OGG/Opus; tidak ada transcoding (tanpa ffmpeg) |
| Multi-target | Sintaks Fonnte `nomor\|nama\|var1,…` atau array. Target tidak valid dilaporkan per target (tidak menggagalkan semua). Duplikat dibuang. Maks `BULK_MAX_TARGETS` (500). Selalu async (202) | Partial success lebih berguna. Pacing antrian tetap berlaku |
| Media massal | Hanya URL (di-download saat kirim, dengan cache memori kecil per URL) | Menyimpan bytes upload × 500 baris akan membengkakkan DB |
| Validasi nomor | Hasil di-cache di Postgres (7 hari), lookup diserialisasi per sesi dengan jeda minimal 3 detik antar batch 50, maks 50 nomor per request | Riset: lookup kontak massal sendiri merupakan sinyal ban |
| Grup | List dari cache (10 menit); `refresh` paling cepat sekali per menit; detail grup (participants) memakai cache metadata Fase 0 | Fonnte sendiri memperingatkan fetch grup berulang berisiko ban |
| API key tenant | Format `wagw_<prefix10hex>_<secret43>`, hash SHA-256 (secret acak 256-bit, jadi tanpa bcrypt), cache 60 detik, `last_used_at` di-update paling sering sekali per menit | Lookup cepat, revoke berlaku seketika di instance ini |
| Akses sesi | `requireSessionAccess` per route + `assertSessionAccess` untuk `sessionId` di body; list difilter | Eksplisit; tidak bergantung pada urutan `router.param` |
| Adapter Fonnte | `POST /fonnte/send`, `/validate`, `/device`, `/get-whatsapp-group`, `/fetch-group`, `/delete-message`. Token = kunci tenant yang terikat ke **tepat satu** sesi; beberapa token dipisah koma = rotator. Selalu HTTP 200 + `status:false/true` (perilaku Fonnte) | Drop-in: ganti base URL & token saja |
| Webhook format Fonnte | Per sesi `webhookFormat: "fonnte"` → payload pesan masuk, status pesan, dan connect/disconnect versi Fonnte | Penerima webhook bekas Fonnte tetap jalan |

Di luar scope: autoreply/flow, kontak, template, OpenAPI, konektor n8n/Chatwoot (prioritas Fase 3); S3, Redis, Cloud API.

## Struktur file

| File | Status | Tanggung jawab |
|---|---|---|
| `src/services/messageContent.js` | baru | Validasi input per tipe, konten Baileys, presence, teks riwayat, vCard |
| `src/services/bulkTargets.js` | baru | Parse target Fonnte-style + render `{name}`/`{varN}` |
| `src/services/sessionSettings.js` | baru | Default + validasi pengaturan sesi |
| `src/services/numberCheck.js` | baru | Checker nomor (cache + throttle) + store Postgres |
| `src/services/numberService.js` | baru | Validasi nomor untuk API |
| `src/services/apiKeys.js` | baru | Generate/hash/store kunci tenant, IP allowlist |
| `src/fonnte/fonnteParams.js`, `src/fonnte/fonnteWebhook.js`, `src/fonnte/fonnteRoutes.js` | baru | Adapter Fonnte |
| `src/controllers/keysController.js`, `src/routes/keysRoutes.js` | baru | API `/api/keys` |
| `src/database/migrations/004_tenants_settings_checks.sql` | baru | `api_keys`, `number_checks`, `sessions.settings`, `sessions.webhook_format` |
| `src/middlewares/auth.js` | tulis ulang | Auth master/tenant, akses sesi, QR link |
| `src/services/messageService.js` | ubah | Submit generik, batch, key pesan |
| `src/services/sessionManager.js` | ubah | Delivery semua tipe, quote, grup, settings, panggilan |
| `src/services/outboundQueue.js` | ubah | Filter `sessionIds` di `list` |
| `src/services/webhookConfigResolver.js`, `webhookService.js` | ubah | Format webhook + nomor device |
| controllers/routes/index/config | ubah | Endpoint baru, scoping, trust proxy, mount `/fonnte` |

Environment: Node `$HOME/.nvm/versions/node/v22.21.1/bin`; Postgres test di `127.0.0.1:56999` (lihat plan Fase 1).

---

### Task 1: Config + migrasi 004

**Files:** Modify `src/config/index.js`. Create `src/database/migrations/004_tenants_settings_checks.sql`.

- [ ] **Step 1: Config** (field baru di objek `config`):
```js
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  bulk: {
    maxTargets: envInt('BULK_MAX_TARGETS', 500)
  },
  validate: {
    maxNumbers: envInt('VALIDATE_MAX_NUMBERS', 50),
    minIntervalMs: envInt('VALIDATE_MIN_INTERVAL_MS', 3000),
    cacheTtlMs: envInt('VALIDATE_CACHE_DAYS', 7) * 24 * 60 * 60 * 1000
  },
  groups: {
    cacheTtlMs: envInt('GROUPS_CACHE_MINUTES', 10) * 60 * 1000,
    refreshMinIntervalMs: 60 * 1000
  },
```
dengan helper:
```js
/**
 * Express "trust proxy" setting: unset/false, true, a hop count, or a list such as "loopback, 10.0.0.0/8".
 */
function parseTrustProxy(value) {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}
```
- [ ] **Step 2: Migrasi**
```sql
-- Per-session behaviour settings and webhook payload format
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS webhook_format VARCHAR(20) NOT NULL DEFAULT 'default';

-- Tenant API keys: limited to a set of sessions and optionally to source IPs. Only a hash is stored.
CREATE TABLE IF NOT EXISTS api_keys (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL UNIQUE,
    key_hash CHAR(64) NOT NULL,
    session_ids TEXT[], -- NULL = every session
    ip_allowlist TEXT[], -- NULL = any IP
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Cache of "is this number on WhatsApp" lookups (bulk contact discovery is a ban signal)
CREATE TABLE IF NOT EXISTS number_checks (
    phone VARCHAR(20) PRIMARY KEY,
    exists_on_whatsapp BOOLEAN NOT NULL,
    jid VARCHAR(150),
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```
- [ ] **Step 3:** Jalankan test DB (`migrate.test.js` otomatis mencakup 004) → PASS. **Commit** `feat(db): migration for API keys, number checks and session settings`.

---

### Task 2: Konten pesan (`messageContent`)

**Files:**
- Create: `src/services/messageContent.js`
- Test: `test/messageContent.test.js`

- [ ] **Step 1: Test**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageContent, buildVcard, historyText, parseMessageInput, presenceFor } from '../src/services/messageContent.js';

test('defaults to a text message and requires text', () => {
  assert.deepEqual(parseMessageInput({ text: 'Halo' }), { type: 'text', payload: { text: 'Halo' }, media: null });
  assert.throws(() => parseMessageInput({}), { status: 400 });
  assert.throws(() => parseMessageInput({ type: 'fax', text: 'x' }), { status: 400 });
});

test('media messages need a URL, base64 or upload and keep caption/fileName/mimetype', () => {
  const doc = parseMessageInput({ type: 'document', caption: 'Invoice', media: { url: 'https://x.test/a.pdf', fileName: 'a.pdf' } });
  assert.deepEqual(doc, { type: 'document', payload: { caption: 'Invoice', fileName: 'a.pdf' }, media: 'https://x.test/a.pdf' });
  const upload = parseMessageInput({ type: 'image' }, { file: { buffer: Buffer.from('img'), mimetype: 'image/png', originalname: 'p.png' } });
  assert.deepEqual(upload.payload, { mimetype: 'image/png' });
  assert.ok(Buffer.isBuffer(upload.media));
  assert.deepEqual(parseMessageInput({ type: 'voice', caption: 'ignored', media: { url: 'https://x.test/v.ogg' } }).payload, {});
  assert.throws(() => parseMessageInput({ type: 'image' }), { status: 400 });
});

test('location, contact and poll are validated', () => {
  assert.deepEqual(parseMessageInput({ type: 'location', location: { latitude: '-6.2', longitude: 106.8, name: 'Kantor' } }).payload,
    { latitude: -6.2, longitude: 106.8, name: 'Kantor' });
  assert.throws(() => parseMessageInput({ type: 'location', location: { latitude: 91, longitude: 0 } }), { status: 400 });

  assert.deepEqual(parseMessageInput({ type: 'contact', contact: { name: 'Budi', phone: '0812-3456-789' } }, { countryCode: '62' }).payload,
    { contacts: [{ name: 'Budi', phone: '628123456789' }] });
  assert.throws(() => parseMessageInput({ type: 'contact', contacts: [] }), { status: 400 });

  assert.deepEqual(parseMessageInput({ type: 'poll', poll: { name: 'Menu?', options: ['A', 'B'] } }).payload,
    { name: 'Menu?', options: ['A', 'B'], selectableCount: 1 });
  assert.throws(() => parseMessageInput({ type: 'poll', poll: { name: 'x', options: ['A'] } }), { status: 400 });
  assert.throws(() => parseMessageInput({ type: 'poll', poll: { name: 'x', options: ['A', 'A'] } }), { status: 400 });
});

test('reaction, edit and delete target a messageId', () => {
  assert.deepEqual(parseMessageInput({ type: 'reaction', messageId: 'ABC', emoji: '👍' }).payload, { messageId: 'ABC', emoji: '👍' });
  assert.deepEqual(parseMessageInput({ type: 'reaction', messageId: 'ABC' }).payload, { messageId: 'ABC', emoji: '' });
  assert.deepEqual(parseMessageInput({ type: 'edit', messageId: 'ABC', text: 'fixed' }).payload, { messageId: 'ABC', text: 'fixed' });
  assert.deepEqual(parseMessageInput({ type: 'delete', messageId: 'ABC' }).payload, { messageId: 'ABC' });
  assert.throws(() => parseMessageInput({ type: 'delete' }), { status: 400 });
});

test('builds Baileys content for every type', () => {
  const media = { buffer: Buffer.from('x'), contentType: 'audio/mpeg' };
  const key = { remoteJid: '62811@s.whatsapp.net', fromMe: true, id: 'ABC' };
  assert.deepEqual(buildMessageContent('text', { text: 'hi', mentions: ['62811@s.whatsapp.net'] }), { text: 'hi', mentions: ['62811@s.whatsapp.net'] });
  assert.deepEqual(buildMessageContent('voice', {}, { media }), { audio: media.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  assert.deepEqual(buildMessageContent('audio', {}, { media }), { audio: media.buffer, mimetype: 'audio/mpeg', ptt: false });
  assert.deepEqual(buildMessageContent('location', { latitude: 1, longitude: 2, name: 'N' }),
    { location: { degreesLatitude: 1, degreesLongitude: 2, name: 'N', address: undefined } });
  assert.deepEqual(buildMessageContent('poll', { name: 'Q', options: ['A', 'B'], selectableCount: 1 }), { poll: { name: 'Q', values: ['A', 'B'], selectableCount: 1 } });
  assert.deepEqual(buildMessageContent('reaction', { emoji: '👍' }, { key }), { react: { text: '👍', key } });
  assert.deepEqual(buildMessageContent('edit', { text: 'new' }, { key }), { text: 'new', edit: key });
  assert.deepEqual(buildMessageContent('delete', {}, { key }), { delete: key });
  const contact = buildMessageContent('contact', { contacts: [{ name: 'Budi', phone: '62811' }] });
  assert.equal(contact.contacts.displayName, 'Budi');
  assert.match(contact.contacts.contacts[0].vcard, /waid=62811:\+62811/);
});

test('presence, history text and vCard helpers', () => {
  assert.equal(presenceFor('text'), 'composing');
  assert.equal(presenceFor('voice'), 'recording');
  assert.equal(presenceFor('reaction'), null);
  assert.equal(historyText('document', { fileName: 'a.pdf' }), 'a.pdf');
  assert.equal(historyText('location', { latitude: 1, longitude: 2 }), '1,2');
  assert.equal(buildVcard({ name: 'A\nB', phone: '62811' }).split('\n')[2], 'FN:A B');
});
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implementasi** — `src/services/messageContent.js`
```js
import { AppError } from '../utils/errors.js';
import { normalizePhoneNumber } from '../utils/phone.js';

export const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'document', 'sticker'];
// Types that act on an earlier message identified by messageId
export const KEY_TYPES = ['reaction', 'edit', 'delete'];
export const MESSAGE_TYPES = ['text', ...MEDIA_TYPES, 'location', 'contact', 'poll', ...KEY_TYPES];

const MAX_TEXT_LENGTH = 65536;
const CAPTIONLESS_TYPES = ['audio', 'voice', 'sticker'];

const invalid = (message) => new AppError(400, message);

function readString(value, name, { max = MAX_TEXT_LENGTH, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw invalid(`${name} is required.`);
  }
  if (typeof value !== 'string') throw invalid(`${name} must be a string.`);
  if (value.length > max) throw invalid(`${name} must be at most ${max} characters.`);
  return value;
}

function readNumber(value, name, min, max, { integer = false } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw invalid(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return number;
}

/**
 * Validates the type-specific part of a send request. Returns the JSON payload stored in the queue
 * and, for media types, the raw media input (URL, data URL or uploaded Buffer).
 * Recipients, replyTo, mentions and message keys are resolved by the caller.
 */
export function parseMessageInput(body, { file = null, countryCode = '62' } = {}) {
  const type = body.type || (file || body.media ? null : 'text');
  if (!type || !MESSAGE_TYPES.includes(type)) {
    throw invalid(`type must be one of: ${MESSAGE_TYPES.join(', ')}.`);
  }

  if (type === 'text') {
    return { type, payload: { text: readString(body.text, 'text') }, media: null };
  }

  if (MEDIA_TYPES.includes(type)) {
    const media = body.media || {};
    const input = file ? file.buffer : media.url || media.base64 || null;
    if (!input) throw invalid('media.url, media.base64 or a file upload is required for media messages.');
    const payload = {};
    const caption = readString(body.caption ?? body.text, 'caption', { optional: true });
    if (caption && !CAPTIONLESS_TYPES.includes(type)) payload.caption = caption;
    if (type === 'document') {
      payload.fileName = readString(media.fileName ?? body.fileName ?? file?.originalname, 'fileName', { max: 255, optional: true }) || 'file';
    }
    const mimetype = media.mimetype ?? body.mimetype ?? file?.mimetype;
    if (mimetype) payload.mimetype = readString(mimetype, 'mimetype', { max: 255 });
    if (type === 'video' && (media.gifPlayback === true || body.gifPlayback === true)) payload.gifPlayback = true;
    return { type, payload, media: input };
  }

  if (type === 'location') {
    const location = body.location || {};
    const payload = {
      latitude: readNumber(location.latitude, 'location.latitude', -90, 90),
      longitude: readNumber(location.longitude, 'location.longitude', -180, 180)
    };
    const name = readString(location.name, 'location.name', { max: 1000, optional: true });
    const address = readString(location.address, 'location.address', { max: 1000, optional: true });
    if (name) payload.name = name;
    if (address) payload.address = address;
    return { type, payload, media: null };
  }

  if (type === 'contact') {
    const list = Array.isArray(body.contacts) ? body.contacts : body.contact ? [body.contact] : [];
    if (!list.length || list.length > 20) throw invalid('contacts must contain 1-20 entries of { name, phone }.');
    const contacts = list.map((contact, index) => ({
      name: readString(contact?.name, `contacts[${index}].name`, { max: 200 }),
      phone: normalizePhoneNumber(contact?.phone, countryCode)
    }));
    return { type, payload: { contacts }, media: null };
  }

  if (type === 'poll') {
    const poll = body.poll || {};
    if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 12) {
      throw invalid('poll.options must contain 2-12 entries.');
    }
    const options = poll.options.map((option, index) => readString(option, `poll.options[${index}]`, { max: 100 }));
    if (new Set(options).size !== options.length) throw invalid('poll.options must be unique.');
    const selectableCount = poll.selectableCount === undefined
      ? 1
      : readNumber(poll.selectableCount, 'poll.selectableCount', 0, options.length, { integer: true });
    return { type, payload: { name: readString(poll.name, 'poll.name', { max: 255 }), options, selectableCount }, media: null };
  }

  const messageId = readString(body.messageId, 'messageId', { max: 150 });
  if (type === 'reaction') {
    // An empty emoji removes an earlier reaction
    return { type, payload: { messageId, emoji: readString(body.emoji, 'emoji', { max: 16, optional: true }) ?? '' }, media: null };
  }
  if (type === 'edit') {
    return { type, payload: { messageId, text: readString(body.text, 'text') }, media: null };
  }
  return { type, payload: { messageId }, media: null };
}

export function buildVcard({ name, phone }) {
  const displayName = String(name).replace(/[\r\n]+/g, ' ');
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${displayName}`, `TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}`, 'END:VCARD'].join('\n');
}

/**
 * Turns a queued payload into Baileys message content. `media` is { buffer, contentType } for media
 * types; `key` is the WhatsApp key of the target message for reaction, edit and delete.
 */
export function buildMessageContent(type, payload, { media = null, key = null } = {}) {
  const mentions = payload.mentions?.length ? { mentions: payload.mentions } : {};
  switch (type) {
    case 'text':
      return { text: payload.text, ...mentions };
    case 'image':
      return { image: media.buffer, caption: payload.caption || '', ...mentions };
    case 'video':
      return { video: media.buffer, caption: payload.caption || '', gifPlayback: Boolean(payload.gifPlayback), ...mentions };
    case 'audio':
      return { audio: media.buffer, mimetype: payload.mimetype || media.contentType || 'audio/mpeg', ptt: false };
    case 'voice':
      // WhatsApp only plays voice notes encoded as OGG/Opus
      return { audio: media.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    case 'document':
      return {
        document: media.buffer,
        fileName: payload.fileName || 'file',
        mimetype: payload.mimetype || media.contentType || 'application/octet-stream',
        caption: payload.caption || ''
      };
    case 'sticker':
      return { sticker: media.buffer };
    case 'location':
      return { location: { degreesLatitude: payload.latitude, degreesLongitude: payload.longitude, name: payload.name, address: payload.address } };
    case 'contact':
      return {
        contacts: {
          displayName: payload.contacts.length === 1 ? payload.contacts[0].name : `${payload.contacts.length} contacts`,
          contacts: payload.contacts.map((contact) => ({ displayName: contact.name, vcard: buildVcard(contact) }))
        }
      };
    case 'poll':
      return { poll: { name: payload.name, values: payload.options, selectableCount: payload.selectableCount }, ...mentions };
    case 'reaction':
      return { react: { text: payload.emoji, key } };
    case 'edit':
      return { text: payload.text, edit: key };
    case 'delete':
      return { delete: key };
    default:
      throw new AppError(400, `Unsupported message type "${type}".`);
  }
}

/**
 * Presence shown before sending: typing for most messages, recording for audio, none for actions.
 */
export function presenceFor(type) {
  if (type === 'audio' || type === 'voice') return 'recording';
  if (['sticker', ...KEY_TYPES].includes(type)) return null;
  return 'composing';
}

/**
 * Human-readable content stored in the message history.
 */
export function historyText(type, payload) {
  switch (type) {
    case 'text':
    case 'edit':
      return payload.text;
    case 'location':
      return payload.name || `${payload.latitude},${payload.longitude}`;
    case 'contact':
      return payload.contacts.map((contact) => contact.name).join(', ');
    case 'poll':
      return payload.name;
    case 'reaction':
      return payload.emoji;
    case 'delete':
      return '';
    default:
      return payload.caption || payload.fileName || '';
  }
}
```
- [ ] **Step 4: Run** → PASS. **Commit** `feat: message content builder for all supported types`.

---

### Task 3: Target massal (`bulkTargets`)

**Files:**
- Create: `src/services/bulkTargets.js`
- Test: `test/bulkTargets.test.js`

- [ ] **Step 1: Test**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBulkTarget, parseTargets, renderTemplate } from '../src/services/bulkTargets.js';

test('parses Fonnte-style targets with names and variables', () => {
  assert.deepEqual(parseTargets('0811|Budi|VIP|Jakarta, 0812|Ani,, 120363@g.us'), [
    { number: '0811', name: 'Budi', vars: ['VIP', 'Jakarta'] },
    { number: '0812', name: 'Ani', vars: [] },
    { number: '120363@g.us', name: '', vars: [] }
  ]);
  assert.deepEqual(parseTargets(['0811|Budi', '0812']), [
    { number: '0811', name: 'Budi', vars: [] },
    { number: '0812', name: '', vars: [] }
  ]);
});

test('renders {name} and {varN}; missing values become empty', () => {
  const target = { name: 'Budi', vars: ['VIP'] };
  assert.equal(renderTemplate('Halo {name}, level {var1}{var2}! {other}', target), 'Halo Budi, level VIP! {other}');
});

test('detects requests that need the bulk path', () => {
  assert.equal(isBulkTarget('0811'), false);
  assert.equal(isBulkTarget(['0811']), false);
  assert.equal(isBulkTarget('0811,0812'), true);
  assert.equal(isBulkTarget('0811|Budi'), true);
  assert.equal(isBulkTarget(['0811', '0812']), true);
});
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implementasi** — `src/services/bulkTargets.js`
```js
/**
 * Recipients in Fonnte-compatible syntax: comma-separated entries (or an array), each
 * "number|name|var1|var2|…". The values feed {name}, {var1}, {var2}, … in the message.
 */
export function parseTargets(to) {
  const entries = Array.isArray(to) ? to : String(to ?? '').split(',');
  return entries
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
    .map((entry) => {
      const [number, name = '', ...vars] = entry.split('|').map((part) => part.trim());
      return { number, name, vars };
    });
}

/**
 * Replaces {name} and {var1}…{varN} with the target's values; missing values become empty.
 */
export function renderTemplate(text, { name = '', vars = [] }) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{(name|var(\d+))\}/g, (match, key, index) => (key === 'name' ? name : vars[Number(index) - 1] ?? ''));
}

/**
 * True when `to` addresses several recipients or carries template values.
 */
export function isBulkTarget(to) {
  if (Array.isArray(to)) return to.length !== 1 || String(to[0]).includes('|');
  return typeof to === 'string' && (to.includes(',') || to.includes('|'));
}
```
- [ ] **Step 4: Run** → PASS. **Commit** `feat: bulk target parsing and templating`.

---

### Task 4: Submit & delivery untuk semua tipe + endpoint terpadu

**Files:** Modify `src/services/messageService.js`, `src/services/sessionManager.js`, `src/controllers/messageController.js`, `src/routes/messageRoutes.js`, `src/index.js` (landing).

- [ ] **Step 1: `messageService.js`.** Ganti `submitMessage` dengan versi generik, dan tambahkan `resolveMessageKey`, `submitBatch`.
```js
async function assertSessionExists(sessionId) {
  const res = await query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);
  if (!res.rowCount) throw new AppError(404, `Session "${sessionId}" not found.`);
}

function assertCanQueue(sessionId, { connectOnly, scheduleAt }) {
  if (connectOnly && !scheduleAt && !isSessionConnected(sessionId)) {
    throw new AppError(409, `Session "${sessionId}" is not connected. Send with connectOnly=false to queue the message until it connects.`);
  }
}

/**
 * WhatsApp key of an earlier message of the session (target of reaction/edit/delete or replyTo).
 */
export async function resolveMessageKey(sessionId, messageId) {
  const res = await query(
    `SELECT remote_jid, from_me, sender_jid FROM messages WHERE session_id = $1 AND message_id = $2`,
    [sessionId, messageId]
  );
  const row = res.rows[0];
  if (!row) throw new AppError(404, `Message "${messageId}" not found in session "${sessionId}".`);
  const inGroup = row.remote_jid.endsWith('@g.us');
  return {
    remoteJid: row.remote_jid,
    fromMe: row.from_me,
    id: messageId,
    ...(inGroup && !row.from_me ? { participant: row.sender_jid } : {})
  };
}

/**
 * Shared preparation of a submission: mentions, reply, message key, media and typing delay.
 */
async function prepareSubmission({ sessionId, countryCode, type, payload, media, replyTo, mentions, delayMs }) {
  const code = countryCode ?? config.defaultCountryCode;
  const prepared = { payload: { ...payload }, mediaData: null, targetJid: null };
  if (delayMs !== undefined) prepared.payload.delayMs = delayMs;
  if (mentions?.length) prepared.payload.mentions = mentions.map((mention) => normalizeTarget(mention, code));
  if (replyTo) {
    await resolveMessageKey(sessionId, replyTo);
    prepared.payload.replyTo = replyTo;
  }
  if (KEY_TYPES.includes(type)) {
    const key = await resolveMessageKey(sessionId, payload.messageId);
    if (type === 'edit' && !key.fromMe) {
      throw new AppError(400, 'Only messages sent by this session can be edited.');
    }
    prepared.payload.key = key;
    prepared.targetJid = key.remoteJid;
  }
  if (media) {
    const preparedMedia = prepareMedia(media, type);
    if (preparedMedia.mediaData && preparedMedia.mediaData.length > config.mediaMaxBytes) {
      throw new AppError(413, `Media is larger than MEDIA_MAX_BYTES (${config.mediaMaxBytes} bytes).`);
    }
    prepared.mediaData = preparedMedia.mediaData;
    if (preparedMedia.url) prepared.payload.url = preparedMedia.url;
    if (!prepared.payload.mimetype && preparedMedia.contentType) prepared.payload.mimetype = preparedMedia.contentType;
  }
  return prepared;
}

/**
 * Validates and queues one outgoing message. With `wait` (and a connected session), resolves once it
 * was sent or failed, or after SEND_WAIT_TIMEOUT_MS while it is still queued.
 */
export async function submitMessage({
  sessionId, to, countryCode, type, payload, media = null, replyTo = null, mentions = null,
  delayMs, scheduleAt = null, idempotencyKey = null, connectOnly = true, wait = true
}) {
  const isKeyType = KEY_TYPES.includes(type);
  const targetJid = isKeyType ? null : normalizeTarget(to, countryCode ?? config.defaultCountryCode);
  await assertSessionExists(sessionId);
  assertCanQueue(sessionId, { connectOnly, scheduleAt });
  const prepared = await prepareSubmission({ sessionId, countryCode, type, payload, media, replyTo, mentions, delayMs });

  const { item, created } = await outboundQueue.enqueue({
    sessionId,
    idempotencyKey,
    targetJid: prepared.targetJid ?? targetJid,
    messageType: type,
    payload: prepared.payload,
    mediaData: prepared.mediaData,
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

/**
 * Queues one message per target. Text, captions and poll names are rendered per target from
 * {name}/{varN}. Invalid and duplicate targets are reported individually; nothing waits for delivery.
 */
export async function submitBatch({
  sessionId, to, countryCode, type, payload, media = null, mentions = null,
  delayMs, scheduleAt = null, idempotencyKey = null, connectOnly = true
}) {
  if (KEY_TYPES.includes(type)) {
    throw new AppError(400, `${type} messages target one existing message and cannot be sent in bulk.`);
  }
  if (media && !(typeof media === 'string' && /^https?:\/\//i.test(media))) {
    throw new AppError(400, 'Bulk media must be given as media.url (uploads and base64 are only supported for a single target).');
  }
  const targets = parseTargets(to);
  if (!targets.length) throw new AppError(400, 'At least one target is required.');
  if (targets.length > config.bulk.maxTargets) {
    throw new AppError(400, `At most ${config.bulk.maxTargets} targets per request (BULK_MAX_TARGETS).`);
  }
  await assertSessionExists(sessionId);
  assertCanQueue(sessionId, { connectOnly, scheduleAt });
  const shared = await prepareSubmission({ sessionId, countryCode, type, payload, media, mentions, delayMs });

  const code = countryCode ?? config.defaultCountryCode;
  const seen = new Set();
  const results = [];
  for (const target of targets) {
    let targetJid;
    try {
      targetJid = normalizeTarget(target.number, code);
    } catch (error) {
      results.push({ to: target.number, status: 'invalid', error: error.message });
      continue;
    }
    if (seen.has(targetJid)) {
      results.push({ to: targetJid, status: 'skipped', error: 'Duplicate target in this request.' });
      continue;
    }
    seen.add(targetJid);

    const personalized = { ...shared.payload };
    for (const field of ['text', 'caption']) {
      if (personalized[field]) personalized[field] = renderTemplate(personalized[field], target);
    }
    if (type === 'poll') personalized.name = renderTemplate(personalized.name, target);

    const { item, created } = await outboundQueue.enqueue({
      sessionId,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:${targetJid}` : null,
      targetJid,
      messageType: type,
      payload: personalized,
      mediaData: null,
      scheduledAt: scheduleAt
    });
    results.push({ to: targetJid, status: created ? 'queued' : 'duplicate', queueId: Number(item.id) });
  }
  queueRunner.wake();
  return results;
}
```
Import tambahan: `parseTargets`, `renderTemplate` dari `./bulkTargets.js`, dan `KEY_TYPES` dari `./messageContent.js`. `prepareMedia(input, label)` tetap seperti Fase 1.

- [ ] **Step 2: `sessionManager.js`**
  - **`sendWithHumanSimulation`** — signature baru: `(sock, jid, content, { delayMs = null, presence = 'composing', options = {} } = {})`.
    - Kalau `presence` null, langsung `sock.sendMessage(jid, content, options)`.
    - Selain itu, presence lalu delay seperti sebelumnya, kemudian `sock.sendMessage(jid, content, options)`.
  - **Cache media URL** untuk kirim massal:
```js
// Bulk sends reuse one media URL for many recipients: keep small downloads for a few minutes
const remoteMediaCache = createTtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 10 });
const CACHEABLE_MEDIA_BYTES = 10 * 1024 * 1024;

async function loadQueuedMedia(item) {
  if (item.media_data) {
    return { buffer: item.media_data, contentType: item.payload.mimetype || null };
  }
  const cached = remoteMediaCache.get(item.payload.url);
  if (cached) return cached;
  const media = await fetchRemoteFile(item.payload.url, { allowPrivate: config.allowPrivateUrls, maxBytes: config.mediaMaxBytes });
  if (media.buffer.length <= CACHEABLE_MEDIA_BYTES) remoteMediaCache.set(item.payload.url, media);
  return media;
}

async function loadQuotedMessage(sessionId, messageId) {
  const res = await query(`SELECT raw_payload FROM messages WHERE session_id = $1 AND message_id = $2`, [sessionId, messageId]);
  const raw = res.rows[0]?.raw_payload;
  return raw ? proto.WebMessageInfo.fromObject(raw) : undefined;
}
```
  - **`deliverQueuedMessage`**:
```js
export async function deliverQueuedMessage(item) {
  const session = activeSessions.get(item.session_id);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(503, `Session "${item.session_id}" is not connected.`);
  }
  const type = item.message_type;
  const { payload } = item;
  const media = MEDIA_TYPES.includes(type) ? await loadQueuedMedia(item) : null;
  const content = buildMessageContent(type, payload, { media, key: payload.key || null });
  const quoted = payload.replyTo ? await loadQuotedMessage(item.session_id, payload.replyTo) : undefined;

  const result = await sendWithHumanSimulation(session.sock, item.target_jid, content, {
    delayMs: payload.delayMs,
    presence: presenceFor(type),
    options: quoted ? { quoted } : {}
  });
  await saveOutgoingMessage(session, item.target_jid, result, {
    messageType: type,
    content: historyText(type, payload),
    mediaUrl: payload.url || null
  });
  return result.key.id;
}
```
    Import `MEDIA_TYPES`, `buildMessageContent`, `historyText`, `presenceFor` dari `./messageContent.js`.

- [ ] **Step 3: `messageController.js`**
  - Endpoint lama memakai signature baru:
    - `sendText` → `submitMessage({ sessionId, to, type: 'text', payload: { text }, ...parseQueueOptions(req) })`
    - `sendImage` → `type: 'image', payload: caption ? { caption } : {}, media: imageInput`
    - `sendAttachment` → `type: 'document', payload: { fileName, caption?, mimetype? }, media: docInput`
  - Endpoint terpadu:
```js
function parseMentions(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  if (list.length > 50) throw new AppError(400, 'At most 50 mentions per message.');
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

/**
 * POST /api/messages/send: every message type, one or many recipients.
 */
export async function sendMessage(req, res) {
  try {
    const { sessionId, to, replyTo } = req.body;
    assertSessionId(sessionId);
    assertSessionAccess(req, sessionId);
    const options = parseQueueOptions(req);
    const { type, payload, media } = parseMessageInput(req.body, {
      file: req.file,
      countryCode: options.countryCode ?? config.defaultCountryCode
    });
    const mentions = parseMentions(req.body.mentions);

    if (isBulkTarget(to)) {
      if (replyTo) throw new AppError(400, 'replyTo cannot be combined with several recipients.');
      const { wait, ...batchOptions } = options;
      const results = await submitBatch({ sessionId, to, type, payload, media, mentions, ...batchOptions });
      const queued = results.filter((result) => result.status === 'queued' || result.status === 'duplicate').length;
      return res.status(queued ? 202 : 400).json({ success: queued > 0, total: results.length, queued, results });
    }

    if (!to && !KEY_TYPES.includes(type)) {
      throw new AppError(400, 'to is required.');
    }
    const submission = await submitMessage({
      sessionId,
      to: Array.isArray(to) ? to[0] : to,
      type,
      payload,
      media,
      replyTo: replyTo ? String(replyTo) : null,
      mentions,
      ...options
    });
    return respondToSubmission(res, submission);
  } catch (error) {
    return sendError(res, error, 'MessageController');
  }
}
```
  - `assertSessionAccess` dipanggil juga di `sendText/sendImage/sendAttachment/sendPairingCode` (setelah `assertSessionId`); task 8 membuat fungsi ini.

- [ ] **Step 4: Route** — `router.post('/send', upload.single('file'), sendMessage);` (sebelum `router.get('/:sessionId', ...)`).
- [ ] **Step 5: Cek** — `node --check`, `npm test` → PASS. **Commit** `feat: unified send endpoint with all message types and bulk recipients`.

---

### Task 5: Validasi nomor

**Files:**
- Create: `src/services/numberCheck.js`, `src/services/numberService.js`
- Modify: `src/services/sessionManager.js` (`getConnectedSocket`), `src/controllers/sessionController.js`, `src/routes/sessionRoutes.js`
- Test: `test/numberCheck.test.js`

- [ ] **Step 1: Test**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNumberChecker } from '../src/services/numberCheck.js';

function createFakeStore() {
  const rows = new Map();
  return {
    rows,
    async read(phones) {
      return new Map(phones.filter((phone) => rows.has(phone)).map((phone) => [phone, rows.get(phone)]));
    },
    async write(results) {
      for (const { phone, exists, jid } of results) rows.set(phone, { exists, jid });
    }
  };
}

function createClock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    advance: (ms) => { time += ms; },
    sleeps
  };
}

test('looks up unknown numbers once and serves them from the cache afterwards', async () => {
  const store = createFakeStore();
  const clock = createClock();
  const lookups = [];
  const lookup = async (jids) => {
    lookups.push(jids);
    return [{ jid: '62811@s.whatsapp.net', exists: true }];
  };
  const checker = createNumberChecker({ store, ttlMs: 1000, minIntervalMs: 3000, now: clock.now, sleep: clock.sleep });

  assert.deepEqual(await checker.check('s1', ['62811', '62822'], lookup), [
    { number: '62811', exists: true, jid: '62811@s.whatsapp.net', cached: false },
    { number: '62822', exists: false, jid: null, cached: false }
  ]);
  assert.deepEqual(lookups, [['62811@s.whatsapp.net', '62822@s.whatsapp.net']]);

  const again = await checker.check('s1', ['62811'], lookup);
  assert.deepEqual(again, [{ number: '62811', exists: true, jid: '62811@s.whatsapp.net', cached: true }]);
  assert.equal(lookups.length, 1);
});

test('throttles lookups per session and splits them into batches', async () => {
  const clock = createClock();
  const lookups = [];
  const checker = createNumberChecker({
    store: createFakeStore(),
    ttlMs: 1000,
    minIntervalMs: 3000,
    batchSize: 2,
    now: clock.now,
    sleep: clock.sleep
  });
  await checker.check('s1', ['1', '2', '3'], async (jids) => { lookups.push(jids.length); return []; });
  assert.deepEqual(lookups, [2, 1]);
  assert.deepEqual(clock.sleeps, [3000]);
});
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implementasi** — `src/services/numberCheck.js`
```js
import { db as defaultDb } from '../database/db.js';
import { createKeyedLock } from '../utils/keyedLock.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Postgres cache of WhatsApp registration lookups (shared by all sessions).
 */
export function createNumberCheckStore(db = defaultDb) {
  return {
    async read(phones, ttlMs) {
      const res = await db.query(
        `SELECT phone, exists_on_whatsapp, jid FROM number_checks
         WHERE phone = ANY($1::text[]) AND checked_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')`,
        [phones, ttlMs]
      );
      return new Map(res.rows.map((row) => [row.phone, { exists: row.exists_on_whatsapp, jid: row.jid }]));
    },
    async write(results) {
      if (!results.length) return;
      await db.query(
        `INSERT INTO number_checks (phone, exists_on_whatsapp, jid, checked_at)
         SELECT phone, found, jid, NOW() FROM unnest($1::text[], $2::boolean[], $3::text[]) AS t(phone, found, jid)
         ON CONFLICT (phone) DO UPDATE
         SET exists_on_whatsapp = EXCLUDED.exists_on_whatsapp, jid = EXCLUDED.jid, checked_at = NOW()`,
        [results.map((r) => r.phone), results.map((r) => r.exists), results.map((r) => r.jid)]
      );
    }
  };
}

/**
 * Checks whether phone numbers are on WhatsApp. Results are cached for `ttlMs`; uncached numbers are
 * looked up in batches, one session at a time and at most once per `minIntervalMs`, because bulk
 * contact discovery is itself a ban signal.
 */
export function createNumberChecker({ store, ttlMs, minIntervalMs, batchSize = 50, now = Date.now, sleep = defaultSleep }) {
  const locks = createKeyedLock();
  const lastLookupAt = new Map();

  return {
    /**
     * @param lookup async (jids) => [{ jid, exists }], e.g. the session's sock.onWhatsApp
     */
    async check(sessionId, phones, lookup) {
      const cached = await store.read(phones, ttlMs);
      const missing = phones.filter((phone) => !cached.has(phone));
      const fresh = new Map();

      if (missing.length) {
        await locks.run(sessionId, async () => {
          for (let index = 0; index < missing.length; index += batchSize) {
            const waitMs = (lastLookupAt.get(sessionId) ?? -Infinity) + minIntervalMs - now();
            if (waitMs > 0) await sleep(waitMs);
            const chunk = missing.slice(index, index + batchSize);
            const found = (await lookup(chunk.map((phone) => `${phone}@s.whatsapp.net`))) || [];
            lastLookupAt.set(sessionId, now());
            const registered = new Map(
              found.filter((entry) => entry.exists).map((entry) => [entry.jid.split('@')[0].split(':')[0], entry.jid])
            );
            for (const phone of chunk) {
              fresh.set(phone, { exists: registered.has(phone), jid: registered.get(phone) || null });
            }
          }
        });
        await store.write([...fresh].map(([phone, result]) => ({ phone, ...result })));
      }

      return phones.map((phone) => ({ number: phone, ...(cached.get(phone) || fresh.get(phone)), cached: cached.has(phone) }));
    }
  };
}
```
`src/services/numberService.js`
```js
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import { normalizePhoneNumber } from '../utils/phone.js';
import { createNumberChecker, createNumberCheckStore } from './numberCheck.js';
import { getConnectedSocket } from './sessionManager.js';

const checker = createNumberChecker({
  store: createNumberCheckStore(),
  ttlMs: config.validate.cacheTtlMs,
  minIntervalMs: config.validate.minIntervalMs
});

/**
 * Which numbers are registered on WhatsApp. Cached answers do not need a connected session.
 */
export async function validateNumbers(sessionId, numbers, { countryCode } = {}) {
  const list = Array.isArray(numbers) ? numbers : String(numbers ?? '').split(',');
  const entries = list.map((entry) => String(entry).trim()).filter(Boolean);
  if (!entries.length) throw new AppError(400, 'numbers is required.');
  if (entries.length > config.validate.maxNumbers) {
    throw new AppError(400, `At most ${config.validate.maxNumbers} numbers per request (VALIDATE_MAX_NUMBERS).`);
  }

  const invalid = [];
  const phones = new Set();
  for (const entry of entries) {
    try {
      phones.add(normalizePhoneNumber(entry, countryCode ?? config.defaultCountryCode));
    } catch {
      invalid.push(entry);
    }
  }

  const results = phones.size
    ? await checker.check(sessionId, [...phones], (jids) => getConnectedSocket(sessionId).onWhatsApp(...jids))
    : [];
  return {
    registered: results.filter((result) => result.exists).map((result) => result.number),
    notRegistered: results.filter((result) => !result.exists).map((result) => result.number),
    invalid,
    results
  };
}
```
`sessionManager.js`:
```js
export function getConnectedSocket(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || session.stopped || session.status !== 'connected') {
    throw new AppError(409, `Session "${sessionId}" is not connected.`);
  }
  return session.sock;
}
```
Controller dan route:
- `POST /api/sessions/:sessionId/validate` body `{ numbers: [...] | "a,b", countryCode? }`;
- respons `{ success, registered, notRegistered, invalid, results }`.
- [ ] **Step 4: Run** → PASS. **Commit** `feat: cached and throttled WhatsApp number validation`.

---

### Task 6: API grup

**Files:** Modify `src/services/sessionManager.js`, `src/controllers/sessionController.js`, `src/routes/sessionRoutes.js`

- [ ] **Step 1: `sessionManager.js`**
```js
// Group list per session: fetching every group is a heavy call, so it is cached and refreshed sparingly
const groupLists = new Map();

function summarizeGroup(metadata) {
  return {
    id: metadata.id,
    subject: metadata.subject || '',
    size: metadata.size ?? metadata.participants?.length ?? 0,
    owner: metadata.owner ?? null,
    createdAt: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
    announce: Boolean(metadata.announce),
    restrict: Boolean(metadata.restrict)
  };
}

/**
 * Groups the account belongs to, from cache (GROUPS_CACHE_MINUTES). `refresh` refetches at most once
 * per minute. A cached list is served even while the session is offline.
 */
export async function listGroups(sessionId, { refresh = false } = {}) {
  const cached = groupLists.get(sessionId);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  const usable = age < config.groups.cacheTtlMs && !(refresh && age >= config.groups.refreshMinIntervalMs);
  if (cached && (usable || !isSessionConnected(sessionId))) {
    return { groups: cached.groups, fetchedAt: new Date(cached.fetchedAt).toISOString() };
  }

  const sock = getConnectedSocket(sessionId);
  const all = await sock.groupFetchAllParticipating();
  const metadataCache = getSessionCache(groupMetadataCaches, sessionId, 5 * 60 * 1000);
  const groups = Object.values(all)
    .map((metadata) => {
      metadataCache.set(metadata.id, metadata);
      return summarizeGroup(metadata);
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));
  const fetchedAt = Date.now();
  groupLists.set(sessionId, { fetchedAt, groups });
  return { groups, fetchedAt: new Date(fetchedAt).toISOString() };
}

export async function getGroup(sessionId, groupJid) {
  if (!/^\d+(-\d+)?@g\.us$/.test(groupJid)) {
    throw new AppError(400, 'groupId must be a group JID such as 120363012345678901@g.us.');
  }
  const sock = getConnectedSocket(sessionId);
  const metadataCache = getSessionCache(groupMetadataCaches, sessionId, 5 * 60 * 1000);
  let metadata = metadataCache.get(groupJid);
  if (!metadata) {
    try {
      metadata = await sock.groupMetadata(groupJid);
    } catch (error) {
      throw new AppError(404, `Group "${groupJid}" not found or the account is not a member (${error.message}).`);
    }
    metadataCache.set(groupJid, metadata);
  }
  return {
    ...summarizeGroup(metadata),
    description: metadata.desc ?? null,
    participants: (metadata.participants || []).map((participant) => ({
      id: participant.id,
      phoneNumber: participant.phoneNumber ?? null,
      admin: participant.admin ?? null
    }))
  };
}
```
Di `logoutSession`: tambahkan `groupLists.delete(sessionId)`.

- [ ] **Step 2: Route & controller**
  - `GET /api/sessions/:sessionId/groups?refresh=true` → `{ success, count, fetchedAt, groups }`
  - `GET /api/sessions/:sessionId/groups/:groupId` → `{ success, group }`
- [ ] **Step 3: Commit** `feat: cached group list and group details API`.

---

### Task 7: Pengaturan sesi + panggilan masuk

**Files:**
- Create: `src/services/sessionSettings.js`
- Modify: `sessionManager.js`, `webhookService.js` (`WEBHOOK_EVENTS`), session controller/routes
- Test: `test/sessionSettings.test.js`

- [ ] **Step 1: Test**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, parseSettingsUpdate } from '../src/services/sessionSettings.js';

test('normalizeSettings fills in defaults', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ rejectCalls: true }), { ...DEFAULT_SETTINGS, rejectCalls: true });
});

test('parseSettingsUpdate accepts known settings and normalises empty messages', () => {
  assert.deepEqual(parseSettingsUpdate({ readMessages: null, rejectCalls: true, rejectCallMessage: '', ignoreGroups: false }),
    { readMessages: null, rejectCalls: true, rejectCallMessage: null, ignoreGroups: false });
});

test('parseSettingsUpdate rejects unknown keys and wrong types', () => {
  assert.throws(() => parseSettingsUpdate({ autoReply: true }), { status: 400 });
  assert.throws(() => parseSettingsUpdate({ rejectCalls: 'yes' }), { status: 400 });
  assert.throws(() => parseSettingsUpdate({ rejectCallMessage: 'x'.repeat(1001) }), { status: 400 });
  assert.throws(() => parseSettingsUpdate([]), { status: 400 });
});
```
- [ ] **Step 2: Implementasi** — `src/services/sessionSettings.js`
```js
import { AppError } from '../utils/errors.js';

export const DEFAULT_SETTINGS = Object.freeze({
  readMessages: null, // null = follow AUTO_READ_MESSAGES
  rejectCalls: false,
  rejectCallMessage: null,
  ignoreGroups: false
});

export function normalizeSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

/**
 * Validates a settings update and returns only the provided fields.
 */
export function parseSettingsUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'Settings must be a JSON object.');
  }
  const update = {};
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'readMessages':
        if (value !== null && typeof value !== 'boolean') {
          throw new AppError(400, 'readMessages must be true, false or null (follow AUTO_READ_MESSAGES).');
        }
        break;
      case 'rejectCalls':
      case 'ignoreGroups':
        if (typeof value !== 'boolean') throw new AppError(400, `${key} must be true or false.`);
        break;
      case 'rejectCallMessage':
        if (value !== null && (typeof value !== 'string' || value.length > 1000)) {
          throw new AppError(400, 'rejectCallMessage must be null or a string of at most 1000 characters.');
        }
        break;
      default:
        throw new AppError(400, `Unknown setting "${key}". Allowed: ${Object.keys(DEFAULT_SETTINGS).join(', ')}.`);
    }
    update[key] = value === '' ? null : value;
  }
  return update;
}
```
`sessionManager.js`:
  - **Upsert sesi** di `startSession` → `RETURNING settings`; `sessionData.settings = normalizeSettings(row.settings)`.
  - **Fungsi settings:**
```js
export async function getSessionSettings(sessionId) {
  const res = await query('SELECT settings FROM sessions WHERE id = $1', [sessionId]);
  if (!res.rowCount) throw new AppError(404, `Session "${sessionId}" not found.`);
  return normalizeSettings(res.rows[0].settings);
}

export async function updateSessionSettings(sessionId, update) {
  const res = await query(
    `UPDATE sessions SET settings = settings || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING settings`,
    [sessionId, JSON.stringify(update)]
  );
  if (!res.rowCount) throw new AppError(404, `Session "${sessionId}" not found.`);
  const settings = normalizeSettings(res.rows[0].settings);
  const session = activeSessions.get(sessionId);
  if (session) session.settings = settings;
  return settings;
}
```
  - **`handleIncomingMessage`:**
    - `if (isGroup && sessionData.settings.ignoreGroups) return;`
    - baca otomatis memakai `sessionData.settings.readMessages ?? config.antiBan.autoReadMessages`.
  - **Panggilan masuk:**
```js
  // Incoming calls: report them, and optionally reject and answer with a message
  on('call', async (calls) => {
    for (const call of calls) {
      if (call.status !== 'offer') continue;
      sendWebhookEvent(sessionId, 'call.received', {
        callId: call.id,
        from: call.from,
        callerPhone: call.callerPn ? phoneFromJid(call.callerPn) : null,
        isVideo: Boolean(call.isVideo),
        isGroup: Boolean(call.isGroup)
      });
      const { rejectCalls, rejectCallMessage } = sessionData.settings;
      if (!rejectCalls) continue;
      await sock.rejectCall(call.id, call.from);
      if (rejectCallMessage) {
        await outboundQueue.enqueue({
          sessionId,
          targetJid: call.from,
          messageType: 'text',
          payload: { text: rejectCallMessage }
        });
      }
    }
  });
```
  - **`WEBHOOK_EVENTS`** ditambah `'call.received'`.
  - **Route:** `GET /api/sessions/:sessionId/settings`, `PATCH /api/sessions/:sessionId/settings`.
- [ ] **Step 3: Run** → PASS. **Commit** `feat: per-session settings (read receipts, call rejection, ignore groups)`.

---

### Task 8: API key multi-tenant

**Files:**
- Create: `src/services/apiKeys.js`, `src/controllers/keysController.js`, `src/routes/keysRoutes.js`
- Rewrite: `src/middlewares/auth.js`
- Modify: routes, controllers (scoping), `src/services/outboundQueue.js` (`list` + `sessionIds`), `src/index.js` (`trust proxy`)
- Test: `test/apiKeys.test.js` (unit + DB), `test/auth.test.js` (tulis ulang)

- [ ] **Step 1: Test** — `test/apiKeys.test.js`
```js
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiKeyStore, generateApiKey, hashApiKey, ipAllowed, parseIpAllowlist } from '../src/services/apiKeys.js';
import { createTestDatabase, dbSkip as skip } from './helpers/testDb.js';

test('generated keys have a recognisable format and a SHA-256 hash', () => {
  const { key, prefix, hash } = generateApiKey();
  assert.match(key, /^wagw_[0-9a-f]{10}_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.split('_')[1], prefix);
  assert.equal(hash, hashApiKey(key));
});

test('IP allowlists accept addresses and CIDR ranges', () => {
  assert.equal(parseIpAllowlist(null), null);
  assert.equal(parseIpAllowlist([]), null);
  assert.deepEqual(parseIpAllowlist(['10.0.0.0/8', ' 203.0.113.7 ']), ['10.0.0.0/8', '203.0.113.7']);
  assert.throws(() => parseIpAllowlist(['10.0.0.0/33']), { status: 400 });
  assert.throws(() => parseIpAllowlist(['example.com']), { status: 400 });

  const allowlist = ['10.0.0.0/8', '203.0.113.7'];
  assert.equal(ipAllowed(allowlist, '10.1.2.3'), true);
  assert.equal(ipAllowed(allowlist, '::ffff:10.1.2.3'), true);
  assert.equal(ipAllowed(allowlist, '203.0.113.8'), false);
  assert.equal(ipAllowed(null, '1.2.3.4'), true);
});

let database;
let store;

before(async () => {
  if (skip) return;
  database = await createTestDatabase();
  store = createApiKeyStore(database.db);
});

after(async () => {
  if (database) await database.drop();
});

test('created keys resolve until revoked; wrong secrets never resolve', { skip }, async () => {
  const created = await store.create({ name: 'tenant-a', sessionIds: ['s1'], ipAllowlist: null });
  assert.match(created.key, /^wagw_/);
  assert.deepEqual(created.sessionIds, ['s1']);

  const resolved = await store.resolve(created.key);
  assert.equal(Number(resolved.id), created.id);
  assert.equal(await store.resolve(created.key.slice(0, -1) + (created.key.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(await store.resolve('not-a-key'), null);

  const listed = await store.list();
  assert.equal('key_hash' in listed[0], false);
  assert.equal(listed[0].prefix, `wagw_${created.key.split('_')[1]}`);

  assert.ok(await store.revoke(created.id));
  assert.equal(await store.resolve(created.key), null);
  assert.equal(await store.revoke(created.id), null);
});
```
`test/auth.test.js` (tulis ulang, async):
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccessSession,
  createAuthenticate,
  createQrLinkToken,
  createQrPageAuth,
  verifyQrLinkToken
} from '../src/middlewares/auth.js';

const API_KEY = 'test-api-key-0123456789';
const TENANT_KEY = 'wagw_0123456789_' + 'a'.repeat(43);

const keyStore = {
  async resolve(key) {
    if (key === TENANT_KEY) return { id: '7', session_ids: ['s1'], ip_allowlist: ['10.0.0.0/8'] };
    return null;
  }
};

async function runMiddleware(middleware, { headers = {}, query = {}, params = {}, ip = '10.0.0.5' } = {}) {
  const req = { query, params, ip, get: (name) => headers[name.toLowerCase()] };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; resolve({ nextCalled: false, req, res: this }); return this; }
    };
    middleware(req, res, () => resolve({ nextCalled: true, req, res }));
  });
}

test('the master key authenticates as admin', async () => {
  const { nextCalled, req } = await runMiddleware(createAuthenticate({ apiKey: API_KEY, keyStore }), { headers: { 'x-api-key': API_KEY } });
  assert.equal(nextCalled, true);
  assert.equal(req.auth.isAdmin, true);
});

test('tenant keys are limited to their sessions and allowed IPs', async () => {
  const authenticate = createAuthenticate({ apiKey: API_KEY, keyStore });
  const ok = await runMiddleware(authenticate, { headers: { 'x-api-key': TENANT_KEY } });
  assert.deepEqual(ok.req.auth, { isAdmin: false, keyId: 7, sessionIds: ['s1'] });
  assert.equal(canAccessSession(ok.req.auth, 's1'), true);
  assert.equal(canAccessSession(ok.req.auth, 's2'), false);

  const wrongIp = await runMiddleware(authenticate, { headers: { 'x-api-key': TENANT_KEY }, ip: '203.0.113.9' });
  assert.equal(wrongIp.res.statusCode, 403);
});

test('missing, wrong or query-string keys are rejected', async () => {
  const authenticate = createAuthenticate({ apiKey: API_KEY, keyStore });
  assert.equal((await runMiddleware(authenticate)).res.statusCode, 401);
  assert.equal((await runMiddleware(authenticate, { headers: { 'x-api-key': 'wrong' } })).res.statusCode, 401);
  assert.equal((await runMiddleware(authenticate, { query: { apiKey: API_KEY } })).res.statusCode, 401);
});

test('without a configured API key every caller is admin (development)', async () => {
  const { req } = await runMiddleware(createAuthenticate({ apiKey: '', keyStore }));
  assert.equal(req.auth.isAdmin, true);
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

test('a QR link grants access to that one session only', async () => {
  const qrPageAuth = createQrPageAuth({ apiKey: API_KEY, keyStore });
  const { token } = createQrLinkToken('sales-01', { secret: API_KEY });
  const { nextCalled, req } = await runMiddleware(qrPageAuth, { params: { sessionId: 'sales-01' }, query: { token } });
  assert.equal(nextCalled, true);
  assert.equal(canAccessSession(req.auth, 'sales-01'), true);
  assert.equal(canAccessSession(req.auth, 'other'), false);
  assert.equal((await runMiddleware(qrPageAuth, { params: { sessionId: 'other' }, query: { token } })).res.statusCode, 401);
});
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implementasi** — `src/services/apiKeys.js`
```js
import crypto from 'node:crypto';
import net from 'node:net';
import { db as defaultDb } from '../database/db.js';
import { createTtlCache } from '../utils/ttlCache.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const KEY_PATTERN = /^wagw_([0-9a-f]{10})_[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60 * 1000;

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * A new tenant key: "wagw_<10 hex prefix>_<256-bit secret>". Only the hash is stored; the prefix
 * makes lookups cheap and identifies the key in listings.
 */
export function generateApiKey() {
  const prefix = crypto.randomBytes(5).toString('hex');
  const key = `wagw_${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/**
 * Validates an IP allowlist of addresses and CIDR ranges; null or empty means any IP.
 */
export function parseIpAllowlist(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length > 50) {
    throw new AppError(400, 'ipAllowlist must be null or an array of up to 50 IP addresses / CIDR ranges.');
  }
  if (!list.length) return null;
  return list.map((entry) => {
    const [address, prefix] = String(entry).trim().split('/');
    const family = net.isIP(address);
    const maxPrefix = family === 6 ? 128 : 32;
    if (!family || (prefix !== undefined && !(/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix))) {
      throw new AppError(400, `Invalid IP address or CIDR range "${entry}".`);
    }
    return prefix === undefined ? address : `${address}/${prefix}`;
  });
}

export function ipAllowed(allowlist, ip) {
  if (!allowlist?.length) return true;
  const family = net.isIP(ip || '');
  if (!family) return false;
  const blockList = new net.BlockList();
  for (const entry of allowlist) {
    const [address, prefix] = entry.split('/');
    const type = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) blockList.addAddress(address, type);
    else blockList.addSubnet(address, Number(prefix), type);
  }
  return blockList.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function formatKey(row) {
  return {
    id: Number(row.id),
    name: row.name,
    prefix: `wagw_${row.key_prefix}`,
    sessionIds: row.session_ids,
    ipAllowlist: row.ip_allowlist,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

export function createApiKeyStore(db = defaultDb, { cacheTtlMs = 60 * 1000, now = Date.now } = {}) {
  const cache = createTtlCache({ ttlMs: cacheTtlMs, now });
  const lastTouched = new Map();

  function touch(id) {
    if (now() - (lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
    lastTouched.set(id, now());
    db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [id])
      .catch((error) => logger.warn({ err: error, keyId: id }, 'Could not record API key usage'));
  }

  return {
    /** Returns the plaintext key once; it cannot be recovered later. */
    async create({ name, sessionIds = null, ipAllowlist = null }) {
      const { key, prefix, hash } = generateApiKey();
      const res = await db.query(
        `INSERT INTO api_keys (name, key_prefix, key_hash, session_ids, ip_allowlist)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, prefix, hash, sessionIds, ipAllowlist]
      );
      return { key, ...formatKey(res.rows[0]) };
    },

    async list() {
      const res = await db.query('SELECT * FROM api_keys ORDER BY id');
      return res.rows.map(formatKey);
    },

    async revoke(id) {
      const res = await db.query(
        'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING *',
        [id]
      );
      const row = res.rows[0];
      if (!row) return null;
      cache.del(row.key_prefix);
      return formatKey(row);
    },

    /** The active key row matching a presented key, or null. */
    async resolve(presented) {
      const match = KEY_PATTERN.exec(String(presented || ''));
      if (!match) return null;
      const prefix = match[1];
      let row = cache.get(prefix);
      if (row === undefined) {
        const res = await db.query('SELECT * FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL', [prefix]);
        row = res.rows[0] || null;
        cache.set(prefix, row);
      }
      if (!row || !crypto.timingSafeEqual(Buffer.from(hashApiKey(presented)), Buffer.from(row.key_hash))) {
        return null;
      }
      touch(row.id);
      return row;
    }
  };
}

export const apiKeyStore = createApiKeyStore();
```
`src/middlewares/auth.js` (tulis ulang):
```js
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError, sendError } from '../utils/errors.js';
import { apiKeyStore, ipAllowed } from '../services/apiKeys.js';

const ADMIN_AUTH = Object.freeze({ isAdmin: true, keyId: null, sessionIds: null });

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
  return res.status(401).json({ success: false, error: 'Unauthorized: missing or invalid x-api-key header.' });
}

/**
 * Signed, short-lived token that lets a browser open one session's QR page without an API key.
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
 * Identifies the caller from the x-api-key header (query-string keys leak into logs and are ignored):
 * - the master API_KEY: admin, every session and key management
 * - a tenant key (wagw_…): only its sessions, optionally only from allowed IPs
 * Without API_KEY (development only, see validateConfig) every caller is admin.
 */
async function resolveAuth(req, { apiKey, keyStore }) {
  if (!apiKey) return ADMIN_AUTH;
  const provided = req.get('x-api-key');
  if (!provided) return null;
  if (safeEqual(provided, apiKey)) return ADMIN_AUTH;
  const key = await keyStore.resolve(provided);
  if (!key) return null;
  if (key.ip_allowlist && !ipAllowed(key.ip_allowlist, req.ip)) {
    throw new AppError(403, 'This API key is not allowed from your IP address.');
  }
  return { isAdmin: false, keyId: Number(key.id), sessionIds: key.session_ids };
}

export function createAuthenticate({ apiKey, keyStore }) {
  return async (req, res, next) => {
    try {
      const auth = await resolveAuth(req, { apiKey, keyStore });
      if (!auth) return unauthorized(res);
      req.auth = auth;
      return next();
    } catch (error) {
      return sendError(res, error, 'Auth');
    }
  };
}

/**
 * The QR page also accepts a signed ?token= link, which grants access to that one session.
 */
export function createQrPageAuth({ apiKey, keyStore }) {
  const authenticate = createAuthenticate({ apiKey, keyStore });
  return (req, res, next) => {
    if (apiKey && verifyQrLinkToken(req.params.sessionId, req.query.token, { secret: apiKey })) {
      req.auth = { isAdmin: false, keyId: null, sessionIds: [req.params.sessionId] };
      return next();
    }
    return authenticate(req, res, next);
  };
}

export function canAccessSession(auth, sessionId) {
  return Boolean(auth && (auth.isAdmin || auth.sessionIds === null || auth.sessionIds.includes(sessionId)));
}

export function assertSessionAccess(req, sessionId) {
  if (!canAccessSession(req.auth, sessionId)) {
    throw new AppError(403, `This API key has no access to session "${sessionId}".`);
  }
}

/** Sessions the caller may see, or null for all. */
export function allowedSessionIds(req) {
  return req.auth?.isAdmin ? null : req.auth?.sessionIds ?? null;
}

export function requireSessionAccess(req, res, next) {
  try {
    assertSessionAccess(req, req.params.sessionId);
    return next();
  } catch (error) {
    return sendError(res, error, 'Auth');
  }
}

export function requireAdmin(req, res, next) {
  if (req.auth?.isAdmin) return next();
  return sendError(res, new AppError(403, 'This endpoint requires the master API key.'), 'Auth');
}

export const authenticate = createAuthenticate({ apiKey: config.apiKey, keyStore: apiKeyStore });
export const qrPageAuth = createQrPageAuth({ apiKey: config.apiKey, keyStore: apiKeyStore });
```
Scoping:
  - **`sessionRoutes`:**
    - `router.get('/:sessionId/qr', qrPageAuth, requireSessionAccess, getQrCode)`;
    - `router.use(authenticate)`;
    - semua route `/:sessionId/...` diberi `requireSessionAccess`;
    - `initSession` memanggil `assertSessionAccess(req, sessionId)`;
    - `listSessions` difilter dengan `allowedSessionIds(req)`.
  - **`messageRoutes`:** `GET /:sessionId` dan download diberi `requireSessionAccess`; controller kirim memanggil `assertSessionAccess`.
  - **`queueController`:**
    - item endpoint: ambil item → `assertSessionAccess(req, item.session_id)` → baru aksi;
    - `listQueue` memakai `sessionIds: sessionId ? null : allowedSessionIds(req)` dan `assertSessionAccess` jika `sessionId` diberikan.
  - **`outboundQueue.list`:** tambah `sessionIds = null` → `AND ($5::text[] IS NULL OR session_id = ANY($5::text[]))`.
  - **`routes/index.js`:**
    - `apiKeyAuth` → `authenticate`;
    - `router.use('/keys', authenticate, requireAdmin, keysRoutes)`.
  - **`src/index.js`:** `app.set('trust proxy', config.trustProxy);`

`src/controllers/keysController.js`
```js
import { apiKeyStore, parseIpAllowlist } from '../services/apiKeys.js';
import { AppError, sendError } from '../utils/errors.js';
import { assertSessionId, parseOptionalInt } from '../utils/validation.js';

function parseSessionIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 100) {
    throw new AppError(400, 'sessionIds must be null (every session) or an array of up to 100 session ids.');
  }
  return [...new Set(value.map((sessionId) => assertSessionId(sessionId)))];
}

export async function createKey(req, res) {
  try {
    const { name } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      throw new AppError(400, 'name is required (at most 100 characters).');
    }
    const created = await apiKeyStore.create({
      name: name.trim(),
      sessionIds: parseSessionIds(req.body.sessionIds),
      ipAllowlist: parseIpAllowlist(req.body.ipAllowlist)
    });
    const { key, ...apiKey } = created;
    return res.status(201).json({ success: true, key, apiKey, message: 'Store this key now: it is not shown again.' });
  } catch (error) {
    return sendError(res, error, 'KeysController');
  }
}

export async function listKeys(req, res) {
  try {
    const keys = await apiKeyStore.list();
    return res.status(200).json({ success: true, count: keys.length, keys });
  } catch (error) {
    return sendError(res, error, 'KeysController');
  }
}

export async function revokeKey(req, res) {
  try {
    const keyId = parseOptionalInt(req.params.keyId, { name: 'keyId', min: 1, max: Number.MAX_SAFE_INTEGER });
    const revoked = await apiKeyStore.revoke(keyId);
    if (!revoked) throw new AppError(404, `Active API key ${keyId} not found.`);
    return res.status(200).json({ success: true, apiKey: revoked });
  } catch (error) {
    return sendError(res, error, 'KeysController');
  }
}
```
`src/routes/keysRoutes.js`: `POST /`, `GET /`, `DELETE /:keyId`.
- [ ] **Step 4: Run** (termasuk DB) → PASS. **Commit** `feat: multi-tenant API keys with session scoping and IP allowlists`.

---

### Task 9: Adapter Fonnte

**Files:**
- Create: `src/fonnte/fonnteParams.js`, `src/fonnte/fonnteWebhook.js`, `src/fonnte/fonnteRoutes.js`
- Modify: `src/services/webhookConfigResolver.js` (format + phone), `src/services/webhookService.js`, `sessionManager.setSessionWebhookConfig` (`format`), `src/index.js` (mount `/fonnte`)
- Test: `test/fonnteParams.test.js`, `test/fonnteWebhook.test.js`, `test/webhookConfigResolver.test.js` (ubah ekspektasi)

- [ ] **Step 1: Test** — `test/fonnteParams.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonnteError, mapFonnteSend, parseFonnteData, parseFonnteDelay } from '../src/fonnte/fonnteParams.js';

const now = () => Date.parse('2026-10-03T00:00:00Z');

test('parses fixed and random delays in seconds', () => {
  assert.equal(parseFonnteDelay(undefined)(), 0);
  assert.equal(parseFonnteDelay('5')(), 5000);
  assert.equal(parseFonnteDelay('5-10', () => 0.5)(), 7500);
  assert.throws(() => parseFonnteDelay('ten'), FonnteError);
  assert.throws(() => parseFonnteDelay('10-5'), FonnteError);
});

test('maps a text send with variables, country code and stacked delays', () => {
  const items = mapFonnteSend({ target: '0811|Budi,0812|Ani', message: 'Hai {name}', delay: '2', countryCode: '62' }, { now });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => [item.to, item.type, item.payload.text]), [['0811', 'text', 'Hai Budi'], ['0812', 'text', 'Hai Ani']]);
  assert.equal(items[0].scheduleAt, null);
  assert.equal(items[1].scheduleAt.toISOString(), '2026-10-03T00:00:02.000Z');
  assert.equal(items[0].delayMs, 0);
  assert.equal(items[0].connectOnly, true);
});

test('maps schedule, typing, location, poll and media', () => {
  const [scheduled] = mapFonnteSend({ target: '0811', message: 'x', schedule: String(now() / 1000 + 60), typing: 'true', duration: '3' }, { now });
  assert.equal(scheduled.scheduleAt.toISOString(), '2026-10-03T00:01:00.000Z');
  assert.equal(scheduled.delayMs, 3000);

  const [location] = mapFonnteSend({ target: '0811', location: '-7.98, 112.62' }, { now });
  assert.deepEqual([location.type, location.payload], ['location', { latitude: -7.98, longitude: 112.62 }]);

  const [poll] = mapFonnteSend({ target: '0811', choices: 'A,B,C', select: 'multiple', pollname: 'Pilih' }, { now });
  assert.deepEqual(poll.payload, { name: 'Pilih', options: ['A', 'B', 'C'], selectableCount: 0 });

  const [image] = mapFonnteSend({ target: '0811', message: 'Promo', url: 'https://x.test/a.JPG' }, { now });
  assert.deepEqual([image.type, image.payload, image.media], ['image', { caption: 'Promo' }, 'https://x.test/a.JPG']);

  const [doc] = mapFonnteSend({ target: '0811', url: 'https://x.test/f.pdf', filename: 'Invoice.pdf' }, { now });
  assert.deepEqual([doc.type, doc.payload.fileName], ['document', 'Invoice.pdf']);

  const [upload] = mapFonnteSend({ target: '0811', message: 'Lagu' }, { now, file: { buffer: Buffer.from('a'), mimetype: 'audio/mpeg', originalname: 'a.mp3' } });
  assert.equal(upload.type, 'audio');
});

test('rejects missing targets, empty messages and malformed values', () => {
  assert.throws(() => mapFonnteSend({ message: 'x' }, { now }), { message: 'target invalid' });
  assert.throws(() => mapFonnteSend({ target: '0811' }, { now }), { message: 'input invalid' });
  assert.throws(() => mapFonnteSend({ target: '0811', location: 'nowhere' }, { now }), { message: 'input invalid' });
});

test('parses the data parameter', () => {
  assert.deepEqual(parseFonnteData('[{"target":"0811","message":"1"}]'), [{ target: '0811', message: '1' }]);
  assert.throws(() => parseFonnteData('{bad'), { message: 'JSON format invalid' });
  assert.throws(() => parseFonnteData('{"target":"0811"}'), { message: 'JSON format invalid' });
});
```
`test/fonnteWebhook.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFonnteWebhook } from '../src/fonnte/fonnteWebhook.js';

const device = '628100000000';

test('incoming personal and group messages use Fonnte field names', () => {
  const personal = toFonnteWebhook('message.received', {
    messageId: 'M1', remoteJid: '62811@s.whatsapp.net', senderJid: '62811@s.whatsapp.net', senderPhone: '62811',
    fromMe: false, pushName: 'Budi', isGroup: false, messageType: 'text', content: 'Halo', media: null,
    timestamp: '2026-10-03T00:00:00.000Z'
  }, { device });
  assert.deepEqual(personal, {
    device, sender: '62811', message: 'Halo', text: 'Halo', member: '', name: 'Budi', location: '',
    pollname: '', choices: '', filename: '', extension: '', inboxid: 'M1', timestamp: 1790985600
  });

  const group = toFonnteWebhook('message.received', {
    messageId: 'M2', remoteJid: '1203@g.us', senderJid: '999@lid', senderPhone: '62822', fromMe: false, pushName: 'Ani',
    isGroup: true, messageType: 'location', content: '', media: { degreesLatitude: 1.5, degreesLongitude: 2.5 },
    timestamp: '2026-10-03T00:00:00.000Z'
  }, { device });
  assert.equal(group.sender, '1203@g.us');
  assert.equal(group.member, '62822');
  assert.equal(group.location, '1.5,2.5');
});

test('own messages and unsupported events are not forwarded', () => {
  assert.equal(toFonnteWebhook('message.received', { fromMe: true }, { device }), null);
  assert.equal(toFonnteWebhook('connection.update', { status: 'qr_ready' }, { device }), null);
  assert.equal(toFonnteWebhook('account.restriction', {}, { device }), null);
});

test('status and connection events', () => {
  assert.deepEqual(toFonnteWebhook('message.status', { queueId: 42, messageId: 'M1', status: 'sent' }, { device }),
    { device, id: '42', stateid: 'M1', status: 'sent' });
  assert.deepEqual(toFonnteWebhook('message.status', { queueId: 42, messageId: 'M1', status: 'read' }, { device }),
    { device, id: '42', stateid: 'M1', state: 'read' });
  const connected = toFonnteWebhook('connection.update', { status: 'connected', phoneNumber: '62899' }, { device: null });
  assert.equal(connected.device, '62899');
  assert.equal(connected.status, 'connect');
  const lost = toFonnteWebhook('connection.update', { status: 'reconnecting', disconnectReason: 'connection_lost' }, { device });
  assert.deepEqual([lost.status, lost.reason], ['disconnect', 'connection_lost']);
});
```
Di `test/webhookConfigResolver.test.js`:
- objek hasil `resolve` sekarang juga berisi `format` (default `'default'`) dan `phone`;
- baris fake menambahkan `webhook_format` dan `phone_number`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implementasi** — `src/fonnte/fonnteParams.js`
```js
import { parseTargets, renderTemplate } from '../services/bulkTargets.js';

/**
 * Error answered as Fonnte does: HTTP 200 with { status: false, reason }.
 */
export class FonnteError extends Error {}

const isTrue = (value) => value === true || value === 'true' || value === '1' || value === 1;
const MAX_TYPING_MS = 15000;

/**
 * Fonnte delay syntax: "5" seconds or "5-10" (random per gap). Returns a function producing ms.
 */
export function parseFonnteDelay(value, random = Math.random) {
  if (value === undefined || value === null || value === '') return () => 0;
  const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(String(value));
  if (!match) throw new FonnteError('input invalid');
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (max < min) throw new FonnteError('input invalid');
  return () => Math.round((min + random() * (max - min)) * 1000);
}

export function parseFonnteData(data) {
  let items = data;
  if (typeof data === 'string') {
    try {
      items = JSON.parse(data);
    } catch {
      throw new FonnteError('JSON format invalid');
    }
  }
  if (!Array.isArray(items) || !items.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    throw new FonnteError('JSON format invalid');
  }
  return items;
}

function mediaTypeOf({ mimetype, name }) {
  const extension = String(name || '').split('?')[0].split('.').pop().toLowerCase();
  if (mimetype?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension)) return 'image';
  if (mimetype?.startsWith('video/') || ['mp4', '3gp', 'mov'].includes(extension)) return 'video';
  if (mimetype?.startsWith('audio/') || ['mp3', 'ogg', 'm4a', 'aac', 'wav', 'opus'].includes(extension)) return 'audio';
  return 'document';
}

function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function contentOf(params, file) {
  const message = params.message ?? '';
  if (params.location) {
    const [latitude, longitude] = String(params.location).split(',').map((part) => Number(part.trim()));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new FonnteError('input invalid');
    return { type: 'location', payload: { latitude, longitude }, media: null };
  }
  if (params.choices) {
    const options = String(params.choices).split(',').map((option) => option.trim()).filter(Boolean);
    return {
      type: 'poll',
      payload: { name: params.pollname || message || 'Poll', options, selectableCount: params.select === 'multiple' ? 0 : 1 },
      media: null
    };
  }
  if (file || params.url) {
    const name = file ? file.originalname : urlPath(params.url);
    const type = mediaTypeOf({ mimetype: file?.mimetype, name });
    const payload = {};
    if (message && type !== 'audio') payload.caption = message;
    if (type === 'document') payload.fileName = params.filename || String(name).split('/').pop() || 'file';
    if (file?.mimetype) payload.mimetype = file.mimetype;
    return { type, payload, media: file ? file.buffer : params.url };
  }
  if (!message) throw new FonnteError('input invalid');
  return { type: 'text', payload: { text: message }, media: null };
}

/**
 * Maps one Fonnte /send request (or one `data` item) to message submissions, one per target.
 * `delay` stacks between targets (the first goes at the base time); `schedule` (unix seconds) and
 * `followup` (seconds) move the base time.
 */
export function mapFonnteSend(params, { now = Date.now, random = Math.random, file = null } = {}) {
  const targets = parseTargets(params.target);
  if (!targets.length) throw new FonnteError('target invalid');
  const { type, payload, media } = contentOf(params, file);
  const nextDelay = parseFonnteDelay(params.delay, random);

  let base = null;
  if (params.schedule !== undefined && params.schedule !== '' && Number(params.schedule) > 0) {
    if (!/^\d+$/.test(String(params.schedule))) throw new FonnteError('input invalid');
    base = Number(params.schedule) * 1000;
  }
  if (params.followup !== undefined && params.followup !== '' && Number(params.followup) > 0) {
    base = (base ?? now()) + Number(params.followup) * 1000;
  }

  const countryCode = params.countryCode === undefined || params.countryCode === '' ? '62' : String(params.countryCode);
  const delayMs = isTrue(params.typing) ? Math.min(Math.max(Number(params.duration) || 1, 0) * 1000, MAX_TYPING_MS) : 0;
  const connectOnly = params.connectOnly === undefined || params.connectOnly === '' ? true : isTrue(params.connectOnly);
  const replyTo = params.inboxid ? String(params.inboxid) : null;

  let offset = 0;
  return targets.map((target, index) => {
    if (index > 0) offset += nextDelay();
    const at = base !== null || offset ? (base ?? now()) + offset : null;
    const personalized = { ...payload };
    for (const field of ['text', 'caption', 'name']) {
      if (typeof personalized[field] === 'string') personalized[field] = renderTemplate(personalized[field], target);
    }
    return {
      to: target.number,
      type,
      payload: personalized,
      media,
      countryCode,
      delayMs,
      connectOnly,
      replyTo,
      scheduleAt: at !== null && at > now() ? new Date(at) : null
    };
  });
}
```
`src/fonnte/fonnteWebhook.js`
```js
import { phoneFromJid } from '../utils/jid.js';

const unixTime = (iso) => Math.floor((iso ? Date.parse(iso) : Date.now()) / 1000);

/**
 * Converts gateway webhook events into Fonnte webhook payloads, for receivers written for Fonnte.
 * Returns null for events that have no Fonnte equivalent.
 */
export function toFonnteWebhook(eventType, data, { device }) {
  switch (eventType) {
    case 'message.received': {
      if (data.fromMe) return null;
      const senderPhone = data.senderPhone || phoneFromJid(data.senderJid);
      const fileName = data.media?.fileName || '';
      return {
        device,
        sender: data.isGroup ? data.remoteJid : senderPhone,
        message: data.content || '',
        text: data.content || '',
        member: data.isGroup ? senderPhone : '',
        name: data.pushName || '',
        location: data.messageType === 'location' && data.media
          ? `${data.media.degreesLatitude},${data.media.degreesLongitude}`
          : '',
        pollname: data.messageType === 'poll' ? data.content || '' : '',
        choices: data.messageType === 'poll' ? (data.media?.options || []).join(',') : '',
        filename: fileName,
        extension: fileName.includes('.') ? fileName.split('.').pop() : '',
        inboxid: data.messageId,
        timestamp: unixTime(data.timestamp)
      };
    }
    case 'message.status': {
      const id = data.queueId !== null && data.queueId !== undefined ? String(data.queueId) : data.messageId;
      if (['delivered', 'read', 'played'].includes(data.status)) {
        return { device, id, stateid: data.messageId || '', state: data.status === 'played' ? 'read' : data.status };
      }
      return { device, id, stateid: data.messageId || '', status: data.status };
    }
    case 'connection.update': {
      if (data.status === 'connected') {
        return { device: data.phoneNumber || device, status: 'connect', timestamp: unixTime() };
      }
      if (data.status === 'disconnected' || data.status === 'reconnecting') {
        return { device, status: 'disconnect', reason: data.disconnectReason || data.reason || '', timestamp: unixTime() };
      }
      return null;
    }
    default:
      return null;
  }
}
```
`webhookConfigResolver.js`:
- query menambah `webhook_format, phone_number`;
- `entry` menyimpan `format: row?.webhook_format || 'default'` dan `phone: row?.phone_number || null`;
- `resolve` mengembalikan `{ url, secret, events, format, phone }`.

`webhookService.sendWebhookEvent`:
```js
    const body = target.format === 'fonnte'
      ? toFonnteWebhook(eventType, payload, { device: target.phone })
      : { event: eventType, sessionId, timestamp: new Date().toISOString(), data: payload };
    if (!body) return;
    await webhookOutbox.enqueue({ sessionId, eventType, payload: body });
```
`setSessionWebhookConfig`:
- terima `format`: `undefined` = tidak berubah; `'default' | 'fonnte'`, selain itu 400;
- kolom `webhook_format`;
- RETURNING ditambah `webhook_format`, dan respons memuat `format`.
- Controller meneruskan `req.body.format`.

`src/fonnte/fonnteRoutes.js`
```js
import express from 'express';
import multer from 'multer';
import { apiKeyStore, ipAllowed } from '../services/apiKeys.js';
import { cancelQueuedMessage, getQueuedMessage, submitMessage } from '../services/messageService.js';
import { validateNumbers } from '../services/numberService.js';
import { getSessionStatus, isSessionConnected, listGroups } from '../services/sessionManager.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { normalizeTarget } from '../utils/phone.js';
import { assertSafeUrl } from '../utils/netGuard.js';
import { phoneFromJid } from '../utils/jid.js';
import { config } from '../config/index.js';
import { FonnteError, mapFonnteSend, parseFonnteData } from './fonnteParams.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.mediaMaxBytes } });
const router = express.Router();

/**
 * Fonnte answers every request with HTTP 200 and { status: false, reason } on errors.
 */
function fail(res, error) {
  if (error instanceof FonnteError) return res.json({ status: false, reason: error.message });
  if (error instanceof AppError) {
    if (error.status === 409) return res.json({ status: false, reason: 'device disconnected' });
    if (error.status < 500) return res.json({ status: false, reason: error.message });
  }
  logger.error({ err: error }, 'Fonnte adapter request failed');
  return res.json({ status: false, reason: 'server error' });
}

/**
 * Fonnte device tokens: tenant API keys bound to exactly one session. Several tokens separated by
 * commas rotate between their sessions.
 */
async function fonnteAuth(req, res, next) {
  try {
    const tokens = String(req.get('authorization') || '').split(',').map((token) => token.trim()).filter(Boolean);
    if (!tokens.length) throw new FonnteError('token invalid');
    const sessionIds = new Set();
    for (const token of tokens) {
      const key = await apiKeyStore.resolve(token);
      if (!key || key.session_ids?.length !== 1 || !ipAllowed(key.ip_allowlist, req.ip)) {
        throw new FonnteError('token invalid');
      }
      sessionIds.add(key.session_ids[0]);
    }
    req.fonnte = { sessionIds: [...sessionIds] };
    return next();
  } catch (error) {
    return fail(res, error);
  }
}

function pickSession(sessionIds, mustBeConnected) {
  const candidates = mustBeConnected ? sessionIds.filter(isSessionConnected) : sessionIds;
  if (!candidates.length) throw new FonnteError('device disconnected');
  return candidates[Math.floor(Math.random() * candidates.length)];
}

router.post('/send', upload.single('file'), fonnteAuth, async (req, res) => {
  try {
    const hasData = req.body.data !== undefined && req.body.data !== '';
    const requests = hasData ? parseFonnteData(req.body.data) : [req.body];
    const items = requests.flatMap((params) => mapFonnteSend(params, { file: hasData ? null : req.file }));

    // Validate everything first so a bad item does not leave half the request queued
    for (const item of items) {
      try {
        normalizeTarget(item.to, item.countryCode);
      } catch {
        throw new FonnteError('target invalid');
      }
      if (typeof item.media === 'string') {
        try {
          assertSafeUrl(item.media, { allowPrivate: config.allowPrivateUrls, label: 'url' });
        } catch {
          throw new FonnteError('url invalid');
        }
      }
    }

    const ids = [];
    const targets = [];
    for (const item of items) {
      const sessionId = pickSession(req.fonnte.sessionIds, item.connectOnly && !item.scheduleAt);
      const { item: queued } = await submitMessage({ sessionId, ...item, wait: false });
      ids.push(String(queued.id));
      targets.push(phoneFromJid(queued.target_jid));
    }
    const scheduled = items.some((item) => item.scheduleAt);
    return res.json({
      detail: scheduled ? 'success! message will be sent on scheduled time' : 'success! message in queue',
      id: ids,
      process: 'pending',
      requestid: Number(ids[0]),
      status: true,
      target: targets
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/validate', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const numbers = String(req.body.target || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    if (!numbers.length) throw new FonnteError('target required');
    const countryCode = req.body.countryCode === undefined || req.body.countryCode === '' ? '62' : String(req.body.countryCode);
    const result = await validateNumbers(req.fonnte.sessionIds[0], numbers, { countryCode });
    return res.json({ status: true, registered: result.registered, not_registered: [...result.notRegistered, ...result.invalid] });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/device', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const status = await getSessionStatus(req.fonnte.sessionIds[0]);
    return res.json({
      status: true,
      device: status.phoneNumber || '',
      device_status: status.status === 'connected' ? 'connect' : 'disconnect',
      name: status.customName || status.sessionId,
      package: 'self-hosted',
      quota: 'unlimited'
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/get-whatsapp-group', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const { groups } = await listGroups(req.fonnte.sessionIds[0]);
    if (!groups.length) return res.json({ status: false, detail: 'you have no whatsapp group yet' });
    return res.json({ status: true, data: groups.map((group) => ({ id: group.id, name: group.subject })) });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/fetch-group', upload.none(), fonnteAuth, async (req, res) => {
  try {
    await listGroups(req.fonnte.sessionIds[0], { refresh: true });
    return res.json({ status: true, detail: 'update whatsapp group list finished' });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/delete-message', upload.none(), fonnteAuth, async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!Number.isInteger(id) || id < 1) throw new FonnteError('invalid message id');
    const item = await getQueuedMessage(id).catch(() => null);
    if (!item || !req.fonnte.sessionIds.includes(item.session_id)) throw new FonnteError('invalid message id');
    if (item.status !== 'queued') throw new FonnteError(`cannot delete message with status ${item.status}`);
    await cancelQueuedMessage(id);
    return res.json({ status: true, detail: `message ${id} successfully deleted` });
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
```
`src/index.js`: `app.use('/fonnte', fonnteRoutes);` (sebelum landing page).

- [ ] **Step 4: Run** → PASS. **Commit** `feat: Fonnte-compatible API and webhook format`.

---

### Task 10: Dokumentasi
- [ ] **README:**
  - endpoint terpadu + tabel tipe pesan;
  - kirim massal + variabel;
  - validasi nomor, grup, settings, panggilan;
  - API key tenant (contoh create/scoping/IP), `TRUST_PROXY`;
  - adapter Fonnte (cara migrasi, endpoint yang didukung, perbedaan);
  - webhook format Fonnte;
  - env baru; perubahan yang breaking: tidak ada, kecuali `/api/webhook-test` dan `PUT webhook` tetap sama.
- [ ] **`.env.example`:** `TRUST_PROXY`, `BULK_MAX_TARGETS`, `VALIDATE_*`, `GROUPS_CACHE_MINUTES`.
- [ ] **Landing page:** endpoint baru.
- [ ] **Commit** `docs: Fase 2 unified sending, tenants and Fonnte adapter`.

### Task 11: Verifikasi
- [ ] `DB_TEST=1 … npm test` → semua PASS.
- [ ] **Smoke** (server production mode + Postgres test + receiver webhook):

| Skenario | Expected |
|---|---|
| `POST /api/keys` tanpa master key / dengan master key | 401 / 201 + key `wagw_…` |
| Key tenant (session `s1`) akses `/api/sessions/s2/status` | 403 |
| Key tenant dari IP di luar allowlist | 403 |
| Key tenant: `GET /api/sessions` | Hanya `s1` |
| Revoke key, lalu pakai lagi | 401 |
| `/api/messages/send` type `poll` dengan 1 opsi | 400 |
| `/api/messages/send` ke `"0811|Budi,abc,0811"` + `connectOnly:false` | 202; `queued` 1, `invalid` 1, `skipped` 1; teks ter-render |
| `/api/messages/send` type `reaction` dengan `messageId` tak dikenal | 404 |
| `/api/sessions/s1/validate`, `/groups` (belum connect) | 409 |
| `PATCH /settings` key tak dikenal / valid | 400 / 200 |
| `/fonnte/send` token salah / token valid + `connectOnly=false` / target `abc` | `{status:false, reason:"token invalid"}` / `{status:true, id:[…]}` / `target invalid` (HTTP 200 semua) |
| `/fonnte/delete-message` id tadi | `status:true`, kedua kali `cannot delete message with status cancelled` |
| Webhook `format: "fonnte"`, QR habis | Receiver menerima `{device, status:"disconnect", reason:"pairing_timeout"}` |
