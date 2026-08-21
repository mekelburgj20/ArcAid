# Contract: Engine + Device — Phase 4 (per-category cards) — v2.59.0

Delivers the **user's original request**: on the Global Scoreboard, a game with scores from different
kinds of platform gets a **card per category**, with each score tagged with the exact engine/device it
came from (that tagging shipped in P3).

Implements **ADR 0016** (`docs/decisions/0016-engine-device-score-provenance.md` — read it first).
P3 (v2.58.0) moved reads onto engine/device and introduced the fidelity categories. P4 groups by them.

## ⚠️ The trap that must not ship

**38 of 67 production global scores have `engine = 'unknown'`** — the majority. They are the
irreducible AtGames ambiguity documented in the ADR.

P3 established that `unknown` carries **no fidelity category**. If card grouping only creates cards
for the three known bands, **those 38 scores have no card and silently disappear from the site.**

Therefore: `unknown` gets its own visible bucket — an **"Unspecified"** card. It is not a fidelity
band and must never be presented as one (no claim about comparability), but the scores must remain
reachable. A test must assert that the union of all cards for a game contains **every** score that
game has. That invariant is the point of this phase.

## Grouping rule

One card per **(game, category)** where that category has at least one score:

| Situation | Cards |
|---|---|
| Scores on `vpx` and `fx` | two cards — Simulation, Arcade-Style |
| Scores on `vpx` and `vp9` | one card — Simulation (same band) |
| Scores with `unknown` engine | an **Unspecified** card |
| Mixed known + unknown | one card per known band **plus** Unspecified |
| **No scores at all** | exactly **one** uncategorised card (keeps discovery and the `Claim 1st →` CTA) |

The no-scores case falls out of the data — the existing `LEFT JOIN` yields a NULL category — rather
than needing a special branch. Do not add one.

Bands (from P3's helper, never re-derived): **Real** · **Simulation** · **Arcade-Style** ·
**Video Games** (video engines, outside the fidelity axis) · **Unspecified**.

## Backend

`GlobalLeaderboardService.getTopGames` currently does `GROUP BY gg.id`. It becomes
`GROUP BY gg.id, <category>` so each row is a (game, category) pair.

- **Derive the category expression from the TypeScript taxonomy at query-build time** — do not
  hand-write a `CASE WHEN engine IN (...)` in SQL. A hardcoded SQL copy is a fourth place the taxonomy
  can drift, and the parity test cannot see it.
- `score_count`, `top_score`, `last_submitted_at`, `popularity` become **per-category** figures. A
  Simulation card must not report the game's total score count.
- `total` and pagination now count **cards**, not games. Update the "Showing N of M" copy so it says
  what it counts — do not leave it saying "games" while counting cards.
- Each row carries a stable identity for React keys and pin lookups: `(global_game_id, category)`.
- `top_scores` / `neighbors` / `my_rank` are scoped **within the card's category**. A viewer ranked 3rd
  on Simulation and 9th on Arcade-Style must see each correctly on its own card.
- Anonymous payload stays additive.

## Filtering

The existing platform-group chips (`All platforms` · `Physical` · `Virtual Pinball` ·
`Arcade & Video`) filter *games by catalogue availability*. Replace them with **category chips** —
`All` · `Real` · `Simulation` · `Arcade-Style` · `Video Games` · `Unspecified` — filtering which
**category cards** appear. That matches the card model and removes the taxonomy the categories
supersede.

Keep the room-scope select and the search field as they are. The ⌘K palette still searches games (not
cards) — a game matches if any of its cards would.

## Frontend

- `GlobalGameCard` gains a **category label** (a small chip in the card header — this is what tells a
  player which board they're looking at). `Unspecified` should read as neutral/muted, visibly not a
  peer of the three real bands.
- Per-score engine/device tags already ship from P3 — **do not re-implement them**.
- **Pins stay keyed on the game, not the card.** Pinning from any category card pins the game, and
  every card for that game shows pinned. The My Pins rail keeps showing one card per pinned game —
  use the game's category with the most scores. Do not multiply rail entries per category.
- **The hero stays game-level.** It represents a game, not a board; render it with its highest-scoring
  category and leave A5a's threshold logic alone.
- All colours via tokens; light mode must work. No literal rgba.

## Tests

- **Coverage invariant (the important one):** for a game with scores spread across known bands and
  `unknown`, the union of all its cards contains every one of its scores, exactly once.
- Two engines in one band (`vpx` + `vp9`) → one card, not two.
- `unknown`-only game renders an Unspecified card and its scores are reachable.
- Zero-score game renders exactly one uncategorised card with the `Claim 1st →` CTA.
- Per-card `score_count` is the category's count, not the game's total.
- `my_rank` is per-category (a viewer ranked differently on two cards sees both correctly).
- Category chips filter cards; `Unspecified` is selectable.
- `total` counts cards, and pagination doesn't drop or duplicate a card across page boundaries.
- Baselines stay green: backend **924**, admin-ui **250**.

## Gates

Root `npm run build` · `cd admin-ui && npm run build` · full BE + FE vitest · CRLF check (for any file
where `--numstat` differs from `-w`, compare CR-byte counts vs HEAD) · **no commit/branch/push**.

## Visual verification

Extend `tmp/global-scoreboard-harness.js`. Capture to `tmp/global-scoreboard-shots/`:
`categories-desktop-dark.png`, `categories-desktop-light.png` (1440×900),
`categories-mobile-dark.png` (390×844). The fixture **must** include one game with scores in two
different bands (so its two cards sit adjacent and the split is visible), one game with only
`unknown` scores, and one game with no scores.

## Blockers policy

STOP and report if per-category `my_rank`/`neighbors` cannot be computed without an unacceptable query
cost, or if pagination over grouped rows can't be made stable. Do **not** touch tournament rules
(**P2**). Do not change the pin data model.
