---
paths:
  - "admin-ui/src/pages/CabinetFrame.tsx"
  - "admin-ui/src/components/cabinetFrame/**"
  - "admin-ui/src/components/WitnessCabinetScreens.tsx"
  - "admin-ui/src/lib/cabinetFrame*.ts"
  - "src/services/cabinetFrame*.ts"
  - "src/services/CabinetFrame*.ts"
---
# Cabinet frames — rules

Plan `docs/cabinet-frames-plan.md`, decision ADR 0046 (W132). arcaid.app draws the Arcaid screens on a cabinet's backglass and DMD; the Witness tile downloads and shows them. This file is the web half (W132.3); the server half (W132.2) adds its own lines here.

## The page (v2.289.0)
- `/cabinet-frame` (`pages/CabinetFrame.tsx`) is the page the server's headless browser screenshots: standalone, lazy, no layout, no auth, no fetch. It reads `window.__CABINET_FRAME__` (`CabinetFrameInput`), draws screen x kind at exactly 1920x1080 (backglass, `--aw-scale` 0.82) or 1920x1200 (DMD, 1.45) and sets `window.__cabinetFrameReady = true` once the kit stylesheets, the fonts and every image have loaded or failed. The kit's sizes resolve at `:root`, so the page sets the scale on `documentElement`.
- **The contract lives twice, identical:** `src/services/cabinetFrameTypes.ts` ≡ `admin-ui/src/lib/cabinetFrameTypes.ts`. Change both and bump `CABINET_FRAME_STYLE_VERSION` when the look changes. Every string arrives display-ready (names resolved, times formatted in the room's zone): the page lays out and formats nothing, and an empty name reads "A PLAYER", never an id.
- Screens are in `components/cabinetFrame/` (`Backglass.tsx`, `Dmd.tsx`, `shared.tsx`) with the kit's classes and `cabinetFrame.css` (kit tokens only, no hex or rgb; a translucent kit colour is a `color-mix`). The reference is the Display Lab's `frames-src/studio.html`; the renders matched it to under half a percent of pixels. `.cf-root` sets `box-sizing: content-box` and `line-height: normal`, because the lab drew without the site's reset; a `cf-` override of a kit class is written `.cf-root .cf-x`, because the kit stylesheet loads after the bundle and wins a tie.
- No running clocks in a picture (an event shows its start or end as a clock time). The DMD's dot window is an empty framed box at `CABINET_DMD_DOT_RECT`; `pair` has none. A title never ellipsises: `FitTitle` shrinks it to 60%, then wraps. A `practice` card says PRACTICE in a larger attention chip.
- Opened with no frame injected, it shows a sample of each screen with a switcher (`?screen=&kind=`), fed by `lib/cabinetFrameSamples.ts`.
- **The renderer's browser context must block service workers** (`serviceWorkers: 'block'`): `index.html` registers `sw.js`, which caches `/api/catalogue-images/` and would serve a stale picture. `/cabinet-frame` is in `RESERVED_ROOM_SLUGS` and `lib/routeClass.ts` so it is never read as a room.

## The player's panel
- `components/WitnessCabinetScreens.tsx`, under each cabinet (not a PC) in Account Settings: a switch per `CABINET_SCREEN_CHOICES` item, seconds per screen (6 to 30), saved by `PUT /api/me/witness-devices/:deviceId/cabinet-screens`, and a preview strip from `GET .../cabinet-frames`. At least one screen stays on. The preview pictures need the player token, so they are fetched as blobs (an `<img>` cannot send a header).
