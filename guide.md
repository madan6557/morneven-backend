# Final Hardening and Freeze Guide

Panduan ini adalah prosedur replikasi untuk deployment Morneven yang memakai
frontend, backend, dan ZeroClaw saat ini.

## 1. Deployment Topology

Service aktif:

1. `morneven-website` untuk SPA dan security headers browser.
2. `morneven-backend` untuk API, database, storage, scheduler, backup, dan Bot
   Manager.
3. `morneven-zeroclaw` untuk seluruh runtime personality Bot Manager.

Persistent volume ZeroClaw harus dipasang tepat pada:

```text
/zeroclaw-data/data
```

Runtime root Morneven:

```text
/zeroclaw-data/data/morneven
```

## 2. Website Hardening

Frontend membundel Inter, Orbitron, dan Rajdhani secara lokal. Jangan
menambahkan kembali import Google Fonts atau stylesheet font eksternal.

Security header minimum:

```text
Content-Security-Policy
Cross-Origin-Opener-Policy: same-origin
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy
```

CSP harus mempertahankan aturan berikut:

```text
default-src 'self'
base-uri 'self'
object-src 'none'
frame-ancestors 'none'
form-action 'self'
script-src 'self' https://va.vercel-scripts.com
script-src-attr 'none'
img-src 'self' data: blob:
font-src 'self' data:
media-src 'self' data: blob:
worker-src 'self' blob:
manifest-src 'self'
```

Hanya backend Morneven, endpoint Vercel yang dipakai, dan localhost development
yang boleh ada di `connect-src`. Jika hostname backend berubah, perbarui
`server.mjs` dan `vercel.json` pada commit yang sama.

Embed video hanya boleh berasal dari:

- `www.youtube.com`
- `www.youtube-nocookie.com`
- `player.vimeo.com`

URL konten untuk navigasi harus berupa path internal atau HTTP(S). Skema
`javascript:`, `data:` untuk navigasi, protocol-relative URL, karakter kontrol,
dan embed host lain harus ditolak.

## 3. Upload and File Serving

Upload normal yang diterima:

- PNG, JPEG, WebP, GIF
- MP4, WebM, QuickTime
- PDF
- JSON, text, Markdown

Upload yang diblokir:

- SVG, HTML, XHTML, XML
- JavaScript, CSS, WebAssembly
- PHP, shell, PowerShell, batch
- executable Windows atau ELF
- ZIP, 7z, RAR, JAR
- MIME yang tidak cocok dengan file signature
- text atau JSON yang berisi active web markup

Storage tidak boleh dipasang dengan `express.static`. Object publik dilayani
oleh handler yang:

1. Menormalisasi dan memvalidasi path.
2. Menolak private prefix.
3. Mengambil object melalui storage driver.
4. Memaksa active content dan document content menjadi download.
5. Mengirim `nosniff`, `DENY`, sandbox CSP, dan cache policy.

Uji dengan upload `.html`, `.svg`, `.js`, `.css`, `.zip`, file `MZ`, dan file
yang MIME-nya dipalsukan. Semua harus gagal.

## 4. Backend Environment

Gunakan secret yang unik dan jangan commit nilainya:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=<unique secret>
JWT_REFRESH_SECRET=<unique secret>
CORS_ORIGIN=https://<frontend-domain>
MIGRATION_KEY=<unique secret, minimum 16 characters>
EXTRACTION_KEY=<unique secret, minimum 16 characters>
BOT_MANAGER_KEY=<unique secret, minimum 16 characters>
BOT_MANAGER_ENCRYPTION_KEY=<unique secret, minimum 32 characters>
BOT_MANAGER_SYNC_TOKEN=<same as ZeroClaw MORNEVEN_BOT_MANAGER_SYNC_TOKEN>
ZEROCLAW_INTERNAL_BASE_URL=http://<zeroclaw-private-domain>:8080
ZEROCLAW_MORNEVEN_RELOAD_TOKEN=<same as ZeroClaw MORNEVEN_RELOAD_TOKEN>
```

## 5. ZeroClaw Environment

```dotenv
ZEROCLAW_DATA_DIR=/zeroclaw-data/data
MORNEVEN_ZEROCLAW_ROOT=/zeroclaw-data/data/morneven
MORNEVEN_PRODUCTION_HARDENING=true
MORNEVEN_WEB_AUTH_ENABLED=true
MORNEVEN_WEB_SESSION_SECRET=<unique secret, minimum 32 characters>
MORNEVEN_WEB_SESSION_TTL_SECONDS=14400
MORNEVEN_RELOAD_TOKEN=<unique secret, minimum 16 characters>
MORNEVEN_BACKEND_INTERNAL_URL=http://<backend-private-domain>:8080
MORNEVEN_BOT_MANAGER_SYNC_TOKEN=<unique secret, minimum 16 characters>
```

Session secret, reload token, dan sync token harus berbeda. ZeroClaw production
gagal start sebelum bind port jika auth dimatikan, secret lemah, token sama,
backend URL invalid, atau runtime root berada di luar data directory.

## 6. Database Migration

Deploy migration sebelum memulai versi backend baru:

```bash
npm ci
npm run prisma:generate
npm run build
npm run prisma:migrate:deploy
npm run start
```

Migration membuat:

- field durable extraction job
- partial unique index untuk satu active job per Author
- `ScheduledTask`
- `ScheduledTaskRun`
- `RuntimeControlState`

Scheduler memeriksa task setiap 30 detik. Lease database diperbarui selama task
berjalan. Unique `(taskId, scheduledFor)` mencegah run ganda pada multi-replica.

## 7. Scheduled Backup

Hanya PL7 Author yang dapat membuat atau menghapus jadwal. Operasi membutuhkan:

- JWT user aktif
- account password
- `EXTRACTION_KEY`

Secret hanya diverifikasi dan tidak disimpan.

Endpoint:

```text
GET    /api/settings/extraction/schedule
PUT    /api/settings/extraction/schedule
DELETE /api/settings/extraction/schedule
```

Jenis schedule:

1. One-time dengan tanggal dan jam lokal.
2. Relative setelah 1 sampai 3650 hari.
3. Weekly dengan satu atau beberapa weekday.
4. IANA timezone, default UI mengikuti timezone browser.

Retention:

- archive count: 1 sampai 10
- retention days: 1 sampai 30
- default: 3 archive selama 7 hari

## 8. Runtime Schedule and Freeze

Per personality:

```text
GET    /api/bot-manager/identities/:id/runtime-schedule
PUT    /api/bot-manager/identities/:id/runtime-schedule
DELETE /api/bot-manager/identities/:id/runtime-schedule
```

Global freeze:

```text
GET    /api/bot-manager/runtime-freeze
PUT    /api/bot-manager/runtime-freeze
DELETE /api/bot-manager/runtime-freeze
```

Mutation hanya untuk PL7 Author dan membutuhkan account password.

Aturan runtime:

- Jika start dan stop jatuh pada instant yang sama, stop menang.
- Freeze dan stop dieksekusi sebelum start pada tick yang sama.
- Freeze menghentikan seluruh personality aktif.
- Manual dan scheduled start ditolak selama freeze aktif.
- Aksi manual berlaku sampai event schedule berikutnya.
- Menghapus freeze tidak otomatis menyalakan runtime.

## 9. Backup Archive

Full backup memakai format:

```text
morneven-zeroclaw-backup/v1
```

Archive berisi:

- manifest dengan path, byte count, dan SHA-256
- backend dataset
- SQL dan compatibility JSON
- attachment manifest dan storage objects
- Bot Manager identity dan credential terenkripsi
- ZeroClaw runtime bundle
- schedule definitions
- runtime control state

Archive baru tidak boleh memasukkan:

```text
backups/**
bot-manager/backups/**
```

Restore menolak:

- path traversal atau duplicate ZIP entry
- encrypted ZIP dan unsupported compression
- entry count atau uncompressed size berlebih
- missing atau unexpected manifest file
- checksum atau byte count yang berbeda
- dataset atau attachment manifest yang tidak sesuai schema
- executable, archive, active markup, dan MIME mismatch

Dataset baru diimport hanya setelah seluruh validasi lulus. Schedule hasil
restore selalu disabled, task run dibersihkan, global freeze tidak diaktifkan,
dan runtime hasil restore tetap stopped.

## 10. Extraction Reliability

Status job:

```text
queued
processing
completed
failed
stopped
```

Worker durable menggantikan background callback sementara. Per Author hanya
boleh ada satu job `queued` atau `processing`.

Reliability rules:

1. Create dan scheduled run memakai idempotency key.
2. Retry memakai attempt key yang deterministik.
3. Update progress memperpanjang lease dan heartbeat.
4. Job tanpa heartbeat selama 30 menit menjadi `stopped`.
5. Job expired yang belum selesai menjadi `stopped`.
6. Partial artifact dihapus saat stop atau failure.
7. Retry membuat attempt baru dan mulai dari 0 persen.
8. Frontend deduplicate REST dan realtime berdasarkan job ID.
9. Polling hanya aktif jika ada job `queued` atau `processing`.
10. API mengirim RFC3339 UTC dan UI menampilkan waktu lokal beserta timezone.

## 11. Storage Control

Volume ZeroClaw hanya 500 MiB. Backend menerapkan:

- cleanup mulai pada 350 MiB
- backup baru diblokir pada 450 MiB jika cleanup tidak cukup
- pruning berdasarkan retention count dan retention days
- backup lama tidak ikut dimasukkan ke backup baru
- runtime directory tanpa personality owner dihapus setelah process berhenti
- parent log rotation 2 MiB dengan 3 archive
- personality log rotation 1 MiB dengan 2 archive

Sebelum deploy, catat penggunaan:

```sh
du -h -d 3 /zeroclaw-data/data
find /zeroclaw-data/data/morneven/runtimes -maxdepth 2 -type f -print
```

Image production bersifat distroless. Gunakan volume browser platform atau
maintenance image yang memiliki shell.

## 12. Three Redeployment Check

1. Catat total bytes dan daftar file `/zeroclaw-data/data`.
2. Deploy revision yang sama.
3. Jalankan Bot Manager sync.
4. Ulangi sampai total tiga redeployment.
5. Pastikan jumlah runtime directory sama dengan jumlah personality.
6. Pastikan file materialized tidak memiliki copy berulang.
7. Pastikan archive log tidak melewati batas rotasi.
8. Pastikan total storage hanya berubah karena data runtime yang benar-benar
   baru.

Actual platform redeployment membutuhkan akses deployment dan volume production.
Jika verifikasi dilakukan lokal, catat sebagai code-level verification, bukan
production volume verification.

## 13. Final Backup Before Freeze

1. Aktifkan global runtime freeze.
2. Pastikan seluruh personality berstatus `stopped`.
3. Buat full backup mode `all`.
4. Download archive.
5. Validasi manifest, file sizes, dan SHA-256.
6. Jalankan restore atau materialization dry-run pada environment terpisah.
7. Pastikan semua personality ter-materialisasi sebagai stopped.
8. Pastikan seluruh restored schedule disabled.
9. Simpan archive final pada storage di luar volume 500 MiB.

Jangan menyatakan backup production valid sebelum checksum dan dry-run selesai.

## 14. Quality Gate

Backend:

```bash
npm ci
npm run prisma:generate
npx prisma validate
npm run build
npm test
npm audit
```

Frontend:

```bash
npm ci
npm run lint
npm test
npm run build
npm audit
```

ZeroClaw:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --exclude zeroclaw-desktop --all-targets --features ci-all -- -D warnings
cargo test --workspace --exclude zeroclaw-desktop
cargo deny check
```

Smoke test:

1. Font dimuat dari `/assets/*.woff2`, bukan domain eksternal.
2. CSP dan framing headers tersedia pada HTML, health, dan asset.
3. Upload berbahaya ditolak.
4. File active content dipaksa download.
5. Dashboard, REST, WebSocket, dan realtime extraction tetap berfungsi.
6. Tidak muncul duplicate extraction job sementara.
7. Stale job berhenti dan Retry mulai dari 0.
8. Tanggal backup menampilkan tanggal, jam, dan timezone lokal.
9. Schedule bertahan setelah backend restart.
10. Multi-worker tidak mengeksekusi run yang sama dua kali.

## 15. Manual Shutdown

Pemilik melakukan shutdown secara manual:

1. Aktifkan global runtime freeze.
2. Verifikasi seluruh runtime stopped.
3. Selesaikan final backup dan dry-run.
4. Nonaktifkan scheduled backup dan runtime schedule jika environment akan lama
   offline.
5. Stop ZeroClaw.
6. Stop backend.
7. Stop frontend.
8. Pertahankan persistent volume dan repository untuk restart mendatang.
