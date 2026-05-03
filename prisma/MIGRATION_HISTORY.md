# Prisma Migration History

Dokumen ini merangkum migration penting agar tim FE, QA, dan DevOps tidak perlu menebak perubahan schema dari nama folder saja.

## Urutan migration aktif

1. `20260430140000_init`
   - Baseline schema awal backend.
   - Membuat tabel inti aplikasi.

2. `20260501090000_fe_parity_updates`
   - Penyesuaian schema untuk parity dengan kebutuhan FE saat itu.
   - Menambahkan dan menyesuaikan beberapa field/relasi untuk endpoint FE.

3. `20260503103000_command_center_global_settings`
   - Migrasi dari model lama `CommandCenterSettings` per-user ke model global.
   - Data lama dikonversi menjadi satu sumber pengaturan global.

4. `20260503113000_command_center_system_presets`
   - Evolusi model global menjadi model **system preset**.
   - Menambahkan dukungan preset melalui kolom:
     - `presetKey` (unik)
     - `presetName`
     - `isActive`
     - `createdAt`
     - `updatedAt`
   - Preset default disiapkan agar sistem tetap punya konfigurasi aktif.

## Catatan operasional

- Banyak folder migration itu normal, karena migration adalah histori perubahan schema.
- Jangan edit atau hapus migration lama yang sudah pernah dipakai environment lain.
- Deployment production harus menjalankan:
  - `prisma migrate deploy`
- Prisma akan mengeksekusi migration yang **belum pernah diterapkan** pada DB target, sesuai urutan histori di tabel `_prisma_migrations`.

