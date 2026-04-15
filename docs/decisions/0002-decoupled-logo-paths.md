---
status: accepted
date: 2026-04-14
deciders: Justin Mekelburg
supersedes:
superseded-by:
---

# Decoupled logo consumption paths (scoreboard vs Mystery Award)

## Context

Room admins upload a logo via Settings > Branding, which stores it at `game_rooms.logo_url` and as the `LOGO_URL` room setting. Initially, this logo was used in one place: the scoreboard header (position, max height configurable). When Mystery Award was added, the logo gained a second consumer: the backglass translite area of the picker.

Some rooms want a logo for Mystery Award's backglass but don't want it cluttering their scoreboard header. A single upload path with a single visibility toggle couldn't satisfy both use cases.

## Decision

The logo has two independent consumption paths with different gating:

1. **Scoreboard path:** `deriveScoreboardConfig()` and `deriveCardProps()` in `scoreboardConfig.ts` read `LOGO_URL` but gate it with `SCOREBOARD_LOGO_ENABLED`. When `SCOREBOARD_LOGO_ENABLED === 'false'`, they return an empty `logoUrl`, and the scoreboard renders no logo. Default is `true` (backward compatible).

2. **Mystery Award path:** `GameAvailability.tsx` resolves the room via `GET /api/rooms` and passes `room.logo_url` directly as the `backglassUrl` prop to `MysteryAward`. This bypasses scoreboard config entirely — the backglass always shows the logo if one is uploaded, regardless of the scoreboard toggle.

The toggle UI ("Show on Scoreboard") appears in Settings > Branding > Logo section only when a logo is uploaded.

### Key files

- `admin-ui/src/lib/scoreboardConfig.ts` — gated `logoUrl` derivation (lines 92, 184)
- `admin-ui/src/pages/Settings.tsx` — toggle UI + `SCOREBOARD_LOGO_ENABLED` in managed keys
- `admin-ui/src/pages/GameAvailability.tsx` — direct `room.logo_url` passthrough to MysteryAward
- `admin-ui/src/components/MysteryAward.tsx` — `backglassUrl` prop consumed in translite renderer

## Consequences

- **Easier:** Rooms can use logos for Mystery Award branding without affecting their scoreboard layout. Adding future logo consumers (e.g., Discord embeds, PDF exports) can independently decide whether to respect the scoreboard toggle or read `logo_url` directly.
- **Harder:** Two code paths to reason about when debugging "why isn't my logo showing." The toggle only affects the scoreboard; a future feature consuming `logoUrl` from scoreboard config would inherit the toggle silently.
- **Locked out:** Nothing significant. If we later need per-feature logo uploads (separate images for scoreboard vs backglass), we'd add new columns rather than overloading `logo_url`.

## Alternatives Considered

- **Single toggle on the logo itself (upload = visible everywhere)** — Rejected because the user explicitly wanted logos for Mystery Award without scoreboard display. This was the original behavior and prompted the feature request.
- **Separate upload fields (scoreboard logo vs backglass logo)** — Over-engineered for the current need. Most rooms will use the same image for both. Can be added later if demand emerges.
- **Gate in MysteryAward instead of scoreboardConfig** — Would require MysteryAward to fetch room settings, adding unnecessary API calls. The current approach keeps MysteryAward as a pure presentational component that receives data via props.
