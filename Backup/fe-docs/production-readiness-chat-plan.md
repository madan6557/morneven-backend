# Analisis Kesiapan Production & Rencana Pengembangan Chat

## 1) Ringkasan Eksekutif

Status saat ini **belum production-ready** untuk kebutuhan enterprise karena data utama (auth, chat, personnel, management workflow) masih ditopang `localStorage` di browser, tanpa backend otoritatif, tanpa kontrol akses server-side, dan tanpa audit trail permanen.

Namun, fondasi UI/UX dan domain model sudah cukup rapi untuk ditingkatkan ke arsitektur production dengan pendekatan bertahap:

1. **Phase A (Foundational Backend)**: auth/session, users/personnel source of truth, RBAC server-side, DB migration.
2. **Phase B (Chat Core Rebuild)**: conversation membership authoritative, real-time transport, message persistence, read/delivery states.
3. **Phase C (Advanced Chat Features)**: file attachment upload, admin authority (invite/kick/promote), governance rules.
4. **Phase D (Automation Rules)**: PL7 auto-join semua grup divisi + grup institute berisi semua personel.

---

## 2) Kondisi Saat Ini (As-Is) dan Gap

### 2.1 Arsitektur data utama masih client-side

- `chatApi` menyimpan conversation + message di `localStorage`. Ini cocok untuk demo/prototype, **tidak cocok** untuk production multi-device. 
- `personnelApi` juga membaca/menulis personnel dari `localStorage` (dengan seed JSON).
- Auth state (`AuthContext`) disimpan di `localStorage` tanpa token/session backend.

**Dampak production:**
- Tidak ada source of truth terpusat.
- Konflik data antar-device/browser tidak bisa diselesaikan dengan benar.
- Integritas data dan akses tidak bisa dijamin.

### 2.2 Chat feature coverage saat ini

Sudah ada:
- DM, manual group, auto group team/division.
- Institute-wide channel (`Institute · All Personnel`) dengan auto-membership.
- Push notifikasi in-app saat kirim pesan.
- Subscription event browser (`storage` + custom event).
- Group roles (`owner/admin/member`) dan moderation delete.
- Invite flow + accept/reject + kick/leave + promote/demote.
- Reply preview snapshot + attachment preview/download (demo data URL).
- Mobile-safe conversation auto-scroll (kirim/open/jump) dan bubble alignment kanan/kiri sesuai pengirim.
- Seed sample history institute + bootstrap read/unread campuran untuk QA unread auto-scroll.

Belum ada (kritikal production):
- File attachment upload production-grade (presigned + malware scan + retention policy).
- Advanced moderation controls (mute/ban/global policy).
- Server-side authorization.
- Message edit/delete policy, read receipts, pagination skala besar.

### 2.3 Kebutuhan spesifik dari request user

Permintaan tambahan:
1. attachment upload,
2. admin authority,
3. kick,
4. invite,
5. **PL7 otomatis masuk semua grup divisi**,
6. **grup institute berisi semua personel**.

Saat ini auto-sync team/division + institute sudah ada di FE demo layer, termasuk aturan PL7 auto-join all division. Gap tersisa adalah menjadikan aturan tersebut authoritative di backend production.

---

## 3) BE Requirements (Jelas & Detail)

## 3.1 Non-Functional Requirements (NFR)

- **Availability**: target 99.9%.
- **Latency**: send message p95 < 300ms (tanpa attachment), p95 < 800ms (dengan attachment metadata).
- **Scalability**: minimal 5.000 concurrent sockets (fase awal).
- **Security**: TLS end-to-end transport, signed JWT/session, server-side RBAC, upload malware scanning.
- **Auditability**: seluruh admin action tersimpan immutable audit log.
- **Recovery**: backup DB harian + point-in-time restore.

## 3.2 Domain model minimum (DB)

### Core identity
- `users(id, username, email, role, personnel_level, track, status, created_at, updated_at)`
- `sessions(id, user_id, token_hash, expires_at, revoked_at)`

### Chat
- `conversations(id, kind, name, created_by, created_at, updated_at, is_system_managed)`
  - `kind`: `dm | group | team | division | institute`
- `conversation_members(conversation_id, user_id, role, joined_at, invited_by, status)`
  - `role`: `owner | admin | member`
  - `status`: `active | invited | removed`
- `messages(id, conversation_id, sender_id, body, type, created_at, edited_at, deleted_at)`
  - `type`: `text | file | system`
- `message_attachments(id, message_id, storage_key, file_name, mime_type, file_size, checksum, scan_status)`
- `conversation_invites(id, conversation_id, inviter_id, invitee_id, status, created_at, responded_at)`
- `conversation_kicks(id, conversation_id, target_user_id, actor_user_id, reason, created_at)`

### Governance & audit
- `audit_logs(id, actor_id, action, resource_type, resource_id, payload_json, created_at)`

## 3.3 Authorization rules (server-side wajib)

- **Create group**: minimal authenticated user, policy configurable.
- **Invite member**: owner/admin.
- **Kick member**: owner/admin, dengan constraint: admin tidak bisa kick owner.
- **Promote/demote admin**: owner only.
- **Post message**: hanya member aktif conversation.
- **Delete message**:
  - sender bisa delete own message (soft delete),
  - admin/owner bisa moderation delete.
- **PL7 special rule**:
  - auto member semua `division` conversations,
  - auto member `institute` conversation.

## 3.4 Event-driven automations

Gunakan event bus (internal queue/topic):

- `USER_CREATED`
- `USER_LEVEL_CHANGED`
- `USER_TRACK_CHANGED`
- `CONVERSATION_CREATED`
- `PERSONNEL_SYNC_COMPLETED`

Automation handlers:
1. **PL7 Division Joiner**
   - Trigger: user menjadi PL7 atau ada division conversation baru.
   - Action: ensure membership user PL7 di semua division conversations.
2. **Institute Group Enforcer**
   - Trigger: user aktif baru / reaktif, atau institute conversation dibuat.
   - Action: ensure semua personel aktif join conversation kind `institute`.
3. **Team/Division Reconciler**
   - Trigger: perubahan team/track.
   - Action: update membership sesuai policy.

Semua handler harus **idempotent** (upsert-based).

## 3.5 API contract minimum

### Conversations
- `POST /v1/conversations` (create group/manual)
- `GET /v1/conversations?mine=true`
- `GET /v1/conversations/:id`
- `PATCH /v1/conversations/:id` (rename, settings)

### Members & authority
- `POST /v1/conversations/:id/invites`
- `POST /v1/conversations/:id/invites/:inviteId/accept`
- `POST /v1/conversations/:id/invites/:inviteId/reject`
- `DELETE /v1/conversations/:id/members/:userId` (kick/remove)
- `PATCH /v1/conversations/:id/members/:userId/role`

### Messages
- `GET /v1/conversations/:id/messages?cursor=...&limit=...`
- `POST /v1/conversations/:id/messages`
- `PATCH /v1/messages/:id`
- `DELETE /v1/messages/:id`

### Attachment flow
- `POST /v1/uploads/presign` -> signed URL
- `POST /v1/uploads/complete` -> finalize metadata + scan status init
- `GET /v1/files/:id` -> signed download URL

### Automation/admin ops
- `POST /v1/system/reconcile/division-membership`
- `POST /v1/system/reconcile/institute-membership`
- `GET /v1/audit-logs?resource=conversation&id=...`

## 3.6 Real-time transport

- WebSocket/SSE channel per user + per conversation.
- Event types minimal:
  - `message.created`, `message.updated`, `message.deleted`
  - `member.invited`, `member.joined`, `member.kicked`, `member.role_changed`
  - `conversation.updated`
- ACK/retry policy client untuk reliability.

## 3.7 Attachment security requirements

- Max file size (mis. 25 MB per file; configurable).
- Allowlist MIME type (`image/*`, `application/pdf`, docs tertentu).
- Antivirus scanning async; file status: `pending_scan | clean | blocked`.
- Signed URL expiry pendek (mis. 5 menit).
- Simpan checksum untuk dedup/integrity.

---

## 4) Rencana Pengembangan Chat (Step-by-step)

## Phase 0 — Discovery & Hardening plan (1 minggu)
- Finalisasi policy RBAC & governance matrix.
- Definisikan migration plan dari localStorage ke backend.
- Definisikan SLO, observability, alert baseline.

## Phase 1 — Backend foundation (2–3 minggu)
- Build service auth + user/personnel sync.
- Build DB schema inti (users, conversations, members, messages).
- Implement API read/write dasar + pagination.
- Integrasi frontend chat ke backend (feature flag).

**Deliverable:** chat text production-grade (tanpa attachment).

## Phase 2 — Admin authority & membership control (1–2 minggu)
- Owner/admin/member roles per group.
- Invite flow + accept/reject.
- Kick/remove flow + audit logs.
- Server-side guard seluruh endpoint.

**Deliverable:** governance group stabil.

## Phase 3 — Attachment upload (1–2 minggu)
- Presigned upload flow.
- Attachment metadata + scanning pipeline.
- Preview/download secure link.
- Quota/rate-limit per user/divisi.

**Deliverable:** file attachment aman dan terkontrol.

## Phase 4 — PL7 & Institute automation (1 minggu)
- Tambah `conversation.kind = institute`.
- Worker reconcile PL7 -> semua division groups.
- Worker reconcile institute group -> semua personel aktif.
- Tambah cron/nightly reconciliation untuk self-heal.

**Deliverable:** policy otomatis sesuai requirement organisasi.

## Phase 5 — Production readiness gate (1 minggu)
- Load test, security test, backup restore drill.
- Incident runbook + on-call checklist.
- Canary release + rollback strategy.

---

## 5) Aturan Bisnis Khusus yang Diminta

## 5.1 PL7 otomatis masuk semua grup divisi

**Rule:**
- Jika `user.level == 7`, maka user harus jadi member aktif di seluruh conversation `kind = division`.

**Trigger:**
- user naik ke PL7,
- division group baru dibuat,
- user PL7 baru dibuat/import.

**Expected behavior:**
- Tidak duplicate membership.
- Jika user PL7 sempat di-kick manual, system reconcile akan menambahkan kembali (authoritative policy).

## 5.2 Grup Institute berisi semua personel

**Rule:**
- Harus ada tepat 1 conversation `kind = institute` (mis. `Institute · All Personnel`).
- Semua personel aktif wajib jadi member.

**Trigger:**
- user aktif baru,
- user status berubah nonaktif->aktif,
- institute conversation missing.

**Expected behavior:**
- Upsert membership idempotent.
- Jika personel dinonaktifkan, member bisa soft-removed dari institute.

---

## 6) Risiko Utama & Mitigasi

1. **Data inconsistency migrasi localStorage -> DB**
   - Mitigasi: one-time import script + verification checksum + dual-write sementara.
2. **Privilege escalation via client tampering**
   - Mitigasi: semua ACL dipindah ke server; client hanya display.
3. **Attachment abuse/malware**
   - Mitigasi: scan async + quarantine + MIME sniffing.
4. **Real-time reliability**
   - Mitigasi: reconnect backoff + message fetch delta on reconnect.

---

## 7) KPI keberhasilan

- Message delivery success rate > 99.9%.
- Invite/kick/admin action error rate < 0.5%.
- 100% PL7 users terdeteksi berada di semua division group (daily reconciliation report).
- 100% active personnel ada di institute group.
- P95 chat list load < 500ms.

---

## 8) Mapping dengan code saat ini

- Fondasi chat prototype sudah ada dan modular (`chatApi` + `ChatPage`).
- Fondasi sinkronisasi team/division sudah ada di workflow management.
- Fondasi role/level/track personnel sudah ada (`pl.ts`, `personnelApi`, `AuthContext`).

Artinya, implementasi backend bisa dilakukan **tanpa redesign total UI**, cukup mengganti lapisan service + menambah state/event untuk real-time.
