# Contract: Global Scoreboard — search palette (v2.51.0, phase A3)

Track A phase **A3** of the approved plan
(`C:\Users\mekel\.claude\plans\transient-crafting-barto.md` — read the Context, the A0 corrections
table, and the A3 section). Builds on A1+A2 (already on this branch's parent).

Design source: `tmp/ArcAid UX/design_handoff_global_scoreboard/README.md` → **View 3 — Search active
(command palette)**, plus `screenshots/04-search-palette.png` as the visual litmus. As with A1/A2,
translate the prototype's inline styles into Tailwind + our tokens — do not copy them.

## Scope

**In:** the ⌘K palette on `/scoreboard`, and the one server-side search improvement it needs.
**Out — do not build or stub:** pins, pinned rail, `sort=pinned`, hero card, density/layout toggles,
rank alerts, the live "updated Ns ago" indicator, player counts. Those are A4/A5.

## Backend — search matching

`src/services/GlobalLeaderboardService.ts` (~line 251) currently does a 3-way `LIKE` over
`name` / `display_name` / `manufacturer`. **Manufacturer matching already works** — the handoff is
wrong that it's new. Only these are new:

1. **Year token.** A bare 4-digit token in the query (`19xx`/`20xx` range — don't treat "1000" as a
   year) matches `gg.year`.
2. **AND-combination across tokens.** Split the query on whitespace; every token must match
   *something* (name/display_name/manufacturer for word tokens, `year` for a year token). So
   `"stern 1995"` = manufacturer-ish match AND year match; `"haunt"` still matches Haunted House.
   Keep it a single SQL statement with parameterized clauses — no string interpolation of user input.
3. **Do NOT add `total_matches`.** `getTopGames` already returns `total` for the same filter set
   (verified) — reuse it. The handoff's `total_matches` is redundant.

Preserve current behavior for single-token queries so existing search UX doesn't regress.

## Frontend — the palette

New component `admin-ui/src/components/GlobalSearchPalette.tsx`, mounted from `GlobalScoreboard.tsx`.
Do not inline 300 lines into the page.

**Trigger / dismiss**
- `⌘K` (mac) / `Ctrl+K` anywhere on the page opens it, focuses the input, selects existing query text.
- Clicking the existing search field opens it.
- `Esc` closes, restores grid opacity, blurs.
- Do not hijack the shortcut while focus is in another text input (check `event.target`).

**Layout** (per View 3)
- Focused field treatment: full-strength cyan border, darker field background, cyan glow.
- Query renders in `font-mono` with a blinking 2px cyan caret. **The blink must be disabled under
  `prefers-reduced-motion`** — follow the scoped-inline-`<style>` convention used by
  `TourOverlay.tsx` / `LandingPage.tsx` (`index.css:664` already nulls `.pulse`, but this is a new
  animation and needs its own guard).
- Results dropdown: header strip (`GAMES — {n} MATCHES` left, `Press ↵ for full results` right),
  result rows, footer strip with `<kbd>`-styled hints (`↑↓ navigate`, `↵ submit score`,
  `⌘↵ open details`).
- Result row: 42×42 art thumb (use the shared `catalogueImageFor` helper from A2 — do not re-roll it),
  title + `{manufacturer} · {year} · {n} scores` meta, champion name + score on the right, and a
  Submit button (solid on the selected row, ghost on the others).
- The card grid behind dims to ~25% opacity and becomes `pointer-events: none`.
- **All colors via tokens** — this must work in light mode, same rule as A1. Verify in the light shot.

**Keyboard**
- `↑`/`↓` move selection and **wrap** at both ends.
- Selected row must stay visible by adjusting the scroll container's `scrollTop` directly —
  **do not use `scrollIntoView`** (contract requirement from the handoff; it scrolls the whole page).
- `↵` opens `SubmissionSheet` for the selected game (`target={{ kind:'global', globalGameId, gameName }}`
  — exact existing shape). If not logged in, route through the existing login affordance instead,
  provider-agnostic.
- `⌘↵` / `Ctrl↵` navigates to `/games/{global_game_id}`.

**Data**
- Reuse the existing 300ms debounce pattern. Query `/api/global/scoreboard` with the existing
  `search` param (+ current platform/scope filters — the palette should respect them) and a small
  `limit` (8–10 rows is enough for a palette).
- Show a subtle in-field spinner while a request is in flight.
- Empty query → show nothing (or a hint row), not a full unfiltered list.

**Accessibility**
- Input `role="combobox"` with `aria-expanded`, `aria-controls`, `aria-activedescendant`.
- Rows `role="option"` with `aria-selected`; the list `role="listbox"`.
- Focus trap not required (it's a dropdown, not a modal), but `Esc` must always return focus to the
  field.
- Touch: the dropdown must not be trapped behind the mobile keyboard — verify at 390px.

## Tests

- Backend: `"stern 1995"` ANDs manufacturer + year; `"haunt"` still matches by name; a 4-digit token
  outside 1900-2099 is treated as a word, not a year; multi-token queries don't SQL-error; `total`
  reflects the filtered set.
- Frontend: ⌘K opens + focuses; `Esc` closes; `↑`/`↓` wrap; `↵` opens the submission sheet for the
  selected row; typing debounces to one request; palette respects the active platform filter;
  reduced-motion disables the caret animation.
- Existing suites stay green (backend 798, admin-ui 158).

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check
(`git diff --numstat` vs `-w`, and for any file that differs, compare CR-byte counts against HEAD to
prove it's re-indentation not a flip) · **no commit/branch/push**.

## Visual verification

Extend `tmp/global-scoreboard-harness.js` (already exists, reuse it — don't write a second harness)
with a palette pass: open the palette, type a query, screenshot. Capture to
`tmp/global-scoreboard-shots/`: `palette-desktop-dark.png`, `palette-desktop-light.png` (1440×900),
`palette-mobile-dark.png` (390×844). Report paths; don't judge the visuals yourself.

## Blockers policy

If something contradicts this contract, STOP and report rather than guessing. Do not expand into
A4/A5 scope.
