# Contract: My Pins — full cards in a carousel (v2.55.0)

User feedback on the v2.52.0 pinned rail: the 220px chips should be **full-size cards identical to
the grid below**, arranged as a carousel that **cycles like the landing page ticker but only when the
cards overflow the screen**, and on mobile shows **one full card at a time with swipe**.

## 1. Backend — pins need the score rows

`GlobalPinService.list()` currently returns `top_player` (the champion only) because the old chip
showed one score. The full card renders ranks 1–6. It already calls the batched
`getTopScoresForGames` and slices `[0]` — return the first **6** as `top_scores[]` instead.

Keep `top_player` **only if** something still consumes it; otherwise remove it rather than shipping
two representations of the same data. Keep `my_rank`, `my_score`, `rank_delta`, `pinned_at`.

The rail's card must be able to render the "YOU" row exactly as the grid does, so whatever the grid
card needs from a game object, the pins payload must now carry.

## 2. Extract the card — one component, two callers

`GameCard` currently lives as a local function in `admin-ui/src/pages/GlobalScoreboard.tsx` (~line
664), with `LeaderboardRow` (~597) beside it. Extract both to
`admin-ui/src/components/GlobalGameCard.tsx` and have **both the grid and the rail import it**.

This is the requirement, not an optimization: "the pinned cards need to look the same" is only
durably true if they are literally the same component. Do not copy it.

Props stay as they are (`game`, `onSubmit`, `onTogglePin`). If the rail needs a variant (e.g. the pin
button always showing as pinned), add a narrow prop rather than forking the component.

## 3. The carousel

New `admin-ui/src/components/PinnedCarousel.tsx`, replacing `PinnedRail.tsx`'s chip markup. Keep the
existing section chrome (the "MY PINS — N games watched" header, the amber-tinted container) and the
trailing dashed **add tile**, which still opens the ⌘K palette.

### Desktop
- Cards render at the **same width as the grid cards** (reuse whatever the grid uses — do not
  hardcode a second number).
- **Auto-cycle only when the content overflows the container.** Measure with a `ResizeObserver` on
  the container plus the content width; when content ≤ container, render a plain static row with no
  animation and no duplicated list.
- When it does overflow, use the landing page's technique (`LandingPage.tsx` ~289, ~316, ~364):
  duplicate the list once, animate `translateX(0)` → `translateX(-50%)` with `linear infinite`, speed
  proportional to card count so more pins don't mean faster travel.
- **Pause on hover, on focus-within, and on touch.** These cards carry Submit buttons, pin toggles
  and clickable titles — a card sliding out from under a click is a real usability failure, unlike
  the landing page's decorative tiles. This is required, not optional.
- **`prefers-reduced-motion`: no auto-cycle at all** — fall back to a manually scrollable row. Follow
  the scoped inline `<style>` convention used by `LandingPage.tsx` ~369 and `TourOverlay.tsx`.
- Duplicated cards must be `aria-hidden` and non-focusable (`tabIndex={-1}` on interactive children)
  so screen readers and keyboard users don't meet every pin twice.

### Mobile (< 640px)
- **One full-size card per view**, horizontally swipeable: `overflow-x-auto` + `scroll-snap-type: x
  mandatory` with `scroll-snap-align: center` on each card. Native momentum, no JS drag handling.
- **No auto-cycle on mobile** — auto-advancing under a reader's thumb is worse than useless. Swipe
  only. (If this contradicts the request, flag it rather than auto-cycling.)
- Cards must not be clipped: the snap container needs horizontal padding so the first and last cards
  center properly.
- The add tile stays as the final snap item.

### Both
- The section is hidden entirely when the viewer has zero pins (current behavior — keep it).
- Unpinning from within the carousel removes the card without a full refetch (current optimistic
  behavior — keep it).

## 4. Known cost to flag, not solve

Full cards are ~3-4× the height of the old chips, so the pins section pushes the search field and
grid substantially further down the page. That is inherent to the request. Do **not** add a
collapse/expand affordance or a height cap on your own initiative — build it as specified and note
the vertical cost in the final report with a screenshot so the user can judge.

## Tests

- Pins payload carries `top_scores` (≤6) and the card renders rows from it.
- Carousel does **not** animate when content fits; does animate when it overflows (assert on the
  presence/absence of the animation, and that the list is only duplicated in the overflow case).
- Reduced-motion disables the animation.
- Hover/focus pauses it.
- Duplicated cards are `aria-hidden` and not keyboard-reachable.
- Zero pins → section hidden.
- Existing suites stay green: backend **862**, admin-ui **193**.

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD) · **no commit/branch/push**.

## Visual verification

Extend `tmp/global-scoreboard-harness.js` (do not write another). Capture to
`tmp/global-scoreboard-shots/`:
- `pins-carousel-desktop-dark.png` (1440×900) — **6+ pins so it overflows and animates**
- `pins-carousel-fits-dark.png` (1440×900) — **2 pins, must NOT animate**
- `pins-carousel-mobile-dark.png` (390×844) — one card per view
- `pins-carousel-desktop-light.png` (1440×900)

Freeze animations for stable stills (`animation-play-state: paused` + a negative `animation-delay`,
the technique used for the landing-page glitch shots).

## Blockers policy

STOP and report if the grid card can't be extracted without changing its rendering, or if the pins
payload needs data the batched query can't cheaply provide. Do not expand into A5 scope (hero card,
density toggles, alerts).
