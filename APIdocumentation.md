# Morneven Backend API Documentation

This document explains backend API usage, authentication, response formats, RBAC behavior, security behavior, and endpoint groups.

## 1. Base URL
- Development: `/api`
- Versioned base path: `/v1` (same route set as `/api`)
- Example: `http://localhost:3000/api`

## 2. Authentication
Most endpoints require Bearer token.

Access JWT now carries: `sub`, `username`, `role`, `level`, `track`.

Header format:
```http
Authorization: Bearer <access_token>
```

Optional trace header:
```http
X-Request-Id: <request_id>
```

Auth endpoints:
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/validate-token`
- `POST /auth/refresh`
- `POST /auth/guest`

### Auth validation notes (latest)
- Register payload requires:
  - `email` valid format
  - `username` length 3..30
  - `password` length 12..128
- Login payload requires:
  - valid email
  - password present (max 128)

## 3. Standard Response Format

### Success
```json
{
  "success": true,
  "message": "Optional message",
  "data": {}
}
```

### Error
```json
{
  "success": false,
  "message": "Validation failed",
  "errorCode": "VALIDATION_ERROR",
  "errors": []
}
```

### Common error codes
- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `RATE_LIMITED`
- `AUTH_RATE_LIMITED`
- `SERVICE_UNAVAILABLE`
- `INTERNAL_SERVER_ERROR`

## 4. Cara Hit Endpoint (Lengkap)

Bagian ini fokus ke langkah praktis untuk memanggil endpoint dari local/dev.

### 4.1 Prasyarat
1. Jalankan backend:
   ```bash
   npm install
   npm run prisma:generate
   npm run prisma:migrate
   npm run prisma:seed
   npm run dev
   ```
2. Pastikan service aktif di `http://localhost:3000`.
3. Gunakan base API: `http://localhost:3000/api` (atau `/v1`).

### 4.2 Quick check tanpa auth
```bash
curl -i http://localhost:3000/health
curl -i http://localhost:3000/ready
```

### 4.3 Alur auth lengkap (register -> login -> akses endpoint protected)

#### a) Register
```bash
curl -i -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "agent@example.com",
    "username": "agentuser",
    "password": "SuperSecurePass123"
  }'
```

#### b) Login
```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "agent@example.com",
    "password": "SuperSecurePass123"
  }'
```

Ambil `token` dari `data.token` di response, lalu set environment variable:
```bash
export TOKEN="<paste_token_di_sini>"
```

#### c) Hit endpoint protected
```bash
curl -i http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

### 4.4 Contoh hit endpoint per modul

#### Projects
```bash
# list
curl -i http://localhost:3000/api/projects -H "Authorization: Bearer $TOKEN"

# detail by id
curl -i http://localhost:3000/api/projects/<id> -H "Authorization: Bearer $TOKEN"

# create (role/level tertentu)
curl -i -X POST http://localhost:3000/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Project A","status":"Planning","shortDesc":"Ringkas","fullDesc":"Deskripsi lengkap","contributor":"author"}'
```

#### Lore
```bash
# list category
curl -i http://localhost:3000/api/lore/characters -H "Authorization: Bearer $TOKEN"

# detail
curl -i http://localhost:3000/api/lore/characters/<id> -H "Authorization: Bearer $TOKEN"
```

#### Gallery + Comment
```bash
# list gallery
curl -i http://localhost:3000/api/gallery -H "Authorization: Bearer $TOKEN"

# add comment
curl -i -X POST http://localhost:3000/api/gallery/<id>/comments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Keren!"}'
```

#### Map
```bash
curl -i http://localhost:3000/api/map/markers -H "Authorization: Bearer $TOKEN"
curl -i http://localhost:3000/api/map/image -H "Authorization: Bearer $TOKEN"
```

#### Personnel
```bash
curl -i http://localhost:3000/api/personnel -H "Authorization: Bearer $TOKEN"
curl -i http://localhost:3000/api/personnel/<id> -H "Authorization: Bearer $TOKEN"
```

#### Settings
```bash
curl -i http://localhost:3000/api/settings/command-center -H "Authorization: Bearer $TOKEN"
```

#### News
```bash
curl -i http://localhost:3000/api/news -H "Authorization: Bearer $TOKEN"
```

#### File upload (multipart)
```bash
curl -i -X POST "http://localhost:3000/api/files/upload?folder=gallery" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/absolute/path/to/image.png"
```

### 4.5 Menambahkan `X-Request-Id` (opsional)
```bash
curl -i http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Request-Id: debug-req-001"
```

### 4.6 Troubleshooting umum
- `401 UNAUTHORIZED`: token belum dikirim / token invalid / expired.
- `403 FORBIDDEN`: role/level tidak memenuhi RBAC endpoint write.
- `429 RATE_LIMITED` atau `AUTH_RATE_LIMITED`: terlalu banyak request di time window aktif.
- `400 VALIDATION_ERROR`: payload tidak sesuai skema (cek field wajib & tipe data).
- `503 SERVICE_UNAVAILABLE`: database belum ready (cek `/ready`).

## 5. RBAC Summary

### Role
- `author`
- `personel`
- `guest`

### Level & Track
- `level`: 0..7
- `track`: `executive`, `field`, `mechanic`, `logistics`

### Access highlights
- L7: full access.
- L6 executive: author panel write + discussion moderation + news write.
- L6 mechanic: projects + lore technology + own gallery write.
- L6 field: lore places/creatures + own gallery write.
- L6 logistics: own gallery write only.
- L0-L5: read-only on protected content modules.

## 6. Endpoint Groups

## 6.1 Health
- `GET /health`
- `GET /ready`

Sample success:
```json
{ "success": true, "data": { "status": "ok", "env": "development" } }
{ "success": true, "data": { "status": "ready" } }
```

Sample readiness failure:
```json
{ "success": false, "message": "Database not ready", "errorCode": "SERVICE_UNAVAILABLE" }
```

## 6.2 Auth
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/validate-token`
- `POST /auth/refresh`
- `POST /auth/guest`

## 6.3 Projects
- `GET /projects`
- `GET /projects/:id`
- `POST /projects`
- `PUT /projects/:id`
- `DELETE /projects/:id`

Write access: L7, or L6 executive/mechanic.

## 6.4 Lore
Category routes:
- `GET /lore/:category`
- `GET /lore/:category/:id`
- `POST /lore/:category`
- `PUT /lore/:category/:id`
- `DELETE /lore/:category/:id`

Category examples:
- `characters`
- `places`
- `technology`
- `creatures`
- `other`

## 6.5 Gallery
- `GET /gallery`
- `GET /gallery/:id`
- `POST /gallery`
- `PUT /gallery/:id`
- `DELETE /gallery/:id`

Comments & replies:
- `POST /gallery/:id/comments`
- `POST /gallery/:id/comments/:commentId/replies`
- `PUT /gallery/:id/comments/:commentId`
- `DELETE /gallery/:id/comments/:commentId`
- `PUT /gallery/:id/comments/:commentId/replies/:replyId`
- `DELETE /gallery/:id/comments/:commentId/replies/:replyId`

## 6.6 Map
- `GET /map/markers`
- `PUT /map/markers` (L7)
- `GET /map/image`
- `PUT /map/image` (L7)

## 6.7 Personnel
- `GET /personnel`
- `GET /personnel/:id`
- `POST /personnel`
- `PUT /personnel/:id`
- `DELETE /personnel/:id`
- `PATCH /personnel/bulk`

Personnel authorization:
- `GET /personnel`: PL >= 4
- `GET /personnel/:id`: PL >= 4 or self
- `POST /personnel`: PL >= 6
- `PUT /personnel/:id`: PL >= 5
- `PATCH /personnel/bulk`: PL >= 6
- `DELETE /personnel/:id`: PL >= 7

## 6.8 Settings
- `GET /settings/command-center`
- `PUT /settings/command-center`

Scope is always current token user.

## 6.9 News
- `GET /news`
- `POST /news`
- `PUT /news/:id`
- `DELETE /news/:id`

Write access: L7 or L6 executive.

## 6.10 Files (Storage Upload Handler: local/GCS)
- `POST /files/upload`

Auth required: yes (Bearer token).
Content-Type: `multipart/form-data`.
Field name: `file`.
Optional query: `folder` (string, defaults to `uploads`).

Storage behavior:
- `STORAGE_DRIVER=local` -> saved to local disk and served by `LOCAL_STORAGE_BASE_PATH`.
- `STORAGE_DRIVER=gcs` -> uploaded to GCS bucket and returned as public/object URL.

Sample response:
```json
{
  "success": true,
  "data": {
    "objectPath": "uploads/171394...-example.png",
    "provider": "local",
    "location": "storage",
    "contentType": "image/png",
    "size": 12345,
    "url": "/storage/uploads/171394...-example.png"
  }
}
```
