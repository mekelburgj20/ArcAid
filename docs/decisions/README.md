# Architecture Decisions

This folder records load-bearing technical and product decisions for ArcAid in chronological order.

## Why this exists

Some choices in this codebase aren't obvious from the code:
- Why iScored username (not Discord ID) is the player primary key
- Why VPS image resolution walks `tableFiles[]` then `b2sFiles[]`
- Why we picked Pattern 3 (site-level handles, decoupled from provider identity) for global scoreboard auth

These docs answer "why is this so?" questions long after the original conversation has been forgotten. Code says **what**; ADRs say **why**.

## When to write one

Write a new decision doc when:
- A choice locks in a data shape, auth pattern, or external integration that future code will assume
- There were viable alternatives and we picked one for stated reasons
- The choice will need to be re-explained more than once to future contributors

You do **not** need an ADR for routine bug fixes, code style preferences, or anything already covered by `CLAUDE.md`.

## How to write one

1. Copy `0000-template.md` to `NNNN-short-title.md` where `NNNN` is the next number (zero-padded, e.g. `0001-identity-site-handles.md`)
2. Fill in the front matter and sections — keep prose tight
3. Set status to `accepted` once the decision is locked in
4. If a later decision overrides this one, update the `superseded-by` field rather than deleting the file
5. Add the new entry to the index below

## Index

| # | Title | Status | Date |
|---|---|---|---|
| 0001 | [Device-specific scoreboard preferences](0001-device-specific-preferences.md) | accepted | 2026-04-12 |
| 0002 | [Decoupled logo consumption paths](0002-decoupled-logo-paths.md) | accepted | 2026-04-14 |
| 0003 | [At-rest encryption for sensitive settings](0003-at-rest-secret-encryption.md) | accepted | 2026-04-19 |
| 0004 | [Catalogue identity is `(name, type, manufacturer, year)`](0004-catalogue-identity-index.md) | accepted | 2026-04-21 |
| 0005 | [Pin to Scoreboard uses `games.tournament_id IS NULL`](0005-pin-via-tournament-id-null.md) | accepted | 2026-04-21 |
| 0006 | [Score-platform stratification](0006-score-platform-stratification.md) | accepted | 2026-04-26 |
| 0007 | [Library = global catalogue](0007-library-equals-global-catalogue.md) | accepted | 2026-04-26 |
| 0008 | [Per-room game tags via `room_game_tags`](0008-room-game-tags.md) | accepted | 2026-04-26 |
| 0009 | [Tournament platform rules are orthogonal (game-level vs submission-level)](0009-tournament-platform-rules-orthogonal.md) | accepted | 2026-04-26 |
| 0010 | [User identity layer: many-to-one `user_mappings` + `user_profiles` display names](0010-user-identity-and-display-names.md) | accepted | 2026-04-28 |
| 0011 | [Deleted-score suppression tombstone for sync-resistant moderation](0011-deleted-score-suppression-tombstone.md) | accepted | 2026-04-30 |
| 0012 | [Per-account iScored Playwright session serialization via `IScoredSessionRegistry`](0012-iscored-session-registry.md) | accepted | 2026-05-02 |
| 0013 | [Cache validation via data watermark (no manual `invalidate()` in mutation paths)](0013-cache-watermark-validation.md) | accepted | 2026-05-02 |
| 0014 | [Manufacturer is the catalogue dedup discriminator; virtual IPDB links are references](0014-catalogue-manufacturer-dedup-guard.md) | accepted | 2026-07-12 |
| 0015 | [Multi-IdP identity linking: bidirectional Google<->Discord, snowflake-is-canonical, no un-merge](0015-multi-idp-identity-linking.md) | accepted | 2026-07-27 |
| 0016 | [Engine + device score provenance (supersedes 0006, partially 0009)](0016-engine-device-score-provenance.md) | accepted | 2026-07-30 |
| 0017 | [Live Event tournament format: rounds are `games` rows, `SCHEDULED` status, read-time aggregation](0017-live-event-tournament-format.md) | accepted | 2026-08-24 |
