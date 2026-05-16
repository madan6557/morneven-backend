

## Backend Requirement Morneven
## Institute
Dokumen ini adalah spesifikasi backend yang disesuaikan dengan fitur frontend saat ini. Tujuannya agar development backend bisa langsung
berjalan tanpa ambigu, termasuk kontrak route, logika akses, variabel request/response, validasi, dan format error.
Update Sistem (April 2026)
Analisa codebase terbaru menunjukkan beberapa perubahan penting yang wajib tercermin di backend:
- News sekarang mendukung detail page (hasDetail) dan lampiran (attachments).
- Command Center Settings bertambah itemLimits dan manualSelections.
- Discussion untuk lore disimpan sebagai field discussions pada entity lore; gallery tetap memakai comments.
- Author panel L6 non-executive tidak memiliki akses write ke news.
- Endpoint gallery comments perlu dukung edit/delete reply.
Dokumen ini sudah diperbarui agar selaras dengan kontrak data frontend saat ini sekaligus menjaga keamanan backend (validasi server-side +
## RBAC).
## 1. Ruang Lingkup Fitur
Backend wajib mendukung modul berikut:
- Authentication: login, register, me, logout, validasi token.
- Lore: characters, places, technology, creatures, other lore (CRUD + detail).
- Projects: list, detail, create, update, delete.
- Gallery: list/detail item, upload, edit/delete, comments, replies.
- Map: markers dan map image.
- Personnel: list/detail/create/update/delete + bulk update.
- Settings: command center settings per user.
- News: feed pengumuman.
- Standar API
2.1 Base URL
## Development: /api
Production: menyesuaikan gateway/reverse proxy.
## 2.2 Format Response Sukses
Gunakan format konsisten:
## {
"success": true,
"message": "Optional message",
## "data": {}
## }

Untuk list:
## {
"success": true,
## "data": [],
## "meta": {
## "page": 1,
## "limit": 20,
## "total": 120,
"totalPages": 6
## }
## }
## 2.3 Format Error
## {
"success": false,
"message": "Validation failed",
"errorCode": "VALIDATION_ERROR",
## "errors": [
## {
## "field": "email",
"message": "Email tidak valid"
## }
## ]
## }
## 2.4 Status Code
200: sukses read/update/delete.
201: sukses create.
400: request tidak valid.
401: token tidak ada/tidak valid.
403: tidak punya akses.
404: data tidak ditemukan.
409: konflik data (mis. email sudah dipakai).
500: server error.
- Model Otorisasi (Wajib)
## 3.1 User Role
author
personel
guest
3.2 Personnel Level (PL)
## Level 0..7.
## L7 = Full Authority.
Threshold restricted content default: L3.

## 3.3 Track
executive
field
mechanic
logistics
## 3.4 Rule Akses Utama
- L7: akses penuh seluruh modul.
- L6 executive: full author panel + moderasi diskusi.
- L6 field: edit lore places dan creatures, plus gallery milik sendiri.
- L6 mechanic: edit projects dan technology, plus gallery milik sendiri.
- L6 logistics: hanya gallery milik sendiri.
- L0-L5: read-only (sesuai batas restricted block).
- Personnel management: hanya L7.
- News write (create/update/delete): hanya L7 atau L6 executive.
3.5 Restricted Block (Lore)
Backend harus mendukung konten yang berisi marker:
## [L3+] ... [/L3+]
[L5+ track=field] ... [/L5+]
Frontend akan parsing marker, tetapi backend tetap harus menyimpan fullDesc apa adanya agar rule tidak rusak.
- Route Aplikasi ke Kebutuhan Endpoint
- /auth -> auth endpoints.
- /home -> summary projects/news/characters/settings.
- /projects, /projects/:id -> projects endpoints.
- /gallery, /gallery/:id -> gallery endpoints + comments/replies.
- /lore, /lore/:category, detail lore -> lore endpoints per domain.
- /maps -> map markers + map image endpoint.
- /author -> seluruh endpoint CRUD dengan guard otorisasi.
- /personnel -> personnel endpoint (L7 only).
- /settings -> settings endpoint per user.
## 4.1 Author Panel Access Matrix
Author panel adalah surface CRUD internal yang dipakai frontend untuk mengelola data konten. Backend harus membedakan akses berdasarkan
level dan track.
- L7 -> akses penuh ke semua section, termasuk moderasi diskusi dan seluruh CRUD.
- L6 executive -> akses penuh ke author panel, plus moderasi diskusi lintas user.
- L6 field -> dapat masuk panel untuk lore/places, lore/creatures, dan gallery milik sendiri.
- L6 mechanic -> dapat masuk panel untuk projects, lore/technology, dan gallery milik sendiri.
- L6 logistics -> hanya dapat masuk panel untuk gallery milik sendiri.
- L0-L5 -> tidak memiliki akses write ke author panel.
- News section -> hanya L7 atau L6 executive.
## Catatan:

- Gallery write access tetap harus diverifikasi dengan ownership uploadedBy di backend.
- Untuk edit/delete komentar diskusi, aturan moderator mengikuti section 5.8 dan 5.13.
- Jika UI mengirim request ke section yang tidak sesuai track, backend harus menolak dengan 403.
## 5. Daftar Endpoint Lengkap
## 5.1 Authentication
POST /api/auth/login
## Body:
## {
## "email": "user@morneven.com",
## "password": "secret123"
## }
Response data:
## {
## "token": "jwt-token",
"refreshToken": "optional-refresh-token",
## "user": {
## "id": "psn-001",
"username": "Mikyl",
## "email": "user@morneven.com",
## "role": "personel",
## "level": 2,
## "track": "executive",
"note": "Optional"
## }
## }
POST /api/auth/register
## Body:
## {
## "email": "new@morneven.com",
## "password": "secret123",
"username": "NewUser"
## }
## Rule:
default role: personel
default level: 2
default track: executive
GET /api/auth/me
## Header: Authorization: Bearer <token>

Response data: object user aktif.
POST /api/auth/logout
Invalidasi refresh token/session.
POST /api/auth/validate-token
Cek token valid/tidak untuk rehydrate session frontend.
## 5.2 Projects
GET /api/projects
Query opsional: status, search, page, limit, sort.
GET /api/projects/:id
POST /api/projects
Akses: L7 atau L6 mechanic/executive.
PUT /api/projects/:id
DELETE /api/projects/:id
## 5.3 Lore - Characters
GET /api/lore/characters
GET /api/lore/characters/:id
POST /api/lore/characters
PUT /api/lore/characters/:id
DELETE /api/lore/characters/:id
Rule edit: L7 atau L6 executive.
## 5.4 Lore - Places
GET /api/lore/places
GET /api/lore/places/:id
POST /api/lore/places

PUT /api/lore/places/:id
DELETE /api/lore/places/:id
Rule edit: L7 atau L6 field.
## 5.5 Lore - Technology
GET /api/lore/technology
GET /api/lore/technology/:id
POST /api/lore/technology
PUT /api/lore/technology/:id
DELETE /api/lore/technology/:id
Rule edit: L7 atau L6 mechanic.
## 5.6 Lore - Creatures
GET /api/lore/creatures
GET /api/lore/creatures/:id
POST /api/lore/creatures
PUT /api/lore/creatures/:id
DELETE /api/lore/creatures/:id
Rule edit: L7 atau L6 field.
## 5.7 Lore - Other
GET /api/lore/other
GET /api/lore/other/:id
POST /api/lore/other
PUT /api/lore/other/:id
DELETE /api/lore/other/:id
Rule edit: L7 atau L6 executive.

## 5.8 Gallery
GET /api/gallery
Query opsional: type=image|video, tag, search, page, limit.
GET /api/gallery/:id
POST /api/gallery
PUT /api/gallery/:id
DELETE /api/gallery/:id
## Rule:
- Create: minimum L6 semua track.
- Update/Delete: L7 atau owner (uploadedBy sama dengan username user aktif).
- Guest tidak boleh create/update/delete.
POST /api/gallery/:id/comments
## Body:
## {
"text": "Komentar",
"mentions": ["Mikyl", "Admin"]
## }
author diambil dari token server-side, bukan dari body.
POST /api/gallery/:id/comments/:commentId/replies
Body sama seperti comments.
PUT /api/gallery/:id/comments/:commentId
DELETE /api/gallery/:id/comments/:commentId
PUT /api/gallery/:id/comments/:commentId/replies/:replyId
DELETE /api/gallery/:id/comments/:commentId/replies/:replyId
Rule moderasi:
Pemilik komentar boleh edit/delete miliknya.
L6 executive atau L7 boleh moderasi komentar siapa pun.
## 5.9 Map
GET /api/map/markers

PUT /api/map/markers
PUT hanya L7.
GET /api/map/image
PUT /api/map/image
PUT hanya L7.
## 5.10 Personnel
GET /api/personnel
GET /api/personnel/:id
POST /api/personnel
PUT /api/personnel/:id
DELETE /api/personnel/:id
PATCH /api/personnel/bulk
Semua endpoint personnel hanya L7.
Rule tambahan:
- Tidak boleh promote via UI ke L7 sembarang user tanpa policy internal.
- Disarankan blok edit/delete akun L7 lain kecuali super-admin policy.
## 5.11 Settings
GET /api/settings/command-center
PUT /api/settings/command-center
Scope per user (berdasarkan user id dari token).
## 5.11.1 Command Center Settings
Frontend memakai satu payload setting per user untuk mengontrol konten yang tampil di halaman /home.

interface CommandCenterSettings {
showStats: boolean;
showProjects: boolean;
showNews: boolean;
showCharacters: boolean;
showPlaces: boolean;
showTechnology: boolean;
showGallery: boolean;
showQuickActions: boolean;
welcomeMessage: string;
itemLimits: {
projects: number;
news: number;
characters: number;
places: number;
technology: number;
gallery: number;
## };
manualSelections: {
projects: string[];
news: string[];
characters: string[];
places: string[];
technology: string[];
gallery: string[];
## };
## }
Default value:

## {
"showStats": true,
"showProjects": true,
"showNews": true,
"showCharacters": true,
"showPlaces": true,
"showTechnology": true,
"showGallery": true,
"showQuickActions": true,
"welcomeMessage": "Here's your operational overview.",
"itemLimits": {
## "projects": 5,
## "news": 6,
## "characters": 3,
## "places": 3,
## "technology": 3,
## "gallery": 4
## },
"manualSelections": {
## "projects": [],
## "news": [],
## "characters": [],
## "places": [],
## "technology": [],
## "gallery": []
## }
## }
Rule penting:
- Settings harus di-scope per user, bukan global.
- Update settings tidak boleh memodifikasi user lain.
- Jika backend mengubah settings, response harus mengembalikan object setting final yang sudah tersimpan.
- Frontend saat ini mengharapkan perubahan settings bisa dipakai segera di Command Center/HomePage setelah reload atau rehydrate
session.
- Untuk migrasi dari localStorage, gunakan key referensi morneven_cc_settings sebagai mapping awal.
## 5.12 News
GET /api/news
GET /api/news/:id
POST /api/news
PUT /api/news/:id
DELETE /api/news/:id
Write operation: L7 atau L6 executive.

5.12.1 News Payload (Updated)
Frontend saat ini memakai field berikut:
interface NewsAttachment {
type: "image" | "video" | "link";
url: string;
caption?: string;
## }
interface NewsItem {
id: string;
text: string;
date: string; // YYYY-MM-DD
hasDetail?: boolean;
thumbnail?: string;
body?: string;
attachments?: NewsAttachment[];
## }
## Rule:
- Jika hasDetail !== true, body, thumbnail, dan attachments boleh kosong.
- Jika hasDetail === true, backend wajib menerima dan menyimpan body (opsional untuk legacy data lama).
- attachments[].type wajib salah satu image|video|link.
## 5.13 Discussion Management
Discussion dipakai lintas entity lore dan disimpan sebagai field discussions pada object entity. Entity aktif:
places|technology|other|characters|creatures. Gallery menggunakan endpoint komentar terpisah pada section 5.8.
GET /api/discussions/:entityType/:entityId
entityType: places|technology|other|characters|creatures
Response: list discussion thread milik entity.
POST /api/discussions/:entityType/:entityId/comments
## Body:
## {
"text": "Status perimeter aman @j.huang",
## "mentions": [
## { "username": "j.huang", "start": 22, "end": 30 }
## ]
## }
author diambil dari token server-side.
POST /api/discussions/:entityType/:entityId/comments/:commentId/replies
Body sama dengan create comment.

PATCH /api/discussions/:entityType/:entityId/comments/:commentId
DELETE /api/discussions/:entityType/:entityId/comments/:commentId
## PATCH
/api/discussions/:entityType/:entityId/comments/:commentId/replies/:replyId
## DELETE
/api/discussions/:entityType/:entityId/comments/:commentId/replies/:replyId
Rule akses:
- Guest tidak boleh create/edit/delete.
- Pemilik comment/reply boleh edit/delete miliknya.
- Moderator (L6 executive atau L7) boleh moderasi lintas user.
Catatan implementasi:
- Untuk kompatibilitas frontend saat ini, backend boleh mengembalikan payload entity lengkap yang sudah berisi field discussions.
- Bila memakai endpoint /api/discussions/*, sinkronisasi tetap harus menulis ke field discussions pada entity terkait.
- Variabel Data yang Diperlukan
## 6.1 Project
interface Project {
id: string;
title: string;
status: "Planning" | "On Progress" | "On Hold" | "Completed" | "Canceled";
thumbnail: string;
shortDesc: string;
fullDesc: string;
patches: {
version: string;
date: string; // YYYY-MM-DD
notes: string;
## }[];
docs: {
type: "image" | "video";
url: string;
caption: string;
## }[];
## }
## 6.2 Character

interface Character {
id: string;
name: string;
race: string;
occupation?: string;
height: string;
traits: string[];
likes: string[];
dislikes: string[];
accentColor: string;
thumbnail: string;
shortDesc: string;
fullDesc: string;
stats: {
combat: number;
intelligence: number;
stealth: number;
charisma: number;
endurance: number;
## };
docs: { type: "image" | "video"; url: string; caption: string }[];
contributions?: { id: string; title: string; description: string; date?: string }[];
discussions?: DiscussionComment[];
## }
## 6.3 Place
interface Place {
id: string;
name: string;
type: string;
thumbnail: string;
shortDesc: string;
fullDesc: string;
docs: { type: "image" | "video"; url: string; caption: string }[];
discussions?: DiscussionComment[];
## }
## 6.4 Technology
interface Technology {
id: string;
name: string;
category: string;
thumbnail: string;
shortDesc: string;
fullDesc: string;
docs: { type: "image" | "video"; url: string; caption: string }[];
discussions?: DiscussionComment[];
## }

## 6.5 Creature
interface Creature {
id: string;
name: string;
classification: "Amorphous" | "Crystalline" | "Metamorphic" | "Catalyst" | "Singularity" | "Zero-State";
dangerLevel: 1 | 2 | 3 | 4 | 5;
habitat: string;
thumbnail: string;
accentColor: string;
shortDesc: string;
fullDesc: string;
docs: { type: "image" | "video"; url: string; caption: string }[];
discussions?: DiscussionComment[];
## }
## 6.6 Other Lore
interface OtherLore {
id: string;
title: string;
category: string;
thumbnail: string;
shortDesc: string;
fullDesc: string;
docs: { type: "image" | "video"; url: string; caption: string }[];
discussions?: DiscussionComment[];
## }
## 6.7 Gallery

interface GalleryItem {
id: string;
type: "image" | "video";
title: string;
thumbnail: string;
videoUrl?: string;
caption: string;
tags: string[];
date: string;
uploadedBy?: string;
comments: {
id: string;
author: string;
text: string;
date: string;
mentions?: { username: string; start: number; end: number }[];
replies: { id: string; author: string; text: string; date: string }[];
## }[];
## }
6.7.1 Discussion (Generic)
interface DiscussionMention {
username: string;
start: number;
end: number;
## }
interface DiscussionReply {
id: string;
author: string;
text: string;
date: string;
mentions?: DiscussionMention[];
## }
interface DiscussionComment {
id: string;
author: string;
text: string;
date: string;
mentions?: DiscussionMention[];
replies: DiscussionReply[];
## }
Untuk entity lore, gunakan field discussions pada object entity.
## 6.8 Map Marker

interface MapMarker {
id: string;
name: string;
status: "safe" | "caution" | "danger" | "restricted" | "mission";
x: number; // normalized 0..1
y: number; // normalized 0..1
description: string;
loreLink?: string;
## }
## 6.9 Personnel
interface PersonnelUser {
id: string;
username: string;
email: string;
role: "author" | "personel" | "guest";
level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
track: "executive" | "field" | "mechanic" | "logistics";
note?: string;
updatedAt?: string;
## }
## 6.10 Command Center Settings

interface CommandCenterSettings {
showStats: boolean;
showProjects: boolean;
showNews: boolean;
showCharacters: boolean;
showPlaces: boolean;
showTechnology: boolean;
showGallery: boolean;
showQuickActions: boolean;
welcomeMessage: string;
itemLimits: {
projects: number;
news: number;
characters: number;
places: number;
technology: number;
gallery: number;
## };
manualSelections: {
projects: string[];
news: string[];
characters: string[];
places: string[];
technology: string[];
gallery: string[];
## };
## }
## 7. Validasi Wajib
- Email format valid.
- Password minimal 6 karakter.
- Username minimal 3 karakter.
- level hanya 0..7.
- track hanya executive|field|mechanic|logistics.
- dangerLevel creature hanya 1..5.
- type media hanya image|video.
- x dan y map marker harus di rentang 0..1.
- status project dan map harus sesuai enum.
- Validasi mention index (start < end, range valid terhadap panjang text).
- Validasi mentions[].username harus ada di personnel registry.
- NewsAttachment.type hanya image|video|link.
- Untuk manualSelections, setiap ID harus ada di collection section terkait.
- Untuk itemLimits, nilai harus bilangan bulat >= 0.
## 8. Logika Bisnis Penting
- uploadedBy pada gallery wajib diisi dari user token saat create.
- Ownership gallery divalidasi backend (jangan hanya frontend).
- author komentar/reply diambil dari token, bukan request body.
- Bulk personnel update hanya mengubah field yang dikirim.

- Semua write endpoint wajib audit trail minimal: updatedAt, updatedBy (disarankan).
- Gunakan soft-delete jika dibutuhkan histori moderation.
- Pairing discussion wajib berbasis entityType + entityId agar tidak tercampur antar konten.
- Role author tidak boleh diberikan bebas; penerbitan role ini harus mengikuti whitelist/policy internal.
- Storage dan Migrasi
Frontend saat ini memakai localStorage keys berikut (untuk referensi migrasi):
- morneven_projects
- morneven_characters
- morneven_places
- morneven_technology
- morneven_gallery
- morneven_creatures
- morneven_other
- morneven_map_markers
- morneven_map_image
- morneven_personnel
- morneven_cc_settings
- auth_state
- morneven_news
Backend harus mengganti pola ini menjadi persistence DB + API tanpa mengubah kontrak data frontend.
## 10. Saran Stack Backend
- Node.js + Express atau NestJS.
- PostgreSQL (disarankan) atau MongoDB.
- JWT access token + refresh token.
- ORM: Prisma/TypeORM.
- Validation: Zod/Joi/class-validator.
- Logging: pino/winston.
- Rate limit + CORS + helmet.
## 11. Checklist Siap Implementasi
- Definisikan schema DB sesuai section variabel.
- Implement auth + middleware RBAC (role, level, track).
- Implement semua endpoint section 5.
- Implement validasi section 7.
- Implement ownership rule gallery + moderation rule komentar.
- Buat test minimal: auth, RBAC, CRUD utama, restricted access.
Dokumen ini menjadi acuan tunggal backend. Jika ada perubahan kontrak frontend, update dokumen ini terlebih dahulu sebelum coding lanjutan.