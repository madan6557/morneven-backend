

Berdasarkan analisis dari dokumen "Backend Requirement Morneven Institute" yang diberikan,
berikut adalah rekomendasi teknologi dan desain skema database relasional (PostgreSQL)
yang sudah ternormalisasi.
## 1. Rekomendasi Teknologi Utama
Meskipun dokumen menyarankan beberapa opsi, berikut adalah rekomendasi tumpukan
teknologi (tech stack) yang paling optimal untuk skala, keamanan, dan kompleksitas fitur
(seperti RBAC kompleks, relasi entitas, dan audit trail) yang ada di dokumen:
● Bahasa & Framework: Node.js dengan NestJS (TypeScript).
○ Alasan: NestJS memiliki arsitektur modular yang sangat cocok untuk memisahkan
domain seperti Lore, Projects, Gallery, dan Map. Sistem Guard dan Interceptor
bawaannya sangat ideal untuk mengimplementasikan Role-Based Access Control
(RBAC) yang spesifik seperti Level (0-7) dan Track (executive, field, mechanic,
logistics).
● Database: PostgreSQL.
○ Alasan: Sistem ini sangat relasional. Terdapat banyak entitas yang saling terhubung
(Users ke Comments, Comments ke Replies, Mentions ke Users). PostgreSQL
menjamin integritas data (ACID) dan mendukung tipe data JSONB yang sangat
berguna untuk menyimpan konfigurasi Command Center Settings per user tanpa
harus membuat puluhan tabel konfigurasi.
● ORM (Object-Relational Mapping): Prisma.
○ Alasan: Prisma memberikan type-safety yang sangat ketat di TypeScript. Ini
memastikan kontrak data (variabel request/response) antara backend dan frontend
tidak mudah rusak.
● Keamanan & Validasi: Zod (untuk validasi payload) dan Passport.js (untuk strategi JWT
## Access & Refresh Token).
- Desain Database Relasional (Ternormalisasi)
Karena spesifikasi memiliki banyak entitas dengan array data (seperti docs, tags, mentions,
traits), database perlu dinormalisasi (minimal bentuk normal ketiga / 3NF) untuk menghindari
anomali data.
Berikut adalah rancangan tabel-tabel utama beserta relasinya:
## A. Entitas Pengguna & Autentikasi
Tabel ini menyimpan data inti personel dan pengaturannya.
● users
○ id (UUID, Primary Key)
○ username (VARCHAR, Unique, Min 3 chars)
○ email (VARCHAR, Unique)
○ password_hash (VARCHAR)
○ role (ENUM: 'author', 'personel', 'guest')
○ level (INT, Check 0-7)
○ track (ENUM: 'executive', 'field', 'mechanic', 'logistics')
○ note (TEXT, Nullable)
○ created_at (TIMESTAMP)

○ updated_at (TIMESTAMP)
● command_center_settings
○ Catatan: Mengingat struktur itemLimits dan manualSelections adalah key-value
yang terikat langsung pada UI, menggunakan JSONB di PostgreSQL adalah praktik
terbaik yang tetap menjaga performa tanpa over-engineering relasi.
○ user_id (UUID, Primary Key, Foreign Key -> users.id)
○ show_stats, show_projects, dll (BOOLEAN)
○ welcome_message (VARCHAR)
○ item_limits (JSONB)
○ manual_selections (JSONB)
## B. Modul Projects & News
● projects
○ id (UUID, Primary Key)
○ title (VARCHAR)
○ status (ENUM: 'Planning', 'On Progress', 'On Hold', 'Completed', 'Canceled')
○ thumbnail (VARCHAR)
○ short_desc (TEXT)
○ full_desc (TEXT)
● project_patches (Normalisasi dari array patches)
○ id (UUID, Primary Key)
○ project_id (UUID, Foreign Key -> projects.id)
○ version (VARCHAR)
○ patch_date (DATE)
○ notes (TEXT)
● news
○ id (UUID, Primary Key)
○ author_id (UUID, Foreign Key -> users.id)
○ text (TEXT)
○ publish_date (DATE)
○ has_detail (BOOLEAN)
○ thumbnail (VARCHAR, Nullable)
○ body (TEXT, Nullable)
● news_attachments (Normalisasi dari array attachments)
○ id (UUID, Primary Key)
○ news_id (UUID, Foreign Key -> news.id)
○ type (ENUM: 'image', 'video', 'link')
○ url (VARCHAR)
○ caption (VARCHAR, Nullable)
C. Entitas Lore (Characters, Places, Technology, dll.)
Untuk menghindari duplikasi tabel dokumentasi (docs), kita menggunakan pendekatan tabel
Polymorphic atau satu tabel terpusat untuk media yang merujuk pada entity_type dan entity_id.
● lore_characters
○ id (UUID, Primary Key)
○ name, race, occupation, height, accent_color (VARCHAR)

○ short_desc, full_desc (TEXT)
○ stat_combat, stat_intelligence, stat_stealth, stat_charisma, stat_endurance (INT)
● Tabel Pendukung Karakter (Normalisasi Arrays):
○ character_traits: id, character_id, trait
○ character_likes: id, character_id, like_item
○ character_dislikes: id, character_id, dislike_item
○ character_contributions: id, character_id, title, description, date
● lore_creatures
○ id (UUID, Primary Key)
○ name, habitat, accent_color (VARCHAR)
○ classification (ENUM: 'Amorphous', 'Crystalline', dll)
○ danger_level (INT, Check 1-5)
○ short_desc, full_desc (TEXT)
● lore_places, lore_technology, lore_other
○ Masing-masing memiliki tabel sendiri dengan kolom dasar: id, name/title,
type/category, thumbnail, short_desc, full_desc sesuai spesifikasi entitas.
● entity_docs (Tabel Polymorphic untuk media/dokumen semua entitas)
○ id (UUID, Primary Key)
○ entity_type (ENUM: 'project', 'character', 'place', 'technology', 'creature', 'other')
○ entity_id (UUID)
○ type (ENUM: 'image', 'video')
○ url (VARCHAR)
○ caption (VARCHAR)
## D. Gallery & Maps
● gallery_items
○ id (UUID, Primary Key)
○ type (ENUM: 'image', 'video')
○ title, thumbnail, caption (VARCHAR)
○ video_url (VARCHAR, Nullable)
○ upload_date (TIMESTAMP)
○ uploaded_by (UUID, Foreign Key -> users.id)
● gallery_tags (Normalisasi dari array tags)
○ id (UUID, Primary Key)
○ gallery_item_id (UUID, Foreign Key -> gallery_items.id)
○ tag (VARCHAR)
● map_markers
○ id (UUID, Primary Key)
○ name (VARCHAR)
○ status (ENUM: 'safe', 'caution', 'danger', 'restricted', 'mission')
○ x, y (FLOAT, Check 0..1)
○ description (TEXT)
○ lore_link (VARCHAR, Nullable)
## E. Modul Diskusi & Komentar Terpusat
Komentar untuk entitas Lore dan Gallery memiliki format yang sangat identik (teks, mentions,

replies). Ini bisa dinormalisasi menjadi sistem diskusi terpusat:
● discussions (Tabel Induk Komentar)
○ id (UUID, Primary Key)
○ entity_type (ENUM: 'gallery', 'character', 'place', 'technology', 'creature', 'other')
○ entity_id (UUID)
○ author_id (UUID, Foreign Key -> users.id)
○ text (TEXT)
○ created_at (TIMESTAMP)
● discussion_replies
○ id (UUID, Primary Key)
○ discussion_id (UUID, Foreign Key -> discussions.id, ON DELETE CASCADE)
○ author_id (UUID, Foreign Key -> users.id)
○ text (TEXT)
○ created_at (TIMESTAMP)
● mentions (Normalisasi Mentions pada Komentar/Balasan)
○ id (UUID, Primary Key)
○ discussion_id (UUID, Nullable, Foreign Key -> discussions.id)
○ reply_id (UUID, Nullable, Foreign Key -> discussion_replies.id)
○ mentioned_user_id (UUID, Foreign Key -> users.id)
○ start_idx (INT)
○ end_idx (INT)