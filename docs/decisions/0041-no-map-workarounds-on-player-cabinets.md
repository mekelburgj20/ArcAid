---
status: accepted
date: 2026-11-19
deciders: owner (ruling 2026-11-19)
supersedes:
superseded-by:
---

# Map fixes go upstream; Arcaid does not hand players a cabinet workaround

## Context

Legends Unchained's (LU) score server reads each table through a PinMAME memory map that LU ships inside its VPX
package. A wrong map splits or loses cabinet games: on Spider-Man Vault Edition (`smanve_101`), Stern's status byte
reads "game over" in the middle of a ball and stays "in game" until attract mode, so a Start pressed after the match
lost a 223,953,260 game (W67).

A per-table override works: `ScoreServerNvramMapsPath` under `[Standalone]` in the table's own `vpx-<table>.ini`,
plus a full copy of the maps folder on the stick (proven on the owner's cabinet for Beastie Boys on 2026-11-14 and for
Spider-Man on 2026-11-19). A player kit was built for the Wizard Battle Extinction tournament: a zip and install steps.

The override has costs that fall on players:

- The copied maps folder is frozen at one LU package and drifts from what LU later ships.
- A table reinstall or an LU update silently resets the table's ini, so the fix vanishes without notice.
- Every player has to remember to remove it once LU ships the fix, or it keeps overriding LU's newer maps.

## Decision

Arcaid does not distribute map workarounds to players' cabinets (owner, 2026-11-19).

- **Map fixes go upstream:** a PR to `tomlogic/pinball-memory-maps`, which LU ships in a later package.
- **A table whose fix has not shipped by tournament time is swapped for another table.** It is not patched on
  players' sticks.
- **The override stays a test tool:** it may be used on the owner's own cabinet to test a map before an upstream PR,
  and is removed after the test.
- **The kit built on 2026-11-19 is not distributed** (`tmp/player-kit/`).

## Consequences

- Tournament tables must be ones LU's current package scores correctly. Choosing them uses the per-table status on
  the board (W50, W114).
- Fixes reach players only as fast as tomlogic merges and LU releases. The LU dev channel is the lever, together with
  asking LU for table and map identity inside each record.
- No cabinet carries Arcaid-specific files, so there is nothing to clean up and no drift between players.
- A cabinet app that installs and removes overrides by itself was considered and deferred: it changes LU's files on
  other people's sticks, and it was not wanted while upstream is moving.
