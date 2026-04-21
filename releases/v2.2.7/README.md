# ArcAid v2.2.7 — Shared Discord login button, scoreboard expand reinforcement

**Released:** 2026-04-21
**Baseline:** v2.2.6 (commit `29140869`)

Small follow-ups from v2.2.6 testing.

## 1. Shared DiscordLoginButton component

Problem: after v2.2.6 normalized login text to "Login", the visual styling
still differed between PublicLayout (room pages) and Global pages:
- PublicLayout: inline Discord brand SVG logo + `#5865F2` blue button
- GlobalScoreboard / GlobalGameDetail: lucide `<LogIn>` arrow icon + neon-cyan button

Users flagged the inconsistency.

Fix: extracted `admin-ui/src/components/DiscordLoginButton.tsx` — same SVG, same
classes as PublicLayout's version. GlobalScoreboard and GlobalGameDetail
both use it now. Any future global-surface page can import the same
component.

## 2. ShowcasePodium pointer-events reinforcement

The v2.2.6 fix set `pointerEvents: 'auto'` on each podium slot's **inner**
tinted box when the player had multiple submissions. Clicks inside that
box expanded inline as intended, but clicks on the slot's outer padding /
flex column whitespace still fell back to the `pointer-events-none`
wrapper → hit the z-10 Link overlay → navigated instead of expanding.

Fix: also set `pointerEvents: 'auto'` on the **outer** slot wrapper
(`<div style={{ flex: 1, minWidth: 0, pointerEvents: 'auto' }}>`) when
`canExpand` is true. Every pixel of the podium column now captures expand
clicks.

## 3. Playbook clarification (doc-only, no code)

The `+` indicator on scorecards renders only when a player has >1
submission on that game. Rows for single-submission players never show
`+` — this is working as designed (it's the expand affordance), not a
missing feature. Playbook updated to call this out.

## Files touched

- `admin-ui/src/components/DiscordLoginButton.tsx` — **new**
- `admin-ui/src/pages/GlobalScoreboard.tsx` — use shared button, drop unused `LogIn` import
- `admin-ui/src/pages/GlobalGameDetail.tsx` — same
- `admin-ui/src/components/scoreboard/ShowcasePodium.tsx` — outer-wrapper pointer-events
- `package.json` + `admin-ui/package.json` — `2.2.6` → `2.2.7`

## Upgrade notes

Drop-in. **Users must hard-refresh (Ctrl+Shift+R or Cmd+Shift+R) after
deploy** to pick up the new bundle — the v2.2.6 scoreboard-expand and
Mystery Award selector changes also rely on the new bundle being served.

## Rollback

Previous tag: `29140869`. Safe.
