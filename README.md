# 🚀 WhatsApp Web Gateway API (Node.js + Baileys + PostgreSQL)

WhatsApp Gateway REST API berbasis Node.js dan `@whiskeysockets/baileys` dengan arsitektur Multi-Device, penyimpanan data persisten di PostgreSQL, simulasi Anti-Ban Typing Indicator, dan sistem Webhook otomatis sesuai tipe pesan.

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
   - Webhook dapat diatur spesifik per session (`device-1`, `device-2`) atau global.
4. **🛡️ Anti-Ban Humanizer Simulation**:
   - Sebelum pesan dikirim, sistem otomatis mengirim status presence `composing` (mengetik) atau `recording` (merekam audio) dengan jeda waktu natural dinamis berbasis panjang teks.
5. **Kirim Pesan WhatsApp Lengkap**:
   - Kirim WhatsApp Pairing Code
   - Kirim Text Message
   - Kirim Image (URL / Base64 / File Upload multipart)
   - Kirim Document / Attachment PDF/ZIP/dll (URL / File Upload multipart)
6. **PostgreSQL Database Storage**:
   - Tabel `sessions`, `baileys_auth_store`, `messages`, dan `webhook_logs`.
7. **Docker & Docker Compose**:
   - Siap dideploy dengan satu perintah `docker compose up -d`.

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
│   │   ├── schema.sql       # Skema DDL tabel
│   │   └── postgresAuthState.js # Baileys Auth Store adapter ke PostgreSQL
│   ├── services/
│   │   ├── sessionManager.js # Core Multi-device, Baileys socket, anti-ban presence
│   │   ├── reconnectPolicy.js # Keputusan reconnect/stop per kode disconnect
│   │   ├── webhookUrlResolver.js # Resolusi URL webhook per session (dengan cache)
│   │   └── webhookService.js # Message parser & Webhook dispatcher
│   ├── controllers/
│   │   ├── sessionController.js # Handler API session & QR
│   │   └── messageController.js # Handler API kirim pesan & riwayat
│   ├── middlewares/
│   │   └── auth.js          # API key (header) & signed QR link
│   ├── utils/               # Validasi, normalisasi nomor, guard SSRF, cache, lock
│   ├── views/
│   │   └── sessionPages.js  # Halaman HTML QR/status
│   └── routes/
│       ├── index.js
│       ├── sessionRoutes.js
│       └── messageRoutes.js
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
- **Error**: `400` input tidak valid, `409` session tidak connected.

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
    "senderJid": "628987654321@s.whatsapp.net",
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

Perubahan `webhookUrl` lewat `PUT /api/sessions/:sessionId/webhook` langsung berlaku (maksimal 30 detik cache), tanpa restart session.

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

Port PostgreSQL di `docker-compose.yml` hanya di-bind ke `127.0.0.1`.

---

## 🛡️ Pengaturan Anti-Ban & Human Simulation

Di file `.env` / `docker-compose.yml`:
- `MIN_TYPING_DELAY_MS=1200` (Jeda minimal mengetik sebelum kirim pesan)
- `MAX_TYPING_DELAY_MS=3000` (Jeda maksimal mengetik)
- `AUTO_READ_MESSAGES=true` (Otomatis menandai pesan masuk sebagai telah dibaca / centang biru)

> Catatan: indikator mengetik hanya sinyal lemah. Yang paling berpengaruh terhadap ban adalah kecepatan kirim, mengirim ke nomor yang belum pernah chat, dan laporan spam dari penerima.

---

## 📜 Lisensi
MIT License.
