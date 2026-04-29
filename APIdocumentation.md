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

## 4. RBAC Summary

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

## 5. Endpoint Groups

## 5.1 Health
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

## 5.2 Auth
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/validate-token`
- `POST /auth/refresh`
- `POST /auth/guest`

## 5.3 Projects
- `GET /projects`
- `GET /projects/:id`
- `POST /projects`
- `PUT /projects/:id`
- `DELETE /projects/:id`

Write access: L7, or L6 executive/mechanic.

## 5.4 Lore
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

## 5.5 Gallery
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

## 5.6 Map
- `GET /map/markers`
- `PUT /map/markers` (L7)
- `GET /map/image`
- `PUT /map/image` (L7)

## 5.7 Personnel
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

## 5.8 Settings
- `GET /settings/command-center`
- `PUT /settings/command-center`

Scope is always current token user.

## 5.9 News
- `GET /news`
- `POST /news`
- `PUT /news/:id`
- `DELETE /news/:id`

Write access: L7 or L6 executive.

## 5.10 Files (Storage Upload Handler: local/GCS)
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

## 6. Security Behavior
- Dedicated auth rate limiting is active for register/login/refresh endpoints.
- JWT Bearer authentication is required for protected routes.
- Global rate limit protection is active; excessive requests return `RATE_LIMITED`.
- Security headers are applied via Helmet.
- CORS is controlled via `CORS_ORIGIN` env config.
- Request payload size is capped (1 MB JSON).
- Refresh tokens are stored hashed in the database layer.

## 7. Example Usage

### Register
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@morneven.com","username":"newuser","password":"VeryStrongPass123"}'
```

### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@morneven.com","password":"VeryStrongPass123"}'
```

### Refresh
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refresh_token>"}'
```

### Access protected endpoint
```bash
curl http://localhost:3000/api/projects \
  -H "Authorization: Bearer <access_token>"
```

### Upload file (storage handler)
```bash
curl -X POST "http://localhost:3000/api/files/upload?folder=news" \
  -H "Authorization: Bearer <access_token>" \
  -F "file=@/path/to/image.png"
```

## 8. How to Use This Documentation
1. Start at **Section 5 Endpoint Groups** to identify route path + module.
2. Check **Section 4 RBAC Summary** before integrating write actions.
3. Use **Section 3 Standard Response Format** to standardize frontend API handling.
4. Use **Section 6 Security Behavior** to align gateway/WAF and client retry behavior.
5. Use **Section 7 Example Usage** as starter templates for Postman/cURL.
6. For deeper contract context, compare with `BERequierment.md`.
