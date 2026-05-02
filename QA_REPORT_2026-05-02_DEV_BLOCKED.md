# Morneven Backend Development QA Report

## Summary

| Field | Value |
| --- | --- |
| Test date | 2026-05-02 |
| Timezone | Asia/Singapore |
| Target environment | Development |
| Base URL | `https://morneven-backend-development.up.railway.app` |
| API prefix | `/api` |
| QA scope requested | Full endpoint QA, including mutation and destructive testing against development only |
| Execution status | Blocked |
| Overall result | Not executed due to network connectivity failure from the QA runtime |

## Blocker

The QA runtime could resolve the development Railway hostname, but it could not open a TCP connection to port `443`. Because the failure occurred before receiving any HTTP response, no endpoint behavior can be marked as passed or failed.

This is treated as an environment/connectivity blocker, not an API defect.

## Connectivity Evidence

### Health Check Attempt

Request:

```http
GET https://morneven-backend-development.up.railway.app/health
```

Result:

```txt
ERROR Unable to connect to the remote server
```

### DNS Resolution

Command:

```powershell
Resolve-DnsName morneven-backend-development.up.railway.app
```

Result:

```txt
morneven-backend-development.up.railway.app AAAA fd00:aa:bb:2140::9765:20f
morneven-backend-development.up.railway.app A    151.101.2.15
```

### TCP Connectivity

Command:

```powershell
Test-NetConnection morneven-backend-development.up.railway.app -Port 443 -InformationLevel Detailed
```

Result:

```txt
PingSucceeded: True
TcpTestSucceeded: False
RemoteAddress: 151.101.2.15
RemotePort: 443
```

### Curl Verification

Command:

```powershell
curl.exe -v --max-time 20 https://morneven-backend-development.up.railway.app/health
```

Result:

```txt
Host morneven-backend-development.up.railway.app:443 was resolved.
IPv4: 151.101.2.15
Trying 151.101.2.15:443...
connect to 151.101.2.15 port 443 failed: Bad access
Failed to connect to morneven-backend-development.up.railway.app port 443
curl: (7) Failed to connect to morneven-backend-development.up.railway.app port 443
```

### Production Control Check

Request:

```http
GET https://morneven-backend-production.up.railway.app/health
```

Result:

```txt
ERROR Unable to connect to the remote server
```

The same failure pattern against production suggests the issue is outbound HTTPS connectivity from the QA runtime to Railway-hosted endpoints, not necessarily a development deployment outage.

## Test Suites Not Executed

The following suites were not executed because the runtime could not establish HTTPS connectivity:

| Suite | Status | Notes |
| --- | --- | --- |
| Health and readiness | Blocked | No HTTP response received |
| Authentication | Blocked | Login could not be attempted |
| Token validation and current user | Blocked | Requires login token |
| Read-only list endpoints | Blocked | Requires HTTPS connectivity and auth for protected endpoints |
| RBAC and permission checks | Blocked | Requires multiple successful logins |
| Project CRUD | Blocked | Mutation tests require auth |
| News CRUD | Blocked | Mutation tests require auth |
| Lore CRUD | Blocked | Mutation tests require auth |
| Gallery CRUD and discussions | Blocked | Mutation tests require auth |
| Chat DM, group, invite, and reconcile flows | Blocked | Requires auth and dynamic IDs |
| Personnel mutation and destructive tests | Blocked | Requires privileged auth |
| Management request and decision workflow | Blocked | Requires privileged auth |
| Notifications workflow | Blocked | Requires auth |
| Map global-state update and rollback | Blocked | Requires privileged auth and pre-read backup |
| Settings update and rollback | Blocked | Requires privileged auth and pre-read backup |
| File upload | Blocked | Requires auth and multipart request |
| Extraction job | Blocked | Requires explicit approval and auth |
| Cleanup verification | Blocked | No QA-owned records were created |

## Data Mutation Status

No mutation or destructive operation was executed.

No QA-owned records were created.

No cleanup was required.

## Risk Assessment

| Risk | Impact |
| --- | --- |
| QA runtime cannot access Railway HTTPS endpoints | Full endpoint QA cannot be executed from this session |
| No HTTP response received | API health cannot be assessed from this evidence |
| Mutation tests not started | No risk of development data corruption from this run |

## Recommended Next Steps

1. Run the same preflight commands from a machine or CI runner with outbound HTTPS access to Railway.
2. If the endpoint is accessible outside this runtime, re-run the full QA suite from that environment.
3. If it is not accessible anywhere, check Railway deployment status, custom networking rules, and whether the development service is sleeping or restricted.
4. Once connectivity is available, execute the full QA order from `QA_RAILWAY_TEST_GUIDE.md` against the development URL only.

