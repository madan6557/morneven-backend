# Morneven Development API QA Report

## Summary

| Field | Value |
| --- | --- |
| Run ID | `QA-20260515-CODEX-STAGING-FULL` |
| Started | 2026-05-15T11:43:26.249Z |
| Ended | 2026-05-15T11:43:31.869Z |
| Base URL | `https://morneven-backend-development.up.railway.app/` |
| API prefix | `/api` |
| Scope | `full` |
| Destructive cleanup | `true` |
| Global-state tests | `true` |
| File upload tests | `true` |
| Extraction tests | `true` |

## Totals

| Status | Count |
| --- | ---: |
| PASS | 54 |
| FAIL | 5 |
| BLOCKED | 1 |
| SKIP | 3 |

## Results

| Status | Suite | Test | Method | Path | HTTP | Expected | Actual |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| PASS | Smoke | Root health endpoint | `GET` | `/health` | 200 | 200 and success true | HTTP 200 |
| PASS | Smoke | Root readiness endpoint | `GET` | `/ready` | 200 | 200 and success true | HTTP 200 |
| PASS | Smoke | API health endpoint | `GET` | `/api/health` | 200 | 200 and success true | HTTP 200 |
| PASS | Smoke | API readiness endpoint | `GET` | `/api/ready` | 200 | 200 and success true | HTTP 200 |
| PASS | Auth | Protected current user rejects missing token | `GET` | `/api/auth/me` | 401 | 401 without Authorization header | HTTP 401 message=Missing token errorCode=UNAUTHORIZED |
| PASS | Auth | Login as author | `POST` | `/api/auth/login` | 200 | 200 and access token returned | HTTP 200 |
| PASS | Auth | Current user accepts author token | `GET` | `/api/auth/me` | 200 | 200 with authenticated user | HTTP 200 |
| PASS | Smoke | Projects list | `GET` | `/api/projects?page=1&pageSize=5` | 200 | 200 and no server error | HTTP 200 |
| PASS | Smoke | News list | `GET` | `/api/news?page=1&pageSize=5` | 200 | 200 and no server error | HTTP 200 |
| PASS | Smoke | Characters lore list | `GET` | `/api/lore/characters?page=1&pageSize=5` | 200 | 200 and no server error | HTTP 200 |
| PASS | Smoke | Gallery list | `GET` | `/api/gallery?page=1&pageSize=5` | 200 | 200 and no server error | HTTP 200 |
| PASS | Smoke | Chat conversations | `GET` | `/api/chat/conversations` | 200 | 200 and no server error | HTTP 200 |
| PASS | Smoke | Navigation badges | `GET` | `/api/me/navigation-badges` | 200 | 200 and no server error | HTTP 200 |
| PASS | Smoke | Notification unread count | `GET` | `/api/notifications/unread-count` | 200 | 200 and no server error | HTTP 200 |
| PASS | Auth | Login as exec7 | `POST` | `/api/auth/login` | 200 | 200 and access token returned | HTTP 200 |
| PASS | Smoke | Management pending count with PL7 | `GET` | `/api/management/requests/pending-count` | 200 | 200 for PL7 user | HTTP 200 |
| FAIL | Auth | Login as guest | `POST` | `/api/auth/login` | 401 | 200 and access token returned | HTTP 401 message=Invalid credentials errorCode=UNAUTHORIZED |
| PASS | Auth | Login as exec6 | `POST` | `/api/auth/login` | 200 | 200 and access token returned | HTTP 200 |
| PASS | Auth | Login as field5 | `POST` | `/api/auth/login` | 200 | 200 and access token returned | HTTP 200 |
| PASS | Auth | Invalid login rejects wrong password | `POST` | `/api/auth/login` | 401 | 401 and no token | HTTP 401 message=Invalid credentials errorCode=UNAUTHORIZED |
| BLOCKED | RBAC | Guest cannot access PL7 management pending count | `GET` | `/api/management/requests/pending-count` |  | Prerequisite is available | Guest login is unavailable. |
| PASS | RBAC | Field user cannot run chat reconcile | `POST` | `/api/chat/reconcile` | 403 | 403 for PL6 non-executive or lower | HTTP 403 message=Forbidden errorCode=FORBIDDEN |
| FAIL | Chat | Executive can run chat reconcile | `POST` | `/api/chat/reconcile` | 403 | 200 for PL6 executive or PL7 user | HTTP 403 message=Forbidden errorCode=FORBIDDEN |
| PASS | Read-only functional | Project by seed ID | `GET` | `/api/projects/proj-001` | 200 | 200 expected | HTTP 200 |
| PASS | Read-only functional | News by unknown ID returns 404 | `GET` | `/api/news/unknown-QA-20260515-CODEX-STAGING-FULL` | 404 | 404 expected | HTTP 404 message=News not found errorCode=NOT_FOUND |
| PASS | Read-only functional | Lore seed character | `GET` | `/api/lore/characters/char-001` | 200 | 200 expected | HTTP 200 |
| PASS | Read-only functional | Invalid lore category | `GET` | `/api/lore/invalid-category` | 400 | 400 or 404 expected | HTTP 400 message=Unsupported lore category errorCode=BAD_REQUEST |
| PASS | Read-only functional | Gallery seed item | `GET` | `/api/gallery/gal-001` | 200 | 200 expected | HTTP 200 |
| PASS | Read-only functional | Personnel list | `GET` | `/api/personnel?page=1&pageSize=5` | 200 | 200 expected | HTTP 200 |
| PASS | Read-only functional | Management teams list | `GET` | `/api/management/teams` | 200 | 200 expected | HTTP 200 |
| PASS | Read-only functional | Management requests list | `GET` | `/api/management/requests` | 200 | 200 expected | HTTP 200 |
| PASS | Projects | Create QA project | `POST` | `/api/projects` | 201 | Project is created | HTTP 201 |
| PASS | Projects | Update QA project | `PUT` | `/api/projects/2365e500-b2f8-401a-9853-a9e60cfd0e4a` | 200 | Project is updated | HTTP 200 |
| PASS | Cleanup | Delete QA Project | `DELETE` | `/api/projects/2365e500-b2f8-401a-9853-a9e60cfd0e4a` | 200 | QA-owned record is deleted | HTTP 200 |
| PASS | News | Create QA news | `POST` | `/api/news` | 201 | News is created | HTTP 201 |
| PASS | News | Update QA news | `PUT` | `/api/news/1c70d820-ace6-41fd-bbdd-3cebcbd9c152` | 200 | News is updated | HTTP 200 |
| PASS | Cleanup | Delete QA News | `DELETE` | `/api/news/1c70d820-ace6-41fd-bbdd-3cebcbd9c152` | 200 | QA-owned record is deleted | HTTP 200 |
| PASS | Lore | Create QA character lore | `POST` | `/api/lore/characters` | 201 | Lore item is created | HTTP 201 |
| PASS | Lore | Update QA character lore | `PUT` | `/api/lore/characters/ba789bb3-4daf-4073-8db9-98171d9d328a` | 200 | Lore item is updated | HTTP 200 |
| PASS | Cleanup | Delete QA Lore character | `DELETE` | `/api/lore/characters/ba789bb3-4daf-4073-8db9-98171d9d328a` | 200 | QA-owned record is deleted | HTTP 200 |
| PASS | Gallery | Create QA gallery item | `POST` | `/api/gallery` | 201 | Gallery item is created | HTTP 201 |
| PASS | Gallery | Update QA gallery item | `PUT` | `/api/gallery/2cd77eda-d801-4b4a-aeaa-9d46a4cd9849` | 200 | Gallery item is updated | HTTP 200 |
| PASS | Gallery discussions | Create gallery comment | `POST` | `/api/gallery/2cd77eda-d801-4b4a-aeaa-9d46a4cd9849/comments` | 200 | Comment is created | HTTP 200 |
| FAIL | Gallery discussions | Create gallery reply | `POST` | `/api/gallery/2cd77eda-d801-4b4a-aeaa-9d46a4cd9849/comments/2cd77eda-d801-4b4a-aeaa-9d46a4cd9849/replies` | 404 | Reply is created | HTTP 404 message=Comment not found errorCode=NOT_FOUND |
| FAIL | Cleanup | Delete QA Gallery comment | `DELETE` | `/api/gallery/2cd77eda-d801-4b4a-aeaa-9d46a4cd9849/comments/2cd77eda-d801-4b4a-aeaa-9d46a4cd9849` | 404 | QA-owned record is deleted | HTTP 404 message=Not found errorCode=NOT_FOUND |
| PASS | Cleanup | Delete QA Gallery item | `DELETE` | `/api/gallery/2cd77eda-d801-4b4a-aeaa-9d46a4cd9849` | 200 | QA-owned record is deleted | HTTP 200 |
| PASS | Chat | Send message to institute conversation | `POST` | `/api/chat/messages` | 201 | Message is created | HTTP 201 |
| PASS | Cleanup | Delete QA Chat message | `DELETE` | `/api/chat/messages/600ec3bd-7d88-40d4-820a-603fe3edd3d2` | 200 | QA-owned record is deleted | HTTP 200 |
| PASS | Chat | Reject empty message | `POST` | `/api/chat/messages` | 422 | Validation error for empty text and attachments | HTTP 422 message=Text or attachment is required errorCode=VALIDATION_ERROR |
| PASS | Chat | Create DM with m.varga | `POST` | `/api/chat/dm` | 201 | DM is returned or created | HTTP 201 |
| PASS | Chat | Create manual QA group | `POST` | `/api/chat/groups` | 201 | Manual group is created | HTTP 201 |
| SKIP | Cleanup | Manual group cleanup note | `N/A` | `/api/chat/conversations/f1901bc7-799a-4813-9c34-273789d427a9` |  | No hard-delete endpoint exists | Manual group left behind with QA prefix. |
| PASS | Management | Create QA management request | `POST` | `/api/management/requests` | 201 | Management request is created | HTTP 201 |
| SKIP | Cleanup | Management request cleanup note | `N/A` | `/api/management/requests/2a22e97e-5ffe-4445-88de-ade2f20acf1a` |  | No hard-delete endpoint exists | Management request left behind or decided by workflow. |
| PASS | Notifications | Create QA notification | `POST` | `/api/notifications` | 201 | Notification is created by PL7 | HTTP 201 |
| PASS | Notifications | Mark QA notification read | `POST` | `/api/notifications/08639cbd-5d95-43fa-aab7-bf80f2625e1b/read` | 200 | Notification is marked read by recipient | HTTP 200 |
| PASS | Cleanup | Delete QA Notification | `DELETE` | `/api/notifications/08639cbd-5d95-43fa-aab7-bf80f2625e1b` | 200 | QA-owned record is deleted | HTTP 200 |
| PASS | Global state | Backup current map markers | `GET` | `/api/map/markers` | 200 | Current markers can be read before update | HTTP 200 |
| PASS | Global state | Update map markers with QA marker | `PUT` | `/api/map/markers` | 200 | Map markers are updated | HTTP 200 |
| PASS | Global state | Rollback map markers | `PUT` | `/api/map/markers` | 200 | Original markers are restored | HTTP 200 |
| PASS | Files | Upload small QA file | `POST` | `/api/files/upload?folder=uploads` | 200 | Small file is uploaded | HTTP 200 |
| SKIP | Cleanup | Uploaded file cleanup note | `N/A` | `/api/files/upload` |  | No confirmed delete endpoint exists | Uploaded file may require storage cleanup outside API. |
| FAIL | Extraction | Start DB extraction job | `POST` | `/api/settings/extractions` | 422 | Extraction job is accepted | HTTP 422 message=Validation failed errorCode=VALIDATION_ERROR |
