# Implementation Plan — Global Scoreboard Redesign

Four phases. Phase 1 is pure frontend and ships independently. Phases 2–4 each need backend work.

Every phase is independently shippable — nothing here requires a big-bang cutover.

---

## Phase 1 — Quick wins (frontend only, no API changes)

Rebuilds the card. No backend work, no new endpoints. This alone fixes most of what's wrong with the page today.

**Files:** `admin-ui/src/pages/GlobalScoreboard.tsx`, `admin-ui/src/index.css`

1. **Add the two medal tokens** to the `@theme` block in `index.css`:
   ```css
   --color-medal-silver: #c0c0c0;
   --color-medal-bronze: #cd7f32;
   ```
2. **Rewrite `GameCard`** per README → *Components → Game card*:
   - Art block first at `110px`, title overlaid on a bottom scrim — delete the centered text stack above the image
   - Collapse empty podium slots — no more `—` placeholders for missing 2nd/3rd
   - Replace the podium grid with `LBRow` rows (ranks 1–6)
   - Scores go from 10–11px to 11px minimum in rows, 14px for the #1 line
   - `text-wrap: pretty` on titles
   - One platform pill on the art; drop the footer pill stack
   - Remove the `StarRating` row entirely
   - Footer: `{n} scores` + a **solid** `bg-neon-cyan` Submit button
3. **Fix `RANK_STYLES`** — 3rd place uses `text-medal-bronze`, 2nd uses `text-medal-silver`. Strip any remaining emoji from the labels.
4. **Replace the sort `<select>` with sort pills.** Same `SortMode` values, visible state, one click. Keep the room-scope `<select>` as-is.
5. **Card hover:** `border-color` → `neon-cyan/60`, 150ms transition.

**Acceptance criteria**
- [ ] A game with exactly one score renders one row and no placeholder dashes
- [ ] A game with zero scores renders the dashed `Claim 1st →` CTA
- [ ] No score text renders below 11px anywhere on the card
- [ ] 3rd-place medal reads as warm brown, not pink
- [ ] No `StarRating` on the scoreboard; still present and functional on `GlobalGameDetail`
- [ ] Submit button is solid cyan and is the highest-contrast element in the card footer
- [ ] Long game titles (e.g. *Teenage Mutant Ninja Turtles*) wrap to two lines without pushing the card taller than its grid row
- [ ] No emoji rendered anywhere on the page
- [ ] Existing behavior intact: `?room=` scope sync, `score:new:global` toast, Load More pagination, `SubmissionSheet` launch

---

## Phase 2 — Search palette

The critical path for "post my score." Frontend-heavy; one server-side search improvement.

**Files:** `GlobalScoreboard.tsx` (or extract a `GlobalSearchPalette.tsx`), search handler in `src/`

1. Promote the search field: `48px`, cyan border, glow, `⌘K` hint. Full width above the filter row.
2. Build the palette overlay per README → *View 3*: focused field treatment, blinking caret, results dropdown, keyboard-hint footer, dimmed background grid.
3. Keyboard handling: `⌘K`/`Ctrl+K` open, `Esc` close, `↑`/`↓` navigate with wrap, `↵` → `SubmissionSheet`, `⌘↵` → detail page.
4. Reuse the existing 300ms debounce.
5. Server: extend `search` matching to `manufacturer` and `year`; support combined tokens like `"stern 1995"`; return `total_matches`.

**Acceptance criteria**
- [ ] `⌘K` from anywhere on the page opens the palette with the input focused
- [ ] `"haunt"` returns *Haunted House*; `"stern 95"` returns Stern titles from 1995
- [ ] Top result is pre-selected; `↵` opens `SubmissionSheet` for it without a mouse
- [ ] `↑`/`↓` moves selection and keeps it visible **without using `scrollIntoView`**
- [ ] `Esc` closes cleanly and restores grid opacity
- [ ] Palette is usable on touch — the dropdown doesn't get trapped behind the mobile keyboard
- [ ] Screen reader: input has `role="combobox"`, results have `role="option"` with `aria-selected`

---

## Phase 3 — Pins + personalization

The retention lever. Needs the pins API from `API_CHANGES.md` §1 and §2.

**Files:** `GlobalScoreboard.tsx`, new `PinnedRail.tsx`, `src/` routes + migration

1. Ship the schema + endpoints from `API_CHANGES.md` §1.
2. Add `is_pinned`, `my_rank`, `my_score`, `neighbors` to the scoreboard payload (§2).
3. Add `sort=pinned` and make it the default for authenticated viewers.
4. Build the **My Pins rail** per README → *View 2*. Unlimited pins, horizontal scroll, rank-delta badges, `Manage` link.
5. Add the **pin hotspot** to card art (logged-in only), optimistic toggle with revert-on-failure.
6. Add the **"YOU" row** to cards when `my_rank` is present.
7. Action-oriented subhead with the rank-change count.

**Acceptance criteria**
- [ ] Pinning from a card immediately adds a chip to the rail with no full refetch
- [ ] Unpinning removes it; both survive a page reload
- [ ] Pinning is unlimited — no cap, no cap messaging
- [ ] Rail scrolls horizontally past ~6 pins without breaking page layout
- [ ] `TrendingUp` shows green for improved rank, `TrendingDown` coral for dropped, nothing when unchanged
- [ ] Logged-in default sort is `Pinned first`; pinned games appear at the front of the grid **and** in the rail
- [ ] Logged-out users see no rail, no pin buttons, and `Popular` as default sort
- [ ] Pin button hit area is at least 44px on touch viewports
- [ ] A failed pin request reverts the optimistic state and surfaces a toast

---

## Phase 4 — Density toggle, hero, alerts

Polish plus the notification loop.

**Files:** `GlobalScoreboard.tsx`, `src/` submit handler, Lobby feed types

1. **Top 6 / My Score toggle** — single page-level segmented control. Client-side switching using `neighbors` from the payload. Persist to `localStorage` + server prefs. Hidden when logged out. Handle all four edge cases in README → *Leaderboard density*.
2. **Hero card** — `2 × 2` span at grid position 1, selecting the game with the most scores in the trailing 7 days. `HOT` badge, `+{n} scores this week`, champion block, three-button row.
3. **Live indicator** — magenta pulse dot + `updated {n}s ago`, driven off the last socket event.
4. **Grid / Compact density toggle** — the table layout from `DirC_LeaderboardList.jsx`. Persist per user.
5. **Rank-change alerts** — `API_CHANGES.md` §3. Lobby bell via the existing `lobby:event` channel, Discord DM via the existing opt-in. 5-minute coalescing. No email.

**Acceptance criteria**
- [ ] Toggling Top 6 ↔ My Score updates every card at once with no network request
- [ ] My Score mode always shows your row when you have a score on that game
- [ ] Ranked 1–3: no break line, ranks 1–5 shown
- [ ] No score on that game: dashed `NO SCORE YET` + qualifying threshold
- [ ] Fewer than 6 total scores: all rows shown, no break line, both modes
- [ ] Toggle choice survives reload and follows the user across devices
- [ ] Hero picks a genuinely trending game, not just the first row of the result set
- [ ] A rank change on a pinned game produces exactly one Lobby feed item within the coalescing window
- [ ] Lobby nav dot appears for unread rank changes and clears on visit
- [ ] Users are never alerted about their own submissions
- [ ] Discord DM respects the existing opt-in flag
- [ ] `prefers-reduced-motion` disables the caret blink and the live-dot pulse

---

## Responsive notes

The mocks are drawn at 1200px. Below that:

| Breakpoint | Grid | Hero | Rail | Toggle |
|---|---|---|---|---|
| `lg` (≥1024) | 4 cols | spans 2×2 | horizontal scroll | inline with sort |
| `md` (≥768) | 3 cols | spans 2×2 | horizontal scroll | inline |
| `sm` (≥640) | 2 cols | spans 2×1 | horizontal scroll | wraps below filters |
| base | 1 col | full width, no span | horizontal scroll | full-width segmented |

- Card art height can shrink to `90px` on the single-column layout.
- The search bar stays `48px` at every size — it's the primary control.
- Sort pills become a horizontally scrollable row on narrow screens rather than wrapping to three lines.
- All tap targets ≥44px on touch.

---

## Suggested commit sequence

```
feat(scoreboard): add medal-silver and medal-bronze theme tokens
refactor(scoreboard): rebuild GameCard — art-first, collapsed empty states
feat(scoreboard): replace sort dropdown with sort pills
feat(scoreboard): command-palette search with keyboard submit
feat(api): extend global search to manufacturer and year
feat(api): global game pins — schema, endpoints, scoreboard payload
feat(scoreboard): My Pins rail and per-card pin action
feat(scoreboard): Top 6 / My Score leaderboard density toggle
feat(scoreboard): broadcast hero card for trending game
feat(api): rank-change alerts via lobby feed and Discord DM
```
