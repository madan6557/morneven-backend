# Chat Feature Readiness Assessment

**Assessment date:** 2026-04-27 (UTC)

## Executive summary

**Overall readiness: 6/10 (demo-ready/beta-ready, not production-ready).**

The chat module has strong feature coverage for a prototype/beta (DMs, manual groups, invites, roles, moderation delete, reply previews, attachments, and auto-managed institute/division channels), but it is still architected as a browser-local system (`localStorage` + client-side auth/authorization). That creates major gaps for security, auditability, cross-device consistency, and operational scalability.

## What is already in good shape

1. **Core collaboration features are present in UI and service layer**
   - DM and manual group creation.
   - Invite/accept/reject flows.
   - Role-aware membership controls (`owner`, `admin`, `member`) including kick/leave/role changes.
   - Message send/delete and reply preview support.
   - Attachment support (client-side data URL) with size cap handling in UI.
   - Message layout parity: current user bubbles on right, other members on left.
   - Conversation-scoped auto-scroll (mobile-safe) for send/open/jump-to-reply flows.

2. **Org-policy automation is implemented**
   - Institute-wide conversation exists and is reconciled.
   - PL7 users are auto-added to all division channels.

3. **Basic event refresh mechanism exists**
   - Chat updates are propagated through browser events (`morneven:chat-changed` and `storage`) so multiple tabs refresh without polling.

## Primary blockers to production

1. **No authoritative backend for chat state**
   - Conversations/messages are stored in browser `localStorage`.
   - Any user can tamper data locally.
   - No guaranteed consistency across devices/sessions.

2. **Authorization is enforced client-side only**
   - Membership and management checks happen in frontend logic.
   - Without server checks, privileged actions are not secure.

3. **Attachment handling is demo-only**
   - Files are stored as data URLs in browser storage.
   - No presigned upload flow, malware scanning, retention policy, or secure file gateway.

4. **Missing production messaging capabilities**
   - No message pagination/cursor loading for large rooms.
   - No delivery/read states.
   - No edit-history or robust moderation policy model.

5. **Operational readiness gaps**
   - No chat-focused automated test suite yet (existing tests focus on discussions/auth/persistence elsewhere).
   - Build/lint pass, but there are still warnings (fast-refresh export patterns, hook dependency warning, large bundle chunk warning).

## Evidence snapshot

- Chat implementation uses a local-storage-backed service with browser events and role/member operations.
- UI includes invites, settings, reply, attachment previews, delete, and conversation management controls.
- Institute conversation now has seeded sample history (non-system messages from personnel accounts) to support unread/auto-scroll QA scenarios.
- Demo read bootstrap marks part of institute history as read on first open so unread indicators and oldest-unread auto-scroll are reproducible.
- Auth and personnel foundations are also local-storage backed.

## Readiness scorecard

- **Feature completeness (product):** 8/10
- **Security model:** 2/10
- **Data integrity & cross-device consistency:** 3/10
- **Scalability/performance architecture:** 4/10
- **Observability/audit/compliance:** 2/10
- **Test coverage for chat domain:** 3/10

## Recommended path to production

1. **Phase 1: Backend authority (highest priority)**
   - Move conversations/messages/membership to server DB.
   - Enforce all RBAC server-side.
   - Replace local auth state with session/JWT-based auth.

2. **Phase 2: Real-time + message lifecycle**
   - Add WebSocket/SSE events from server.
   - Add pagination and read/delivery metadata.

3. **Phase 3: Attachment hardening**
   - Presigned upload + server metadata finalization.
   - Malware scanning pipeline + signed downloads.

4. **Phase 4: Reliability + governance**
   - Add audit logs for invite/kick/role changes/moderation actions.
   - Add rate limits and abuse controls.
   - Add chat integration/unit tests for critical RBAC and membership edge cases.

## Demo readiness decision (2026-04-27)

**Ready for demo:** **Yes**.  
**Ready for production:** **No**.

The current implementation is stable for showcasing end-to-end chat flows in a single environment/session, but still lacks backend authority, security hardening, and operations controls required for production.

## Validation run (2026-04-27)

- `npm test -- --run`: pass (10/10 tests).
- `npm run lint`: pass with warnings (0 errors, 12 warnings).
- `npm run build`: pass with non-blocking warnings (Browserslist age + large chunk warning).
