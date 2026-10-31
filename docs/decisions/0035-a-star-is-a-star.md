# ADR 0035 — A star is a star: one rating store per catalogue table, with a platform axis

**Status:** accepted (owner rulings 2026-08-24; ROADMAP "Ratings move next to the player"), built v2.207.0 (WORK.md C3 ratings half + C2.2)

## Context

Ratings lived in two stores that never met:

- `game_ratings(game_room_id, game_name, user_id, rating)` — written from the room game page, the room
  Game Library and the Discord `/submit-score` star buttons. Keyed on a NAME inside a room (migration 139
  made it per room after same-named games in two rooms had shared one aggregate).
- `global_game_ratings(global_game_id, discord_user_id, rating)` — written from the Global game page, read
  by the Global Scoreboard cards.

So "Medieval Madness" could carry three different averages (room A, room B, Global) made of the same
people's opinions, and a star given after a submission in a room was invisible on the catalogue page of
the very same table. ROADMAP's C3 note already said where this should go: "probably fully unify for any
game with a `global_game_id` — a star is a star. Room-only games keep their ratings local."

The 2026-08-24 feature-request thread added two rulings. Opinions are public ("stamp your name on it or
don't rate at all" — built in v2.206.0 as the `raters` list), and a rating should be able to say WHICH
version it is about ("is the VPXS version better than native?"). A per-platform rating keyed on a room
name would have had to be invented twice, once per store, which is what forced the unification first.

## Decision

1. **`global_game_ratings` is THE rating store for any table the catalogue knows.** A room game's name
   that resolves to exactly ONE approved `global_games` row (case-insensitive, the same rule the room
   scoreboard uses to link a card to `/games/:id`) reads and writes that row's ratings, from every entry
   point: both game pages, the submission sheet, Discord, the Game Library. `game_ratings` survives only
   for names with no catalogue row or an ambiguous one (ADR 0004 lets same-named tables from different
   manufacturers coexist; a rating is never guessed onto one of them).
2. **Migration 205 folds the history.** Every `game_ratings` row whose name is unambiguous moves to the
   one store; when a player had rated the same table in two rooms (or in a room and on Global) the NEWER
   opinion wins. The residue stays where it was. Pre-v2.86 guest ids move too; they already render as
   "Unknown player".
3. **A rating has a platform.** `global_game_ratings.platform` is `''` ("the table in general") or a
   canonical ENGINE id — the same vocabulary as `player_tables.platform` and `score_history.engine`, so
   "the VPX version" means the same thing in a player's inventory, their scores and their opinions. One
   row per (table, player, platform).
4. **The headline counts each player once.** The table's average is the average of each rater's own
   average across their rows, and the count is distinct raters; the per-platform averages sit beside it.
   A player who rates three versions is still one opinion on the table, and the Global Scoreboard cards
   use the same rule.
5. **The submission moment rates the version just played.** The post-submit "How was X?" and the Discord
   star buttons already know the engine; they write a platform rating, not a general one.

## Consequences

- Room aggregates for catalogue tables are now community-wide. That is the point, and the owner asked for
  it, but a room that liked having "its" average for a table no longer has one; the Game Library column
  reads the catalogue number.
- `RatingService` is a name-keyed facade over `GlobalRatingService`, not a second store. A new rating
  surface calls one of them and inherits the fold; a new `INSERT INTO game_ratings` anywhere else is a
  bug.
- Room-only names have no platform axis (a platform on one is a `400 PLATFORM_UNSUPPORTED`). Pinning the
  name to a catalogue row is the fix, not a `platform` column on `game_ratings`.
- The comments half of C3 ("share globally", both comment stores tagged by origin) is untouched by this
  ADR and still open.
