# Morneven Security and Backup Guide

Panduan ini menjelaskan hardening yang dipakai untuk mencegah injeksi iklan judi online, file aktif berbahaya, dan backup yang membengkak setelah migrasi ke ZeroClaw.

## Website Security

1. Terapkan header global di frontend server dan hosting:
   - `Content-Security-Policy`
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Permissions-Policy` untuk mematikan perangkat yang tidak dipakai.
2. CSP harus minimal:
   - `default-src 'self'`
   - `object-src 'none'`
   - `base-uri 'self'`
   - `frame-ancestors 'none'`
   - `script-src 'self'`
3. Iframe hanya boleh untuk provider yang dipercaya. Saat ini embed video dibatasi ke YouTube no-cookie dan Vimeo player.
4. Jangan render URL dengan skema `javascript:`, data HTML, data SVG, atau skema lain yang tidak dikenal.
5. Jika membuat komponen yang memakai `dangerouslySetInnerHTML`, validasi semua key dan value yang masuk ke HTML atau CSS.

## Upload and File Serving

1. Upload yang boleh diterima:
   - PNG, JPEG, WebP, GIF
   - MP4, WebM, MOV
   - PDF
   - JSON, text, Markdown
2. Upload yang harus ditolak:
   - SVG, HTML, XHTML, XML, JS, CSS, WASM
   - PHP, shell script, executable
   - ZIP, 7z, RAR, JAR
3. File object yang bertipe aktif harus dipaksa download sebagai `application/octet-stream`.
4. File object harus selalu memakai `X-Content-Type-Options: nosniff` dan CSP sandbox:
   - `sandbox`
   - `default-src 'none'`
   - `script-src 'none'`
   - `object-src 'none'`
   - `frame-ancestors 'none'`

## Backup and Extraction

1. Backup baru tidak boleh memasukkan artefak backup lama:
   - `backups/**`
   - `bot-manager/backups/**`
2. Backup baru tidak boleh memasukkan arsip legacy Nanobot:
   - `legacy/nanobot/**`
   - `bot-manager/workspace/*/legacy/nanobot/**`
3. Job extraction dan Bot Manager backup hanya dianggap aktif jika `expiresAt` masih di masa depan.
4. Bot Manager export saat ini kompatibel dengan ZeroClaw dan membawa data:
   - credentials
   - OpenRouter profiles
   - provider analytics credentials
   - provider usage events
   - general config
   - identities
   - active identity files
5. Identity files legacy Nanobot tidak diekspor lagi sebagai data aktif. File lama tetap bisa dibaca untuk migrasi, tetapi tidak dipaketkan ulang.

## ZeroClaw Storage

Mount path ZeroClaw production saat ini:

```text
/zeroclaw-data/data
```

Runtime root Morneven yang dipakai ZeroClaw:

```text
/zeroclaw-data/data/morneven
```

ENV yang relevan pada image ZeroClaw:

```text
ZEROCLAW_DATA_DIR=/zeroclaw-data/data
MORNEVEN_ZEROCLAW_ROOT=/zeroclaw-data/data/morneven
```

ENV lama bernama `NANOBOT_*` masih boleh dipakai sampai redeployment berikutnya, tetapi nilainya harus menunjuk ke service ZeroClaw.

## Replication Checklist

1. Deploy backend dan frontend dari branch hardening yang sama.
2. Pastikan frontend mengirim header CSP global.
3. Upload test file `.html`, `.svg`, `.js`, `.css`, dan `.zip`. Semua harus ditolak.
4. Download object aktif lama. Response harus forced download, bukan render inline.
5. Jalankan extraction mode `all`, lalu cek `attachments/manifest.json`. Path `backups/**`, `bot-manager/backups/**`, dan `legacy/nanobot/**` tidak boleh muncul.
6. Jalankan Bot Manager backup, lalu cek archive. Folder `workspace-objects/**/legacy/nanobot/**` tidak boleh muncul.
7. Cek storage cleanup report. Objek backup expired boleh terdeteksi sebagai orphan, tetapi legacy archive `legacy/nanobot/**` tetap dilindungi dari cleanup otomatis.
8. Sync Bot Manager ke ZeroClaw dan pastikan response memakai field `runtime`.
