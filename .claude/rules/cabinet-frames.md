---
paths:
  - "src/services/CabinetFrame*.ts"
  - "src/services/cabinetFrameTypes.ts"
  - "src/utils/cabinetDots.ts"
  - "src/utils/cabinetScreens.ts"
  - "admin-ui/src/pages/CabinetFrame.tsx"
  - "admin-ui/src/lib/cabinetFrameTypes.ts"
---
# Cabinet frames (W132) — rules

The Legends Pinball backglass and DMD show pictures arcaid.app draws (ADR 0046, `docs/cabinet-frames-plan.md`). Witness devices, routing and attempts are in `witness.md` / `attempts.md`.

## Server (W132.2, v2.288.0, ADR 0046)
- **The data contract is `src/services/cabinetFrameTypes.ts` ≡ `admin-ui/src/lib/cabinetFrameTypes.ts`** (identical below the header; change both). Every string is display-ready; the page formats nothing but layout. Bump `CABINET_FRAME_STYLE_VERSION` when the page's look changes, or old pictures stay.
- **Screens are for the device's CURRENT player** (`WitnessPlaySessionService.playingAs`; the preview passes the caller), resolved ONCE in `CabinetFrameService.context` and threaded through every read. Never the pairing account by default.
- **No new queries for what exists:** open cards = `openGamesForDevice` + `orderTileCards`; boards = `LeaderboardService.getForGame`; attempts = `deviceAttemptsLeft`; routed rooms = `ActivityLogService.roomsForDevice`; events = `EventLobbyService.eventIdsForDevice` (shared with the check-in lobby); last score = `WitnessTileService.lastScoreBlock`. Nothing in a screen read writes (never `checkinFromWitness`).
- **Never a raw id in a picture:** board names go through `boardName` (`A PLAYER` when nothing resolves). **No running clock in a picture:** `endsText` is hour-bucketed or a clock time; seconds tick only in the dot lines.
- **Frame id = sha256 over kind, screen, JSON(data), style version; first 32 hex** (`cabinetFrameId`). Ids are validated (`isCabinetFrameId`) before they touch a path.
- **The manifest (`GET /witness/frames`) is flat strings for the tile's naive reader:** no URL, no `"` or `\`; dot text only through `dotsString` / `dotText` (`src/utils/cabinetDots.ts`, the one sanitizer for dots). It writes nothing but render jobs (no last-seen, check-in or clock offset).
- **Pair pictures live in their own store** (`data/cabinet-frames/pair/`): the public `/witness/pair-frames` routes (per-IP `cabinetPairFramesLimiter`, code = `CODE_ALPHABET` x `PAIRING_CODE_LEN` or 400) can never serve a player's picture.
- **`witness_device_players.cabinet_screens` (migration 227) is read only through `parseCabinetScreens`** (`src/utils/cabinetScreens.ts`; NULL = every screen, 10 s; seconds 6..30; unknown keys dropped; `[]` = all off). Player routes: `/api/me/witness-devices/:deviceId/cabinet-screens|cabinet-frames[/<id>.jpg]`, caller must be on the device (404).
- **`CabinetFrameRenderer`:** one shared Chromium (`--disable-dev-shm-usage`, service workers blocked), one render at a time through a de-duplicating queue (cap 200), 20 s budget, idle close 5 min, JPEG q85, temp file + rename, read touches mtime, prune at 7 days / 500 MB. **Inert under vitest** unless a test calls `setForTests({ capture })`.
