---
status: accepted
date: 2026-04-26
deciders: mekelburgj
supersedes:
superseded-by:
---

# Tournament platform rules are two orthogonal axes (game-level vs submission-level)

## Context

ADR 0006 introduced `tournaments.platform_rules` as `{ required: string[]; excluded: string[] }` and a single resolver, `resolveSubmittablePlatforms(gamePlatforms, rules)`, returning `gamePlatforms ∩ required − excluded`. That same intersection was used both to gate game eligibility (which catalogue rows can be picked for the tournament) AND to populate the submission picker (which platforms a player can submit a score from).

In production the conflation surfaced as a UX bug:

> **WHO dunnit** in `RTX_Pinball` is on `[vpx, vpxs, real, pinball_fx, pinball_fx_vr, atgames]` (catalogue platforms ∪ the room's `atgames` tag). **Daily Grind** has `Must = [atgames]`, `NotAllowed = []`. The submission picker showed only AtGames — but the user had played a VPX recreation. They had no way to log it.

The user's intent (stated repeatedly across this work):

- **Must ("Must be available on")** is *curation*. It picks which games are even pickable for a tournament. A player who picks an admitted game should be free to log a score from any platform that game ships on.
- **NotAllowed ("Not allowed on")** is *restriction*. It blocks specific scoring surfaces — e.g. "no Real Machine scores in this VR tournament" — without removing eligible games whose other platforms still satisfy the curation gate.

ADR 0006 implemented Must as both. This ADR clarifies that it should only be the first.

## Decision

`tournaments.platform_rules.required` and `tournaments.platform_rules.excluded` operate on **two orthogonal axes**, each enforced by exactly one helper in `src/utils/platformRules.ts`:

| Rule | Helper | Axis | Question it answers |
|---|---|---|---|
| `required` ("Must") | `passesplatformRules(gamePlatforms, rules)` | **Game-level** | Does this catalogue row qualify to be in this tournament? |
| `excluded` ("NotAllowed") | `resolveSubmittablePlatforms(gamePlatforms, rules)` | **Submission-level** | Which of an admitted game's platforms can a player submit a score from? |

`passesplatformRules` checks `required` only. `resolveSubmittablePlatforms` checks `excluded` only. **Neither helper looks at the other axis's field.** The JSDoc on both helpers spells out the contract so the next reader doesn't re-introduce the conflation.

Server-side `ensurePlatformAllowed` (rooms.ts) inherits the corrected semantics through `resolveSubmittablePlatforms` — it rejects on `excluded` membership, never on `required` non-membership.

The FE picker disambiguates the single-platform chip caption:

- `fullGamePlatforms.length === 1` → "(only platform for this game)"
- `fullGamePlatforms.length > 1 && submittable.length === 1` → "(only platform allowed by this tournament)"

The second case can now only fire when `NotAllowed` excludes all but one of a multi-platform game — `Must` no longer has any effect on the picker.

### Worked examples

**Example 1.** WHO dunnit on `[vpx, vpxs, real, fx, fx_vr, atgames]`. Tournament `Must=[atgames]`, `NotAllowed=[]`.
- `passesplatformRules`: TRUE (game has atgames → admissible)
- `resolveSubmittablePlatforms`: `[vpx, vpxs, real, fx, fx_vr, atgames]` (nothing excluded)
- Picker: full dropdown. Player may submit any of the 6.

**Example 2.** Same game, tournament `Must=[atgames]`, `NotAllowed=[real]`.
- `passesplatformRules`: TRUE (admissible)
- `resolveSubmittablePlatforms`: `[vpx, vpxs, fx, fx_vr, atgames]` (real stripped)
- Picker: 5 options. Real submission rejected at `ensurePlatformAllowed`.

**Example 3.** Tournament `Must=[atgames]`, `NotAllowed=[vpx, vpxs, real, fx, fx_vr]`.
- `passesplatformRules`: TRUE (game still has atgames)
- `resolveSubmittablePlatforms`: `[atgames]`
- Picker: read-only chip with "(only platform allowed by this tournament)".

**Example 4 (phantom case).** Tournament `Must=[atgames]`, `NotAllowed=[atgames]`. WHO dunnit admissible, but submittable = `[vpx, vpxs, real, fx, fx_vr]`. **Mitigation:** the tournament-form `getPlatformRuleConflicts` validator (introduced alongside this ADR) flags Must ∩ NotAllowed contradictions before save. Phantom case is preventable, not enforced-against at submit time.

## Consequences

- **Easier:** tournament rules express what users actually want — curation and restriction become independent dials. Common case ("AtGames-only tournament" really meaning "games available on AtGames") works without phantom platform locks on multi-surface games.
- **Easier:** `ensurePlatformAllowed`, picker, autopick, and Discord `/submit-score` all share the same one-line truth (`gamePlatforms − excluded`). Drift across the five submit paths gets harder to introduce.
- **Easier:** `passesplatformRules` is now genuinely game-only and can be reused anywhere we need eligibility (autopick, queue revalidation) without dragging submission-time concerns along.
- **Harder:** users who want a tournament to *force* scores through a single platform must use `NotAllowed` for the others rather than `Must` for the one. The semantic shift is captured in the rule labels ("Must be available on" vs "Not allowed on") but admins migrating from older expectations may need a docs note.
- **Locked out:** treating `Must` as a hard submission filter. If a future requirement needs that ("only AtGames scores count, regardless of game platforms"), it must add a third rule (`platform_rules.scoreOnly` or similar) rather than re-conflating.

## Alternatives Considered

- **Keep the combined filter (status quo before this ADR).** Rejected — it produced the WHO dunnit bug and is fundamentally a category error: curation and restriction are different operations on different objects (games vs scores).
- **Single rule with a mode flag (`platform_rules.required`, `platform_rules.requiredMode: 'gameOnly' | 'gameAndScore'`).** Rejected — adds a third axis to a UI that already has two, and the `gameAndScore` mode is exactly the conflation we just removed. Configurability for its own sake.
- **Drop `Must` entirely; express curation via the catalogue tag system (ADR 0008).** Rejected — `Must=[atgames]` is a tournament-scoped expression of intent, not a per-game annotation. Forcing admins to bulk-tag every AtGames game in the room before each tournament is worse UX than a one-line tournament rule.
- **Auto-derive `Must` from the catalogue (game's platforms list) without a tournament rule at all.** Rejected — catalogue platforms are global; tournaments are room-scoped and time-scoped. A "VR-only weeknight" tournament needs to express its intent without altering the catalogue.

## Notes

- ADR 0006 remains accurate about the *existence* of the rule shape and the picker UX; only its description of the resolver semantics ("∩ required") is now stale. ADR 0006 is not formally superseded since the platform-stratification decision (every score row carries `platform`) is unchanged.
- The phantom-prevention validator (`getPlatformRuleConflicts` in tournament form) is the safety net for the Example 4 case above. It does not enforce a particular stratification — that's this ADR's job.
