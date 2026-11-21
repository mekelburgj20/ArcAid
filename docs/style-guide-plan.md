# Style guide plan (G21, G22)

Handoff for the style work that follows G20 (Account Settings, v2.256.0). Read this before starting
G21. Items live in `WORK.md` section G.

## The brief (owner, 2026-11-17 to 2026-11-21)

- Pages are narrow on a full-screen desktop: "they look like they are mobile". G20 fixed Account
  Settings; the rest follow.
- The owner likes the Arcaid Witness look and the shipped Account Settings ("the page looks great").
- Asked (2026-11-18): does it now differ too much from the rest of the site, and should there be a
  style guide so every future change keeps one look? Yes to both (see below).
- Asked: the site shares an "AI vibe" with other generated sites, e.g. vpxtablemanager.com (Legends
  Unchained's Table Manager): same chips, cards and fonts. How do we look unique without losing the
  80s/90s neon (pinks, blues)?

## What is true today

- 4 of 65 pages wear the Witness kit (`/witness/install`, `/pair`, `/pair/:code`, Account
  Settings). Everything else uses `src/index.css` tokens: Inter body, JetBrains Mono for small data,
  Orbitron display, 16 themes (`lib/themeIds.ts`), 6 px corners.
- The kit (`admin-ui/public/aw-theme/aw-theme.css`, verbatim, never edit) is one fixed dark look:
  Audiowide brand, Orbitron display, Chakra Petch UI, tokens `--aw-ice/cyan/pink/chrome/gunmetal/red`.
  It cannot follow a light theme, so rolling it out everywhere would end room and personal themes.
- 33 files in `src/pages/` use `max-w-md` to `max-w-4xl` (Tailwind). Not every match is the page's
  outer cap (some are a paragraph or a modal), but the outer cap is the "looks mobile" cause on a wide
  screen; audit per page in G22.

## Why it reads like Table Manager (measured 2026-11-18)

`docs/design/style-probe.mjs <url>` tallies the computed styles of every visible element.

| | vpxtablemanager.com | Arcaid Account Settings (G20) |
|---|---|---|
| Display font | Orbitron, 96 of 171 text elements | Orbitron (headings, labels) |
| Labels | uppercase, 1.2 to 2.4 px tracking | uppercase, wide tracking (`.aw-label`) |
| Ground | `#080B14` navy-black + one cyan radial wash | navy-black + grid lines + washes |
| Cards | 1 px `rgba(77,227,255,.22-.34)` cyan outline, 8 to 14 px corners, cyan glow | same family |
| Chips | pill (999 px) with a glowing dot | jump-list chip with a dot |
| Lead accent | cyan `#4DE3FF` | cyan |

Some of that is the kit, some was added in G20 (dot chips, grid, capitals).

## What is Arcaid's alone

Present on the live site, absent from Table Manager:

1. **The slant.** The logo and the Global Scoreboard title lean about 10 degrees
   (`components/GlobalScoreboardTitle.tsx`, `skewX(-10deg)` plate, italic Orbitron 900).
2. **Chrome lettering on a purple plate.** Same component: the chrome gradient and the
   `#4A1D82 -> #1B0638` plate.
3. **Pink leads, cyan second** (`#FF2E63` neon on the trophy). Table Manager leads with cyan.

## The sketch (not built into the app)

`docs/design/style-direction-sketch.html` (open in a browser; `?light` for the light version). It keeps
G20's layout (wide, five colour groups, jump list) and changes the skin:

- violet-black ground (`#0E0718`), no grid, no glows on panels;
- one chrome title on the purple plate per page, the only loud thing;
- the slant as a shape: buttons, colour ticks, status lamps (in place of pills and dots);
- sentence-case headings in Barlow / Barlow Condensed italic; Orbitron only in the title plate;
- scores in an orange dot-matrix display (Doto), as on a pinball machine;
- works in a light theme too.

Open risks seen in the sketch: Doto legibility at small sizes is untested; the 400 px logo PNG washes
out on a light ground. Fonts in the sketch load from Google Fonts; the app would self-host them like
the kit does.

## Decisions waiting on the owner

1. **Where the fixed dark look applies.** Recommended: personal and global pages only (Account
   Settings, My Rooms, My Tables, My Stats, Friends, Create Room). Room pages (scoreboards, lobby,
   results) keep their 16 themes and get the width fix and the shared parts, not the dark skin.
2. **Which swaps from the sketch, if any.** Recommended: slanted buttons and status lamps, the chrome
   title plate, sentence-case headings; drop the dot chips, grid and uppercase tracked labels.
   The owner likes the shipped G20 page, so any swap is applied to it and screenshot-approved first.

## The guide (G21), once those are answered

Three parts, so it cannot drift the way a document alone does:

1. **Shared parts in code:** page shell with the desktop widths, panel, group, button, status lamp,
   title plate. G20's `components/SettingsPanel.tsx` (`SettingsGroup`, `SettingsPanel`) is the start.
2. **A live page in the app** showing every part in every theme (super-admin only).
3. **A rule section** in `.claude/rules/admin-ui.md`: what to use, what is banned (uppercase tracked
   labels, dot chips, glow outlines, a new hex outside the tokens). `admin-ui.md` has room; check
   `npm run docs:check`.

## The rollout (G22)

One PR per page family, screenshots with mock data before each merge (owner preference):
personal/global pages first, then the narrow room pages (width only), then admin.
