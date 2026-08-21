# Contract: Global Scoreboard — pins + per-viewer rank context (v2.52.0, phase A4)

Track A phase **A4** of the approved plan
(`C:\Users\mekel\.claude\plans\transient-crafting-barto.md` — read Context, the **A0 corrections
table**, and A4). Builds on A1–A3, all shipped and live.

Design source: `tmp/ArcAid UX/design_handoff_global_scoreboard/README.md` → **View 2 — Logged in**
(My Pins rail, pin hotspot, YOU row) and `API_CHANGES.md` §1–§2. `screenshots/03-target-logged-in.png`
is the visual litmus. **The handoff's backend spec has verified errors — the corrections below win.**

## Scope

**In:** the pins table + endpoints, per-viewer rank fields on the scoreboard payload, `sort=pinned`,
the My Pins rail, the per-card pin hotspot, and the "YOU" row on cards.
**Out — do not build or stub:** rank-change *alerts* (Discord DM / socket / coalescing / the new
notification type), the hero card, density toggles, the live "updated Ns ago" indicator. Those are
A5. Pins must work fully without any alerting.

## Binding corrections (verified against our code — do NOT follow the handoff here)

1. **FK column.** `global_games`' primary key is **`id`**, not `global_game_id` (`database.ts:340`).
   The handoff's `REFERENCES global_games(global_game_id)` is invalid. Use
   `REFERENCES global_games(id) ON DELETE CASCADE`, matching `database.ts:402/592/604`.
   `PRAGMA foreign_keys = ON` is enabled, and SQLite reports a bad FK at **DML time**, so getting
   this wrong fails on the first pin insert, not at migration — write a test that actually inserts.
2. **Auth on `/api/global/scoreboard`.** That route is **fully public today** (`global.ts:1271`, no
   middleware) and the client sends no token. Add **`optionalDiscordUser`** (`middleware.ts:144`) —
   never `requireAuth`/`requireDiscordUser`, which would break anonymous browsing of the page.
   The client must start sending its player token on that request when it has one.
3. **`total_matches`** — do not add. `getTopGames` already returns `total`.
4. Migration number: **124** is next free (verified — the array ends at `123_user_bans_room_index`).

## Backend

### Migration 124 — `global_game_pins`
```sql
CREATE TABLE IF NOT EXISTS global_game_pins (
  discord_user_id  TEXT NOT NULL,
  global_game_id   TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_known_rank  INTEGER,          -- seeded at pin time; A5 uses it for deltas
  last_seen_at     TEXT,
  PRIMARY KEY (discord_user_id, global_game_id),
  FOREIGN KEY (global_game_id) REFERENCES global_games(id) ON DELETE CASCADE
);
```
Plus the two indexes from the handoff. Follow the repo's inline-array migration convention.
Note `discord_user_id` holds any provider id (`google:*` too) — it's the generic identity column
name used throughout, don't add a provider column.

### Endpoints (all auth'd, `requireDiscordUser` is correct for these — they're pin-owner actions)
- `GET /api/global/pins` — the viewer's pins with enough to render the rail without a second
  round-trip: game identity + art fields, `score_count`, `top_score`, `top_player` (same entry shape
  as `top_scores`), `my_rank`, `my_score`, `rank_delta`, `pinned_at`. Order `created_at DESC`.
  `rank_delta = last_known_rank - my_rank` (**negative = improved**), `0` unchanged, `null` if no
  prior reading.
- `POST /api/global/games/:globalGameId/pin` — idempotent (already pinned → 200 no-op). Seeds
  `last_known_rank` with the viewer's current rank on that game, or NULL if they have no score.
  Returns `{ pinned: true, pin_count }`. 404 if the game doesn't exist.
- `DELETE .../pin` — idempotent, returns `{ pinned: false, pin_count }`.
- Rate-limit the write endpoints with the existing `writeLimiter`, matching sibling global writes.
- **Pins are unlimited** — no cap, no cap messaging.

### `/api/global/scoreboard` additions (only when a valid token is present)
`is_pinned: boolean`, `my_rank: number | null`, `my_score: number | null`,
`neighbors: TopScoreEntry[]` (ranks `my_rank-1 … my_rank+1`, each carrying an explicit `rank`).
Rules: `my_rank === null` → `neighbors: []`; when `my_rank <= 4` neighbors overlap `top_scores`
(fine — the client dedupes). Anonymous requests must return **exactly today's payload** — no new
keys, no nulls leaking in.

`neighbors` exists so A5's density toggle can flip client-side with no refetch. Ship it now even
though the toggle is A5 — it's the same query and splitting it would mean touching this SQL twice.

### `sort=pinned`
Pinned games first ordered `created_at DESC`, then the existing `popular` ordering for the rest.
Requires auth; **falls back to `popular` for anonymous requests** rather than erroring.

## Frontend

- **My Pins rail** (new `admin-ui/src/components/PinnedRail.tsx`), between the title block and the
  search field, logged-in only, hidden entirely when the viewer has no pins. Horizontally scrollable
  (unlimited pins), each chip: art strip, title, `#1` score + avatar, a `+` submit button, and a
  rank-delta badge (`TrendingUp` green when improved, `TrendingDown` coral when dropped, nothing at
  0/null). Trailing dashed "add" tile opens the ⌘K palette (reuse A3's open mechanism — do not
  re-implement).
- **Pin hotspot** on card art, logged-in only, top-left, `aria-pressed`. Optimistic toggle with
  revert + toast on failure. **≥44px effective touch target** via an invisible padded wrapper (the
  visual control is 22px).
- **"YOU" row** — when `my_rank` is present and outside the rendered top 6, the card appends the
  viewer's row (styled per the plan's rank→color table, `YOU` badge). Keep it simple this release:
  no break-line/neighbor logic, that's A5's density toggle.
- **Sort pills** gain `Pinned first` as the leading option, default for authenticated viewers
  (anonymous default stays `popular`).
- The scoreboard fetch must send the player token when present so the new fields populate.
- All colors via tokens — must work in light mode. No literal rgba.

## Tests

- **Migration 124 actually inserts a pin row** (proves the FK) on a fresh DB.
- Pin/unpin idempotency; `pin_count` accuracy; 404 on unknown game; unauthenticated → 401.
- Anonymous `/api/global/scoreboard` payload is byte-identical to today's shape (no `is_pinned` etc).
- Authenticated payload carries the four new fields; `neighbors` correct at rank 1, rank 4,
  no-score, and when the game has <6 scores.
- `sort=pinned` orders pinned first; anonymous `sort=pinned` degrades to `popular` without error.
- A `google:*` identity can pin (guards against any Discord-shape assumption).
- FE: rail hidden with zero pins; pin toggle is optimistic and reverts on a failed request; YOU row
  renders only when `my_rank` is outside the top 6.
- Baselines stay green: backend 804, admin-ui 168.

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (and for
any file where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD to prove re-indentation)
· **no commit/branch/push**.

## Visual verification

Extend the existing `tmp/global-scoreboard-harness.js` (do not write another). Mock a logged-in
viewer with 3+ pins and a `my_rank` outside the top 6. Capture to `tmp/global-scoreboard-shots/`:
`pins-desktop-dark.png`, `pins-desktop-light.png` (1440×900), `pins-mobile-dark.png` (390×844).
Report paths; don't judge the visuals yourself.

## Blockers policy

Anything contradicting this contract → STOP and report. Do not expand into A5 (especially: no
alerting, no notification type, no socket event).
