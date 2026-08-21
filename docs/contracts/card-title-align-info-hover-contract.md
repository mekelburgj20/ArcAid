# Contract: Card title alignment + info-popup hover (v2.34.0)

Two small FE-only deliverables. No backend changes, no migration (113 stays free).

## D1 — Reserved two-line title box (all three card styles)

Problem: card titles are normal-flow blocks; a wrapping title (e.g. "Black Knight Sword of Rage (Stern, 2019)" at 380px) pushes the card's meta row + podium/leaderboard content down ~1 line vs sibling cards, breaking horizontal alignment across the row.

Fix, applied to `ShowcaseCard.tsx` (title area ~:179-233), `BannerCard.tsx`, and `MinimalCard.tsx` (locate each one's title render):

1. Wrap/extend the title element so its container reserves exactly two lines: `minHeight: 2 * 1.2 * <that card's effective title font size>` — computed from the SAME expression the fontSize uses (e.g. `titleFontSize || 18` in ShowcaseCard; find each card's actual default — do NOT hardcode 43px). Title vertically centered within the reserved box (the title elements are already flex; add the vertical centering the cleanest way per component).
2. Clamp the title TEXT to 2 lines so a 3-line title can't re-break alignment: put `displayName` in an inner `<span>` with `display: -webkit-box; WebkitBoxOrient: 'vertical'; WebkitLineClamp: 2; overflow: hidden;`. The `GameInfoPopup` icon stays OUTSIDE the clamped span, still inline in the flex row (it must remain hoverable/clickable). lineHeight stays 1.2.
3. Preserve everything else byte-for-byte: `titleLinkTo` Link vs `<h2>` branches, `getTitleStyleClass`, theme color/shadow spreads, ShowcaseCard's `hasFloatImage` padding variant, `scoreboard-card-slot` wrappers, `qrTopPad`, card widths.

Acceptance: in a row of cards with 1-line and 2-line titles, the meta row (badge + timer) and first podium slot/leaderboard row start at identical y across cards, in all four layouts (grid/vertical/hscroll/kiosk) and at ≤640px mobile. Single-line titles sit vertically centered in the 2-line box.

## D2 — GameInfoPopup: hover-intent open with grace period

Locate `GameInfoPopup` (referenced from the card components; likely in `ScoreboardComponents.tsx`). Current behavior: click-to-toggle. New behavior:

1. **Pointer (mouse) hover:** popup opens on hover of the "i" icon (small open delay ~100ms to avoid flicker on pass-through), and stays open while the pointer is over the icon OR the popup itself. When the pointer leaves both, close after a **~300ms grace period** — long enough to travel from icon into the popup to click the source link (the user's explicit requirement). Implement with a shared close-timer cleared on re-enter of either element; clean up timers on unmount.
2. **Touch:** `mouseenter` misfires or doesn't exist on touch — KEEP the existing tap-to-toggle behavior as-is (tap opens, tap outside / tap again closes). Guard the hover handlers so touch devices don't get a double open/close (e.g. pointer-event `pointerType` check or `matchMedia('(hover: hover)')` gate — pick the approach most consistent with the codebase's existing `[@media(hover:none)]` idiom from S20).
3. **Keyboard/a11y:** keep or add: icon focusable, Enter/Space toggles, Escape closes (match the S20 dialog/expand patterns already in the codebase). Do not regress whatever exists.
4. **Event containment:** the icon lives INSIDE the title `<Link>` — hover/click on icon or popup must not navigate. Preserve/extend the existing stopPropagation/preventDefault discipline. Links inside the popup must remain clickable (that's the point of the grace period).
5. Popup positioning/content unchanged.

Acceptance: mouse-hover the icon → popup appears; move pointer into popup → stays open; click the external link → navigates (new tab per existing behavior); move pointer away → closes after ~300ms. On touch: tap icon → opens, tap elsewhere → closes. Title link still navigates when clicking the title text itself.

## Tests

- If a lightweight component test is feasible with the existing vitest+jsdom harness (check how existing admin-ui tests mount components), add one for the grace-period logic using fake timers (hover icon → open; leave → still open at 200ms → closed after 400ms; re-enter popup within grace → stays open). If the harness can't express hover semantics cleanly, skip — note it in the report — and rely on the acceptance checks.
- Existing suites must stay green: admin-ui build + `npx vitest run` (56 currently), root build, `docker compose build`.

## Process

1. Branch `card-title-align-info-hover` off current `main`.
2. Implement D1 + D2. Gates. Version → **2.34.0** (Edit tool). No CHANGELOG edit.
3. Commit(s) `feature:` prefix. Do NOT push, do NOT open PR.
4. Report: files + summaries, discretionary decisions, verbatim gate results, commit SHA(s), deviations/blockers. STOP on semantic conflicts.

Repo hygiene: NEVER `git add -A`; no SW bump; admin-ui is ESM.
