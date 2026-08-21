# Admin Leaderboard: arrow-overlay fix + drag-to-reposition cards (v2.118.0) — design, 2026-08-20 session #86

Owner report (verbatim-in-substance): with the Display-settings rail open, the `<`/`>` card-strip overlays sit on top of the rail and eat clicks. Remove the overlays in this view; replace with a fixed bottom scrollbar + hand drag-to-scroll. Plus drag-to-reposition of score cards as a manual override of tournament-config order; editing tournament position values resets it; a tournament's next rotation resets its cards; a multi-slot tournament's manual order survives until that rotation.

Recon facts this design rests on (file:line verified 2026-08-20):
- Order = `COALESCE(g.display_order, t.display_order, 9999) ASC, g.start_date ASC` in `LeaderboardService.getActiveLeaderboards` (`src/services/LeaderboardService.ts:699-734`), retained COMPLETED cards inherit the tournament's order (`:769,:810`), combined stable sort at `:818-820`, dedupe `:824-829`. Pins all land on 9999. `games.display_order` has NO writer anywhere — leave it alone (do not start writing it).
- No FE re-sort except search relevance (`ScoreboardSurface.tsx:250-252`).
- Arrows: `HorizontalScrollNav.tsx` — `fixed z-40` portalled to body (`:313-352`, `:126`), right arrow width = `viewportWidth - wrapperRect.right + zone` (`:283`) = the rail column. Rail: `Leaderboard.tsx:440`, sticky, no z-index. Drag-to-scroll ALREADY exists in `HorizontalScrollNav.tsx:187-251` (mouse only, 5px threshold, 100ms click suppressor after a drag). Sole render site `ScoreboardSurface.tsx:676-691`, scroll layout only.
- No drag library installed; no `draggable`/dragstart anywhere. Precedent for order persistence: `PUT /:roomId/queue/reorder` (`rooms.ts:1097-1163`) takes the full id list.
- Rotation has no single choke point (activateGame `:153`, two maintenance promotions `:1521,:966`, auto-pick insert `:2051`, TimeoutManager in-place updates ×2) and only the two engine paths emit `game:rotated` (global). Kiosk does NOT listen to `game:rotated`; all three surfaces listen to `leaderboard:updated` (room-scoped).
- `game_room_settings` JSON-valued precedent: `LOBBY_*` keys via `GameRoomSettingsService.set(roomId, key, JSON.stringify(...))`. `SCOREBOARD_*`/`KIOSK_*`/`LOGO_*`/`GLOBAL_CARD_*` prefixes are auto-public via `/scoreboard-config` — so the new key must NOT use those prefixes (and must not trip the rail's managedKeys coverage test).

## Part A — arrows off in the admin view, fixed bottom scrollbar, hand drag

1. `HorizontalScrollNav` gains `showArrows?: boolean` (default `true`) and `onScrollMetrics?: (m: { scrollLeft, scrollWidth, clientWidth, left, width }) => void` (fires on scroll/resize/children change — reuse its existing overflow-detection observers). `ScoreboardSurface` gains `hscrollArrows?: boolean` (default true) and `onHscrollMetrics?`, passed through. The admin Leaderboard page passes `hscrollArrows={false}` ALWAYS (not only when the rail is open — the owner said "in this view"). Public Scoreboard + kiosk unchanged.
2. New `admin-ui/src/components/scoreboard/FixedHScrollbar.tsx`: a viewport-fixed track (`position: fixed; bottom: 0; z-30`) whose `left`/`width` track the scroll wrapper's own horizontal extent (so it never spans under the rail), 10px tall with a 16px hit area, theme tokens (`bg-surface/80 border-t border-border`, thumb `bg-primary/60 hover:bg-primary`), thumb width = clientWidth/scrollWidth × track, position from scrollLeft. Pointer-event drag on the thumb (`setPointerCapture`, works for touch), click on the track = page-jump, hidden entirely when `scrollWidth <= clientWidth + 1`. Rendered by the admin page only, only when the surface's effective layout is `scroll` (Banner forces scroll; see `ScoreboardSurface.tsx:242`). Respects the mobile bottom sheet: when the sheet is mounted (viewport < 1024 and panel open) the scrollbar sits just above the sheet's peek height or is hidden — simplest: hide it while the sheet is open (phone users scroll by touch anyway).
3. Hand drag-to-scroll: already there for mouse (`cursor: grab`). Keep. Do NOT add touch drag-to-scroll (native touch scrolling already works and would fight the reorder gesture).

## Part B — drag-to-reposition as a self-invalidating manual order override

### Storage
One `game_room_settings` key **`LEADERBOARD_CARD_ORDER`** (deliberately NOT `SCOREBOARD_*` — stays out of the public config allowlist and out of the rail's managedKeys). Value JSON:
```jsonc
{
  "v": 1,
  "savedAt": "2026-08-20T17:10:00.000Z",
  "order": ["<games.id>", "..."],                 // every card id the admin saw, in the manual order
  "tournaments": {                                 // fingerprint for self-invalidation
    "<tournament_id>": { "displayOrder": 0, "activeGameIds": ["<id>", "<id>"] }   // activeGameIds sorted
  },
  "pins": ["<games.id>"]                           // pinned (tournament_id NULL) card ids present at save
}
```
Written by `CardOrderService.save(roomId, orderedIds)` which (inside one read) loads the current ACTIVE rows for the room grouped by tournament, validates `orderedIds` ⊆ current card ids (ACTIVE + retained COMPLETED — take the ids from `getActiveLeaderboards(roomId)` itself so the set is exactly what the admin saw), and stores the fingerprint. Empty-string `set` deletes (existing service semantics) — `CardOrderService.clear(roomId)`.

### Read-time application (no mutation hooks — the data tells us when it is stale, ADR 0013 style)
In `LeaderboardService.getActiveLeaderboards`, after the combined sort + dedupe (`:818-829`), call `applyCardOrderOverride(allGames, override, currentState)` where `currentState` = `{ tournaments: {id → {displayOrder, activeGameIds}}, pinIds }` computed from the rows the method ALREADY fetched (no extra game query; ONE extra `GameRoomSettingsService.get` for the key — skip entirely when `gameRoomId` is undefined). Pure function in `src/services/CardOrderService.ts`, unit-tested exhaustively:

1. **Whole-override discard** when ANY tournament present in both the stored fingerprint and the current state has a different `displayOrder` → return the default order untouched. (Rule: "edit the position values → reset to tournament order". A tournament that was deleted or deactivated since save simply no longer participates.)
2. **Per-tournament drop**: for each stored tournament whose current `activeGameIds` (sorted) ≠ stored → remove that tournament's card ids from `order` (rotation happened: promotion, deactivate, delete, auto-pick, TimeoutManager — every path, including Discord, because it is derived from state, not from hooks). Pins are never dropped (unpin just removes the id from the list).
3. **Slot-fill merge**: let D = default order (cards as sorted today), L = remaining `order` filtered to ids present in D. Let S = the positions in D occupied by L's ids (ascending). Output = D with positions S refilled by L's ids in L's order; every other card keeps its default position. Worked example: D=[DG′,WG1,WG2,MG], L=[WG2,WG1,MG] → S=[1,2,3] → [DG′,WG2,WG1,MG]: the rotated DG returns to its configured slot, the manual WG/MG order survives. D=[DG′,WG1,WG2,MG], L=[MG,WG1,WG2] → [DG′,MG,WG1,WG2].
4. `applied: boolean` returned alongside, surfaced to the FE (see API) so the page can show "Manual order".

The read path never writes. A stale stored override is simply ignored each read and overwritten by the next drag; `clear` is available to the admin. (Add a ROADMAP note: lazy self-clean of a fully-invalidated blob is a possible follow-up, not needed.)

### API (`rooms.ts`, `requireAuth + requireRoomAccess('roomId')`, audited)
- `GET  /:roomId/admin/leaderboard/card-order` → `{ active: boolean, savedAt: string|null }` — `active` = an override exists AND survives validation against current state (run the same pure function on the current boards).
- `PUT  /:roomId/admin/leaderboard/card-order` body `{ gameIds: string[] }` (Zod: non-empty array of non-empty strings, max 200, unique) → validates ⊆ current card ids (400 naming the strays), saves, `emitLeaderboardUpdated(roomId, {})` (room-scoped — public Scoreboard, kiosk AND the admin page all refetch on it), returns `{ active: true, savedAt }`. Audit action `leaderboard.card_order_set`.
- `DELETE /:roomId/admin/leaderboard/card-order` → clear + same emit. Audit `leaderboard.card_order_clear`.
- `GET /:roomId/leaderboard` response is unchanged in shape (array) — order is simply applied. Do NOT add fields to the array items.

### FE — admin Leaderboard page only
- **Handle, not whole-card drag.** The admin under-card controls strip (`renderUnderCard`, v2.85.0, `LeaderboardAdminControls`) gains a leading grip (`GripHorizontal` lucide, `aria-label="Drag to reorder"`, 44px hit target, `touch-action: none`, `cursor: grab`). Pointer events (`pointerdown` → `setPointerCapture` → `pointermove` → `pointerup/cancel`), so mouse AND touch work. `pointerdown` on the handle calls `stopPropagation()` so `HorizontalScrollNav`'s drag-to-scroll never engages, and `preventDefault()` so text selection doesn't start.
- **Mechanics**: on start, snapshot every card slot's bounding rect (slots carry the shared card-slot class — see `ScoreboardWysiwygParity.test.tsx:262` for its name) keyed by game id; lift the card (`transform: scale(1.03)`, shadow, `z-20`), render a translucent placeholder at the target index; on move, target index = the slot whose center is nearest the pointer (Euclidean — works for grid, vertical and horizontal layouts alike); near the scroll wrapper's left/right edge (within 48px) auto-scroll it ±8px/frame via rAF. On drop: compute the new FULL order from the page's full `leaderboards` array (server order), moving the dragged id to sit immediately before/after the target id — robust to `hideEmpty`/search filtering hiding some cards. Optimistic local reorder, then `PUT`; on failure revert + toast. Disable the handle while the search box has text (the surface re-sorts by relevance then; dragging would be meaningless).
- **Status + reset**: a small chip in the page header / rail top: "Manual order · Reset" when `active`; clicking Reset → confirm → `DELETE`. Refetch `card-order` on `leaderboard:updated`.
- **Keyboard parity (a11y, S20 doctrine)**: the handle is a button; ArrowLeft/ArrowRight (and Up/Down) move the card one position; Enter/Space no-op; announce via an `aria-live="polite"` region ("Bad Cats moved to position 2 of 6").
- Mobile (Q4 first-class): touch drag on the handle works in all layouts; the auto-scroll edges use the wrapper rect; the fixed scrollbar hides while the sheet is open.

### Explicitly unchanged
Public Scoreboard and kiosk keep their arrows and get the new ORDER only (via the endpoint). `TournamentEngine.reorderIScoredLineup` (the iScored lineup) is a different rule and is NOT touched — note in CHANGELOG that the manual order affects Arcaid boards only, not the iScored lineup. `games.display_order` stays unwritten.

## Tests
BE (vitest, in-memory DB helpers): `card-order-override.test.ts`
1. slot-fill merge: the two worked examples above + ids missing from D are skipped + L empty → D.
2. display_order change on any fingerprinted tournament → whole override discarded; a tournament deleted since save does not trigger discard.
3. rotation: changing a tournament's active set (promotion, deactivate, delete) drops only that tournament's ids; other tournaments' manual order survives; pins survive; unpinned id vanishes harmlessly.
4. `getActiveLeaderboards` end-to-end: save an order via the service → the endpoint's array comes back in manual order → rotate one tournament (insert a new ACTIVE row, complete the old) → that tournament's card is back in its tournament slot, the others keep manual order.
5. PUT validation: stray id → 400 naming it; success emits `leaderboard:updated` once with the roomId (mock websocket like `settings-broadcast.test.ts`); DELETE clears + emits. Room-access gate (other room's admin → 403).
6. multi-slot: WG with 2 ACTIVE slots, manual swap A↔B survives an unrelated tournament's rotation and a settings save; both WG slots rotating drops it.

FE (vitest + RTL, existing harness; `stubResizeObserver`):
7. `HorizontalScrollNav showArrows={false}` renders no arrow buttons even when overflowing + hovered; default still does (extend `HorizontalScrollNav.test.tsx`).
8. admin Leaderboard passes `hscrollArrows={false}` (parity test: public still renders arrows — extend `ScoreboardWysiwygParity.test.tsx`).
9. `FixedHScrollbar`: hidden when no overflow; thumb width/position math; thumb drag changes `scrollLeft`.
10. Drag handle: pointerdown on the handle stops propagation (spy on the wrapper's mousedown) · a pointer sequence over slot rects yields the expected `PUT` body (full order, moved id before target) · search text disables the handle · keyboard ArrowRight moves one slot and announces.
11. "Manual order · Reset" chip renders only when `GET card-order` says active; Reset calls DELETE.

## Screenshot loop (pre-PR, mock data, per `feedback_rapid_ui_iteration`)
Desktop 1440 with the rail OPEN: (a) no arrow overlay over the rail, rail controls clickable (assert by clicking a toggle in the rail via Playwright — it must change), (b) fixed scrollbar visible at the bottom spanning only the surface column, (c) mid-drag frame (lifted card + placeholder), (d) after-drop order + "Manual order · Reset" chip. Phone 390: (e) sheet open at half snap — no scrollbar under it, (f) touch drag on the handle reorders. Measure: no horizontal document scroll at 390 (the C1 regression class).
