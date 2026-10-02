# 🚀 WhatsApp Web Gateway API (Node.js + Baileys + PostgreSQL)

WhatsApp Gateway REST API berbasis Node.js dan `@whiskeysockets/baileys` (v7) dengan arsitektur Multi-Device, penyimpanan data persisten di PostgreSQL, antrian kirim per nomor, pelacakan status pesan, dan webhook dengan retry + tanda tangan HMAC.

---

## ✨ Fitur Utama

1. **Multiple Device / Sessions**:
   - Mendukung banyak nomor / akun WhatsApp secara bersamaan dalam satu instance.
   - Session tersimpan langsung di PostgreSQL (`baileys_auth_store`), tidak hilang saat container restart.
2. **Generate QR Code & Pairing Code**:
   - Tampilkan QR Code via REST API (JSON Base64 atau tampilan HTML browser).
   - Mendukung **WhatsApp Pairing Code** (8 digit) untuk pairing tanpa scan kamera.
3. **Sistem Webhook Sesuai Tipe Pesan**:
   - Mengelompokkan jenis pesan otomatis: `text`, `image`, `video`, `voice`, `document`, `location`, `contact`, `poll`, `sticker`.
   - Webhook dapat diatur spesifik per session (`device-1`, `device-2`) atau global, dengan filter event.
   - Dikirim lewat outbox: retry otomatis dengan backoff, tanda tangan HMAC-SHA256, riwayat delivery bisa dilihat dan di-retry lewat API.
4. **🛡️ Anti-Ban Humanizer Simulation**:
   - Sebelum pesan dikirim, sistem otomatis mengirim status presence `composing` (mengetik) atau `recording` (merekam audio) dengan jeda waktu natural dinamis berbasis panjang teks.
5. **Kirim Pesan WhatsApp Lengkap**:
   - Kirim WhatsApp Pairing Code
   - Kirim Text Message
   - Kirim Image (URL / Base64 / File Upload multipart)
   - Kirim Document / Attachment PDF/ZIP/dll (URL / File Upload multipart)
6. **Antrian Kirim & Status Pesan**:
   - Semua pesan keluar masuk antrian per nomor dengan jeda acak antar pesan, bisa dijadwalkan (`scheduleAt`), dibatalkan, dijadwal ulang, dan aman dikirim ulang (`idempotencyKey`).
   - Status `sent` → `delivered` → `read` (atau `failed`) disimpan dan dikirim sebagai webhook `message.status`.
7. **PostgreSQL Database Storage**:
   - Tabel `sessions`, `baileys_auth_store`, `messages`, `outbound_messages`, `webhook_deliveries`; skema dikelola migrasi otomatis.
8. **Docker & Docker Compose**:
   - Siap dideploy dengan satu perintah `docker compose up -d` (Node 22, user non-root, graceful shutdown).

---

## 🏗️ Struktur Proyek

```text
.
├── docker-compose.yml       # Docker Compose untuk App + PostgreSQL
├── Dockerfile               # Production Docker image
├── package.json
├── .env.example             # Template konfigurasi environment
├── src/
│   ├── index.js             # Entry point Express server & startup restore
│   ├── config/
│   │   └── index.js         # Konfigurasi environment
│   ├── database/
│   │   ├── db.js            # PostgreSQL connection pool
│   │   ├── migrate.js       # Runner migrasi SQL (otomatis saat start)
│   │   ├── migrations/      # 001_initial.sql, 002_..., 003_...
│   │   └── postgresAuthState.js # Baileys Auth Store adapter ke PostgreSQL
│   ├── services/
│   │   ├── sessionManager.js # Core Multi-device, Baileys socket, anti-ban presence
│   │   ├── reconnectPolicy.js # Keputusan reconnect/stop per kode disconnect
│   │   ├── messageService.js # Submit pesan ke antrian + queue runner
│   │   ├── outboundQueue.js / queueRunner.js # Antrian kirim (Postgres) & worker per session
│   │   ├── messageStatus.js # Status pesan & kode error WhatsApp
│   │   ├── webhookService.js # Message parser & pencatatan event webhook
│   │   ├── webhookOutbox.js / webhookDispatcher.js # Outbox webhook & pengirim dengan retry
│   │   └── webhookConfigResolver.js / webhookSigner.js # URL/secret/filter per session & HMAC
│   ├── controllers/
│   │   ├── sessionController.js # Handler API session & QR
│   │   ├── messageController.js # Handler API kirim pesan & riwayat
│   │   └── queueController.js   # Handler API antrian
│   ├── middlewares/
│   │   └── auth.js          # API key (header) & signed QR link
│   ├── utils/               # Validasi, normalisasi nomor, guard SSRF, cache, lock
│   ├── views/
│   │   └── sessionPages.js  # Halaman HTML QR/status
│   └── routes/
│       ├── index.js
│       ├── sessionRoutes.js
│       ├── messageRoutes.js
│       └── queueRoutes.js
└── test/                    # Unit & integration test (node --test)
```

---

## 🚀 Cara Menjalankan

### Opsi 1: Menggunakan Docker Compose (Direkomendasikan)

0. Buat file `.env` dan isi `API_KEY` (wajib, minimal 16 karakter — compose menolak start tanpa ini):
   ```bash
   cp .env.example .env
   # contoh membuat key acak:
   openssl rand -hex 24
   ```
1. Jalankan container:
   ```bash
   docker compose up -d --build
   ```
2. Cek status container:
   ```bash
   docker compose ps
   ```
3. Buka browser: [http://localhost:3000/](http://localhost:3000/)

---

### Opsi 2: Menjalankan Lokal (Node.js)

1. Pastikan PostgreSQL lokal berjalan, lalu buat database `whatsapp_gateway`.
2. Salin `.env.example` menjadi `.env` dan sesuaikan kredensial database:
   ```bash
   cp .env.example .env
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Jalankan mode development:
   ```bash
   npm run dev
   ```
5. Jalankan test:
   ```bash
   npm test
   ```
   Test database (migrasi, antrian, outbox, auth state) butuh PostgreSQL sekali pakai; setiap file test membuat dan menghapus database sementaranya sendiri:
   ```bash
   docker run -d --name wagw-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:56999:5432 postgres:16-alpine
   DB_TEST=1 DB_HOST=127.0.0.1 DB_PORT=56999 DB_USER=postgres DB_PASSWORD=test DB_NAME=postgres npm test
   ```

---

## 🔐 Autentikasi

- Semua endpoint (kecuali `/api/health`) membutuhkan header **`x-api-key: <API_KEY>`**. API key lewat query string (`?apiKey=`) **tidak lagi diterima** karena bocor ke log dan riwayat browser.
- Dengan `NODE_ENV=production`, server menolak start kalau `API_KEY` kosong atau kurang dari 16 karakter.
- Halaman QR di browser tidak bisa mengirim header, jadi dipakai **signed link** berumur pendek (default 10 menit, `QR_LINK_TTL_SECONDS`) yang hanya berlaku untuk satu session. Link ini dikembalikan di field `qrPage.url` oleh `POST /api/sessions/init` dan `POST /api/sessions/:sessionId/qr-link`.
- `sessionId` hanya boleh berisi huruf, angka, `.`, `_`, `-` (maksimal 64 karakter).

---

## 📖 Dokumentasi REST API

### 1. Inisialisasi Session Baru
Membuat dan mengaktifkan instance WhatsApp baru.

- **Endpoint**: `POST /api/sessions/init`
- **Request Body**:
  ```json
  {
    "sessionId": "sales-01",
    "customName": "Nomor CS Sales",
    "webhookUrl": "https://your-domain.com/webhook"
  }
  ```

---

Response berisi `qrPage.url`, yaitu signed link ke halaman QR:
```json
{
  "success": true,
  "session": { "sessionId": "sales-01", "status": "qr_ready", "...": "..." },
  "qrPage": {
    "url": "/api/sessions/sales-01/qr?format=html&token=1790954521.6aR3Qi...",
    "expiresAt": "2026-10-02T15:22:01.000Z"
  }
}
```

---

### 2. Dapatkan QR Code untuk Scan
Mendapatkan QR Code untuk pairing device. Endpoint ini **tidak** membuat atau menyalakan session: jalankan `POST /api/sessions/init` dulu (session yang belum ada → `404`, session yang tidak berjalan → `409`).

- **Endpoint (JSON Base64)**: `GET /api/sessions/:sessionId/qr` (header `x-api-key`)
- **Endpoint (Tampilan Browser Web)**: buka `qrPage.url` dari response init di browser, misalnya `http://localhost:3000/api/sessions/sales-01/qr?format=html&token=...`
- **Link baru** (kalau link lama kedaluwarsa): `POST /api/sessions/:sessionId/qr-link`

Session yang belum di-scan akan berhenti sendiri saat QR habis (sekitar 2,5 menit, `disconnectReason: "pairing_timeout"`). Jalankan `POST /api/sessions/init` lagi untuk QR baru.

---

### 3. Request WhatsApp Pairing Code (Tanpa Scan QR)
Menghubungkan WhatsApp menggunakan kode 8 digit.

- **Endpoint**: `POST /api/sessions/:sessionId/pairing-code`
- **Request Body** (`phoneNumber` boleh format lokal `08…`, `countryCode` opsional, default `DEFAULT_COUNTRY_CODE`):
  ```json
  {
    "phoneNumber": "08123456789"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "sessionId": "sales-01",
    "phoneNumber": "628123456789",
    "pairingCode": "ABCD-1234",
    "instruction": "Enter this 8-digit code in WhatsApp > Linked Devices > Link with phone number."
  }
  ```

---

### 4. Cek Status Session
- **Endpoint**: `GET /api/sessions/:sessionId/status`
- **Response**:
  ```json
  {
    "success": true,
    "session": {
      "sessionId": "sales-01",
      "status": "connected",
      "disconnectReason": null,
      "phoneNumber": "628123456789",
      "webhookUrl": "https://your-domain.com/webhook"
    }
  }
  ```
- **Status**: `connecting`, `qr_ready`, `connected`, `reconnecting` (menunggu backoff), `disconnected`.
- **`disconnectReason`** (alasan terakhir session berhenti):

  | Nilai | Arti | Yang dilakukan gateway |
  |---|---|---|
  | `connection_lost` | Koneksi putus (jaringan, timeout, server WA) | Reconnect otomatis dengan backoff eksponensial (2 detik s/d 5 menit) |
  | `restart_required` | Restart normal setelah scan QR | Reconnect langsung |
  | `pairing_timeout` | QR/pairing code tidak dipakai sampai habis | Berhenti; panggil `init` lagi |
  | `logged_out` | Device dihapus dari HP / logout | Auth dihapus; perlu pairing ulang |
  | `connection_replaced` | Nomor yang sama tersambung di socket lain (conflict 440) | Berhenti (tidak saling rebut) |
  | `forbidden` | Akun diblokir/dibatasi WhatsApp (403) | Berhenti |
  | `multidevice_mismatch` | Perlu pairing ulang (411) | Berhenti |
  | `client_version_rejected` | Versi WA Web ditolak (405) | Berhenti; update Baileys atau set `WA_VERSION` |
  | `not_restored` | Session belum di-pair saat server restart | Panggil `init` lagi |

### 4b. Batasan Akun dari WhatsApp
- **Endpoint**: `GET /api/sessions/:sessionId/limits` (session harus connected)
- Mengembalikan `newChatMessageCap` (kuota pesan ke chat baru) dan `reachoutTimelock` (`isActive`, `timeEnforcementEnds`, `enforcementType`) langsung dari server WhatsApp. Cek ini sebelum kampanye; kalau `reachoutTimelock.isActive` bernilai `true`, nomor sedang dilarang memulai chat baru (penyebab error 463) dan hanya boleh membalas chat yang sudah ada.
- Pembatasan yang muncul saat sesi berjalan juga dikirim sebagai webhook `account.restriction`.

---

### 5. Kirim Pesan Teks (dengan Anti-Ban Typing Simulation)
Otomatis mengirim sinyal `composing` (sedang mengetik) selama 1-3 detik sebelum pesan dikirim.

- **Endpoint**: `POST /api/messages/send-text`
- **Request Body**:
  ```json
  {
    "sessionId": "sales-01",
    "to": "628987654321",
    "text": "Halo! Terima kasih telah menghubungi kami.",
    "delayMs": 2000
  }
  ```
- **`to`** menerima `08123456789`, `628123456789`, `+62 812-3456-789`, atau JID (`...@s.whatsapp.net`, `...@g.us`, `...@lid`). Awalan `0` diganti `countryCode` (default `62`); kirim `"countryCode": "60"` untuk nomor lokal negara lain, atau `"0"` untuk mematikan konversi.
- **`delayMs`** (opsional, 0–15000): lama indikator "mengetik". Tanpa `delayMs`, durasi dihitung dari panjang teks.
- **Respons**: `200` kalau pesan terkirim dalam `SEND_WAIT_TIMEOUT_MS` (berisi `messageId` dan `queueId`), `202` kalau masih di antrian/terjadwal, `400` input tidak valid, `404` session tidak ada, `409` session tidak connected (kecuali `connectOnly: false`), `502` gagal kirim. Opsi antrian ada di bagian [Antrian Kirim](#-antrian-kirim--status-pesan).

---

### 6. Kirim Gambar (Image)
Mendukung URL gambar, Base64, atau upload file (`multipart/form-data`). URL di-download oleh gateway (maksimal `MEDIA_MAX_BYTES`) dan ditolak kalau mengarah ke alamat privat/lokal (lihat `ALLOW_PRIVATE_URLS`).

- **Endpoint**: `POST /api/messages/send-image`
- **Request Body (JSON)**:
  ```json
  {
    "sessionId": "sales-01",
    "to": "628987654321",
    "imageUrl": "https://picsum.photos/800/600",
    "caption": "Berikut foto produk kami"
  }
  ```

---

### 7. Kirim Dokumen / Attachment
Mendukung PDF, DOCX, ZIP, XLS, dll.

- **Endpoint**: `POST /api/messages/send-attachment`
- **Request Body (JSON)**:
  ```json
  {
    "sessionId": "sales-01",
    "to": "628987654321",
    "attachmentUrl": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    "fileName": "Invoice-INV-2026.pdf",
    "mimetype": "application/pdf",
    "caption": "Silakan unduh invoice terlampir."
  }
  ```

---

### 8. Download Media / Dokumen (PDF, PPTX, Image, Audio, dll)
Mengunduh dan mendekripsi file media yang diterima dari WhatsApp berdasarkan `messageId`.

- **Endpoint (Download Binary File)**: `GET /api/messages/:sessionId/download/:messageId`
- **Endpoint (Base64 JSON)**: `GET /api/messages/:sessionId/download/:messageId?format=base64`

Contoh:
```bash
# Download langsung sebagai file asli (misal .pdf / .pptx)
curl -O -J "http://localhost:3000/api/messages/device-1/download/ACDCBDA49D620C139EC01419CE6F2D35"

# Atau ambil format JSON Base64
curl "http://localhost:3000/api/messages/device-1/download/ACDCBDA49D620C139EC01419CE6F2D35?format=base64"
```

---

### 9. Ambil Riwayat Pesan dari PostgreSQL
- **Endpoint**: `GET /api/messages/:sessionId?limit=50&offset=0&type=document`

---

## 📬 Antrian Kirim & Status Pesan

Semua endpoint kirim (`send-text`, `send-image`, `send-attachment`) memasukkan pesan ke tabel `outbound_messages`. Worker mengirim **satu pesan per nomor pada satu waktu** dengan jeda acak `SEND_INTERVAL_MIN_MS`–`SEND_INTERVAL_MAX_MS` (default 2–6 detik) antar pesan; nomor yang berbeda diproses paralel. Pesan pertama pada nomor yang sedang diam langsung terkirim.

Field opsional di body (juga berlaku untuk `multipart/form-data`):

| Field | Default | Keterangan |
|---|---|---|
| `async` | `false` | `true` = langsung balas `202` + `queueId` tanpa menunggu pesan terkirim |
| `scheduleAt` | – | Jadwal kirim: ISO-8601 (`2026-10-03T08:00:00+07:00`) atau unix detik; maksimal 365 hari ke depan |
| `idempotencyKey` | – | Juga bisa lewat header `Idempotency-Key`. Request ulang dengan key yang sama tidak membuat pesan baru (respons `duplicate: true` + `queueId` yang sama) |
| `connectOnly` | `true` | `false` = tetap antrikan walau session belum connected; dikirim begitu connect |

- Error sementara (koneksi putus) diulang sampai `QUEUE_MAX_ATTEMPTS` kali; input yang salah (misalnya URL media tidak bisa di-download) langsung `failed`.
- Pesan yang tertahan lebih dari `QUEUE_MAX_AGE_HOURS` (default 24 jam) karena session offline menjadi `expired`.
- Kalau server mati tepat saat mengirim, pesan itu ditandai `failed` saat start berikutnya (tidak dikirim ulang, untuk mencegah pesan dobel).

**API antrian** (header `x-api-key`):

| Endpoint | Fungsi |
|---|---|
| `GET /api/queue?sessionId=&status=&limit=&offset=` | Daftar pesan di antrian |
| `GET /api/queue/:queueId` | Detail + status satu pesan |
| `PATCH /api/queue/:queueId` body `{"scheduleAt": "..."}` | Jadwal ulang (hanya status `queued`; tanpa `scheduleAt` = kirim sekarang) |
| `DELETE /api/queue/:queueId` | Batalkan (hanya status `queued`) |

**Status**: `queued` → `processing` → `sent` → `delivered` → `read` / `played`, atau `failed` / `cancelled` / `expired`. Status `delivered`/`read` untuk pesan grup tidak dilacak per anggota.

---

## 🔔 Format Payload Webhook

Ketika ada pesan masuk, gateway otomatis mengirimkan webhook HTTP POST ke `webhookUrl` Anda dengan format JSON:

```json
{
  "event": "message.received",
  "sessionId": "sales-01",
  "timestamp": "2026-09-30T10:00:00.000Z",
  "data": {
    "messageId": "3EB0ABC123456789",
    "remoteJid": "628987654321@s.whatsapp.net",
    "remoteJidAlt": null,
    "senderJid": "628987654321@s.whatsapp.net",
    "senderJidAlt": null,
    "senderPhone": "628987654321",
    "fromMe": false,
    "pushName": "Budi Santoso",
    "isGroup": false,
    "messageType": "text",
    "rawType": "conversation",
    "content": "Halo admin, mau tanya harga produk",
    "media": null,
    "timestamp": "2026-09-30T10:00:00.000Z"
  }
}
```

Jika pesan berupa gambar (`image`):
```json
{
  "messageType": "image",
  "rawType": "imageMessage",
  "content": "Bukti transfer",
  "media": {
    "mimetype": "image/jpeg",
    "fileLength": 102400,
    "height": 1280,
    "width": 720
  }
}
```

---

Event `connection.update` saat koneksi tertutup:
```json
{
  "event": "connection.update",
  "sessionId": "sales-01",
  "data": {
    "status": "reconnecting",
    "statusCode": 428,
    "reason": "Connection Closed",
    "disconnectReason": "connection_lost",
    "retryInMs": 3412
  }
}
```

Sejak Baileys v7, chat bisa dialamatkan dengan **LID** (`123456789@lid`) dan bukan nomor telepon. Dalam kasus itu nomor telepon (kalau diketahui) ada di `remoteJidAlt` / `senderJidAlt`, dan `senderPhone` selalu berisi nomor pengirim bila tersedia. Balas ke `remoteJid` apa adanya (LID juga valid sebagai tujuan kirim).

Event `message.status` (dari antrian dan tanda terima WhatsApp):
```json
{
  "event": "message.status",
  "sessionId": "sales-01",
  "data": {
    "messageId": "3EB0ABC123456789",
    "queueId": 42,
    "remoteJid": "628987654321@s.whatsapp.net",
    "status": "delivered",
    "error": null,
    "timestamp": "2026-10-03T10:00:05.000Z"
  }
}
```
`status`: `sent`, `delivered`, `read`, `played`, `failed`, `expired`. Untuk `failed` karena penolakan WhatsApp, `error` menjelaskan kodenya, misalnya `WhatsApp error 463: account restricted from starting new chats (...)`.

Event lain: `account.restriction` (data = status reach-out timelock dari WhatsApp).

### Pengiriman, retry & keamanan webhook

- **Antrian (outbox):** setiap event disimpan dulu di tabel `webhook_deliveries`, lalu dikirim di background.
- **Retry:** untuk HTTP 5xx, 408, 429 dan error jaringan, dengan backoff eksponensial (`WEBHOOK_RETRY_BASE_DELAY_MS` 10 detik s/d 1 jam, maksimal `WEBHOOK_MAX_ATTEMPTS` = 10 kali). Status 4xx lainnya langsung `failed`.
- **At-least-once:** event yang sama bisa terkirim lebih dari sekali, dan urutan antar-event tidak dijamin. Gunakan header `X-Webhook-Id` untuk dedupe, dan field `timestamp` untuk urutan.
- **Header yang dikirim:**
  - `X-Webhook-Id`
  - `X-Webhook-Event`
  - `X-Webhook-Timestamp` (unix detik)
  - `X-Webhook-Attempt`
  - `X-Webhook-Signature`: hanya kalau ada secret.
- **Secret:** diambil dari `webhookSecret` per session. Kalau kosong, dipakai `WEBHOOK_SECRET` global (selalu dipakai untuk `GLOBAL_WEBHOOK_URL`).

Verifikasi signature di penerima (Node.js/Express), pakai **raw body**:
```js
import crypto from 'node:crypto';

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const timestamp = req.get('X-Webhook-Timestamp');
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(`${timestamp}.${req.body}`).digest('hex');
  const received = req.get('X-Webhook-Signature') || '';
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  if (!fresh || expected.length !== received.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return res.sendStatus(401);
  }
  const event = JSON.parse(req.body);
  // ... proses event, dedupe dengan req.get('X-Webhook-Id')
  res.sendStatus(200);
});
```

**Pengaturan webhook per session** — `PUT /api/sessions/:sessionId/webhook` (field yang tidak dikirim tidak berubah; `null`/`""` mengosongkan):
```json
{
  "webhookUrl": "https://your-domain.com/webhook",
  "webhookSecret": "minimal-16-karakter-acak",
  "events": ["message.received", "message.status"]
}
```
`events: null` = semua event (`connection.update`, `message.received`, `message.status`, `account.restriction`). Perubahan berlaku maksimal 30 detik kemudian, tanpa restart session.

**Riwayat delivery**:
- `GET /api/sessions/:sessionId/webhook-deliveries?status=failed`: status, percobaan, kode HTTP, dan error terakhir.
- `POST /api/sessions/:sessionId/webhook-deliveries/:deliveryId/retry`: kirim ulang delivery yang `failed`.
- Delivery yang `delivered` dihapus setelah `WEBHOOK_RETENTION_DAYS`; yang `failed` dihapus setelah `WEBHOOK_FAILED_RETENTION_DAYS`.

---

## ⚙️ Konfigurasi (`.env`)

Lihat `.env.example` untuk daftar lengkap.

| Variabel | Default | Keterangan |
|---|---|---|
| `API_KEY` | – | Wajib di production (≥16 karakter). Dikirim lewat header `x-api-key`. |
| `QR_LINK_TTL_SECONDS` | `600` | Umur signed link halaman QR. |
| `DEFAULT_COUNTRY_CODE` | `62` | Pengganti awalan `0` pada nomor lokal. |
| `ALLOW_PRIVATE_URLS` | `false` | Izinkan URL media/webhook ke alamat privat/lokal. Set `true` kalau webhook diarahkan ke service internal, misalnya `http://n8n:5678/...` di network docker yang sama. |
| `MEDIA_MAX_BYTES` | `52428800` | Batas ukuran media yang di-download dari URL. |
| `WA_VERSION` | (bawaan Baileys) | Override versi WA Web, hanya kalau WhatsApp menolak versi bawaan (`client_version_rejected`). |
| `RECONNECT_BASE_DELAY_MS` / `RECONNECT_MAX_DELAY_MS` | `2000` / `300000` | Backoff reconnect untuk session yang sudah di-pair. |
| `RESTORE_STAGGER_MS` | `1500` | Jeda antar session saat restore ketika server start. |
| `MIN_TYPING_DELAY_MS` / `MAX_TYPING_DELAY_MS` | `1000` / `2500` | Rentang durasi indikator "mengetik". |
| `MAX_REQUEST_DELAY_MS` | `15000` | Batas atas field `delayMs` per request. |
| `AUTO_READ_MESSAGES` | `false` | Tandai pesan masuk sebagai dibaca (centang biru). |
| `SEND_INTERVAL_MIN_MS` / `SEND_INTERVAL_MAX_MS` | `2000` / `6000` | Jeda acak antar pesan dari nomor yang sama. |
| `SEND_WAIT_TIMEOUT_MS` | `60000` | Lama request kirim menunggu hasil sebelum membalas `202`. |
| `QUEUE_MAX_ATTEMPTS` / `QUEUE_RETRY_DELAY_MS` | `3` / `30000` | Retry kirim untuk error sementara (jeda × nomor percobaan). |
| `QUEUE_MAX_AGE_HOURS` | `24` | Pesan antrian yang lebih tua dari ini (session offline) menjadi `expired`. |
| `QUEUE_POLL_MS` | `1000` | Interval worker antrian. |
| `WEBHOOK_SECRET` | – | Secret HMAC global (≥16 karakter). |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Timeout per pengiriman webhook. |
| `WEBHOOK_MAX_ATTEMPTS` | `10` | Maksimal percobaan per event. |
| `WEBHOOK_RETRY_BASE_DELAY_MS` / `WEBHOOK_RETRY_MAX_DELAY_MS` | `10000` / `3600000` | Backoff retry webhook. |
| `WEBHOOK_RETENTION_DAYS` / `WEBHOOK_FAILED_RETENTION_DAYS` | `7` / `30` | Retensi riwayat delivery. |
| `LOG_LEVEL` | `info` | `trace`…`fatal`, atau `silent`. |
| `LOG_PRETTY` | `true` kecuali production | Log mudah dibaca; di production log berupa JSON per baris. |
| `BAILEYS_LOG_LEVEL` | `error` | Level log internal Baileys. |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Batas waktu graceful shutdown sebelum dipaksa keluar. |

Port PostgreSQL di `docker-compose.yml` hanya di-bind ke `127.0.0.1`.

---

## 🛡️ Pengaturan Anti-Ban & Human Simulation

Di file `.env` / `docker-compose.yml`:
- `MIN_TYPING_DELAY_MS=1200` (Jeda minimal mengetik sebelum kirim pesan)
- `MAX_TYPING_DELAY_MS=3000` (Jeda maksimal mengetik)
- `AUTO_READ_MESSAGES=true` (Otomatis menandai pesan masuk sebagai telah dibaca / centang biru)

> Catatan: indikator mengetik hanya sinyal lemah. Yang paling berpengaruh terhadap ban adalah kecepatan kirim, mengirim ke nomor yang belum pernah chat, dan laporan spam dari penerima.

---

## 🧰 Operasional

- **Migrasi database:**
  - Dijalankan otomatis saat start, dari `src/database/migrations/*.sql`, dan dicatat di tabel `schema_migrations`.
  - Database dari versi lama (yang dibuat `schema.sql`) di-upgrade tanpa langkah manual.
- **Log:** pino. Di production berupa JSON per baris (siap untuk Loki/ELK); atur dengan `LOG_LEVEL`.
- **Graceful shutdown** (SIGTERM/SIGINT):
  - Berhenti menerima request dan menyelesaikan pesan yang sedang dikirim.
  - Menutup socket WhatsApp **tanpa logout**, sehingga session dipulihkan saat start berikutnya.
  - Menyelesaikan webhook yang sedang terkirim, lalu menutup koneksi DB.
  - `docker-compose.yml` memberi waktu `stop_grace_period: 30s`.
- **Docker:** image `node:22-alpine`, `npm ci`, berjalan sebagai user `node`, proses `node` langsung sebagai PID 1.
- **Satu instance per database:** state socket ada di memori, jadi jangan jalankan dua replica dengan database yang sama.

---

## ⚠️ Perubahan yang Perlu Diperhatikan Klien

- **Autentikasi:** API key hanya lewat header `x-api-key`. `?apiKey=` tidak diterima lagi.
- **Endpoint kirim:**
  - Bisa membalas `202` (masih di antrian) selain `200`, dan response menyertakan `queueId`.
  - Pesan dari nomor yang sama diberi jeda 2–6 detik, sehingga kirim massal lewat API lebih lambat dari sebelumnya (memang disengaja).
- **Webhook:**
  - Dikirim asinkron dengan retry, minimal sekali (bisa dobel), dan urutannya tidak dijamin.
  - Ada header `X-Webhook-*` baru.
  - Tabel `webhook_logs` tidak diisi lagi (diganti `webhook_deliveries`).
- **`PUT /api/sessions/:sessionId/webhook`:** field yang tidak dikirim tidak lagi mengosongkan `webhookUrl`.
- **LID (Baileys v7):** `remoteJid` bisa berupa `...@lid`. Pakai `remoteJidAlt`/`senderPhone` untuk nomor telepon.
- **`GET /api/sessions/:sessionId/qr`:** tidak lagi menyalakan session; jalankan `POST /api/sessions/init`.

---

## 📜 Lisensi
MIT License. Catatan: Baileys bergantung pada `libsignal` (GPL-3.0). Kalau gateway ini didistribusikan ke pihak lain (bukan hanya dijalankan sebagai layanan), periksa kewajiban lisensi GPL.
