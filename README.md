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
│   │   └── webhookService.js # Message parser & Webhook dispatcher
│   ├── controllers/
│   │   ├── sessionController.js # Handler API session & QR
│   │   └── messageController.js # Handler API kirim pesan & riwayat
│   ├── middlewares/
│   │   └── auth.js          # Middleware API Key
│   └── routes/
│       ├── index.js
│       ├── sessionRoutes.js
│       └── messageRoutes.js
```

---

## 🚀 Cara Menjalankan

### Opsi 1: Menggunakan Docker Compose (Direkomendasikan)

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

### 2. Dapatkan QR Code untuk Scan
Mendapatkan QR Code untuk pairing device.

- **Endpoint (JSON Base64)**: `GET /api/sessions/:sessionId/qr`
- **Endpoint (Tampilan Browser Web)**: `GET /api/sessions/:sessionId/qr?format=html`
  > Buka URL `http://localhost:3000/api/sessions/sales-01/qr?format=html` di browser untuk langsung scan dari aplikasi WhatsApp di HP Anda.

---

### 3. Request WhatsApp Pairing Code (Tanpa Scan QR)
Menghubungkan WhatsApp menggunakan kode 8 digit.

- **Endpoint**: `POST /api/sessions/:sessionId/pairing-code`
- **Request Body**:
  ```json
  {
    "phoneNumber": "628123456789"
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
      "phoneNumber": "628123456789",
      "webhookUrl": "https://your-domain.com/webhook"
    }
  }
  ```

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

---

### 6. Kirim Gambar (Image)
Mendukung URL gambar, Base64, atau upload file (`multipart/form-data`).

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

## 🛡️ Pengaturan Anti-Ban & Human Simulation

Di file `.env` / `docker-compose.yml`:
- `MIN_TYPING_DELAY_MS=1200` (Jeda minimal mengetik sebelum kirim pesan)
- `MAX_TYPING_DELAY_MS=3000` (Jeda maksimal mengetik)
- `AUTO_READ_MESSAGES=true` (Otomatis menandai pesan masuk sebagai telah dibaca / centang biru)

---

## 📜 Lisensi
MIT License.
