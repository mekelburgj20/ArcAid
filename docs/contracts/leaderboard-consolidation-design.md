# Leaderboard Settings Consolidation + Live Card Editor — Design

**Date:** 2026-08-19 · **Status:** DECIDED — owner answered all six calls 2026-08-19 (see §6); recommendations accepted on 1/2/3/5/6, Q4 upgraded to FIRST-CLASS mobile. Arc green-lit; C1 in build.
**Owner directives:** (1) "all in one config in Leaderboards" — migrate Leaderboard Display config out of Room Settings onto the admin Leaderboard page. (2) Same evening, scope expanded: the StylePicker modal is legacy and gets REBUILT inside this effort — the ACTUAL card being edited becomes the live real-time preview.

---

## 1. Why this design is cheap to build (recon findings)

- `pages/Leaderboard.tsx` already fetches the **full** scoreboard config map (`GET /rooms/:roomId/scoreboard-config` returns every `SCOREBOARD_*`/`LOGO_*`/`KIOSK_*` key) and passes it wholesale to the real `ScoreboardSurface`. Live room-level editing = keep a **draft copy of that map in state and pass the draft to the surface**. The page becomes its own preview with zero new render machinery.
- `ScoreboardSurface` fetches nothing and derives everything internally (`deriveScoreboardConfig`, contract comment at `ScoreboardSurface.tsx:73-75`) — a draft config cannot diverge from what viewers will see.
- The card being edited is **already rendered with real scores** on this page. Per-card live editing = merge a local override object into that card's `GameLeaderboard` before it reaches the surface: `{...lb, ...draftOverlay}`. No new card render path.
- The framing model is **already focus-point-like**: `bgTransformStyle` couples `transformOrigin` to `backgroundPosition` (`admin-ui/src/lib/bgFraming.ts:53-63`), so the point you position stays anchored while zooming. Zoom-out needs **no storage change** — migration 154's columns survive untouched; only three clamp sites move from 100 → 50.
- StylePicker (633 lines) has exactly **4 production call sites**: Leaderboard game card, Leaderboard ranking group, GameLibrary, Tournaments. `CardRouter` renders a card standalone with no page dependencies, so the non-Leaderboard call sites can get a synthetic-card live preview from the same editor component.
- None of the scoreboard-display keys are in `DANGEROUS_KEYS` (`Settings.tsx:258` — iScored/Discord/global/join-policy only), so the relocated save path needs no confirm gate.

## 2. Target UX — one editing surface on `/:slug/admin/leaderboard`

The page header gains a **"Display settings"** button. It opens an editing rail:

- **Desktop (≥lg):** sticky right rail, ~380px, full height beside the surface (the surface's grid/scroll already reflows on width).
- **Mobile — FIRST-CLASS (owner call, 2026-08-19):** bottom sheet with snap points (peek / half / full) so the live surface stays visible and editable above it at half height. Driving scenario: a mod standing in the game room with only a phone, watching the room's kiosk while tweaking. See §2c.

The rail has **two contexts, mutually exclusive** (a tab strip or automatic switch):

### 2a. Room display (the consolidation)

Everything from Settings → "Leaderboard Display" re-hosts here, structure preserved:
`StyleProfiles` → `StyleThemePicker` (Looks grid, showcase theme + podium variant, Display options collapsible) → the 5 inline toggles → Fine tuning (9 controls) → Branding (bg image, logo, title).

- Controls write to `draftConfig` (initialized from `config`); the surface renders `draftConfig` — **the whole page live-previews every change**, including zoom, layout, rankings position, branding. This is exactly the doctrine that killed the Settings preview in v2.110.0, completed.
- Sticky **Save / Discard** bar appears when dirty. Save = the same `POST /rooms/:roomId/settings` diff the Settings page uses today; then `setBaseline`. Unsaved-changes guard on nav/close.
- **Phone preview** stays available: a small toggle in the rail opens the existing `DevicePreviewFrame` iframe fed by `draftConfig` — mobile rendering genuinely differs (QR gate ≤640px, `SCOREBOARD_MOBILE_*`), and the admin's desktop surface can't show it.
- **Settings page residue:** the Leaderboard Display card is REMOVED and replaced by a small link card ("Scoreboard appearance now lives on the Leaderboard page → Configure"). All moved keys **stay in `managedKeys`** (`Settings.tsx:976-1026`) or they leak into the raw "Other" card — build trap #1.
- `ScoreboardPreview`'s mock-data usage on Settings retires with the section (the component may survive for the phone-preview toggle).
- `SCOREBOARD_RANKINGS_STYLE` stays on the Rankings page (its own surface); noted as a candidate follow-up, not in scope.

### 2b. Selected card (the StylePicker rebuild)

Entry: the per-card **Style** button on `AdminControlsStrip` (relabel "Edit card"). Selecting a card: scroll it into view, spotlight ring, rail switches to the card editor.

**The card itself is the preview.** All edits land in a per-card `draftOverlay` (`Partial<GameLeaderboard>`: `catalogueStyleId`/`logoStyleId`/`bgStyleId` effects expressed via the fields the cards read — see trap #6, `styleHeaderDisabled`, `bgZoom/bgPosX/bgPosY`) merged into the lb before the surface renders. Real style, real theme, real toggles, real scores — "so we know exactly what we are going to get."

Editor panel contents (everything StylePicker does today, re-hosted):
1. **Art pack picker** — search + paged grid + BG/HDR badges (reuse the list logic) + the existing `UploadForm` (30MB, cropper for identifiers, 1920² resize for backgrounds).
2. **Apply as** — Both / Background / Identifier segmented control (unchanged semantics → same two PUT endpoint families).
3. **Hide game identifier** — now a first-class toggle, always reachable (fixes the unreachable-checkbox finding; live-previews via `styleHeaderDisabled`).
4. **Background framing** — zoom slider (50–300, step 5) + **drag directly on the selected card**: in edit mode a transparent pointer-capture overlay sits on the card and reuses the existing subtractive delta math (`StylePicker.tsx:143-162`). The wide-strip preview problem evaporates — you drag the exact pixels the viewer sees. Reset framing button kept.
5. **Set as room default** (library cascade) — kept, same endpoints.
6. **Apply / Cancel / Clear style** — Apply fires the existing PUTs (always the FULL framing triple — backend clears omitted axes, trap #2); Cancel drops the overlay; Clear keeps v1's deliberate clear-style-clears-framing semantic.

**Framing honesty note:** framing renders only on the fill layer, gated by `SCOREBOARD_CARD_BG_FILL && bgImage` (`BannerCard.tsx:161-171`). When the room has fill off, the panel shows an inline note ("Framing has no effect while Card Background Fill is off") with a one-click enable that writes the room draft. v1's picker silently previewed framing that could never render — the real-card preview makes this impossible to miss, but the note explains *why*.

**Ranking-group cards:** same selection model, style-only editor (their schema has no framing today — `AssignRankingGroupStyleSchema` is `{styleId}` only). Adding ranking-card framing is a separate decision (open Q5).

### 2c. First-class mobile (owner call on Q4)

The mod's feedback loop in the driving scenario is NOT the phone screen — it's the **kiosk on the wall**. Recon confirmed the gap: `KioskScoreboard.tsx:47-61` fetches scoreboard-config **once on mount** (its poll + `leaderboard:updated` handler refresh scores/rankings/feed only), the public Scoreboard does the same, and the settings POST (`rooms.ts:3838`) **emits no socket event**. Today a phone-side save changes nothing on the kiosk until its next full page reload.

1. **Kiosk-live loop (load-bearing, lands in C1):** new `emitSettingsUpdated(roomId)` in `src/api/websocket.ts` (room-scoped, empty payload — the public `scoreboard-config` endpoint already filters to its allowlist, so clients refetch rather than trust a pushed body). Emitted after a successful `POST /:roomId/settings` AND after `POST .../style-profiles/:id/apply` (both write settings). `KioskScoreboard` + public `Scoreboard` listen on their existing room channel and refetch scoreboard-config (Scoreboard re-applies viewer prefs — the refetch block at `Scoreboard.tsx:340` already exists to copy). Save on phone → every screen in the room updates within a second. Benefits desktop admins equally.
2. **Bottom sheet with snap points** (peek ~30% / half ~55% / full), drag handle, scroll containment inside the sheet. At half, the phone's own mobile-rendered surface stays live above the sheet.
3. **Touch targets ≥44px** throughout the panel; the framing drag overlay already uses pointer events + `touch-none` (works for touch; deliberately trades card-area scroll for drag ONLY while in edit mode).
4. **Explicit Save stays** (no per-change write-through): settings saves trigger `invalidateAll` → whole-room leaderboard recalculation, so debounced auto-writes would be expensive and spam the audit log. The loop is "tweak a few things → Save → look up at the kiosk," which the socket makes ~1s.
5. **Phone (390px) screenshots join the pre-merge judgment set for every phase** — standing rapid-UI-iteration practice, now with mobile as a first-class judged viewport, not an afterthought.
6. The phone-preview iframe toggle remains a **desktop-only** affordance (on a phone you're already looking at the mobile render).

## 3. Zoom below 100% — recommendation

**Keep the storage model exactly as shipped (migration 154 survives); lower the floor to 50% in the three clamp sites:**
- `admin-ui/src/lib/bgFraming.ts` `BG_ZOOM_MIN` (100 → 50)
- `src/api/schemas.ts` `BgFramingFields` `bgZoom.min(100)` → `.min(50)`
- `src/utils/bgFraming.ts` `normalizeFraming` clamp

Rationale: `transformOrigin = position%` already makes the stored triple behave as focus-point + zoom — an anchor-based storage rewrite buys nothing and breaks the "data model survives" expectation. Below 100%, `scale(<1)` on a cover-sized layer reveals gaps showing the card's own background — with the REAL card as preview, that trade-off is visible truth and the owner's eye decides per game. No migration, no backfill (all existing rows are ≥100).

Rejected alternative: per-axis cover floor (minimum zoom that still covers the card) — the floor would depend on the current card style's aspect ratio, making a stored framing invalid the moment the room changes Look. Honest gaps are simpler and self-explanatory.

## 4. StylePicker retirement path — three shippable phases

- **C1 — Room display rail.** Consolidation: rail (desktop) + snap-point sheet (mobile) + draft config + Save/Discard + Settings link-card + phone preview toggle, **plus the kiosk-live loop** (`emitSettingsUpdated` + kiosk/scoreboard listeners — the one BE change in the arc). StylePicker untouched.
- **C2 — Card editor.** New shared `CardStyleEditor` component hosted in the rail; replaces BOTH Leaderboard call sites (game + ranking group). Zoom floor lowered here. StylePicker still serves GameLibrary/Tournaments.
- **C3 — Retirement.** GameLibrary + Tournaments swap their StylePicker modals for a sheet hosting the SAME `CardStyleEditor`, with a **synthetic real-card preview**: build a mock `GameLeaderboard` from the library/game row (name, imageUrl, style ids, framing) + the room's real config + placeholder scores, rendered via a one-element `ScoreCardGrid` (existing standalone path, `ScoreCardGrid.tsx:112-132`). Then `StylePicker.tsx` is deleted.

Each phase deploys alone; a session that stalls mid-arc leaves nothing broken.

## 5. Build traps (from recon — verify each during build)

1. **`managedKeys` on Settings.tsx** must keep claiming every moved key after the card is removed, or they surface in the raw "Other" card.
2. **Always send the full framing triple** on every write — `normalizeFraming` treats an omitted framing object as CLEAR (`src/utils/bgFraming.ts:21-26`), and a partial object silently resets the missing axes.
3. **`PUT .../image` framing rides along separately** (`rooms.ts:5764` `setGameBgFraming`) — the editor's Apply must hit the right endpoint family per Apply-as mode, exactly as v1's `onSelect` branches do (`Leaderboard.tsx:377-411`).
4. **StyleProfiles "Apply" writes server-side immediately** (`POST .../style-profiles/:id/apply`) — applying a profile while the room draft is dirty must warn/flush first, or the draft silently overwrites the applied profile on Save.
5. **Style-deletion cascade doesn't clear framing columns** (`StyleCatalogueService.ts:204-210`) — pre-existing, becomes more visible with live preview; decide whether to fix en route (cheap) or leave.
6. **Live style-id preview needs the `has_*` flags**: cards gate on `bgHasBg`/`catHasBg`/`logoHasHeader`/`catHasHeader` (`resolveImages`, `BannerCard.tsx:43-52`) — the overlay must set these from the picked style's `has_background`/`has_header`, not just the ids, or the preview lies.
7. **Legacy card path:** rooms without `SCOREBOARD_STYLE` render `GameCard` (legacy), which ignores framing. P0 seeded defaults for new rooms; verify auto-convert coverage or gate card-edit mode on `useNewCards`.
8. **Socket refetch during edit** (`leaderboard:updated` → `loadData`) replaces the `leaderboards` array — the overlay is keyed by gameId and merged at render time, so it must survive a refetch (don't store merged objects).
9. **`GET .../game_library/:name/style` already returns framing** (`rooms.ts:4483-4485`) but `Leaderboard.tsx:153` reads only `catalogueStyleId` — the editor's "room default" state can use the full response, no BE change.
10. **CRLF discipline**: `Leaderboard.tsx`, `Settings.tsx`, `rooms.ts` are large tracked files — `git diff --numstat` vs `-w --numstat` before every commit.

## 6. Owner decisions (2026-08-19)

1. **Zoom-out floor at 50%** — ✅ accepted (honest gaps, storage unchanged).
2. **Rail placement** — ✅ sticky right rail with scroll-into-view + spotlight.
3. **Settings page residue** — ✅ remove entirely + link card.
4. **Mobile admin editing** — ⬆ **UPGRADED to first-class** (owner: "some mods make changes on the fly — like in a game room looking at their kiosk with only their phone handy"). Design in §2c; the kiosk-live socket loop joins C1.
5. **Ranking-card framing** — ✅ later (no owner ask).
6. **Phase C3 timing** — ✅ in this arc; StylePicker is deleted at the end of C3.

## 7. Estimate

C1 ≈ one session (component relocation + draft plumbing + kiosk-live loop + tests). C2 ≈ one-to-two sessions (editor component, card overlay, drag-on-card, zoom floor, tests incl. the framing test updates). C3 ≈ one session (synthetic preview + two call-site swaps + delete). Screenshot-judged pre-merge per standing practice at every phase — desktop AND 390px phone sets.
