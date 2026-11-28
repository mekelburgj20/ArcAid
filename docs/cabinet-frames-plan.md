# Cabinet frames: arcaid.app draws the cabinet head, the cabinet shows it (W132)

Owner decision 2026-11-28 (ADR 0046): the Arcaid screens on a Legends Pinball's
**backglass** and **DMD** are drawn by arcaid.app in a headless browser with the
web app's own Arcaid look, and the Witness tile downloads and shows them. The
cabinet draws only what changes by the second: the DMD's dot lines (countdowns,
tickers, the dot logo).

Proven first in the Display Lab (arcaid-witness branch `display-lab`,
`apps/arcaid-display-lab/`): build 2 ran on the owner's 4KP (HA9920); build 3 is
the frames-from-PNGs player this plan productises. `frames-src/studio.html` in
that branch is the visual reference for every screen.

## Facts from the hardware (HA9920, 2026-11-28)

- Backglass: 1920x1080, rotation 0. DMD: a full **1920x1200** panel (mounted
  1200x1920, rotate 90), the whole of it visible through the cabinet window.
- The cabinet's SDL is older than the SDK's build SDL: `SDL_RenderFillRectF`
  (2.0.10) is missing and killed lab build 1. Only SDL 2.0.0-era calls.
- Only the foreground tile may open the secondary displays (the launcher kills
  it when a game is staged; during play the table owns both screens).

## Owner answers (2026-11-28)

1. Players choose what shows **on arcaid.app** (per device, per player), not
   on the cabinet.
2. The first cabinet release carries **every screen from the lab**: attract,
   my rooms' games carousel, global scoreboard, standings, activity, live event,
   and the pair screen for an unpaired cabinet.
3. **Research** whether the launcher menu can show something of ours when the
   Witness tile is highlighted (W132.5); separate from this pipeline.

## Who the screens are for

The device's current player: `WitnessPlaySessionService.playingAs(deviceId)`
(open session, else the default player), routing from
`WitnessService.getDeviceTarget(deviceId, playerId)`. Resolve that **once** per
request and thread the one `playerId` through every data read (open cards,
attempts, "your row", standings, feed). Never the pairing account by default.

## Screens

Each screen is one backglass frame + one DMD frame + the DMD's live dot lines.
The data shapes below are the contract between the server (W132.2) and the
frame page (W132.3); `src/services/cabinetFrameTypes.ts` and
`admin-ui/src/lib/cabinetFrameTypes.ts` carry them (keep both identical; a
parity test like `scoreProvenance` is welcome).

| key | backglass | DMD picture | DMD dots |
|---|---|---|---|
| `attract` | badge + PLAYING AS + status lines on the carpet | badge + ARCAID WITNESS, chips | logo, then status lines |
| `card` (one per open card, up to 6) | the card: table art filling it under a 55% scrim, room/kind chips, attempts + time-left chips, title, top 5 + your row, footer | art + room/table header, chips | beat-this, time left (live count), attempts |
| `global` (up to 2 tables from the carousel) | global board for the table: top 4 + your row, region | art + header | global rank, gap to next |
| `standings` (each active ranking group in the player's routed rooms, up to 2) | two-column standings, top 10 | header | standings ticker |
| `activity` | latest lobby-feed items across the routed rooms, thumbnails | header | activity ticker |
| `event` (when an event the device routes to is upcoming/live) | round, table art, start/end times, checked-in chip | header | round countdown (live) |
| `pair` (unpaired cabinet) | QR for `https://arcaid.app/pair/<code>` + steps + code | big code | none |

Rules every frame keeps:

- **No running clocks in a picture.** A picture shows absolute times (room
  zone via `resolveTimezone`) or coarse "ENDS IN 2D 4H" text bucketed to the
  hour (so the picture is re-rendered hourly). Seconds tick only in the dots.
- Names resolve at read (`getForGame` already hydrates; otherwise
  `resolveUserLabels`), never a raw id; an unresolvable player is "A PLAYER".
- Public integrity marks are ✓ and ⚠ only (ADR 0038); no round timing (elapsed)
  anywhere (owner 2026-11-10).
- The kit look (aw-theme.css + aw-theme-ext.css verbatim, aw-web.css carpet,
  kit fonts), kit colours (1st pink, 2nd cyan, 3rd ice, your row the kit's
  current row). No game title ellipsised: shrink to fit, then wrap.
- A `practice` card says PRACTICE loudly (attempts.md).

## Server (W132.2)

### Data: `CabinetFrameService.screensFor(deviceId)`

Builds the ordered list of screens for the device's current player, honouring
their display preferences:

- open cards: `VpxScoreIngestService.openGamesForDevice` + `orderTileCards`
  (extend `OpenDeviceGame` additively if a field is missing; never a second
  card query, witness.md). Board rows: `LeaderboardService.getForGame`
  (top 5 + the player's row matched as `WitnessTileService.boardRank` does);
  gap to the next place from the row above. Attempts:
  `AttemptService.deviceAttemptsLeft`. Art: `GameArtService.artForNames`
  (+ the card's style background when it has one, as the room board does).
- global: the carousel's first tables, `global_game_id` by name
  (`catalogueIdForName`), board from `GlobalLeaderboardService.getForCard` for
  the table's main category (or `getForGame` when there is one category).
- standings: `RankingService.getActiveWithRankings(roomId)` per routed room.
- activity: `LobbyFeedService.getFeed(roomId, {limit: 8, viewerUserId})` per
  routed room, merged newest first, 6 items; text is the feed's own title.
- event: the event list logic of `EventLobbyService.lobbyFromHeartbeat`
  (reuse, never copy) + `EventService.getRounds` / `deriveState` /
  `isParticipant`. Never call anything that writes.

Each screen's `data` object is hashed (sha256 over kind + screen + JSON +
`CABINET_FRAME_STYLE_VERSION`) into a **frame id** (32 hex chars). Same data,
same picture, rendered once.

### Rendering: `CabinetFrameRenderer`

- One shared Chromium (`playwright`'s `chromium.launch({ args:
  ['--disable-dev-shm-usage'] })`; prod has Docker's 64 MB /dev/shm), launched
  on first use, closed after 5 minutes idle. One render at a time through a
  de-duplicating queue; a render has a 20 s budget.
- It loads the app's own page `http://127.0.0.1:<PORT>/cabinet-frame` (W132.3)
  with the frame input injected by `page.addInitScript`
  (`window.__CABINET_FRAME__ = { kind, screen, data }`), waits for
  `window.__cabinetFrameReady === true`, screenshots **JPEG quality 85** at
  1920x1080 (backglass) or 1920x1200 (DMD) into
  `data/cabinet-frames/<id>.jpg`. No device token ever goes into a page.
- Cache: keep files read in the last 7 days, cap 500 MB (oldest-read first);
  a read touches the file's mtime.
- Under vitest the renderer is a stub (no browser), like
  `IScoredSnapshotService`'s test switch.

### Device endpoints (global.ts, `witnessIngestLimiter`)

`GET /api/witness/frames` (`requireWitnessDevice`): the manifest, flat strings
for the tile's naive parser (no URLs, no `"` or `\`):

```
ok:true  now:<epoch sec>  refresh:"60"  count:"N"
s<i>Kind  "card"                                  (1-based i)
s<i>Secs  "10"
s<i>Bg    "<32 hex frame id>"   ("" = none)
s<i>Dmd   "<32 hex frame id>"   ("" = none)
s<i>Ready "1" when both pictures exist, else "0" (render queued; skip it)
s<i>Rect  "64,318,1792,448"     dot window on the DMD, logical px ("" = no dots)
s<i>Dots  "text|TO TAKE 2ND ON AC/DC|+210,450;count|MOX WEEKLY ENDS IN|1796012345;logo"
```

Dot grammar: lines split by `;`, fields by `|`. Types: `text|small|big`,
`count|small|<end epoch>` (the cabinet shows D HH:MM:SS, or MM:SS under an
hour, ticking), `ticker|small|text` (scrolls), `logo`. Text is upper case and
limited to `A-Z 0-9 space , . : / # + & ! ? ' -` and the middle dot `·`;
anything else is dropped server-side.

`GET /api/witness/frames/<id>.jpg` (`requireWitnessDevice`): the picture
(`image/jpeg`, `Content-Length`, `Cache-Control: private, max-age=86400`); 404
when unknown or not rendered. Follows `/witness/app/download`'s pattern.

`GET /api/witness/pair-frames?code=<code>` and
`GET /api/witness/pair-frames/<id>.jpg`: **unauthenticated** (an unpaired
cabinet has no token), the same manifest shape with one `pair` screen; the code
must match the tile's pairing alphabet and length (`AppConfig.h`
`kPairingAlphabet`, `kPairingCodeLen` = 6) or 400. A pair picture carries only
the code. Rate-limit per IP.

### Player endpoints (preferences + preview)

- `witness_device_players.cabinet_screens` (TEXT JSON, NULL = defaults) read
  only through `parseCabinetScreens` (`{ screens: [...keys], seconds: 6..30 }`,
  default every screen on, 10 s). Claim the next free migration number on
  `origin/main` before coding.
- `GET` / `PUT /api/me/witness-devices/:deviceId/cabinet-screens`
  (`requireDiscordUser`; the caller must be a player on the device) for their
  own row.
- `GET /api/me/witness-devices/:deviceId/cabinet-frames`: the same screen list
  as the device would get **if the caller were playing**, with each picture as
  `/api/me/witness-devices/:deviceId/cabinet-frames/<id>.jpg` (player auth), for
  the preview on arcaid.app.
- Every device fetch of the manifest writes nothing (read-only, like the tile).

## Web (W132.3)

- `admin-ui/src/pages/CabinetFrame.tsx` at `/cabinet-frame` (standalone, no
  layout, like the kiosk; add `cabinet-frame` to `RESERVED_ROOM_SLUGS`): reads
  `window.__CABINET_FRAME__`, loads the kit (`useAwTheme`) and the carpet, draws
  the screen with the kit's classes (port of the lab's `studio.html`), sets
  `window.__cabinetFrameReady = true` once fonts and every image have loaded.
  Without the global (a person opening the URL) it shows a sample of each
  screen, so the look can be reviewed in a browser.
- Account Settings, the device's panel: **Cabinet screens** for the signed-in
  player on that device: a switch per screen, seconds per screen, and a preview
  strip of the real rendered pictures (the preview endpoint). Shared parts only
  (ADR 0042), inside the device's existing group.

## Cabinet (W132.4, arcaid-witness 1.2.0)

- Branch from `1.1.2`. Move the lab's `ScreenOut`, `DmdCanvas`, `DmdLines` and
  the image decoder into the tile; a `CabinetScreens` member started in
  `App::init()` after `detectDisplayTopology()`, ticked in `run()`, stopped
  first in `shutdown()` and on `SDL_QUIT`. Skip silently when a role is absent.
- While the tile is open: fetch the manifest every `refresh` s on a worker
  thread (paired: `/witness/frames`; unpaired: `/witness/pair-frames` with the
  code on screen); download each ready picture once into
  `/tmp/aw-beacon/frames/<id>.jpg` (cap 64 MB, oldest out, statvfs check);
  decode on the worker thread (stb_image JPEG + PNG, `STBI_MAX_DIMENSIONS`
  4096, size checked first); show them in order; draw the dot lines in the
  manifest's rect, the countdowns against the manifest's `now`.
- No frames yet (no network, nothing ready): the lab's built-in dot logo on the
  DMD and the attract screen drawn locally; never a black screen.
- Frame ids validated as 32 hex before they touch a path or URL. URLs built on
  the cabinet (`AppConfig::kServerBase`), auth as every other call.
- `scripts/check-sdl.sh`: fail the build when the ELF imports an SDL symbol the
  shipped 1.1.1 ELF does not, unless it is on a reviewed allow list of SDL
  2.0.0 API. Run it in `build-app.sh` after `check-compat.sh`.
- Released as 1.2.0 through the signed self-update (witness.md), after the
  owner tests an unsigned build from the stick.

## Order of work

1. W132.2 server and W132.3 web in parallel (the contract above), merged
   server first.
2. W132.4 cabinet in parallel against the contract; its own test before the
   server is live: a manifest + pictures served from the PC (a test build only
   reads a `frames-base.txt` override; release builds never do).
3. Owner test on the 4KP, then the signed 1.2.0 release.

## Not in this

- Drawing anything while a table is being played (the table owns the screens).
- Avatars in pictures (remote Discord URLs; later).
- The launcher-menu research (W132.5).
