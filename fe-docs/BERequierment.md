# BERequierment.md

## Chat Backend Handover Specification (for BE Developer)

**Product:** Morneven Institute Website  
**Module:** Chat  
**Last updated:** 2026-04-27 (UTC)  
**Document status:** ✅ Handover-ready (implementation baseline)  
**Primary FE reference:** `src/pages/ChatPage.tsx`, `src/services/chatApi.ts`

---

## 0) Purpose of this document

This document is the **single handover contract** for backend implementation of Chat.

It defines:
1. what FE behavior must be preserved,
2. required API + DB contracts,
3. authorization rules,
4. real-time/event requirements,
5. acceptance criteria and definition of done.

If BE proposes deviations, record them in a decision log before implementation.

---

## 1) Scope

### In scope (must deliver)
- Direct Message (DM)
- Manual Group conversations
- System-managed conversations (`team`, `division`, `institute`)
- Membership invite/accept/reject
- Roles (`owner`, `admin`, `member`)
- Kick / leave / role change
- Message send/delete
- Reply snapshot support
- Attachment upload lifecycle
- Real-time updates
- PL7 and institute automation rules
- Audit logs for privileged actions

### Out of scope (this phase)
- Message edit history UI
- E2EE
- Voice/video
- Typing indicators
- Reactions

---

## 2) FE behavior parity requirements

Backend must preserve these FE-visible behaviors:

1. Conversation kinds:
   - `dm`, `group`, `team`, `division`, `institute`
2. Membership status:
   - `active`, `invited`, `removed`
3. Roles:
   - `owner`, `admin`, `member`
4. Permissions:
   - Sender delete own message
   - Owner/Admin can moderation-delete
   - Owner/Admin invite members (non-system conversations)
   - Owner-only role transfer/escalation
5. Reply preview:
   - Reply stores snapshot (author/text/hasAttachments), not live pointer only
6. System-managed constraints:
   - `team/division/institute` cannot be renamed by user-level actions
7. Message lane alignment contract (UI parity):
   - current authenticated user messages are rendered right-aligned
   - other users rendered left-aligned
8. Scroll-scope contract:
   - send/open/jump-to-reply must scroll inside conversation viewport only (not whole page), especially on mobile layout

---

## 3) Non-functional requirements (target SLO)

- Availability: **99.9%** monthly
- API p95 latency:
  - send message < 300ms
  - list conversations < 500ms
  - load messages page < 700ms
- Concurrent real-time connections: minimum **5,000**
- Data consistency: membership/role updates are strongly consistent
- Recovery: daily backup + PITR restore capability

> FE saat ini juga memiliki **demo-only institute sample history seeding** untuk kebutuhan QA unread/auto-scroll.
> Saat backend authoritative siap, behavior ini sebaiknya dipindahkan ke fixture/test seed server-side (bukan localStorage FE).

---

## 4) Canonical data model

> Suggested SQL model (PostgreSQL). Types can be adapted, semantics cannot.

### 4.1 users
- `id (uuid, pk)`
- `username (text, unique, not null)`
- `email (citext, unique, not null)`
- `status (text: active|inactive|suspended)`
- `personnel_level (int)`
- `track (text: executive|field|mechanic|logistics)`
- `created_at, updated_at`

### 4.2 conversations
- `id (uuid, pk)`
- `kind (text: dm|group|team|division|institute)`
- `name (text, not null)`
- `created_by (uuid fk users.id)`
- `is_system_managed (bool default false)`
- `source_team_id (text nullable)`
- `source_track (text nullable)`
- `created_at, updated_at`

**Indexes**
- `(kind)`
- `(source_team_id)`
- `(source_track)`

### 4.3 conversation_members
- `id (uuid, pk)`
- `conversation_id (uuid fk conversations.id)`
- `user_id (uuid fk users.id)`
- `role (text: owner|admin|member)`
- `status (text: active|invited|removed)`
- `invited_by (uuid fk users.id nullable)`
- `joined_at (timestamptz)`
- `updated_at (timestamptz)`

**Constraints / indexes**
- unique `(conversation_id, user_id)`
- index `(user_id, status)`
- index `(conversation_id, status)`

### 4.4 messages
- `id (uuid, pk)`
- `conversation_id (uuid fk conversations.id)`
- `sender_id (uuid fk users.id)`
- `body (text nullable)`
- `reply_to_message_id (uuid nullable)`
- `created_at (timestamptz)`
- `edited_at (timestamptz nullable)`
- `deleted_at (timestamptz nullable)`

**Indexes**
- `(conversation_id, created_at desc)`

### 4.5 message_reply_snapshots
- `id (uuid, pk)`
- `message_id (uuid fk messages.id unique)`
- `original_message_id (uuid)`
- `original_author (text)`
- `original_body (text)`
- `has_attachments (bool)`
- `created_at`

### 4.6 attachments
- `id (uuid, pk)`
- `message_id (uuid fk messages.id)`
- `storage_key (text)`
- `file_name (text)`
- `mime_type (text)`
- `file_size (bigint)`
- `checksum_sha256 (text)`
- `scan_status (text: pending_scan|clean|blocked)`
- `created_at`

### 4.7 audit_logs
- `id (uuid, pk)`
- `actor_id (uuid fk users.id)`
- `action (text)`
- `resource_type (text)`
- `resource_id (text)`
- `payload_json (jsonb)`
- `created_at`

---

## 5) Authorization contract (mandatory)

| Action | Who can do it | Notes |
|---|---|---|
| Create DM | Authenticated user | Ensures exactly 2 participants |
| Create group | Authenticated user | Creator becomes owner |
| Invite member | Owner/Admin | Non-system conversations only |
| Accept invite | Invitee | status invited → active |
| Reject invite | Invitee | remove pending invite |
| Kick member | Owner/Admin | Admin cannot kick admin/owner |
| Change role | Owner only | Includes transfer owner |
| Leave conversation | Active member | Owner handoff required if owner leaves |
| Rename conversation | Owner/Admin | Non-system only |
| Send message | Active member | |
| Delete own message | Sender | soft delete |
| Moderation delete | Owner/Admin | audit required |

All authorization MUST be server-side and independent from FE checks.

---

## 6) API contract (v1)

> JSON only, UTC timestamps (ISO-8601), cursor pagination.

## 6.1 Conversations

### `POST /v1/conversations`
Creates DM or group.

Request:
```json
{
  "kind": "group",
  "name": "Ops Planning",
  "memberUserIds": ["u2", "u3"]
}
```

Response `201`:
```json
{ "conversation": { "id": "c1", "kind": "group", "name": "Ops Planning" } }
```

### `GET /v1/conversations?mine=true`
Returns user-visible conversations sorted by recent activity.

### `PATCH /v1/conversations/:conversationId`
Supported patch in phase 1:
```json
{ "name": "New Group Name" }
```

## 6.2 Membership / invites
- `POST /v1/conversations/:id/invites`
- `POST /v1/conversations/:id/invites/:inviteId/accept`
- `POST /v1/conversations/:id/invites/:inviteId/reject`
- `DELETE /v1/conversations/:id/members/:userId`
- `PATCH /v1/conversations/:id/members/:userId/role`
- `POST /v1/conversations/:id/leave`

## 6.3 Messages

### `GET /v1/conversations/:id/messages?cursor=<token>&limit=30`
Response:
```json
{
  "items": [{ "id": "m1", "body": "hello", "createdAt": "2026-04-27T03:00:00Z" }],
  "nextCursor": "..."
}
```

### `POST /v1/conversations/:id/messages`
Request:
```json
{
  "body": "Need approval",
  "replyTo": {
    "messageId": "m0",
    "author": "alpha",
    "text": "previous message",
    "hasAttachments": false
  },
  "attachmentIds": ["att1"]
}
```

### `DELETE /v1/messages/:messageId`
Soft-delete message.

## 6.4 Attachments
- `POST /v1/uploads/presign`
- `POST /v1/uploads/complete`
- `GET /v1/files/:fileId`

Presign request example:
```json
{ "fileName": "report.pdf", "mimeType": "application/pdf", "size": 12345 }
```

---

## 7) Error contract (standardized)

Error format:
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You are not allowed to perform this action",
    "details": null
  }
}
```

Required codes:
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

---

## 8) Real-time contract

Transport:
- WebSocket primary (SSE fallback optional).

Minimum events:
- `conversation.created`
- `conversation.updated`
- `member.invited`
- `member.joined`
- `member.left`
- `member.kicked`
- `member.role_changed`
- `message.created`
- `message.deleted`

Event envelope:
```json
{
  "eventId": "evt-123",
  "type": "message.created",
  "occurredAt": "2026-04-27T03:05:00Z",
  "conversationId": "c1",
  "payload": {}
}
```

Rules:
- events must be idempotent by `eventId`
- ordering guaranteed per conversation

---

## 9) Automation requirements (PL7 + institute)

System rules:
1. One singleton `institute` conversation exists.
2. One `division` conversation exists per track.
3. For active personnel:
   - PL7 (level >= 7): active in **all** division conversations.
   - Non-PL7: active only in own division.
   - All active personnel: active in institute conversation.

Trigger events:
- `USER_CREATED`
- `USER_UPDATED` (level/track/status)
- `PERSONNEL_SYNC_COMPLETED`
- `CONVERSATION_CREATED` for division/institute

Implementation must be idempotent (upsert style).

---

## 10) Security requirements

1. Server-side RBAC on every mutation endpoint.
2. Signed auth session/JWT with revocation support.
3. Rate limits:
   - message send
   - invite actions
   - upload actions
4. Attachment security:
   - max file size default 25MB
   - MIME allowlist
   - malware scan async
   - short-lived signed download URL (5 min)
5. Audit mandatory for role/invite/kick/moderation actions.

---

## 11) Observability + operational handover checklist

### Metrics (must expose)
- request count + latency by endpoint
- websocket active connections
- events publish/consume lag
- authz deny rate
- upload blocked-by-scan count

### Logs
- structured logs with `requestId`, `userId`, `conversationId` where relevant

### Alerts
- p95 latency breach
- websocket disconnect spike
- queue lag > threshold
- error rate > threshold

### Runbooks required before go-live
- chat outage
- websocket degradation
- uploads scanning backlog
- DB restore + replay

---

## 12) Delivery plan and definition of done

### Phase A (Foundation)
- DB schema + migrations
- authn/authz middleware
- conversation/member/message CRUD (text)

**DoD A:** FE can run text chat entirely from backend (no localStorage dependency).

### Phase B (Realtime + governance)
- websocket event fanout
- invites/kick/role/leave flows
- audit logs

**DoD B:** FE receives real-time events for message/member changes and governance actions are enforced server-side.

### Phase C (Attachments + security)
- presign/complete/download flows
- scanning pipeline
- rate limits

**DoD C:** FE attachments work end-to-end with security controls.

### Phase D (Automation + hardening)
- PL7/institute workers
- reconciliation cron
- SLO validation + incident drills

**DoD D:** automation is stable and measurable in production-like load.

---

## 13) Final handover acceptance criteria (BE sign-off)

BE implementation is handover-complete when all are true:
1. API endpoints from Section 6 are implemented and documented.
2. Authorization matrix from Section 5 is enforced by tests.
3. Real-time events from Section 8 are emitted and consumed by FE.
4. Automation rules from Section 9 pass idempotency tests.
5. Error contract from Section 7 is consistently used.
6. Ops checklist from Section 11 is completed.
7. FE smoke test passes with backend enabled (chat send/invite/kick/role/attachment/reply).
