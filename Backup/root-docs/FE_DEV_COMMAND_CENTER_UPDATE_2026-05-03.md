# FE Dev Update: Command Center Integration

Date: 2026-05-03  
Audience: Frontend Development  
Scope: Command Center API integration and settings behavior update

## Summary

Backend now provides a single aggregate endpoint for Home Command Center data:

- `GET /api/command-center`
- `GET /v1/command-center` (compatibility prefix)

This endpoint returns:

- `settings`
- `stats`
- `sections`

In the same response envelope:

```json
{
  "success": true,
  "data": {}
}
```

## Important Behavior Change

Command Center settings are now treated as **global configuration with system presets**, not per-user configuration.

What this means:

- A high-privilege user updates settings once.
- The same settings are applied to all personnel for Home rendering.
- FE should not assume each user has different Command Center settings.
- Backend uses one active preset (`isActive = true`) as source of truth for Home rendering.

## Auth

Protected endpoint. Use standard bearer token:

```http
Authorization: Bearer <token>
```

Login token source:

- `POST /api/auth/login`
- Read token from `data.token`

## Endpoint

```http
GET /api/command-center
```

Optional compatibility:

```http
GET /v1/command-center
```

## Response Contract

```json
{
  "success": true,
  "data": {
    "settings": {
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
        "projects": 5,
        "news": 6,
        "characters": 3,
        "places": 3,
        "technology": 3,
        "gallery": 4
      },
      "manualSelections": {
        "projects": [],
        "news": [],
        "characters": [],
        "places": [],
        "technology": [],
        "gallery": []
      }
    },
    "stats": {
      "totalProjects": 3,
      "activeProjects": 1,
      "totalLore": 18,
      "totalGallery": 24
    },
    "sections": {
      "projects": [],
      "news": [],
      "characters": [],
      "places": [],
      "technology": [],
      "gallery": []
    }
  }
}
```

## Section Resolution Rules

For each section:

1. If `showX` is `false`, backend returns an empty array.
2. If `manualSelections[section]` has IDs, backend returns only those IDs and preserves that exact order.
3. If manual selection is empty, backend uses `itemLimits[section]` and fallback ordering.

Fallback ordering:

- Projects: latest updated first
- News: newest publish date first
- Characters: name ascending
- Places: name ascending
- Technology: name ascending
- Gallery: newest upload date first

## Stats Definitions

- `totalProjects`: total project count
- `activeProjects`: projects with status `On Progress` (internal enum `OnProgress`)
- `totalLore`: count across lore categories in `loreItem`
- `totalGallery`: total gallery item count

All stats fields are numbers and never `null`.

## Settings Endpoints

Global settings and preset management are exposed via:

- `GET /api/settings/command-center`  
  Read active preset content only (resolved settings for Home).

- `PUT /api/settings/command-center`  
  Update active preset content.

- `GET /api/settings/command-center/defaults`  
  Read backend default template.

- `GET /api/settings/command-center/presets`  
  List all system presets.

- `POST /api/settings/command-center/presets`  
  Create preset.

- `PUT /api/settings/command-center/presets/:id`  
  Update preset metadata and/or setting content.

- `DELETE /api/settings/command-center/presets/:id`  
  Delete preset (cannot delete active preset).

- `POST /api/settings/command-center/presets/:id/activate`  
  Activate selected preset globally.

Compatibility prefix also available:

- `/v1/settings/...`

### Preset list item shape

`GET /api/settings/command-center/presets` returns:

```json
{
  "success": true,
  "data": [
    {
      "id": "preset-id",
      "presetKey": "default",
      "presetName": "Default System Preset",
      "isActive": true,
      "updatedBy": "admin.username",
      "updatedAt": "2026-05-03T10:30:00.000Z",
      "createdAt": "2026-05-03T09:00:00.000Z"
    }
  ]
}
```

### Create preset payload

```json
{
  "presetKey": "ops-night-shift",
  "presetName": "Ops Night Shift",
  "settings": {
    "showNews": true,
    "itemLimits": {
      "projects": 8
    }
  }
}
```

### Update preset payload

All fields optional:

```json
{
  "presetName": "Ops Night Shift v2",
  "settings": {
    "showGallery": false
  }
}
```

Update permission remains restricted:

- `author`, or
- level `7`, or
- level `6` with track `executive`

Delete rule:

- Active preset cannot be deleted (`409 CONFLICT`).
- Activate another preset first, then delete old preset.

## Legacy Endpoint

`GET /api/content-stats` still exists for compatibility, but FE Home should prefer:

- `GET /api/command-center`

## FE Integration Notes

- Use base URL: `https://backend.dev.morneven.com`
- Use one Home request: `/api/command-center`
- Keep existing auth header format
- Do not fan out Home stats or section fetches to multiple endpoints unless fallback is explicitly needed
- For Settings UI, treat Command Center settings as global system presets, not per-user preference state
