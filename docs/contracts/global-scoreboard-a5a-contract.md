# Contract: Global Scoreboard — hero card, density toggle, live indicator (v2.57.0, phase A5a)

Track A phase **A5**, first half. Plan: `C:\Users\mekel\.claude\plans\transient-crafting-barto.md`
(Context, A0 corrections, A5). Design: `tmp/ArcAid UX/design_handoff_global_scoreboard/README.md`
→ *Hero card*, *Leaderboard density*, *Live indicator*; `screenshots/06-hero-card.png`,
`08-toggle-top6.png`, `09-toggle-my-score.png`.

## Scope

**In:** the hero card, the Top 6 / My Score density toggle, the live indicator.
**Out — do not build or stub:** the Grid/Compact table layout and rank-change alerts. Both are A5b;
alerts in particular carry a notification-system blast radius that stays isolated.

The A0 corrections still bind: provider-agnostic copy, "Arcaid" casing, `PLATFORM_GROUPS` **keys**,
all colours via tokens (light mode must work — no literal rgba).

## 1. Hero card

Spans 2×2 at grid position 1, per the design: full-bleed art with the 90° scrim, badges top-left,
platform pills top-right, and a bottom-aligned content block (eyebrow, title, champion block with
avatar/name/score/`+delta over #2`, and a three-button row: Submit / Pin / Full leaderboard).

### Selection — deviates from the design deliberately

The design says "most scores submitted in the trailing 7 days" with a `HOT` badge and
`+{n} scores this week`. **Verified against prod: the trailing week has one game with 5 scores and
three with 1 each.** Applied literally, a quiet week crowns a game with a single score and stamps it
HOT — the badge becomes noise and the acceptance criterion ("a genuinely trending game, not just the
first row") fails.

Therefore:
- Compute trailing-7-day score counts per game (column is **`global_scores.submitted_at`** — there is
  no `created_at`).
- **If the top game clears a minimum of 3 scores in the window** → hero is that game, with the `HOT`
  badge and `+{n} scores this week`.
- **Otherwise** → hero is the highest `score_count` game in the current result set, rendered with a
  **neutral eyebrow and no HOT badge, no weekly delta**. A hero card is good page structure
  regardless; it just must not claim heat it doesn't have.
- **If the result set is empty** → no hero, plain grid.
- Put the threshold in a named constant with a comment explaining the sparse-data reasoning, so it's
  tunable as the community grows.

### Delivery
Add a `hero` object to the existing `/api/global/scoreboard` response **only when `offset === 0`**
(it is page-1 content; sending it on every page wastes work). It must respect the **same filters**
as the grid — platform group, room scope, search — so a filtered view gets a coherent hero rather
than a global one. `null` when there is nothing to show.

Reuse `optionalDiscordUser` (already on the route) so an authenticated viewer's hero carries
`is_pinned` / `my_rank` like any other card. Anonymous payload shape must stay unchanged apart from
the additive `hero` key — assert it.

## 2. Top 6 / My Score density toggle

Page-level segmented control (`Trophy` Top 6 / `MapPin` My Score). **Hidden entirely when logged
out.** Top 6 is the default.

`neighbors` already ships on the payload from A4 — **the toggle must flip client-side with no
refetch**. That is the whole point of having shipped it early; a network round-trip per toggle makes
the control feel broken.

Handle all four edge cases from the design:
- Viewer ranked 1–3 → no break line, show ranks 1–5.
- Viewer ranked 4 → contiguous, no break line.
- Viewer has no score on that game → dashed prompt: `NO SCORE YET` plus
  `#{lastQualifyingRank} needs {score} to qualify`.
- Fewer than 6 total scores → show all, no break line, in either mode.

Break line: dashed top border, centred `· · ·`. Persist the choice per the A0 #8 correction —
`/api/me/scoreboard-preferences` with a **namespaced** key (`global_density`), never
`/api/me/preferences` (theme-only, admin-scoped, would 400).

## 3. Live indicator

Magenta filled `Circle` beside the `h1` plus a `LIVE · updated {n}s ago` line. Drive `{n}` off the
timestamp of the last received `score:new:global` event, falling back to the initial fetch time.
Reuse the existing `.pulse` class — `index.css` already nulls it under `prefers-reduced-motion`, so
no new guard is needed for the dot.

Do **not** add the `{total} games · {playerCount} players` line from the design: there is no
player-count API and inventing one is out of scope.

## Tests

- Hero: chosen game clears the threshold → HOT badge and weekly delta present; below threshold →
  neutral hero, **no** HOT badge, **no** weekly delta; empty result set → no hero; hero respects an
  active platform filter; `hero` absent when `offset > 0`; anonymous payload otherwise unchanged.
- Density toggle: flips with **zero** additional network requests (assert the fetch count); each of
  the four edge cases renders correctly; hidden when logged out; choice persists via the namespaced
  preference key.
- Live indicator: text updates from a simulated socket event; the dot carries the `.pulse` class.
- Baselines stay green: backend **876**, admin-ui **216**.

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD) · **no commit/branch/push**.

## Visual verification

Extend the existing `tmp/global-scoreboard-harness.js` (do not write another). Capture to
`tmp/global-scoreboard-shots/`: `hero-desktop-dark.png`, `hero-desktop-light.png` (1440×900),
`hero-mobile-dark.png` (390×844), plus `density-top6.png` and `density-myscore.png` showing the same
cards in both modes with a viewer ranked outside the top 6. Freeze animations for stable stills.

## Blockers policy

STOP and report if the trailing-7-day aggregate can't be computed without a new index or an
unacceptably slow scan, or if `neighbors` turns out to be insufficient for any of the four density
edge cases. Do not expand into A5b (Grid/Compact, alerts).
