# ArcAid v2.2.8 — Remove Link overlay, title-as-Link per card variant, Mystery Award z-fix

**Released:** 2026-04-21
**Baseline:** v2.2.7 (commit `e849c61d`)

Structural fix: the scoreboard click-routing problem is solved by
architecture change, not pointer-events workaround.

## The problem

From v2.0.x through v2.2.7 the `GameCard` wrapper rendered an inset-0
`<Link>` overlay at `z-10` covering the whole card. The idea was "click
anywhere on the card to navigate to Game Detail." But interactive child
elements (submit button, expand `+`, score rows) had to sit *above* the
overlay with `z-20` and `pointer-events-auto` to capture their clicks.

v2.2.6 added a `pointer-events-none` wrapper around CardRouter to let
only opted-in score rows get clicks. v2.2.7 added more `pointerEvents: auto`
to the ShowcasePodium outer wrapper to catch edge clicks. Neither was
reliable across all layouts — users reported that clicking the `+`
indicator on Showcase-style cards still navigated instead of expanding.

## The fix

Remove the Link overlay entirely. Each card wraps its own **title** in a
`<Link>`. There's no competing overlay for score rows, `+` icons, or
submit buttons to fight.

**Click routing now:**
| Target | Action |
|---|---|
| Card title | Navigate to Room Game Detail (`/:slug/games/:name`) |
| `+` (top-right submit affordance) | Open submit sheet |
| Score row with multi-submissions | Expand inline |
| Score row with single submission | No-op (no expand) |
| Card background / padding | No-op (nothing to click) |

**Removed behavior:** clicking the title area used to open the submit
sheet when `onSubmitScore` was set. That's gone — the `+` button is the
single submit affordance now. Title clicks navigate.

### Plumbing

- `GameCard` → drops `<Link>` overlay and the `z-20 pointer-events-none`
  wrapper. Passes `titleLinkTo` + `titleLinkOnClick` through CardRouter.
- `CardRouter` → forwards those two props to each card variant.
- `BannerCard` / `MinimalCard` / `ShowcaseCard` → wrap their own title
  element in `<Link to={titleLinkTo} onClick={titleLinkOnClick}>` when
  set. Title-click-submit behavior removed.
- `_onSubmitScore` is still accepted as a prop on each card (CardRouter's
  spread pattern), prefixed with `_` to satisfy `noUnusedParameters` —
  may be re-used in a future card variant.

## Mystery Award header visibility

`MysteryAwardPage`'s header overlay was `absolute top: 0 z-10` inside a
`relative min-h-screen` wrapper. But `MysteryAward.tsx` itself renders as
`fixed inset-0 z-50` — so the modal covered the entire page including my
overlay. Users couldn't see the back link, the Pool selector (v2.2.6),
or the login CTA.

Fix: change header to `fixed top: 0 z-[60]` so it renders above the
modal. Same content, correct layering.

## Files touched

- `admin-ui/src/components/cards/GameCard.tsx` — remove Link overlay + wrapper; pass `titleLinkTo` through
- `admin-ui/src/components/scoreboard/CardRouter.tsx` — plumb `titleLinkTo` + `titleLinkOnClick`
- `admin-ui/src/components/scoreboard/BannerCard.tsx` — title-as-Link, drop title-click-submit
- `admin-ui/src/components/scoreboard/MinimalCard.tsx` — title-as-Link
- `admin-ui/src/components/scoreboard/ShowcaseCard.tsx` — title-as-Link
- `admin-ui/src/pages/MysteryAwardPage.tsx` — header fixed + z-[60]
- `package.json` + `admin-ui/package.json` — `2.2.7` → `2.2.8`

## Upgrade notes

Drop-in. **Hard-refresh (Ctrl+Shift+R) after deploy.** No schema changes,
no config changes.

## Rollback

Previous tag: `e849c61d`. Safe.
