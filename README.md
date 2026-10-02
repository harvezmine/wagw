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
4. **🛡️ Anti-Ban Guard** (lihat [Anti-Ban Guard](#️-anti-ban-guard)):
   - Setiap pesan dicek tepat sebelum dikirim: anggaran dan jeda khusus untuk chat baru, masa tenang setelah pairing, jam kampanye, opt-out/opt-in, dan batas frekuensi kampanye.
   - Patuh pada sinyal WhatsApp: berhenti saat di-ban (402/406), menjeda chat baru saat error 463, reach-out timelock, atau peringatan kuota.
   - Monitor kesehatan menjeda kampanye otomatis saat tingkat terkirim atau tingkat balasan anjlok.
   - Simulasi presence `composing`/`recording` sebelum kirim.
5. **Kirim Pesan WhatsApp Lengkap** (satu endpoint `POST /api/messages/send`):
   - Text, image, video, audio, voice note, document, sticker, lokasi, kontak (vCard), poll.
   - Reply (quote), mention, reaksi, edit, dan hapus pesan.
   - Kirim massal multi-target dengan variabel `{name}`, `{var1}`… (sintaks Fonnte).
6. **Validasi Nomor & Grup**: cek nomor terdaftar di WhatsApp (dengan cache + throttle), daftar grup dan detail anggota.
7. **API Key Multi-Tenant**: kunci per klien yang hanya bisa mengakses sesinya sendiri, opsional dengan IP allowlist.
8. **Kompatibel Fonnte**: endpoint `/fonnte/send` dkk. dan format webhook Fonnte, jadi klien Fonnte bisa pindah cukup dengan ganti base URL dan token.
9. **Pengaturan per Session**: baca otomatis, tolak panggilan (dengan pesan balasan), abaikan pesan grup.
10. **Antrian Kirim & Status Pesan**:
   - Semua pesan keluar masuk antrian per nomor dengan jeda acak antar pesan, bisa dijadwalkan (`scheduleAt`), dibatalkan, dijadwal ulang, dan aman dikirim ulang (`idempotencyKey`).
   - Status `sent` → `delivered` → `read` (atau `failed`) disimpan dan dikirim sebagai webhook `message.status`.
11. **PostgreSQL Database Storage**:
   - Tabel `sessions`, `baileys_auth_store`, `messages`, `outbound_messages`, `webhook_deliveries`, `api_keys`, `number_checks`; skema dikelola migrasi otomatis.
12. **Docker & Docker Compose**:
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
│   ├── fonnte/              # Adapter kompatibel Fonnte (parameter, route, format webhook)
│   ├── services/
│   │   ├── sessionManager.js # Core Multi-device, Baileys socket, anti-ban presence
│   │   ├── messageContent.js / bulkTargets.js # Validasi & konten per tipe pesan, target massal + template
│   │   ├── apiKeys.js       # API key tenant (hash, cache, IP allowlist)
│   │   ├── numberCheck.js / numberService.js # Validasi nomor (cache + throttle)
│   │   ├── sessionSettings.js # Pengaturan per session
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
│   │   ├── queueController.js   # Handler API antrian
│   │   └── keysController.js    # Handler API key tenant
│   ├── middlewares/
│   │   └── auth.js          # API key (header) & signed QR link
│   ├── utils/               # Validasi, normalisasi nomor, guard SSRF, cache, lock
│   ├── views/
│   │   └── sessionPages.js  # Halaman HTML QR/status
│   └── routes/
│       ├── index.js
│       ├── sessionRoutes.js
│       ├── messageRoutes.js
│       ├── queueRoutes.js
│       └── keysRoutes.js
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

- Semua endpoint (kecuali `/api/health`) membutuhkan header **`x-api-key`** berisi master `API_KEY` atau **API key tenant** (lihat [API Key Multi-Tenant](#-api-key-multi-tenant)). API key lewat query string (`?apiKey=`) **tidak diterima** karena bocor ke log dan riwayat browser.
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
  | `temporarily_banned` | Ban sementara dari WhatsApp (402) | Berhenti; `init` ditolak (`409`) sampai `ban.expiresAt` |
  | `banned` | Ban dari WhatsApp (406) | Berhenti; auth tidak dihapus (untuk banding) |
  | `client_rejected` | Klien ditolak WhatsApp (409) | Berhenti |
  | `not_restored` | Session belum di-pair saat server restart | Panggil `init` lagi |

- **`ban`**: `null`, atau `{ permanent, code, expiresAt }` saat `disconnectReason` adalah `banned`/`temporarily_banned`. `code` adalah alasan ban sementara dari WhatsApp, misalnya `101` = terlalu banyak pesan ke orang yang tidak menyimpan nomor ini, `102` = banyak yang memblokir, `104` = pesan yang sama ke terlalu banyak orang.

### 4b. Batasan Akun dari WhatsApp
- **Endpoint**: `GET /api/sessions/:sessionId/limits` (session harus connected)
- Mengembalikan `newChatMessageCap` (kuota pesan ke chat baru) dan `reachoutTimelock` (`isActive`, `timeEnforcementEnds`, `enforcementType`) langsung dari server WhatsApp. Cek ini sebelum kampanye; kalau `reachoutTimelock.isActive` bernilai `true`, nomor sedang dilarang memulai chat baru (penyebab error 463) dan hanya boleh membalas chat yang sudah ada.
- Pembatasan yang muncul saat sesi berjalan juga dikirim sebagai webhook `account.restriction` dan otomatis menjeda chat baru (lihat [Anti-Ban Guard](#️-anti-ban-guard)). Ringkasan lengkapnya ada di `GET /api/sessions/:sessionId/health`.

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

## ✉️ Endpoint Kirim Terpadu

`POST /api/messages/send` (JSON, atau `multipart/form-data` dengan field `file` untuk upload media). Semua pesan lewat antrian, jadi opsi `async`, `scheduleAt`, `idempotencyKey`, `connectOnly`, `delayMs`, `countryCode`, dan `category` di bagian [Antrian Kirim](#-antrian-kirim--status-pesan) berlaku di sini.

| `type` | Field | Contoh body |
|---|---|---|
| `text` (default) | `text` | `{"sessionId":"s1","to":"0812...","text":"Halo"}` |
| `image`, `video`, `document`, `audio`, `voice`, `sticker` | `media.url` / `media.base64` / upload `file`, `caption`, `media.fileName`, `media.mimetype`, `gifPlayback` (video) | `{"type":"document","to":"0812...","media":{"url":"https://.../inv.pdf","fileName":"INV.pdf"},"caption":"Invoice"}` |
| `location` | `location.latitude`, `location.longitude`, `location.name`, `location.address` | `{"type":"location","to":"0812...","location":{"latitude":-6.17,"longitude":106.82,"name":"Monas"}}` |
| `contact` | `contact` atau `contacts` (maks 20) berisi `{name, phone}` | `{"type":"contact","to":"0812...","contact":{"name":"CS","phone":"0811..."}}` |
| `poll` | `poll.name`, `poll.options` (2–12, unik), `poll.selectableCount` (0 = bebas pilih banyak) | `{"type":"poll","to":"0812...","poll":{"name":"Menu?","options":["Bakso","Soto"]}}` |
| `reaction` | `messageId`, `emoji` (kosong = hapus reaksi) | `{"type":"reaction","messageId":"3EB0...","emoji":"👍"}` |
| `edit` | `messageId`, `text` (hanya pesan milik session ini) | `{"type":"edit","messageId":"3EB0...","text":"Revisi"}` |
| `delete` | `messageId` (hapus untuk semua) | `{"type":"delete","messageId":"3EB0..."}` |

- **Opsi tambahan:**
  - `replyTo`: `messageId` yang dikutip (quote).
  - `mentions`: daftar nomor yang di-mention. Tulis juga `@628...` di teks supaya tampil.
- **Pesan acuan:** `reaction`/`edit`/`delete`/`replyTo` mencari pesan di riwayat (`messages`). Untuk tiga tipe pertama, `to` tidak perlu diisi.
- **Voice note** (`voice`) harus berupa file **OGG/Opus**; gateway tidak melakukan konversi audio.

**Kirim massal**: `to` berisi beberapa target (array, atau dipisah koma) dengan sintaks Fonnte `nomor|nama|var1|var2`:
```json
{
  "sessionId": "s1",
  "to": "08111111111|Budi|VIP, 08122222222|Ani|Reguler",
  "text": "Halo {name}, status member Anda: {var1}"
}
```
- **Respons:** `202` kalau ada target yang masuk antrian (`400` kalau tidak ada), berisi hasil per target: `queued`, `duplicate`, `invalid`, atau `skipped` (duplikat dalam request, penerima opt-out, atau kampanye tanpa consent; alasannya di `error`). Target yang ditolak tidak menggagalkan yang lain.
- **Kategori:** default `campaign`, jadi berlaku aturan kampanye: wajib consent, hanya di jam kampanye, maksimal sekali per penerima per 72 jam.
- **Batas:** maksimal `BULK_MAX_TARGETS` (500).
- **Media:** harus berupa `media.url`.
- **Jeda:** jeda antar pesan per nomor dari antrian tetap berlaku; chat baru diberi jeda dan anggaran harian tersendiri.

> Kirim massal ke nomor yang belum pernah chat adalah penyebab ban paling umum. Gateway hanya mengizinkan kampanye ke kontak yang pernah menulis atau sudah opt-in; lihat [Anti-Ban Guard](#️-anti-ban-guard).

---

## 🔎 Validasi Nomor, Grup & Pengaturan Session

**Validasi nomor** — `POST /api/sessions/:sessionId/validate` body `{"numbers": ["0812...", "0813..."], "countryCode": "62"}`:
- **Respons:** `{ registered: [...], notRegistered: [...], invalid: [...], results: [...] }`.
- **Batasan:**
  - Maksimal `VALIDATE_MAX_NUMBERS` (50) nomor per request.
  - Hasil di-cache `VALIDATE_CACHE_DAYS` (7 hari).
  - Lookup ke WhatsApp dijalankan bergantian per session dengan jeda `VALIDATE_MIN_INTERVAL_MS`, karena lookup kontak massal juga sinyal ban.
  - Maksimal `VALIDATE_DAILY_LIMIT` (200) nomor yang belum ter-cache per session per 24 jam; lebih dari itu dibalas `429`.

**Grup**:
- `GET /api/sessions/:sessionId/groups`:
  - Daftar grup (id, subject, size, owner, …) dari cache 10 menit.
  - `?refresh=true` mengambil ulang, paling cepat sekali per menit.
- `GET /api/sessions/:sessionId/groups/:groupId`: detail grup beserta anggota (`id`, `phoneNumber`, `admin`).
- Kirim ke grup memakai `to: "1203...@g.us"`.

**Pengaturan session** — `GET` / `PATCH /api/sessions/:sessionId/settings`:

| Setting | Default | Fungsi |
|---|---|---|
| `readMessages` | `null` (ikut `AUTO_READ_MESSAGES`) | Kirim tanda baca (centang biru) untuk pesan masuk |
| `rejectCalls` | `false` | Tolak panggilan masuk otomatis |
| `rejectCallMessage` | `null` | Pesan yang dikirim (lewat antrian) ke penelepon yang ditolak |
| `ignoreGroups` | `false` | Abaikan pesan grup (tidak disimpan, tidak di-webhook) |
| `newContactDailyLimit` | `null` (ikut `NEW_CONTACT_DAILY_LIMIT`) | Maksimal chat baru per 24 jam (0–1000; `0` = hanya membalas dan kirim ke kontak dikenal) |
| `campaignConsentRequired` | `null` (ikut `CAMPAIGN_REQUIRE_CONSENT`) | Kampanye hanya ke kontak dikenal atau yang opt-in |
| `optOutReply` | `null` | Balasan konfirmasi saat seseorang mengirim keyword opt-out |

Panggilan masuk selalu dilaporkan lewat webhook `call.received` (`callId`, `from`, `callerPhone`, `isVideo`, `isGroup`).

---

## 🔑 API Key Multi-Tenant

Master `API_KEY` bisa membuat kunci tenant. Setiap kunci tenant hanya bisa mengakses session yang ditentukan, dan opsional hanya dari IP tertentu:
```bash
curl -X POST http://localhost:3000/api/keys \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"name":"Klien A","sessionIds":["klien-a"],"ipAllowlist":["203.0.113.0/24"]}'
# -> {"key":"wagw_3f2a9c1b7e_...","apiKey":{"id":1,...}}  (key hanya ditampilkan sekali)
```
- **Pemakaian:** pakai di header `x-api-key`.
  - `sessionIds: null` = semua session.
  - `ipAllowlist: null` = semua IP.
- **Hak akses tenant:**
  - Hanya melihat session-nya sendiri, termasuk di daftar session dan daftar antrian.
  - Request ke session lain dibalas `403`.
  - Tidak bisa mengelola API key.
- **Manajemen key:** `GET /api/keys` (daftar, tanpa secret) dan `DELETE /api/keys/:keyId` (cabut; langsung berlaku). Keduanya hanya untuk master key.
- **Keamanan:** kunci disimpan sebagai hash SHA-256.
- **Di belakang reverse proxy:** set `TRUST_PROXY` (misalnya `1` atau `loopback`) supaya IP allowlist membaca IP klien yang benar.

---

## 🔁 Migrasi dari Fonnte

Gateway menyediakan endpoint dengan parameter dan format respons Fonnte di `/fonnte`. Selalu HTTP 200 dengan `status: true/false` dan `reason`, sama seperti Fonnte.

1. Buat API key tenant yang terikat ke **tepat satu** session (session = "device" Fonnte). Key itu dipakai sebagai token Fonnte.
2. Ganti base URL `https://api.fonnte.com` menjadi `https://gateway-anda/fonnte`. Header `Authorization: <token>` tetap sama. Dengan beberapa token dipisah koma, setiap penerima selalu dikirimi dari nomor yang sudah punya percakapan dengannya (tanpa pindah ke nomor lain saat nomor itu offline); penerima baru dibagi dengan hash tetap, bukan acak.
3. Opsional: `PUT /api/sessions/:sessionId/webhook` dengan `"format": "fonnte"` supaya payload webhook (pesan masuk, status pesan, connect/disconnect) berbentuk seperti Fonnte.
4. Kirim ke lebih dari satu target dianggap `campaign` (wajib consent, jam kampanye); satu target dianggap `transactional`. Parameter `category` mengubahnya. Target yang opt-out dilewati; kalau semua ditolak, respons `status: false` dengan alasannya.

| Endpoint Fonnte | Didukung | Catatan |
|---|---|---|
| `POST /send` | ✓ | `target` (`nomor\|nama\|var`, grup), `message`, `url`/`file`, `filename`, `schedule`, `delay` (`"5"`/`"5-10"`), `countryCode`, `location`, `typing`+`duration`, `choices`/`select`/`pollname`, `connectOnly`, `followup`, `data`, `inboxid` (reply). `preview` dan `sequence` diabaikan (antrian sudah berurutan per nomor) |
| `POST /validate` | ✓ | `registered` / `not_registered` (maks `VALIDATE_MAX_NUMBERS`) |
| `POST /device` | ✓ | `device`, `device_status`, `name`; kuota selalu `unlimited` |
| `POST /get-whatsapp-group`, `/fetch-group` | ✓ | Dari cache grup |
| `POST /delete-message` | ✓ | Membatalkan pesan yang masih `queued` (id = id dari respons `/send`) |
| GET `/send?token=` | ✗ | Sengaja tidak didukung (token bocor ke log) |
| Rotator, autoreply, flow, dashboard | ✗ | Di luar gateway ini |

**Webhook format Fonnte:**
- **Pesan masuk:** `device`, `sender`, `message`, `text`, `member`, `name`, `location`, `pollname`, `choices`, `filename`, `extension`, `inboxid`, `timestamp`. URL file media tidak disertakan; unduh lewat `GET /api/messages/:sessionId/download/:inboxid`.
- **Status pesan:** `device`, `id`, `stateid`, `status` / `state`.
- **Koneksi:** `device`, `status` (`connect`/`disconnect`), `reason`, `timestamp`.

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
| `category` | `transactional` (satu penerima) / `campaign` (massal) | `transactional`, `campaign`, atau `reply`; menentukan aturan [Anti-Ban Guard](#️-anti-ban-guard) yang berlaku |

- Error sementara (koneksi putus) diulang sampai `QUEUE_MAX_ATTEMPTS` kali; input yang salah (misalnya URL media tidak bisa di-download) langsung `failed`.
- Pesan yang tertahan lebih dari `QUEUE_MAX_AGE_HOURS` (default 24 jam) karena session offline menjadi `expired`.
- Kalau server mati tepat saat mengirim, pesan itu ditandai `failed` saat start berikutnya (tidak dikirim ulang, untuk mencegah pesan dobel).
- Pesan yang **ditahan** oleh Anti-Ban Guard tetap `queued`, dengan `deferredUntil` dan alasan di `error`. Penahanan tidak memakai jatah retry, dan pesan tetap menjadi `expired` kalau tertahan lebih dari `QUEUE_MAX_AGE_HOURS` setelah jadwalnya. Request yang menunggu hasil langsung dibalas `202` dengan `deferredUntil` dan `reason`.
- Pesan yang **dilewati** oleh guard (penerima opt-out, tidak terdaftar di WhatsApp, kampanye berulang) berstatus `skipped`; request yang menunggu hasil dibalas `409`.

**API antrian** (header `x-api-key`):

| Endpoint | Fungsi |
|---|---|
| `GET /api/queue?sessionId=&status=&limit=&offset=` | Daftar pesan di antrian |
| `GET /api/queue/:queueId` | Detail + status satu pesan |
| `PATCH /api/queue/:queueId` body `{"scheduleAt": "..."}` | Jadwal ulang (hanya status `queued`; tanpa `scheduleAt` = kirim sekarang) |
| `DELETE /api/queue/:queueId` | Batalkan (hanya status `queued`) |

**Status**: `queued` → `processing` → `sent` → `delivered` → `read` / `played`, atau `failed` / `cancelled` / `expired` / `skipped`. Setiap item juga punya `category` dan `newContact` (apakah pesan ini membuka chat baru). Status `delivered`/`read` untuk pesan grup tidak dilacak per anggota.

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
`status`: `sent`, `delivered`, `read`, `played`, `failed`, `expired`, `skipped`. Untuk `failed` karena penolakan WhatsApp, `error` menjelaskan kodenya, misalnya `WhatsApp error 463: account restricted from starting new chats (...)`; untuk `skipped`, `error` berisi alasan dari Anti-Ban Guard.

Event lain: `call.received` (panggilan masuk), serta event Anti-Ban Guard `account.restriction`, `account.banned`, `session.paused`, dan `contact.consent` (lihat [Anti-Ban Guard](#️-anti-ban-guard)).

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
`events: null` = semua event (`connection.update`, `message.received`, `message.status`, `account.restriction`, `account.banned`, `session.paused`, `contact.consent`, `call.received`). Field `format`: `"default"` atau `"fonnte"` (lihat [Migrasi dari Fonnte](#-migrasi-dari-fonnte)). Perubahan berlaku maksimal 30 detik kemudian, tanpa restart session.

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
| `TRUST_PROXY` | – | Setting Express `trust proxy` (`1`, `true`, `loopback`, …) agar IP klien benar di belakang reverse proxy. |
| `BULK_MAX_TARGETS` | `500` | Maksimal target per request kirim massal. |
| `VALIDATE_MAX_NUMBERS` / `VALIDATE_MIN_INTERVAL_MS` / `VALIDATE_CACHE_DAYS` | `50` / `3000` / `7` | Batas, throttle, dan cache validasi nomor. |
| `VALIDATE_DAILY_LIMIT` | `200` | Maksimal nomor yang belum ter-cache per session per 24 jam (validasi + cek otomatis chat baru). |
| `GROUPS_CACHE_MINUTES` | `10` | Umur cache daftar grup. |

Variabel Anti-Ban Guard ada di bagian [Anti-Ban Guard](#️-anti-ban-guard). Port PostgreSQL di `docker-compose.yml` hanya di-bind ke `127.0.0.1`.

---

## 🛡️ Anti-Ban Guard

WhatsApp membatasi dan mem-ban nomor terutama karena **perilaku**:
- memulai banyak chat ke orang yang tidak menyimpan nomor kita;
- mengirim pesan yang sama ke banyak orang;
- banyak penerima yang memblokir atau melaporkan;
- tetap memaksa kirim saat nomor sudah dibatasi.

Guard ini mengatur perilaku tersebut. Gateway **tidak** menyamarkan diri: tidak ada spoofing fingerprint, rotasi proxy/IP, spintax, atau rotasi nomor untuk mengakali batas. Tidak ada yang bisa menjamin nomor tidak di-ban; tujuannya menurunkan risikonya serendah mungkin. Angka default adalah heuristik konservatif, bukan angka resmi WhatsApp.

**Istilah:**
- **Kontak dikenal:** penerima yang pernah mengirim pesan 1:1 ke nomor ini (dicocokkan lewat nomor maupun LID).
- **Chat baru:** kirim ke penerima yang belum dikenal. Inilah yang dihitung kuota WhatsApp dan memicu error 463 serta ban sementara kode 101.
- **Kategori pesan** (field `category` di semua endpoint kirim):

  | Kategori | Default untuk | Contoh |
  |---|---|---|
  | `transactional` | Kirim ke satu penerima | OTP, notifikasi pesanan |
  | `campaign` | Kirim massal, Fonnte multi-target | Promo, broadcast |
  | `reply` | — | Jawaban dalam percakapan aktif (penerima menulis < 24 jam lalu) |

### Gerbang kirim

Setiap pesan dicek tepat sebelum dikirim. Aturan dievaluasi berurutan; aturan pertama yang cocok menentukan hasilnya:
- **kirim** — pesan dikirim sekarang;
- **tahan** — tetap `queued` sampai waktu tertentu (`deferredUntil`);
- **lewati** — status final `skipped`.

| # | Berlaku untuk | Aturan | Hasil |
|---|---|---|---|
| 0 | reaction / edit / delete | Bekerja pada chat yang sudah ada | kirim |
| 1 | Semua (bukan grup) | Penerima opt-out (kecuali `reply` dalam percakapan aktif) | lewati |
| 2 | `campaign` | Penerima bukan kontak dikenal dan belum opt-in (`CAMPAIGN_REQUIRE_CONSENT`) | lewati |
| 3 | `campaign` | Kampanye session sedang dijeda monitor kesehatan | tahan sampai jeda selesai |
| 4 | `campaign` | Di luar `CAMPAIGN_HOURS` (08:00–20:00 `CAMPAIGN_TIMEZONE`) | tahan sampai jam buka |
| 5 | `campaign` | Penerima sudah menerima kampanye dalam `CAMPAIGN_RECIPIENT_COOLDOWN_HOURS` (72 jam) | lewati |
| 6 | Kontak dikenal / grup | — | kirim |
| 7 | Chat baru | Chat baru dijeda karena sinyal WhatsApp (463, timelock, kuota) | tahan |
| 8 | Chat baru | Masa tenang setelah pairing (`NEW_SESSION_COOLDOWN_HOURS`, 72 jam): nomor baru hanya membalas dan kirim ke kontak dikenal | tahan |
| 9 | Chat baru | Baru (re)connect (`RECONNECT_WARMUP_MS`, 2 menit) | tahan |
| 10 | Chat baru | Kuota chat baru WhatsApp habis | tahan sampai siklus berakhir |
| 11 | Chat baru | Anggaran harian `NEW_CONTACT_DAILY_LIMIT` (20 per 24 jam bergulir) habis | tahan sampai ada slot |
| 12 | Chat baru | Jeda antar chat baru `NEW_CONTACT_INTERVAL_MIN_MS`–`MAX_MS` (60–180 detik, acak) | tahan |
| 13 | Chat baru | Nomor tidak terdaftar di WhatsApp (cek ber-cache, `VALIDATE_NEW_CONTACTS`) | lewati |
| 14 | — | Lolos semua aturan | kirim |

Opt-out dan kampanye tanpa consent juga sudah ditolak saat request masuk: kirim tunggal dibalas `409 Not sent: <alasan>`, kirim massal memberi hasil `skipped` per target.

### Persetujuan (consent)

- **Opt-out:**
  - Pesan 1:1 yang isinya persis salah satu `OPT_OUT_KEYWORDS` (tidak case-sensitive, tanda baca di akhir diabaikan; `stop!` cocok, `jangan stop dulu` tidak), atau lewat API.
  - Memblokir kampanye sampai orang itu opt-in lagi. Pesan lain diblokir sampai orang itu menulis lagi.
  - Setting `optOutReply` dikirim sekali sebagai konfirmasi.
- **Opt-in:** pesan `OPT_IN_KEYWORDS` (`START`, …), atau import lewat API (misalnya dari formulir pendaftaran).
- **Kampanye** hanya ke kontak dikenal atau yang sudah opt-in. Bisa dimatikan per session dengan `campaignConsentRequired: false`, tapi tidak disarankan.

| Endpoint | Fungsi |
|---|---|
| `PUT /api/sessions/:sessionId/consents` body `{"numbers": ["0812...", "0813..."], "status": "opted_in"}` | Import opt-in / catat opt-out (maks 1000 nomor per request) |
| `GET /api/sessions/:sessionId/consents?status=opted_out&limit=100&offset=0` | Daftar consent |
| `DELETE /api/sessions/:sessionId/consents/:nomor` | Hapus catatan (dianggap belum pernah ditanya) |

### Reaksi terhadap sinyal WhatsApp

| Sinyal | Tindakan gateway |
|---|---|
| Pesan gagal dengan error 463 | Cek reach-out timelock ke WhatsApp. Kalau timelock tidak aktif atau gagal dicek, chat baru dijeda `RESTRICTION_PAUSE_HOURS` (24 jam). Pesan tidak pernah diulang, karena mengulang juga dihitung sebagai upaya baru. |
| Reach-out timelock aktif | Chat baru dijeda sampai `timeEnforcementEnds`; jeda dicabut otomatis saat WhatsApp mencabut timelock |
| Kuota chat baru `FIRST_WARNING` / `SECOND_WARNING` / `CAPPED` | Chat baru dijeda sampai siklus kuota berakhir; dicabut saat status kembali `NONE` |
| Koneksi ditolak 402 (ban sementara) | Session berhenti tanpa reconnect, webhook `account.banned`, `init` ditolak sampai ban berakhir |
| Koneksi ditolak 406 (ban) / 409 | Session berhenti tanpa reconnect; auth tidak dihapus |
| Pairing baru | Masa tenang dimulai (aturan 8); logout menghapus status guard nomor itu |

Selama jeda chat baru, membalas dan kirim ke kontak dikenal tetap berjalan normal.

### Monitor kesehatan

Setiap `HEALTH_CHECK_INTERVAL_MS` (10 menit), untuk setiap session yang connected:
- **Kuota WhatsApp:** diperbarui setiap `CAP_POLL_HOURS` (6 jam). WhatsApp juga mengirim perubahannya sendiri.
- **Kampanye dijeda** `HEALTH_PAUSE_HOURS` (24 jam) kalau, dari minimal `HEALTH_MIN_SAMPLE` (20) pesan:
  - tingkat terkirim pesan 1:1 (dikirim 2–24 jam lalu) di bawah `HEALTH_MIN_DELIVERY_RATE` (60%); atau
  - tingkat balasan chat baru kampanye (dikirim 1–7 hari lalu) di bawah `HEALTH_MIN_REPLY_RATE` (5%).

  Ini meniru cara Meta menjeda template berkualitas rendah: banyak pesan tak terkirim atau tak dibalas biasanya berarti banyak blokir dan laporan. Setelah jeda berakhir, hanya pesan yang dikirim sesudahnya yang dinilai.

**`GET /api/sessions/:sessionId/health`** — ringkasan guard:
```json
{
  "success": true,
  "sessionId": "sales-01",
  "status": "connected",
  "ban": null,
  "pauses": {
    "newChats": { "until": "2026-10-04T05:00:00.000Z", "reason": "whatsapp_error_463: WhatsApp refused to start a new chat", "byWhatsApp": true },
    "campaigns": null
  },
  "coolDown": { "pairedAt": "2026-09-01T03:00:00.000Z", "endsAt": "2026-09-04T03:00:00.000Z", "active": false },
  "warmUp": { "connectedAt": "2026-10-03T04:00:00.000Z", "endsAt": "2026-10-03T04:02:00.000Z", "active": false },
  "newChats": { "last24h": 7, "dailyLimit": 20, "remaining": 13, "lastAt": "2026-10-03T04:40:00.000Z" },
  "whatsappQuota": { "total": 150, "used": 42, "status": "NONE", "cycleStart": "...", "cycleEnd": "...", "updatedAt": "..." },
  "campaignHours": { "window": "08:00-20:00", "timezone": "Asia/Jakarta", "openNow": true },
  "metrics": { "deliverySample": 120, "delivered": 113, "deliveryRate": 0.94, "replySample": 35, "replied": 6, "replyRate": 0.17 },
  "canStartNewChats": false
}
```

**`POST /api/sessions/:sessionId/health/resume`** body `{"scope": "campaigns"}` (atau `"new_chats"`):
- Mencabut jeda dari monitor kesehatan.
- Jeda dari WhatsApp (`byWhatsApp: true`) ditolak `409` sampai berakhir, karena tetap mengirim saat dibatasi itulah yang berujung ban.

### Webhook Anti-Ban Guard

| Event | Data |
|---|---|
| `account.restriction` | `source`: `reachout_timelock` (`isActive`, `timeEnforcementEnds`, `enforcementType`), `error_463` (`isActive`, `pausedUntil`), atau `chat_cap` (`total`, `used`, `status`, `cycleStart`, `cycleEnd`) |
| `account.banned` | `permanent`, `code`, `reason`, `expiresAt` |
| `session.paused` | `scope` (`new_chats` / `campaigns`), `until`, `reason` — hanya saat jeda baru atau diperpanjang |
| `contact.consent` | `jid`, `jids` (nomor + LID), `status` (`opted_in` / `opted_out`), `source` (`keyword`) |

Event ini tidak dikirim dalam format webhook Fonnte.

### Konfigurasi

| Variabel | Default | Keterangan |
|---|---|---|
| `NEW_CONTACT_DAILY_LIMIT` | `20` | Chat baru per session per 24 jam bergulir (bisa diubah per session) |
| `NEW_CONTACT_INTERVAL_MIN_MS` / `NEW_CONTACT_INTERVAL_MAX_MS` | `60000` / `180000` | Jeda acak antar chat baru |
| `NEW_SESSION_COOLDOWN_HOURS` | `72` | Masa tenang setelah pairing (session yang sudah di-pair sebelum fitur ini tidak terkena) |
| `RECONNECT_WARMUP_MS` | `120000` | Jeda chat baru setelah (re)connect |
| `RESTRICTION_PAUSE_HOURS` | `24` | Lama jeda chat baru setelah error 463 tanpa info timelock |
| `CAMPAIGN_HOURS` / `CAMPAIGN_TIMEZONE` | `08:00-20:00` / `Asia/Jakarta` | Jam kirim kampanye (boleh melewati tengah malam, misal `22:00-06:00`) |
| `CAMPAIGN_RECIPIENT_COOLDOWN_HOURS` | `72` | Jarak minimal antar kampanye ke penerima yang sama |
| `CAMPAIGN_REQUIRE_CONSENT` | `true` | Kampanye hanya ke kontak dikenal atau opt-in |
| `OPT_OUT_KEYWORDS` | `STOP,BERHENTI,UNSUBSCRIBE,UNSUB,STOP PROMO,BERHENTI PROMO` | Keyword opt-out (dipisah koma) |
| `OPT_IN_KEYWORDS` | `START,SUBSCRIBE,LANGGANAN` | Keyword opt-in |
| `VALIDATE_NEW_CONTACTS` | `true` | Cek nomor terdaftar sebelum membuka chat baru |
| `CAP_POLL_HOURS` | `6` | Interval cek kuota chat baru WhatsApp |
| `HEALTH_CHECK_INTERVAL_MS` | `600000` | Interval monitor kesehatan |
| `HEALTH_MIN_SAMPLE` | `20` | Sampel minimal sebelum monitor boleh menjeda |
| `HEALTH_MIN_DELIVERY_RATE` / `HEALTH_MIN_REPLY_RATE` | `0.6` / `0.05` | Ambang tingkat terkirim / balasan |
| `HEALTH_PAUSE_HOURS` | `24` | Lama jeda kampanye dari monitor |

### Simulasi mengetik

Sebelum kirim, gateway mengirim presence `composing` (atau `recording` untuk voice note) selama `MIN_TYPING_DELAY_MS`–`MAX_TYPING_DELAY_MS`, tergantung panjang teks. Ini hanya sinyal lemah; yang menentukan adalah aturan di atas.

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
- **Anti-Ban Guard** (lihat [Anti-Ban Guard](#️-anti-ban-guard)):
  - Nomor yang baru di-pair hanya bisa membalas dan kirim ke kontak dikenal selama 72 jam; chat baru menunggu.
  - Chat baru dibatasi 20 per 24 jam per nomor, dengan jeda 1–3 menit; sisanya tertahan di antrian (`deferredUntil`).
  - Kirim massal default-nya `campaign`: hanya ke kontak dikenal atau yang opt-in, hanya 08:00–20:00 WIB, maksimal sekali per penerima per 72 jam. Kirim satu penerima tetap `transactional`.
  - Penerima yang mengirim `STOP`/`BERHENTI` tidak dikirimi lagi (`409` / `skipped`).
  - Status antrian baru `skipped`; event webhook baru `account.banned`, `session.paused`, `contact.consent`; payload `account.restriction` kini punya `source`.
  - Target `status@broadcast` / `...@broadcast` ditolak `400`.
  - 402/406 tidak lagi di-reconnect; `init` ditolak selama ban sementara.
  - Fonnte dengan beberapa token: penerima tidak lagi dirotasi acak, tapi tetap di nomor yang pernah chat dengannya.
  - Lookup nomor yang belum ter-cache dibatasi 200 per session per 24 jam (`429`).

---

## 📜 Lisensi
MIT License. Catatan: Baileys bergantung pada `libsignal` (GPL-3.0). Kalau gateway ini didistribusikan ke pihak lain (bukan hanya dijalankan sebagai layanan), periksa kewajiban lisensi GPL.
