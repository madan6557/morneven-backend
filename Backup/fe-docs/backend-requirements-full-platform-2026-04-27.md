# Backend Requirements — Full Platform (Minimum-Revision Handover)

**Product:** Morneven Institute Website  
**Date:** 2026-04-27 (UTC)  
**Audience:** Backend engineers, tech lead, QA, DevOps  
**Status:** Proposed implementation baseline (full-platform)

---

## 1) Purpose

Dokumen ini adalah kontrak implementasi backend **lintas semua fitur website**, bukan hanya chat. Tujuan utamanya: backend bisa dibangun sekali dengan perubahan FE minimal (minimum revision), sambil memberi pondasi production-ready.

> Referensi chat-only requirement lama tetap valid untuk detail chat mendalam, tetapi dokumen ini menjadi baseline arsitektur menyeluruh.

---

## 2) Product scope covered

Wajib tercakup untuk fase backend inti:

1. Authentication & session
2. Authorization (role + personnel level/track)
3. Personnel directory + profile lifecycle
4. Projects (list/detail/create/update)
5. Gallery (list/detail/create/update)
6. Lore domain (characters, places, technology, creatures, other)
7. Discussions/comments (per lore entity)
8. News (list/detail/manage)
9. Map markers & map metadata
10. Management workflows (request, approval, side effects)
11. Notifications
12. Chat (DM/group/team/division/institute + invite/kick/role + attachments)
13. Audit logs + admin observability endpoints

Out of scope fase ini:
- Voice/video chat
- E2EE
- Recommendation engine
- Full-text semantic search

---

## 3) Core architecture requirements

## 3.1 Source of truth

- Semua state business-critical harus authoritative di backend DB.
- FE tidak boleh jadi authority untuk auth, permission, membership, approval outcome.
- FE cache tetap boleh (React Query/local cache), tapi write path wajib ke API.

## 3.2 API style

- REST JSON (`/v1/*`) untuk seluruh CRUD/workflow.
- UTC ISO-8601 timestamp untuk semua datetime.
- Cursor pagination untuk list berpotensi besar (chat messages, notifications, audit, comments).
- Idempotency key untuk endpoint write kritikal (create message/request/upload finalize).

## 3.3 Eventing

- Domain event bus internal (queue/topic).
- Minimal event keys:
  - `user.created`, `user.updated`
  - `personnel.level_changed`, `personnel.track_changed`
  - `request.created`, `request.decided`
  - `discussion.created`, `discussion.updated`, `discussion.deleted`
  - `chat.*` (conversation/member/message/attachment)

---

## 4) Identity, auth, and authorization contract

## 4.1 AuthN

- Email/password (or SSO if later) dengan session/JWT backend.
- Refresh flow + revocation list.
- Session storage server-side (or token store + revocation strategy).

## 4.2 AuthZ

Gabungan policy berikut harus ditegakkan server-side:

1. **Role policy** (`author`, `personel`, `guest`, admin variants jika ada).
2. **Personnel Level (PL) policy** (`L0..L7+`).
3. **Track policy** (`executive`, `field`, `mechanic`, `logistics`).

## 4.3 Route-equivalent access policy (backend enforcement)

- Author dashboard / personnel management / management actions harus validasi privilege server-side.
- FE guard (`AuthorRoute`) dianggap UX helper saja, bukan security layer.

---

## 5) Unified domain model (minimum tables)

## 5.1 Identity & profile
- `users(id, email, username, role, status, created_at, updated_at)`
- `sessions(id, user_id, token_hash, issued_at, expires_at, revoked_at)`
- `personnel_profiles(user_id, level, track, active, metadata_json, updated_at)`

## 5.2 Content domains
- `projects(id, slug, title, summary, body_json, status, owner_id, created_at, updated_at)`
- `gallery_items(id, type, title, caption, thumbnail_url, payload_json, owner_id, created_at, updated_at)`
- `lore_entities(id, category, slug, title, content_json, created_by, updated_by, created_at, updated_at)`
- `news_items(id, slug, title, body_json, status, published_at, created_by, updated_at)`
- `map_markers(id, label, x, y, kind, data_json, created_by, updated_at)`

## 5.3 Discussions
- `discussion_threads(id, entity_type, entity_id, created_at)`
- `discussion_comments(id, thread_id, parent_id, author_id, body, mentions_json, created_at, edited_at, deleted_at)`

## 5.4 Management workflows
- `mgmt_requests(id, kind, requester_id, requester_level, requester_track, payload_json, reason, status, reviewer_id, review_note, created_at, decided_at)`
- `teams(id, name, leader_id, track, cycle_year, completed, created_at, updated_at)`
- `team_members(team_id, user_id, joined_at, removed_at)`
- `quota_records(user_id, month_key, year_key, personal_count, team_count, supervised_count, updated_at)`

## 5.5 Notifications
- `notifications(id, recipient_id, sender_id, kind, title, body, ref_type, ref_id, is_read, created_at, read_at)`

## 5.6 Chat (mandatory parity)
- `conversations(id, kind, name, created_by, is_system_managed, source_team_id, source_track, created_at, updated_at)`
- `conversation_members(id, conversation_id, user_id, role, status, invited_by, joined_at, updated_at)`
- `messages(id, conversation_id, sender_id, body, reply_to_message_id, created_at, edited_at, deleted_at)`
- `message_reply_snapshots(id, message_id, original_message_id, original_author, original_body, has_attachments, created_at)`
- `attachments(id, message_id, storage_key, file_name, mime_type, file_size, checksum_sha256, scan_status, created_at)`

## 5.7 Governance
- `audit_logs(id, actor_id, action, resource_type, resource_id, payload_json, created_at)`

---

## 6) API modules and minimum endpoint set

## 6.1 Auth
- `POST /v1/auth/login`
- `POST /v1/auth/register`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`

## 6.2 Personnel
- `GET /v1/personnel`
- `GET /v1/personnel/:id`
- `PATCH /v1/personnel/:id`
- `POST /v1/personnel/reconcile` (admin/system)

## 6.3 Projects
- `GET /v1/projects`
- `GET /v1/projects/:id`
- `POST /v1/projects`
- `PATCH /v1/projects/:id`
- `DELETE /v1/projects/:id` (soft delete optional)

## 6.4 Gallery
- `GET /v1/gallery`
- `GET /v1/gallery/:id`
- `POST /v1/gallery`
- `PATCH /v1/gallery/:id`
- `DELETE /v1/gallery/:id`

## 6.5 Lore
- `GET /v1/lore/:category`
- `GET /v1/lore/:category/:id`
- `POST /v1/lore/:category`
- `PATCH /v1/lore/:category/:id`
- `DELETE /v1/lore/:category/:id`

## 6.6 Discussions
- `GET /v1/discussions/:entityType/:entityId`
- `POST /v1/discussions/:entityType/:entityId/comments`
- `PATCH /v1/discussions/comments/:commentId`
- `DELETE /v1/discussions/comments/:commentId`

## 6.7 News
- `GET /v1/news`
- `GET /v1/news/:id`
- `POST /v1/news`
- `PATCH /v1/news/:id`
- `DELETE /v1/news/:id`

## 6.8 Maps
- `GET /v1/maps/markers`
- `POST /v1/maps/markers`
- `PATCH /v1/maps/markers/:id`
- `DELETE /v1/maps/markers/:id`
- `PATCH /v1/maps/asset` (image/meta)

## 6.9 Management workflow
- `GET /v1/management/requests`
- `POST /v1/management/requests`
- `POST /v1/management/requests/:id/decide`
- `GET /v1/management/teams`
- `POST /v1/management/teams`
- `PATCH /v1/management/teams/:id`

## 6.10 Notifications
- `GET /v1/notifications?cursor=...`
- `POST /v1/notifications` (system/admin)
- `POST /v1/notifications/:id/read`
- `POST /v1/notifications/read-all`

## 6.11 Chat
- `POST /v1/conversations`
- `GET /v1/conversations?mine=true`
- `PATCH /v1/conversations/:id`
- `POST /v1/conversations/:id/invites`
- `POST /v1/conversations/:id/invites/:inviteId/accept`
- `POST /v1/conversations/:id/invites/:inviteId/reject`
- `DELETE /v1/conversations/:id/members/:userId`
- `PATCH /v1/conversations/:id/members/:userId/role`
- `POST /v1/conversations/:id/leave`
- `GET /v1/conversations/:id/messages?cursor=...&limit=...`
- `POST /v1/conversations/:id/messages`
- `DELETE /v1/messages/:id`
- `POST /v1/uploads/presign`
- `POST /v1/uploads/complete`
- `GET /v1/files/:id`

## 6.12 Admin/Governance
- `GET /v1/audit-logs?resource=...`
- `POST /v1/system/reconcile/division-membership`
- `POST /v1/system/reconcile/institute-membership`

---

## 7) Cross-feature business rules (must be server-side)

1. User status nonaktif/suspended tidak bisa create/edit sensitive resources.
2. Privileged management decisions wajib audit log.
3. Semua side effect approval management (transfer, clearance, quota, sync team/division chat) terjadi di backend transaction/event workflow.
4. Mention data pada discussion disanitasi dan tervalidasi terhadap user existence.
5. Deletion policy:
   - content bisa soft-delete untuk auditability,
   - hard-delete dibatasi admin/system job.

---

## 8) Chat-specific mandatory automations

1. Singleton conversation `institute` wajib ada.
2. Division conversation per track wajib ada (`executive/field/mechanic/logistics`).
3. Membership rules:
   - Semua personnel aktif wajib join institute.
   - `level >= 7` wajib join semua division conversation.
   - Non-PL7 join division sesuai track aktif.
4. Rule bersifat authoritative: manual removal yang melanggar policy akan dipulihkan oleh reconciliation worker.

---

## 9) Error, validation, and compatibility contract

## 9.1 Error response shape

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You are not allowed to perform this action",
    "details": null
  }
}
```

Required error codes:
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

## 9.2 Backward-compatible evolution rules

- Tambah field response boleh, hapus/rename field wajib major version.
- Enum value baru harus documented sebelum release.
- Deprecation window minimal 1 release cycle.

---

## 10) Security and compliance requirements

1. TLS-only transport.
2. Password hashing strong (`argon2id`/`bcrypt` cost policy documented).
3. Server-side RBAC/ABAC checks di seluruh write endpoint.
4. Rate limiting untuk auth, message send, invite, upload, decision endpoints.
5. Attachment security:
   - max size default 25MB,
   - MIME allowlist,
   - malware scan async,
   - signed URL expiry short (5 min).
6. Audit log immutable untuk action kritikal (role change, request decision, moderation delete, kick/invite).

---

## 11) Performance and scalability targets

- Availability target: 99.9% monthly.
- p95 latency:
  - read list endpoint < 500ms,
  - write endpoint standar < 400ms,
  - chat send < 300ms.
- Real-time connection baseline: 5,000 concurrent.
- Background jobs (reconcile, scan) harus punya retry with dead-letter strategy.

---

## 12) Observability and operations

## 12.1 Metrics
- HTTP request count/latency/error rate per endpoint.
- Job queue lag + fail rate.
- WebSocket/SSE active connections + disconnect spikes.
- Authorization deny rate.
- Upload blocked-by-scan count.

## 12.2 Logging
- Structured logs with `requestId`, `userId`, `resourceId`, `action`.
- Correlation ID propagated to async jobs.

## 12.3 Runbooks (required before go-live)
- Auth outage
- DB restore/PITR
- Queue backlog
- WebSocket degradation
- Attachment scanning failure mode

---

## 13) Testing and acceptance matrix (minimum revision gate)

## 13.1 Contract tests
- Endpoint request/response schema validation.
- Error code consistency.

## 13.2 Authorization tests
- Positive + negative tests per privileged action.
- AuthorRoute-equivalent server guard scenarios.

## 13.3 Data consistency tests
- Concurrent write conflict handling.
- Idempotency for retried write requests.

## 13.4 End-to-end feature tests (must pass)
- Auth login/register/logout/me.
- CRUD projects, gallery, lore, news, map markers.
- Discussion create/edit/delete + replies + mentions.
- Management request create/approve/reject + side effects.
- Notifications read/unread flow.
- Chat full flow (create/invite/accept/send/reply/attachment/delete/kick/role).
- PL7 + institute membership reconciliation.

## 13.5 FE compatibility smoke test
- FE berjalan dengan backend flag ON tanpa patch besar pada page component.
- Tidak ada dependensi localStorage sebagai source of truth.

---

## 14) Delivery roadmap to minimize rework

## Phase 1 — Foundation
- Auth/session + users/personnel + shared error contract.
- Projects/gallery/lore/news/maps basic CRUD.

## Phase 2 — Collaborative layer
- Discussions + notifications + management workflow core.

## Phase 3 — Chat authority
- Chat APIs + real-time + invite/kick/role + reply snapshot + basic attachments.

## Phase 4 — Hardening
- Scan pipeline, rate limits, full audit, reconciliation workers, load/security tests.

Gate per phase wajib punya signed acceptance dari FE + QA + BE lead.

---

## 15) Definition of done (full-platform)

Backend dianggap handover-complete bila:

1. Semua endpoint minimum di Section 6 tersedia dan teruji.
2. Semua business rule lintas fitur di Section 7–8 enforced server-side.
3. Audit log + observability + runbook tersedia (Section 12).
4. E2E acceptance matrix (Section 13) lulus.
5. FE demo flow seluruh halaman utama berjalan tanpa revisi arsitektur besar.

