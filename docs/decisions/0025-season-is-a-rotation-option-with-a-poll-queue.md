# ADR 0025 — A Season is a rotation option with a poll queue, and Arcaid owns the poll

**Status:** Accepted (2026-10-17)
**Relates to:** ADR 0013 (ranking cache watermark), ADR 0017 (Live Event format — the other
bounded tournament shape, deliberately NOT reused here).

## Context

GamerDad89's league (mox_s_vpx_tournaments) runs a twelve-week "weekly grind": one VPX table per
week, Friday to Thursday, first place worth 50 points, second 49 and so on, totals forming a
season standings table. The community votes each week's table in a Discord poll from four or five
tables the host curates; the host breaks ties by taste; the league pauses over Christmas. Until
now he ran all of it by hand — a Discord poll on Monday, a manual table start before work on
Friday, an Excel sheet for the points.

Arcaid already had most of the pieces: a weekly cron rotation with announcements and winner
pings, ranking groups with a linear points method and a ticker display, retained completed cards
that are locked by construction (every submit path requires `games.status = 'ACTIVE'`), and
per-tournament Discord channels. What it lacked was the **bound** (a rotation never ends), the
**points scale** (linear started at 100, not 50), the **poll**, the **pause**, and one quiet trap:
ranking groups counted only `ACTIVE`/`COMPLETED` games, so once cleanup archived week 1's table
its points vanished from the standings.

## Decision

### 1. A Season is `format = 'rotation'` with a season block, not a fourth format

`tournaments.season_table_count IS NOT NULL` is the whole signal (migration 181). Everything a
season needs from rotation — cron activation, `announceGameActivated`, the pick queue, the
rotation log, retained cards, the ticker — is reused untouched. The Live Event format was
considered and rejected: its rounds are pre-created `games` rows on a fixed clock with no queue,
which is exactly the shape a community-voted week does NOT have.

A season **forces** `winner_picks = 0`, `auto_pick = 0`, `max_active_games = 1` and
`eligibility_days = 0` on save. The poll is the only queue writer; with both pick flags off the
engine's existing empty-queue behaviour is "wait for admin", which is the hold-and-alert a season
wants, so no new fallback exists. A community vote overrides cooldown by definition, hence
`eligibility_days = 0`; the candidate picker's `played_before` flag is the host's repeat guard.

### 2. Points live on the ranking group; archived weeks count

`ranking_groups.points_top` (default 100, so existing groups are unchanged) parameterises
`best_game_linear`; the season auto-creates its group with `points_top = season_points_top` and
`best_n = season_table_count`, and keeps both locked to the season config.
`ranking_groups.include_archived` (default 0; the season sets 1) admits `ARCHIVED` games. It
defaults off because flipping every room's standings on deploy is a separate decision.

Placement for points moved from `ROW_NUMBER()` semantics to `RANK()`: tied scores share the place
and both take the higher points. This is global. Breaking a pinball score tie alphabetically was
indefensible wherever it happened.

### 3. The poll is a queue of drafts; Arcaid owns the tally

`season_polls` / `season_poll_candidates` / `season_poll_votes`. Each poll is a draft tied to a
slot; season-level defaults ("opens 96 h / closes 3 h before each rotation") derive its times,
and a per-poll absolute override exists for the Christmas gap. A per-minute `SeasonScheduler`
tick (stateless, at-least-once, `UPDATE … WHERE status =` + `changes === 1`, the same doctrine as
`EventScheduler`) posts, syncs, closes and resolves. **Resolve happens at close, never at
rotation**, so a tie surfaces hours before Friday.

**Arcaid is the source of truth and Discord is one vote source.** Discord has no API to vote on
behalf of a user (verified against discord.js 14.27), so a web vote can never appear inside the
Discord widget; therefore the merged tally lives in Arcaid, and the bot edits the message content
above the poll with the combined count. Votes are keyed on the CANONICAL identity
(`IdentityLinkService.resolveCanonical`). **A web vote beats a Discord vote** for the same person:
the web vote is the explicit, Arcaid-authenticated act, and Discord exposes no vote timestamps, so
"latest wins" is not implementable. Vote rows are identity-stable (no names baked in).

The Discord side is REST-only (`Routes.channelMessages` with a `poll` body,
`Routes.pollAnswerVoters`, `Routes.expirePoll`, `Routes.channelMessage` PATCH), read once per
tick. No gateway intent was added; `GuildMessagePolls` events are a later upgrade for an instant
mirror, not a requirement.

### 4. Tie rule `admin` applies the fallback immediately

The owner's tie rule is "I pick". A cron that fires at midnight cannot wait on a human, so
`admin` resolves NOW with `season_tie_fallback` (`random`, seeded on the poll id, or
`first_nominated`), queues that table, posts the tie to the channel, and lets the admin **swap the
queued row** from the admin page until the rotation fires. No DM buttons, no interaction handler,
no race with the cron. Runoff polls are not offered: they compress the week and can tie again.

### 5. The bound and the end

Polls stop when resolved polls that queued a table reach `season_table_count`; the season ends
when `COUNT(COMPLETED|ARCHIVED rotation games) ≥ season_table_count` at the rotation, which
stamps `season_finished_at` once and announces the top three. **The count is derived, never
stored**: the game rows are the record, so a `deleteGameCompletely` of a wrong table correctly
un-counts the week. `season_paused_at` makes both the poll tick and `runMaintenance` skip
(recorded as a `skipped` maintenance run); the live table stays open during a pause.

## Consequences

- One table-per-week league is now zero-touch between curating candidates and reading results.
- The admin form shows the four forced fields disabled, with the reason, rather than rejecting.
- Discord's own poll counters undercount web votes; the edited content line carries the truth.
  Whether Discord allows editing the content of a poll message is confirmed on the first live
  post; if refused, the line is dropped and the link stays.
- Vote mirror latency is up to one minute.
- The post-failure "three strikes then cancel" counter is in memory; a restart resets it.
- `season_ranking_group_id` is a pseudo-FK like the other `ALTER`-added references.
- `RANK()` placement changes points on any existing group that happens to hold a tied score.

## Alternatives rejected

- **A new `format = 'season'`.** Would duplicate every rotation reader for the sake of a bound.
- **Discord-only poll, no web mirror.** Cheaper, but the owner wants players who live on the web
  page to vote there, and Google-only members have no Discord vote at all.
- **Resolve at rotation time.** Hides a tie or a failed resolve until the moment it matters.
- **Storing the tables-done count.** A second answer that drifts from the game rows.
