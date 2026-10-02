# Fase Anti-Ban (P0 + P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menurunkan risiko restriction/ban dengan mengubah **perilaku** gateway, bukan menyamarkan klien.
- **P0:**
  - berhenti saat di-ban;
  - menjeda chat baru saat WhatsApp membatasi;
  - anggaran dan jeda khusus untuk chat baru;
  - masa tenang setelah pairing/reconnect.
- **P1:**
  - opt-out/opt-in;
  - kategori pesan + jam kampanye + batas frekuensi;
  - monitor kesehatan dengan auto-pause;
  - routing sticky;
  - menutup fitur berisiko.

**Architecture:**
- **Gerbang kirim (`sendGate`).** Setiap pesan dievaluasi tepat sebelum dikirim oleh queue runner, dengan tiga kemungkinan hasil:
  - `send`;
  - `defer` (dijadwal ulang, tidak memakan jatah retry);
  - `skip` (status final `skipped` + alasan).
- **Sumber keputusan:**
  - status sesi di DB (jeda, waktu pairing, kuota WhatsApp, ban);
  - riwayat kontak: apakah penerima pernah mengirim pesan ke nomor ini;
  - catatan persetujuan (consent).
- **Reaksi terhadap sinyal WhatsApp:**
  - **463** dan **reach-out timelock** → menjeda chat baru sesi tersebut;
  - **capping** → menjeda chat baru sesi tersebut;
  - **402/406** → menghentikan sesi.
- **Monitor kesehatan:** menjeda **kampanye** saat tingkat terkirim atau tingkat balasan anjlok, meniru cara Meta menjeda template berkualitas rendah.

**Tech Stack:** Node.js 22, Baileys 7.0.0-rc14, PostgreSQL 16, `node:test`.

---

## Bukan tujuan
Tidak ada spoofing fingerprint, rotasi proxy/IP, spintax, rotasi nomor untuk akal-akalan limit, bot warm-up, atau failover otomatis ke nomor lain saat satu nomor dibatasi.

## Definisi
- **Kontak dikenal:** penerima yang pernah mengirim pesan 1:1 ke session ini, dicocokkan dengan `remote_jid` atau `remote_jid_alt` dari pesan masuk. Kirim ke kontak dikenal **bukan** chat baru.
- **Chat baru:** kirim ke penerima yang belum dikenal. Ini yang dihitung kuota WhatsApp dan yang memicu 463 dan temp-ban 101.
- **Kategori pesan:**
  - `transactional` — default untuk kirim tunggal;
  - `campaign` — default untuk kirim massal;
  - `reply` — jawaban dalam percakapan aktif (penerima menulis < 24 jam lalu).
- **Persetujuan:**
  - Opt-out dari keyword STOP/BERHENTI dll. atau dari API; berlaku kecuali penerima menulis lagi setelahnya.
  - Opt-in dari keyword START dll. atau dari API.

## Aturan gerbang (urutan evaluasi)

| # | Berlaku untuk | Aturan | Hasil |
|---|---|---|---|
| 0 | reaction/edit/delete | Bekerja pada chat yang sudah ada | send |
| 1 | semua (non-grup) | Penerima opt-out (kecuali `reply` dalam percakapan aktif) | skip |
| 2 | campaign | Wajib consent (`CAMPAIGN_REQUIRE_CONSENT`, default **true**): penerima harus kontak dikenal atau opt-in | skip |
| 3 | campaign | Kampanye sesi sedang dijeda (monitor kesehatan) | defer sampai jeda selesai |
| 4 | campaign | Di luar `CAMPAIGN_HOURS` (default 08:00–20:00 Asia/Jakarta) | defer ke jam buka berikutnya |
| 5 | campaign | Penerima sudah menerima kampanye dalam `CAMPAIGN_RECIPIENT_COOLDOWN_HOURS` (72 jam) | skip |
| 6 | kontak dikenal / grup | — | send |
| 7 | chat baru | Chat baru sesi dijeda (463 / timelock / capping) | defer |
| 8 | chat baru | Masa tenang setelah pairing (`NEW_SESSION_COOLDOWN_HOURS`, 72) | defer |
| 9 | chat baru | Baru connect (`RECONNECT_WARMUP_MS`, 2 menit) | defer |
| 10 | chat baru | Kuota bulanan WhatsApp habis (`used ≥ total`) | defer ke akhir siklus |
| 11 | chat baru | Anggaran harian (`NEW_CONTACT_DAILY_LIMIT`, 20, rolling 24 jam) | defer sampai slot kosong |
| 12 | chat baru | Jeda antar chat baru (`NEW_CONTACT_INTERVAL_MIN/MAX_MS`, 60–180 detik) | defer |
| 13 | chat baru | Nomor tidak terdaftar di WhatsApp (cek ber-cache, `VALIDATE_NEW_CONTACTS`) | skip |
| 14 | — | Lolos semua | send (`new_contact = true`) |

Angka default adalah heuristik konservatif, bukan angka resmi WhatsApp; semuanya bisa diubah lewat env atau per session.

## Struktur file

| File | Status | Isi |
|---|---|---|
| `src/database/migrations/005_anti_ban.sql` | baru | Kolom guard di `sessions`, `category`/`new_contact` di antrian, tabel `contact_consents`, index |
| `src/services/banPolicy.js` | baru | `describeBan` (402/406 + kode alasan) |
| `src/utils/timeWindow.js` | baru | `parseTimeWindow`, `nextWindowStart` |
| `src/services/consent.js` | baru | Keyword opt-in/opt-out, `consentBlockReason` |
| `src/services/healthPolicy.js` | baru | `evaluateHealth` |
| `src/services/routing.js` | baru | `pickStickySession` |
| `src/services/sendGate.js` | baru | Gerbang kirim |
| `src/services/guardStore.js` | baru | Akses DB untuk guard/kontak/consent/metrik |
| `src/services/antiBan.js` | baru | Reaksi terhadap sinyal WhatsApp, jeda + webhook, monitor kesehatan, laporan |
| `src/controllers/guardController.js` | baru | `/health`, `/health/resume`, `/consents` |
| `src/services/reconnectPolicy.js` | ubah | Stop pada 402/406/409 |
| `src/services/queueRunner.js`, `outboundQueue.js` | ubah | Integrasi gate, `defer`, `markSkipped`, `category`, `new_contact` |
| `src/services/sessionManager.js` | ubah | Ban, 463, timelock, capping, paired_at, connectedAt, keyword consent |
| `src/services/messageService.js`, `numberService.js`, `numberCheck.js` | ubah | Kategori, cek consent saat enqueue, gate, batas lookup harian |
| `src/fonnte/fonnteRoutes.js` | ubah | Routing sticky, kategori |
| `src/utils/phone.js`, `src/services/messageStatus.js`, `sessionSettings.js`, `webhookService.js`, `config` | ubah | Blokir `@broadcast`, hapus 475, setting baru, event baru, config |

---

### Task 1: Migrasi + config + konstanta
- [ ] **`005_anti_ban.sql`:**
```sql
-- Anti-ban guards decided by the gateway, WhatsApp's own signals and ban details
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS paired_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_chats_paused_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_chats_pause_reason VARCHAR(200);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS campaigns_paused_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS campaigns_pause_reason VARCHAR(200);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ban_code INT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ban_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chat_cap JSONB;

-- Sessions paired before this migration count as paired when they were created (no cool-down for them)
UPDATE sessions SET paired_at = created_at WHERE paired_at IS NULL AND phone_number IS NOT NULL;

-- Campaign rules only apply to campaigns; new_contact marks sends that opened a new chat
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'transactional';
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS new_contact BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_outbound_new_contact_sent ON outbound_messages(session_id, sent_at) WHERE new_contact;
CREATE INDEX IF NOT EXISTS idx_outbound_campaign_target ON outbound_messages(session_id, target_jid, sent_at) WHERE category = 'campaign';

-- Opt-ins imported through the API and opt-outs from STOP keywords or the API
CREATE TABLE IF NOT EXISTS contact_consents (
    session_id VARCHAR(100) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    jid VARCHAR(150) NOT NULL,
    status VARCHAR(20) NOT NULL, -- opted_in, opted_out
    source VARCHAR(20) NOT NULL, -- api, keyword
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, jid)
);

-- "Has this person ever written to us" lookups
CREATE INDEX IF NOT EXISTS idx_messages_inbound_remote ON messages(session_id, remote_jid, created_at DESC) WHERE from_me = false;
CREATE INDEX IF NOT EXISTS idx_messages_inbound_remote_alt ON messages(session_id, remote_jid_alt, created_at DESC) WHERE from_me = false;
```
- [ ] **Config** `guard` (env → default):
  - `NEW_CONTACT_DAILY_LIMIT`=20
  - `NEW_CONTACT_INTERVAL_MIN_MS`/`MAX_MS`=60000/180000
  - `NEW_SESSION_COOLDOWN_HOURS`=72
  - `RECONNECT_WARMUP_MS`=120000
  - `RESTRICTION_PAUSE_HOURS`=24
  - `CAMPAIGN_HOURS`=08:00-20:00
  - `CAMPAIGN_TIMEZONE`=Asia/Jakarta
  - `CAMPAIGN_RECIPIENT_COOLDOWN_HOURS`=72
  - `CAMPAIGN_REQUIRE_CONSENT`=true
  - `OPT_OUT_KEYWORDS`=STOP,BERHENTI,UNSUBSCRIBE,UNSUB,STOP PROMO,BERHENTI PROMO
  - `OPT_IN_KEYWORDS`=START,SUBSCRIBE,LANGGANAN
  - `VALIDATE_NEW_CONTACTS`=true
  - `CAP_POLL_HOURS`=6
  - `HEALTH_CHECK_INTERVAL_MS`=600000
  - `HEALTH_MIN_SAMPLE`=20
  - `HEALTH_MIN_DELIVERY_RATE`=0.6
  - `HEALTH_MIN_REPLY_RATE`=0.05
  - `HEALTH_PAUSE_HOURS`=24

  Ditambah `validate.dailyLimit` (`VALIDATE_DAILY_LIMIT`=200). `validateConfig` memeriksa format jam, timezone valid (Intl), dan interval min ≤ max.
- [ ] **Konstanta:**
  - `QUEUE_STATUSES` + `skipped`;
  - `WEBHOOK_EVENTS` + `account.banned`, `session.paused`, `contact.consent`;
  - payload `account.restriction` menjadi `{ source, ... }`.
- [ ] **Commit** `feat(db): anti-ban guard columns, consents and config`.

### Task 2 (A): Berhenti saat di-ban
- [ ] **Test** `banPolicy.test.js` + tambahan di `reconnectPolicy.test.js`:
  - 402 → `{ permanent:false, code:101, reason:"…address book", expiresAt: now+expire s }`;
  - 406 → permanen;
  - kode lain → null;
  - `decideReconnect` 402/406/409 → stop.
- [ ] **`banPolicy.js`:**
```js
// Temporary-ban reasons that come with connection failure 402 (strings from WhatsApp Web)
const TEMP_BAN_REASONS = {
  101: 'sent too many messages to people who do not have this number in their address book',
  102: 'too many people blocked this number',
  103: 'created too many groups with people who do not have this number in their address book',
  104: 'sent the same message to too many people',
  106: 'sent too many messages to a broadcast list'
};

/**
 * Details of a ban from a connection failure (402 temporary, 406 permanent), or null for other codes.
 * `data` are the failure attributes; `expire` is the remaining ban time in seconds.
 */
export function describeBan(statusCode, data = {}, now = Date.now) {
  if (statusCode === 402) {
    const code = Number(data?.code) || null;
    const expireSeconds = Number(data?.expire);
    return {
      permanent: false,
      code,
      reason: TEMP_BAN_REASONS[code] || 'temporarily banned by WhatsApp',
      expiresAt: Number.isFinite(expireSeconds) && expireSeconds > 0 ? new Date(now() + expireSeconds * 1000) : null
    };
  }
  if (statusCode === 406) {
    return { permanent: true, code: null, reason: 'banned by WhatsApp', expiresAt: null };
  }
  return null;
}
```
- [ ] **`reconnectPolicy.STOP_REASONS`** + `[402,'temporarily_banned']`, `[406,'banned']`, `[409,'client_rejected']`.
- [ ] **`handleClose`:** jika `describeBan` tidak null → `antiBan.recordBan` (simpan `ban_code`/`ban_expires_at`, webhook `account.banned`). Auth **tidak** dihapus. `getSessionStatus` menampilkan `ban`.
- [ ] **Commit** `fix: stop reconnecting while WhatsApp bans the account`.

### Task 3: Helper murni + perbaikan cepat (I)
- [ ] **Test & implementasi:**
  - `timeWindow.js`: `parseTimeWindow("08:00-20:00")`; `nextWindowStart(now, window, "Asia/Jakarta")` → null di dalam jendela, jam buka berikutnya di luar; mendukung jendela yang melewati tengah malam.
  - `consent.js`:
    - `parseKeywordList`;
    - `matchConsentKeyword(text, {optOut, optIn})` — pesan utuh saja, tidak case-sensitive, tanda baca di akhir diabaikan;
    - `isActiveConversation`;
    - `consentBlockReason({category,isGroup,contact,requireConsent,now})`.
  - `healthPolicy.js`: `evaluateHealth(metrics, {minSample,minDeliveryRate,minReplyRate})`.
  - `routing.js`: `pickStickySession(candidates, jid, conversations)` → sesi dengan percakapan terbaru, jika tidak ada → hash stabil dari jid.
- [ ] **Perbaikan:**
  - `phone.js`: hapus pola `@broadcast` (Status/broadcast list ditolak 400);
  - `messageStatus.js`: hapus 475;
  - test-nya ikut disesuaikan.
- [ ] **Commit** `feat: pure anti-ban helpers; block broadcast targets; drop unsourced 475`.

### Task 4: `guardStore` + antrian
- [ ] **Test DB `guardStore.test.js`:**
  - `getContacts` (lewat `remote_jid` & `remote_jid_alt`, plus consent);
  - `pause`/`clearPause` (memperpanjang hanya jika lebih lama, `reasonPrefix`);
  - `newContactUsage`, `lastCampaignTo`, `conversationsWith`;
  - `setConsents`/`listConsents`/`deleteConsent`;
  - `healthMetrics` (delivery & reply).
- [ ] **Test DB tambahan `outboundQueue.test.js`:**
  - `enqueue` dengan `category`;
  - `defer` (kembali `queued`, `attempts` tidak bertambah);
  - `markSkipped`;
  - `markSent(id, msgId, {newContact:true})`.
- [ ] **Implementasi** sesuai test (SQL di file).
- [ ] **Commit** `feat: guard store and queue support for deferral, skipping and categories`.

### Task 5 (C, D, E, F): Gerbang kirim + runner
- [ ] **Test `sendGate.test.js`** (fake store, jam tetap) — satu kasus per baris tabel aturan, ditambah:
  - `recordSent` memulai jeda chat baru;
  - `settings.newContactDailyLimit` mengalahkan default.
- [ ] **Test `queueRunner.test.js`:**
  - `defer` menjadwal ulang tanpa menghabiskan attempt;
  - `skip` → `finish` status `skipped`;
  - pesan yang di-defer tidak memblokir pesan berikutnya di tick yang sama;
  - `send` meneruskan `newContact` ke `markSent` & `recordSent`;
  - error di gate → defer.
- [ ] **`sendGate.js`:** lihat tabel aturan. Membaca `store.getGuards`, `store.getContacts`, `store.newContactUsage`, `store.lastCampaignTo`, `getSessionState(sessionId) → { settings, connectedAt }`, dan opsional `checkRegistered`.
- [ ] **`queueRunner`:**
  - opsi `gate` dan `maxDecisionsPerTick` (50);
  - `processItem` mengembalikan `sent | deferred | skipped | failed`;
  - `runSession` terus mengambil item selama hasilnya defer/skip.
- [ ] **Commit** `feat: send gate for new chats and campaigns`.

### Task 6 (B, D, E): Reaksi terhadap sinyal WhatsApp di sessionManager
- [ ] **`antiBan.js`:**
  - `pauseSession(sessionId, scope, until, reason)` → simpan; webhook `session.paused` hanya jika jeda baru/lebih lama;
  - `handleRestrictionAck(sessionId, sock)` → panggil `fetchAccountReachoutTimelock()`; kalau timelock tidak aktif atau gagal diambil → jeda `RESTRICTION_PAUSE_HOURS` (`whatsapp_error_463`); dibatasi sekali per 10 menit per sesi;
  - `applyReachoutTimelock(sessionId, t)` → `isActive` → jeda sampai `timeEnforcementEnds`, selain itu bersihkan jeda timelock; webhook `account.restriction`;
  - `applyChatCap(sessionId, info)` → simpan `chat_cap`; `FIRST_WARNING`/`SECOND_WARNING`/`CAPPED` → jeda chat baru sampai akhir siklus, `NONE` → bersihkan;
  - `recordBan`, `recordConsent`.
- [ ] **`sessionManager`:**
  - ack `failed` dengan kode 463 → `handleRestrictionAck` (tidak pernah retry);
  - `connection.update.reachoutTimeLock` → `applyReachoutTimelock`;
  - `isNewLogin` → `paired_at = NOW()`;
  - `on('message-capping.update')` → `applyChatCap`;
  - `handleOpen` → `sessionData.connectedAt` + `markPairedIfUnknown`;
  - pesan masuk 1:1 bertipe teks yang cocok keyword → `recordConsent` untuk `remoteJid` dan `remoteJidAlt`, webhook `contact.consent`; kalau opt-out dan `settings.optOutReply` diisi, balasan diantrikan dengan kategori `reply`;
  - logout → `paired_at = NULL`;
  - export `getSessionState`, `getConnectedSessionSockets`.
- [ ] **`sessionSettings`** + `newContactDailyLimit` (null | 0–1000), `campaignConsentRequired` (null | bool), `optOutReply` (null | string ≤ 1000).
- [ ] **Commit** `feat: pause new chats on WhatsApp restrictions; opt-in/out keywords; pairing cool-down`.

### Task 7 (E, F): Kategori & consent saat enqueue
- [ ] **`validation.parseCategory`** (`transactional` | `campaign` | `reply`).
- [ ] **`outboundQueue.enqueue`** menerima `category`.
- [ ] **`submitMessage`** (default `transactional`):
  - target personal dengan alasan dari `consentBlockReason` → 409 `Not sent: <alasan>`;
  - `requireConsent` = setting sesi ?? config.
- [ ] **`submitBatch`** (default `campaign`): target terblokir → hasil `skipped` + alasan.
- [ ] **Controller:**
  - `category` di semua endpoint kirim;
  - Fonnte: lebih dari satu target → `campaign`, satu target → `transactional`, bisa di-override dengan `category`.
- [ ] **Gate** dipasang ke runner di `messageService`, dengan `checkRegistered` dari `numberService.isRegistered` (ber-cache; error → null).
- [ ] **Commit** `feat: message categories with consent checks at enqueue`.

### Task 8 (G): Monitor kesehatan + endpoint
- [ ] **`antiBan.createHealthMonitor({ getConnectedSessions })`:**
  - tiap `HEALTH_CHECK_INTERVAL_MS`: poll `fetchNewChatMessageCap` tiap `CAP_POLL_HOURS`;
  - `healthMetrics` → `evaluateHealth`;
  - jeda kampanye `HEALTH_PAUSE_HOURS` jika belum dijeda.
  - Dimulai dan dihentikan di `index.js`.
- [ ] **`guardController`:**
  - `GET /api/sessions/:id/health` → jeda, cool-down, anggaran harian, kuota WhatsApp, ban, metrik;
  - `POST /api/sessions/:id/health/resume` `{scope}` — menolak 409 untuk jeda yang berasal dari WhatsApp dan masih aktif;
  - `GET`/`PUT`/`DELETE /api/sessions/:id/consents`.
- [ ] **Commit** `feat: health monitor with campaign auto-pause; health and consent API`.

### Task 9 (H, I): Routing sticky + batas lookup
- [ ] **Fonnte `pickSession`:**
  - sesi yang punya percakapan dengan penerima selalu dipakai, tanpa failover ke nomor lain;
  - kalau belum ada percakapan → hash stabil di antara sesi yang memenuhi syarat.
- [ ] **`numberCheck`:**
  - `maxLookupsPerDay` (rolling 24 jam per sesi, di memori) → 429 `Daily number lookup limit reached`;
  - test baru.
- [ ] **Commit** `feat: sticky number routing and a daily number-lookup limit`.

### Task 10: Dokumentasi
- [ ] **README:**
  - bagian "🛡️ Anti-Ban Guard": tabel aturan, kategori, consent, endpoint, webhook baru, env;
  - perubahan perilaku: sesi baru hanya bisa membalas selama 72 jam, chat baru dibatasi 20/hari, kirim massal butuh consent, kampanye hanya 08–20 WIB, `@broadcast` ditolak, 402/406 tidak di-reconnect.
- [ ] **`.env.example`** + landing page.
- [ ] **Commit** `docs: anti-ban guard`.

### Task 11: Verifikasi
- [ ] **Test penuh** dengan DB, diulang beberapa kali untuk memastikan stabil.
- [ ] **Smoke:**
  - endpoint `consents`, `health`, `resume`, `settings`;
  - kirim massal campaign ke target tanpa consent → `skipped`;
  - kirim ke target yang opt-out → 409;
  - `@broadcast` → 400;
  - simulasi keyword STOP (insert pesan masuk lalu kirim) → 409;
  - restart server tetap bersih.
- [ ] **Bersihkan** container/server test.
