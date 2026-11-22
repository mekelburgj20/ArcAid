# Arcaid Launcher API Contract Draft v1

Oct 30, 2026 · mekelburgj · DRAFT for Legends Unchained review

## Scope and rules

This is the Arcaid-owned half of the integration: how a Legends Unchained launcher or Table Manager identifies a player, pushes games, and learns which tournaments the player can join. LU owns the other half, which this document only references: what the launcher signs and with which key, the OLE stream-hash recipe for table identity, the manifest field that carries it, and key rotation.

Nothing here is built yet. Everything is proposed for v1 and shaped to match what the Arcaid server already does for the cabinet Witness and the Castcade desktop companion, so the server logic behind it (routing, entry, attempts, verification, Global fan-out) is reused as is.

Five rules hold for every endpoint:

1. **Every 200 is final.** The client never retries a 200, whatever the status inside it. Only transport failures and 5xx are retried. This is what keeps an unmatched play from becoming a retry loop.
2. **The server decides where a play lands.** The client may narrow (joined tournaments, a device designation) but never routes. A play counts in every tournament it legitimately matches.
3. **Badge, never gate.** Verification and evidence produce marks on a score row. The two exceptions are a host's explicit tournament settings (Sanctioned play, event flag mode), which act at standings time, never by refusing at ingest. Open play never refuses a play.
4. **Signed times are the truth; arrival time is irrelevant.** A game is placed in a window by its signed start and end, and a score that arrives ten minutes late still counts.
5. **v1 is frozen once agreed, then additive only.** New fields and new statuses may be added; existing ones never change meaning. Unknown fields are ignored, malformed optional fields are dropped, never a 400.

## Identity

Two keys, one token. The **application key** identifies the launcher (a client id Arcaid issues to LU once). The **player token** identifies one player on one device and is obtained with the OAuth device authorization grant (RFC 8628), the same flow Table Manager already runs against vpinratings. LU's **signing key** is separate and covers the payload, not the identity.

**1. Request a device code** (no auth beyond the client id)

```http
POST /api/oauth/device/code
Content-Type: application/json

{
  "client_id": "lu-launcher",
  "device_id": "bcf74cfb58d7…7753d0",
  "device_type": "atgames",
  "model": "HA9920",
  "model_name": "Legends Ultimate",
  "scope": "scores:submit tournaments:read tournaments:join"
}
```

```json
{
  "device_code": "3c9f…",
  "user_code": "WXR7-K4PM",
  "verification_uri": "https://arcaid.app/activate",
  "verification_uri_complete": "https://arcaid.app/activate?code=WXR7-K4PM",
  "expires_in": 600,
  "interval": 5
}
```

`device_id` is the cabinet's `ATGAMES_UNIQUE_ID` (or Table Manager's stable per-install id on desktop); `device_type` is `atgames` or `desktop`. The user code alphabet drops I, L, O, 0 and 1.

**2. The player approves.** Table Manager opens `verification_uri_complete`. The player signs in to Arcaid with Discord or Google (Arcaid has no passwords) and presses Approve. The page names the application and the device.

**3. Poll for the token**

```http
POST /api/oauth/token
Content-Type: application/json

{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
  "device_code": "3c9f…", "client_id": "lu-launcher" }
```

While pending the reply is `400 {"error":"authorization_pending"}`; too fast is `slow_down`; timed out is `expired_token`; declined is `access_denied`. On approval:

```json
{ "access_token": "arc_…", "token_type": "Bearer", "scope": "scores:submit tournaments:read tournaments:join" }
```

The token is long-lived, has no refresh step, and is **bound at issue to the `device_id`** it was requested for (owner decision 2026-10-30). Every later call carries it as `Authorization: Bearer` and repeats `device_id`; a mismatch is a bare 401. The player can revoke it from Account Settings at any time, and revoked reads as the same bare 401. Internally the token is a device row, so routing, entry rules, attempts and the event lobby treat a launcher exactly like a paired cabinet.

One player per device at a time. A second player approving on the same device replaces the binding; the previous token stops working.

## Push payload v1

One endpoint, two event kinds, JSON over POST. **`game_start` is sent live, the moment a game begins**, because Arcaid counts a limited-attempts try at the start of the game (a crash or power-off must not be a free retry). `game_end` is sent when the game is over. Both carry the same identity block so a start and its end pair up.

```http
POST /api/launcher/v1/events
Authorization: Bearer arc_…
Content-Type: application/json
```

**game\_start**

```json
{
  "event": "game_start",
  "event_id": "e7d1…",
  "device_id": "bcf74cfb58d7…7753d0",
  "started_at": "2026-10-30T23:03:40.825Z",
  "table": {
    "vps_id": "VpkkSgv-",
    "rom": "bdk_294",
    "name": "Batman - The Dark Knight (Stern 2008)",
    "stream_hash": "sha256:…"
  },
  "players": 1,
  "tournaments": ["6ddc16f3-…"],
  "attestation": { "clean_install": true, "build": "lu-10.8.0-6a8106474" },
  "sig": { "kid": "lu-tournament-2026-10", "alg": "Ed25519", "value": "base64…" }
}
```

**game\_end**

```json
{
  "event": "game_end",
  "event_id": "a41c…",
  "start_event_id": "e7d1…",
  "device_id": "bcf74cfb58d7…7753d0",
  "started_at": "2026-10-30T23:03:40.825Z",
  "ended_at": "2026-10-30T23:05:29.242Z",
  "submitted_at": "2026-10-30T23:05:30.011Z",
  "table": { "vps_id": "VpkkSgv-", "rom": "bdk_294", "name": "…", "stream_hash": "sha256:…" },
  "players": 1,
  "scores": [
    { "player": 1, "score": 1196660,
      "balls": [ {"ball":1,"points":411780}, {"ball":2,"points":647260}, {"ball":3,"points":137620} ] }
  ],
  "reason": "game_over",
  "quit": false,
  "ball_in_play": null,
  "tournaments": ["6ddc16f3-…"],
  "attestation": { "clean_install": true, "build": "lu-10.8.0-6a8106474" },
  "sig": { "kid": "lu-tournament-2026-10", "alg": "Ed25519", "value": "base64…" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `event_id` | yes | Client-generated, unique per device. Repeats are answered with the stored result, never processed twice. |
| `device_id` | yes | Must equal the token's bound device. |
| `started_at`, `ended_at` | yes | ISO 8601 UTC with milliseconds, from the launcher's clock. These place the game in a window. |
| `submitted_at` | yes on end | When the launcher sent it. Used for replay and hold-back detection only. |
| `table.vps_id` | preferred | The VPS game id. Matching prefers it; `rom` and `name` are fallbacks. |
| `table.stream_hash` | when LU has it | The OLE stream hash per LU's recipe. Compared against the manifest value Arcaid ingests. |
| `players` | yes | Player count. v1 lands player 1 only; others are stored for later. |
| `scores[].score` | yes on end | Integer, not a string. `balls` optional. |
| `reason` | yes on end | `game_over`, `quit`, `shutdown`, `restart`. |
| `quit`, `ball_in_play` | optional | Shown as "quit on ball N". Never a gate. |
| `tournaments` | optional | The player's joined tournament ids, as a **filter**. Omitted means "all my rooms". |
| `attestation` | optional | Whatever the launcher can vouch for: clean install, build, adjustments. Feeds Sanctioned-play rules. |
| `sig` | yes | Signature over the canonical JSON of the event without `sig`, by LU's tournament key, with a key id. Recipe to be fixed by LU. |

`model` and `model_name` travel at device-code time, not per event.

## Answers

Every accepted event is a 200 with a status the launcher can show the player. The vocabulary is the one the cabinet Witness already uses, so nothing new has to be learned server-side.

**To a `game_start`:** one entry per tournament the start was tried in.

```json
{ "ok": true, "event_id": "e7d1…",
  "attempts": [
    { "tournament_id": "6ddc16f3-…", "tournament": "Test #4", "status": "counted",
      "attempt": 1, "of": 5, "remaining": 4 }
  ],
  "sending_to": "Test #4 · 4 of 5 attempts left" }
```

| start status | meaning |
| --- | --- |
| `counted` | A try was used (attempt n of `of`, `remaining` left). |
| `over_limit` | No try left. The game is recorded but its score will not count. |
| `unlimited` | The tournament has no limit. Nothing recorded. |
| `not_started` | The tournament requires the player to press "Start attempts" first; this play will go to Global only. |
| `no_match` | No open tournament of the player's covers this table. Normal, not an error. |

**To a `game_end`:** the top level is the first landing (what a one-line display shows), `landed[]` lists every tournament.

```json
{ "ok": true, "event_id": "a41c…", "status": "ingested", "game": "Batman - The Dark Knight (Stern 2008)",
  "landed": [ { "tournament_id": "6ddc16f3-…", "status": "ingested" } ],
  "verification": { "signature": "valid", "kid": "lu-tournament-2026-10" } }
```

| end status | meaning |
| --- | --- |
| `ingested` | On a tournament board. |
| `global` | No tournament matched (or none allowed); recorded as a personal best on the Global Scoreboard if the player allows it. |
| `duplicate` | Already recorded, or the player deleted this play. |
| `no_match` | Nothing to land on and Global declined (table not in the catalogue, or player opted out). Carries `not_counted` with the reason in plain words. |
| `not_sanctioned` | A Sanctioned-play tournament refused it; `reasons[]` says why, `fallback` says where it went instead (Global). |
| `invalid` | Malformed, bad signature, or the signed times/score disagree with the fields. Nothing written anywhere. |

`sending_to` on every answer is the same human line the cabinet tile prints: where this device's plays are going right now, plus attempts left. Table Manager can show it as is.

## Tournaments

Table Manager shows the player what they can join and lets them join it, so the launcher only pushes plays that have somewhere to go. The list is built with the same filters the score path uses, so a listed tournament is one a play would actually land on.

**List**

```http
GET /api/launcher/v1/tournaments?device_id=…
Authorization: Bearer arc_…
```

```json
{ "tournaments": [
  { "id": "6ddc16f3-…", "name": "Test #4", "room": { "slug": "rtx_pinball", "name": "RTX Pinball" },
    "format": "rotation", "integrity": "open",
    "entry": "entered",
    "window": { "opens_at": "2026-10-28T00:00:00Z", "closes_at": "2026-11-04T00:00:00Z" },
    "attempts": { "max": 5, "start_required": true },
    "tables": [ { "vps_id": "VpkkSgv-", "name": "Batman - The Dark Knight (Stern 2008)", "rom": "bdk_294",
                  "attempts": { "used": 1, "remaining": 4, "started": true } } ],
    "device_rules": { "engines": ["vpx"], "devices": ["atgames"] } }
] }
```

| `entry` | meaning | what Table Manager offers |
| --- | --- | --- |
| `entered` | member of the room, or on the roster, or checked in | nothing, plays count |
| `can_join` | open room, not yet a member | a Join button |
| `request` | approval room or invite-only | a Request button; `pending` after |
| `pending` | request sent, host has not decided | nothing |
| `not_eligible` | device or engine rules exclude this device | greyed, with the rule |

**Join**

```http
POST /api/launcher/v1/tournaments/{id}/join
Authorization: Bearer arc_…
{ "device_id": "…" }
```

Answers `{"entry":"entered"}` for an open room, `{"entry":"pending"}` where a host must approve, and `409 {"error":"invite_required"}` for an invite-only tournament with no open request method. Joining a tournament's room through this call is exactly the room join a player makes on the website; it is not a second kind of membership.

**Start attempts.** Where `attempts.start_required` is true, plays go to Global only until the player presses Start for that table. `POST /api/launcher/v1/tournaments/{id}/tables/{vps_id}/start` is the launcher's press, equivalent to the button on the Arcaid game page. First press wins; a repeat keeps the original time.

**The filter.** The launcher may send the ids of joined tournaments as `tournaments[]` on every event. The server intersects them with what the play matches; it never adds a tournament the player is not entered in and never skips the match. Omitting the field means "all my rooms", the default every cabinet uses today.

## Time, idempotency, limits and errors

**Time.** All timestamps are ISO 8601 UTC with milliseconds. The window a game falls in is decided by `started_at` and `ended_at` as signed by the launcher, never by arrival. A tournament's end carries a grace (default 60 s, hosts set up to 180 s for exit-to-submit) that applies to `ended_at`. A start that reaches the server more than 120 s after `started_at` is still counted as an attempt but marked `late`; its score will not count, which is what stops a client from "starting" a game after seeing how it went.

**Idempotency.** `event_id` is the key. A repeat of a stored event returns the stored answer with the same 200, no second write, no second attempt. A `game_end` whose `start_event_id` is unknown is still accepted (the start may have been lost to a network blip): the attempt is created at end time with a note, the same rule the cabinet uses today.

**Limits.** 120 requests per minute per IP, shared across all launcher endpoints. A 429 carries `Retry-After`. The payload cap is 16 KB.

**Errors.** Transport and auth errors are the only non-200s a launcher should ever see in normal use:

| code | body | when |
| --- | --- | --- |
| 401 | `{"ok":false}` | Unknown, revoked or device-mismatched token. Deliberately says nothing more. |
| 400 | `{"ok":false,"error":"<code>"}` | Missing required field, unknown `event`, unknown `grant_type`. Never for an optional field. |
| 409 | `{"ok":false,"error":"<code>"}` | Join conflicts (`invite_required`, `already_pending`). |
| 429 | `{"ok":false,"error":"rate_limited"}` | With `Retry-After`. |
| 5xx | `{"ok":false}` | Retry with backoff; the server is idempotent on `event_id`. |

Everything about a play itself (no match, over limit, refused by a Sanctioned tournament, duplicate, invalid signature) is a **200 with a status**, so the launcher never retries it and the player sees the reason.

## Sequence

&#91;embedded content: launcher flow · pairing once, two events per game\]

The pairing row happens once and survives restarts. The play row repeats per game; the start answer is what the player sees before pressing Start, the end answer is what they see when the ball drains.

## Conformance

Agreement is a passing script, not a signature on a document.

- **Fake launcher.** Arcaid ships a small Node script that runs the device flow, then posts a `game_start` and a `game_end` signed with a test Ed25519 key, and prints every answer. It is the reference client; if LU's launcher produces the same requests, it works.
- **Test application key and test room.** LU gets an application key scoped to a test room on production, so the launcher can be exercised against the real server with real latency and nothing lands on a live board.
- **Test signing key.** Arcaid's key registry holds LU's production key and a test key side by side, each with a key id. The fake launcher signs with the test key; the launcher signs with the real one; both verify.
- **Done when:** the launcher passes pairing, one counted start, one ingested end with `verification.signature = valid`, one `no_match` on a table nobody runs, one `duplicate` on a resent `event_id`, and one 401 on a revoked token.

**What changes on the Arcaid side once this is live.** For LU tables, the cabinet Witness stops reading score files and keeps only pairing, check-in, heartbeat and native-table launch/exit. Nothing changes for non-LU devices or for Castcade on desktop.

## Open questions for LU

- [ ] **Payload signature recipe.** Canonical JSON (key order, whitespace, number formatting) over the event without `sig`, or a detached signature over the raw bytes as sent? Arcaid will implement whichever LU specifies; the jsonl approach (sign the bytes, cut at the last `,"sig":`) also works over the wire if the launcher sends the exact bytes it signed.
- [ ] **Key ids and rotation.** One `kid` per key, published where? A JSON endpoint on LU's side that Arcaid polls, or a key posted in the channel per rotation.
- [ ] **Live `game_start`.** Can the launcher emit it at game start rather than at exit? This is the one field that changes what Limited attempts can do on a cabinet.
- [ ] **`quit` and `ball_in_play`.** Does the recorder know the ball in play at a quit? Today a quit is written as an ordinary game over with fewer ball entries.
- [ ] **Stream hash.** The recipe (which OLE streams, order, concatenation, digest) and the manifest field name that will carry it per table.
- [ ] **Attestation fields.** What the tournament-only launcher can vouch for per game: clean install, build id, nvram reset, no sidecar scripts, adjustments in force.
- [ ] **Players 2 to 4.** Does the launcher know who they are, or only that they exist? v1 lands player 1.
- [ ] **Device id on desktop.** For Table Manager on a PC, what is the stable per-install id to bind the token to?
