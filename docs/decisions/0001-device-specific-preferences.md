---
status: accepted
date: 2026-04-12
deciders: Justin Mekelburg
supersedes:
superseded-by:
---

# Device-specific scoreboard preferences stored as nested JSON

## Context

Users view scoreboards on both desktop and mobile devices. Display preferences that work well on desktop (e.g., 2-column layout, large zoom, horizontal scroll) are often wrong for mobile, and vice versa. The original implementation stored preferences as a flat JSON blob in `user_preferences.scoreboard_prefs` with no device distinction — a user changing settings on their phone would overwrite their desktop preferences.

We needed a way to let users maintain independent preference sets per device type without adding schema complexity or requiring a migration that restructures existing data.

## Decision

Store preferences as a single nested JSON object keyed by device type:

```json
{
  "desktop": { "SCOREBOARD_STYLE": "showcase", "SCOREBOARD_ZOOM": "120", ... },
  "mobile": { "SCOREBOARD_STYLE": "banner", "SCOREBOARD_ZOOM": "80", ... }
}
```

This lives in the existing `scoreboard_prefs` TEXT column on `user_preferences`. The API accepts a `?device=desktop|mobile` query parameter on `GET/POST /api/me/scoreboard-preferences`. The frontend detects device type via `window.innerWidth <= 640` and passes it with every request.

`PreferencesService.parseDevicePrefs()` handles auto-migration: if the stored JSON is a flat object (old format), it's treated as desktop preferences and wrapped in `{ desktop: oldPrefs, mobile: {} }` on next read. No explicit migration needed — the conversion happens transparently on access and persists on next save.

## Consequences

- **Easier:** Users can independently tune desktop and mobile views. No schema migration required — the column type stays TEXT. Old data migrates automatically on first access.
- **Harder:** The JSON structure is opaque to SQL queries — you can't `WHERE scoreboard_prefs LIKE '%showcase%'` and know which device it applies to. Bulk analytics on preference distribution would need application-level parsing.
- **Locked out:** Adding a third device type (e.g., `tablet`, `kiosk`) is straightforward (just add a key), but the frontend device detection logic (`<= 640px`) would need updating. The two-bucket model (desktop/mobile) is baked into the modal UI toggle.

## Alternatives Considered

- **Separate rows per device** (`discord_user_id` + `device_type` composite key) — cleaner relational model, but requires a schema migration, breaks the existing single-row-per-user assumption in `getTheme()`/`setTheme()`, and doubles the row count. Rejected for migration cost with no querying benefit (we never query prefs in bulk).
- **Separate columns** (`scoreboard_prefs_desktop`, `scoreboard_prefs_mobile`) — explicit but rigid. Adding a third device type means another column + migration. Rejected for inflexibility.
- **Client-side only** (localStorage per device) — zero backend changes, but preferences wouldn't survive browser clears or follow the user across browsers/devices of the same type. Rejected because users expected their logged-in preferences to persist.
