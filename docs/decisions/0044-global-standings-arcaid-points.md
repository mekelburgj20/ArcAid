---
status: accepted (not built; B32)
date: 2026-11-27
deciders: owner (rulings 2026-11-26/27)
supersedes:
superseded-by:
---

# Global Standings: Arcaid Points, two views, and what a player's profile may hold

Plan: `docs/global-standings-plan.md` (WORK.md B32). Sits beside ADR 0023 (every score reaches the Global
Scoreboard), ADR 0027 (integrity mode) and ADR 0038 (public boards show evidence, not its absence).

## Context

LeonSpeegle (RTX Discord, 2026-11-24) asked for friends boards, location and age boards, custom groups, a
points ranking across every table counting Witness scores only, and this-year boards beside all-time. The need
under all of them: a player who can never top a table's global board still wants a board they can win.

Arcaid had the parts (friendships, the per-card global ranking, the room rankings' points and tie rules,
Witness evidence) but no ranking across tables on the Global Scoreboard, no time window, and no profile data.
Three things needed a ruling: how points are scored, which scores count, and what personal data a player may
give.

## Decision

1. **Arcaid Points.** On each scoreboard card (a global game + category), in the chosen window, each player's
   best score is ranked with competition ranks; with `N` players and rank `r`,
   `points = round(100 × (N − r + 1) ÷ max(N, 10))`. A player's total is the sum of their best 20 cards.
   The formula, the floor (10) and the cap (20) are constants in one place. Players can read how it works:
   an explainer on the Standings page and the Help page, and the arithmetic on their own breakdown.
2. **Filters narrow, never re-score.** Points are computed once per (window × view × category); a slice
   (friends, country / state, birth decade, a room's members, a group) is that list filtered and renumbered.
3. **Two views: All scores and Witness only.** All scores is every score the Global Scoreboard ranks. Witness
   only is machine-reported scores (`isMachineReportedScore`: Witness and AtGames) that pass the Arcaid
   standard, plus upheld appeals. Photo and typed scores count in All scores only; a photo never promotes a
   score. A desktop score needs evidence (Castcade ≥ 0.2.5) to count in Witness only.
4. **The Arcaid standard** is one rule set evaluated by `evaluateSanctioned` (never a second checker), judged
   when standings are computed, not stored, so a relaxed rule counts old scores again on the next recompute.
5. **Flagged scores** earn nothing in Witness only and count in All scores like a typed score ("not verified",
   never "cheating"). The player is told why, can fix their setup and replay (a machine-reported score is never
   edited), and can appeal within 7 days to the global admin; an appeal requires a Witness log bundle from the
   device that recorded the score, shared through the existing log pull. Decisions are stored beside the score,
   never on it.
6. **Profile data.** Country and state / province only (no zip code, no radius). Age is the birth decade only:
   the typed year is converted before it reaches the server and is never stored or logged. Every field is
   optional, off by default, with its own visibility switch; decades that could include under-18s are shown
   combined, so no board is a minors' board. Account linking merges the switches stricter-wins.
7. **No teams** (cats vs dogs, maker rivalries): dropped as too broad to drive play.
8. **Windows are All-time, Year and Month**, never "season" (a room format, ADR 0025, and B31's recap).

## Consequences

- PC (Castcade) players can be flagged and cabinet / AtGames players cannot, because only desktops send
  evidence. That follows "no evidence is an absence of badge" (ADR 0038) until a cabinet evidence profile
  exists.
- Witness only is empty for categories with no machine path (Pinball FX / Zen on PC, AtGames native outside a
  linked tournament); the page says so instead of showing an empty board.
- Witness only may start thin; All scores carries the page until more players use Witness.
- The standings never edit, delete or re-rank a table's own board; they only read it.

## Alternatives rejected

- **IFPA-style fixed points (100 for 1st down to 1 for 100th):** farmed by being alone on an obscure table.
- **Extinction (N points for 1st when N players posted):** small tables become worthless.
- **Re-scoring inside each slice:** a slice rank that disagrees with global points, and one computation per
  slice.
- **Zip code / radius, birthday or birth year:** enough to locate or identify a private person; the gain is
  small.
- **A photo-verified middle tier:** photos can be old or edited and only the owner could review global ones.
