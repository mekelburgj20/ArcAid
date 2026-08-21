# API Changes — Global Scoreboard Redesign

Backend work needed to support the redesign. Three groups: **pins**, **per-user rank context**, and **rank-change alerts**.

Server code lives under `src/` in the repo root (Node + Express + SQLite, per `CLAUDE.md`).

---

## 1. Pins

Pins are **unlimited per user**. Keyed on the viewer's Discord identity, same auth as ratings (`Authorization: Bearer <playerToken>`).

### Schema

```sql
CREATE TABLE IF NOT EXISTS global_game_pins (
  discord_user_id  TEXT NOT NULL,
  global_game_id   TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  -- rank held by this user on this game at the time of the last alert;
  -- used to compute deltas and avoid duplicate notifications
  last_known_rank  INTEGER,
  last_seen_at     TEXT,
  PRIMARY KEY (discord_user_id, global_game_id),
  FOREIGN KEY (global_game_id) REFERENCES global_games(global_game_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pins_user ON global_game_pins(discord_user_id);
CREATE INDEX IF NOT EXISTS idx_pins_game ON global_game_pins(global_game_id);
```

### `GET /api/global/pins`

Auth required. Returns the viewer's pins with enough data to render the rail without a second round trip.

```json
{
  "pins": [
    {
      "global_game_id": "opdb-1234",
      "name": "Haunted House",
      "display_name": null,
      "manufacturer": "Gottlieb",
      "year": 1982,
      "image_url": null,
      "local_image_path": "data/catalogue-images/opdb/haunted-house.jpg",
      "wheel_image_path": null,
      "platforms": "[\"vpx\"]",
      "score_count": 6,
      "top_score": 9525852588,
      "top_player": {
        "iscored_username": "Krobs",
        "display_name": null,
        "discord_user_id": "…",
        "avatar_hash": "…",
        "score": 9525852588
      },
      "my_rank": 2,
      "my_score": 999464323,
      "rank_delta": -1,
      "pinned_at": "2026-07-20T18:03:11Z"
    }
  ]
}
```

`rank_delta` is `last_known_rank - my_rank` — **negative means improved** (moved toward #1). Return `0` when unchanged and `null` when there's no prior reading. The UI renders `TrendingUp` for negative, `TrendingDown` for positive, nothing for `0`/`null`.

Order by `pinned_at DESC`.

### `POST /api/global/games/:globalGameId/pin`

Auth required. Idempotent — pinning an already-pinned game is a no-op `200`. Seeds `last_known_rank` with the user's current rank on that game (or `NULL` if they have no score).

```json
{ "pinned": true, "pin_count": 13 }
```

### `DELETE /api/global/games/:globalGameId/pin`

Auth required. Idempotent.

```json
{ "pinned": false, "pin_count": 12 }
```

---

## 2. Per-user rank context on the scoreboard

### `GET /api/global/scoreboard` — additions

**New query param:**

| Param | Values | Notes |
|---|---|---|
| `sort` | adds `pinned` | Pinned games first (ordered by `pinned_at DESC`), then the `popular` ordering for everything else. Requires auth; falls back to `popular` for anonymous requests. |

**New per-game response fields** — only populated when the request carries a valid `playerToken`:

```ts
{
  is_pinned: boolean;
  my_rank: number | null;      // null when the viewer has no score on this game
  my_score: number | null;
  neighbors: TopScoreEntry[];  // ranks (my_rank - 1) … (my_rank + 1), inclusive
}
```

`neighbors` entries use the same shape as `top_scores` (including `origin_room_slug`, `origin_room_short_tag`, `origin_room_logo_url`, `display_name`) and each carries an explicit `rank` field.

Rules:
- When `my_rank` is `null`, return `neighbors: []`.
- When `my_rank <= 4`, `neighbors` overlaps `top_scores` — that's fine, the client dedupes and skips the break line.
- Cap `top_scores` at 6 for the grid view (down from 10) unless `layout=compact` needs fewer. The full list stays on the detail endpoint.

**Why `neighbors` matters:** shipping it lets the Top 6 / My Score toggle switch client-side with zero latency. Without it every toggle is a network round trip and the control feels broken.

### `GET /api/global/scoreboard` — search matching

Extend the existing `search` param beyond name-only matching:

- Fuzzy/prefix match on `name` and `display_name` (current behavior)
- **New:** match on `manufacturer`
- **New:** parse a 4-digit token as `year` and match it
- **New:** allow combined tokens — `"stern 1995"` should AND a manufacturer match with a year match

Return a `total_matches` count so the palette footer can render `{n} more games matched "{query}"`.

---

## 3. Rank-change alerts

Two channels: **Discord DM** (existing opt-in) and **in-app Lobby bell** (new, rides existing infrastructure).

### Trigger

When a global score is submitted and it changes the ranking of a game, for each user who has that game pinned **and** whose rank shifted:

1. Compute `old_rank` (from `global_game_pins.last_known_rank`) and `new_rank`.
2. If they differ, emit the alerts below and `UPDATE global_game_pins SET last_known_rank = new_rank, last_seen_at = datetime('now')`.
3. Never alert a user about their own submission.

Also alert pinners when a game gets a **new #1**, regardless of whether their own rank moved.

### Channel A — Lobby bell (no new infrastructure)

`admin-ui/src/pages/Lobby.tsx` already consumes a `lobby:event` socket channel and renders typed events via `components/lobby/FeedItem.tsx`. The feed already recognizes `rank_change` and `new_high_score` in its `SELF_EVENT_TYPES` set.

Emit into that existing channel:

```js
socket.to(`lobby:${roomId}`).emit('lobby:event', {
  id: <autoincrement>,
  type: 'rank_change',          // or 'new_high_score'
  source: 'system',
  icon: 'trending-down',
  title: 'You dropped to #3 on Haunted House',
  subtitle: 'Krobs posted 9,525,852,588',
  player_id: '<the pinner\'s discord id>',
  game_name: 'Haunted House',
  tournament_id: null,
  metadata: {
    global_game_id: 'opdb-1234',
    old_rank: 2,
    new_rank: 3,
    pinned: true
  },
  created_at: '<iso>'
});
```

Because `Lobby.tsx` filters out self-authored events for `SELF_EVENT_TYPES`, target these at the *pinner*, and make sure `player_id` is the pinner so the existing filter behaves correctly. Verify the filter logic — you may want pinned-game alerts to bypass the self-filter since the pinner is the intended audience, not the actor.

**Unread badge.** `PublicLayout.tsx` already tracks `lobby_last_seen_{slug}` in `localStorage` and shows a dot on the Lobby nav item. Reuse that mechanism; no new state needed.

### Channel B — Discord DM

Discord integration is already coded and opt-in. Send a DM for the same triggers, respecting the existing opt-in flag. Suggested copy:

> **Haunted House** — you're now **#3** (was #2). Krobs posted **9,525,852,588**.
> Beat it: `<link to /games/opdb-1234>`

### Rate limiting

A popular game can churn ranks rapidly. Recommendation:
- Coalesce per user per game with a **5-minute window** — one alert covering the net movement, not one per submission.
- Cap DMs at a sane daily volume per user; the Lobby bell can be more permissive since it's passive.
- No email. Explicitly out of scope — would require an external provider.

### Counter for the subhead

The logged-in subhead reads *"You have {n} new rank changes on pinned games."* Source `n` from unread `rank_change` events for that user since their `lobby_last_seen_*` timestamp. Either expose it on `GET /api/global/pins` as a top-level `unread_rank_changes` field, or reuse the existing lobby feed count endpoint.

---

## Migration checklist

- [ ] `global_game_pins` table + indexes
- [ ] `GET /api/global/pins`
- [ ] `POST` / `DELETE /api/global/games/:id/pin`
- [ ] `sort=pinned` on `/api/global/scoreboard`
- [ ] `is_pinned`, `my_rank`, `my_score`, `neighbors` on scoreboard payload (auth-gated)
- [ ] Search matching extended to manufacturer + year; `total_matches` in response
- [ ] Rank-diff computation on global score submit
- [ ] `rank_change` / `new_high_score` emission into `lobby:event`
- [ ] Discord DM on rank change (respecting existing opt-in)
- [ ] 5-minute coalescing window per user/game
- [ ] `unread_rank_changes` count exposed for the subhead
