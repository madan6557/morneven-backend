# Morneven Backend API Documentation

This document explains backend API usage, authentication, response formats, RBAC behavior, and endpoint groups.

## 1. Base URL
- Development: `/api`
- Example: `http://localhost:3000/api`

## 2. Authentication
Most endpoints require Bearer token.

Header format:
```http
Authorization: Bearer <access_token>
```

Auth endpoints:
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/validate-token`

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

## 5.1 Auth
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/validate-token`

## 5.2 Projects
- `GET /projects`
- `GET /projects/:id`
- `POST /projects`
- `PUT /projects/:id`
- `DELETE /projects/:id`

Write access: L7, or L6 executive/mechanic.

## 5.3 Lore
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

## 5.4 Gallery
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

## 5.5 Map
- `GET /map/markers`
- `PUT /map/markers` (L7)
- `GET /map/image`
- `PUT /map/image` (L7)

## 5.6 Personnel
- `GET /personnel`
- `GET /personnel/:id`
- `POST /personnel`
- `PUT /personnel/:id`
- `DELETE /personnel/:id`
- `PATCH /personnel/bulk`

All personnel endpoints are L7-only.

## 5.7 Settings
- `GET /settings/command-center`
- `PUT /settings/command-center`

Scope is always current token user.

## 5.8 News
- `GET /news`
- `POST /news`
- `PUT /news/:id`
- `DELETE /news/:id`

Write access: L7 or L6 executive.

## 6. Example Usage

### Register
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@morneven.com","username":"newuser","password":"secret123"}'
```

### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@morneven.com","password":"secret123"}'
```

### Access protected endpoint
```bash
curl http://localhost:3000/api/projects \
  -H "Authorization: Bearer <access_token>"
```

## 7. How to Use This Documentation
1. Start at **Section 5 Endpoint Groups** to identify route path + module.
2. Check **Section 4 RBAC Summary** before integrating write actions.
3. Use **Section 3 Standard Response Format** to standardize frontend API handling.
4. Use **Section 6 Example Usage** as starter templates for Postman/cURL.
5. For deeper context and contract source of truth, compare with `BERequierment.md`.
