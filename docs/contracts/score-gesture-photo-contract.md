# Score gesture model v2 + photo evidence — work-package contract (v2.109.0)

Owner spec (2026-08-14, screenshots 27/28): unify card-row clicks and make
photo evidence quick to pull up. Branch: `feature/score-gesture-photos`.

## The gesture model (THE spec)

CARD rows (all card families incl. podiums + ScoreList + legacy GameCard, the
two room tabs where quick-view is wired):
- Row has expandable history (hasMultiple) and is NOT expanded → click EXPANDS
  (for every row — v2.108.0's own-row-click-opens-popup exception is REMOVED;
  this restores expand access on your own rows, the owner's complaint).
- Row IS expanded → clicking the main row body or ANY nested sub-score row
  OPENS the game quick popup (same onOpenQuickView wiring v2.108.0 added).
- Row NOT expandable (single score) → click opens the popup directly.
- COLLAPSE moves exclusively to the −/chevron icon (give it a slightly larger
  hit target, e.g. p-1) — the second row-body click now means "popup".
- The own-row visual affordance from v2.108.0 (cursor/hint) applies to ALL
  rows now (they're all clickable); keep it quiet.

QUICK POPUP (GameQuickView) rows:
- +/− control: expand/collapse (unchanged).
- Trash: delete (unchanged).
- Clicking the ROW BODY (main ranked row, or any expanded nested history row)
  → opens that score's PHOTO EVIDENCE in a full-screen viewer.
- Rows whose score has NO photo: no dead click — the row body is only
  photo-clickable when a photo exists, and a small Camera glyph (lucide
  `Camera`, ~12px, text-faint) renders next to the score ONLY when a photo
  exists, as the affordance cue. Photo-less rows: row body click does nothing
  (delete/expand still work via their own targets).

PHOTO VIEWER: search the codebase FIRST for an existing photo/lightbox idiom
(GameDetail renders score photos somewhere; grep `photo_url`, `score-photos`,
lightbox/modal patterns). Reuse it if one exists; otherwise a minimal shared
`admin-ui/src/components/PhotoLightbox.tsx`: fixed inset-0 z-50 black/90
overlay, centered `<img>` max-h/max-w, click-anywhere + Esc to close, and the
image loads from the row's `photo_url` (the `/api/score-photos/...` mount).
Alt text = "<player> — <score> photo evidence".

## Data

- Nested history rows already carry `photo_url` (per-player endpoint) — widen
  `useScoreExpand.ts`'s `ScoreHistoryEntry` type if it dropped it (it declares
  photo_url already — verify).
- MAIN ranked rows need `photo_url` added to the ranked payload the same way
  v2.108.0 added history_id/source/submitted_by_user_id: `LeaderboardService`
  (live + cached — bump the cache envelope v3→v4; photo_url of the best row is
  an identity-stable fact of that row, NOT profile data, so caching it is
  allowed) and `RoomScoresService.getGameRankingsBatch`. Old v3 blobs → miss.
- GameQuickView consumes rankings from the caller — once RankedEntry has
  photo_url nothing else is needed for main rows.

## Tests

- FE: gesture cycle on a card (unexpanded click → expand; expanded click →
  onOpenQuickView; single-score click → onOpenQuickView; − collapses),
  popup row-body opens lightbox only when photo_url present, camera glyph
  presence/absence, delete/expand targets unaffected.
- BE: ranked payload carries photo_url (live + cached path, envelope v4).
- Baselines: backend 1724, admin-ui 774 — end at or above. ALL suites run
  SYNCHRONOUSLY in the foreground (never background).

## Screenshot loop (required)

Per tmp/self-delete-harness.js pattern (mock claims + photo_url on some rows;
a data-URI image works for the photo): (1) card with one row expanded, (2)
popup with camera glyphs visible on photo-carrying rows, (3) the lightbox
open, (4) 390px popup shot. Save to tmp/gesture-photo-shots/. Kill the vite
preview when done — orphaned previews lock node_modules.

## Hard rules

Branch `feature/score-gesture-photos` off main (pull first; v2.108.1 merged).
Both builds green; lint zero-new on touched files; CRLF check; commit with a
`feature:` message. NO push/version/CHANGELOG/SPRINT_STATUS/ROADMAP/PR. If the
code contradicts this contract, STOP and return a structured blocker.

RETURN: per-item status, the lightbox reuse-or-new decision with evidence,
envelope details, test/build/lint/CRLF results, screenshot list, commit SHA.
