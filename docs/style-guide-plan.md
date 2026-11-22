# Style guide plan (G21 to G25)

Handoff for the style work that follows G20 (Account Settings, v2.256.0). Read this before starting
G21. Items live in `WORK.md` section G. Since 2026-11-22 this is also the UX plan: the 2026-10-19 UX
investigation is merged in (see "Merged with the UX plan" below), and the owner decisions are made
(see "Decisions").

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

## The sketch (rejected by the owner 2026-11-22; kept for the record)

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

## Decisions (owner, 2026-11-22)

1. **Where the fixed dark look applies:** personal and global pages only (Account Settings, My Rooms,
   My Tables, My Stats, Friends, Create Room). Room pages (scoreboards, lobby, results) keep their 16
   themes and get the width fix and the shared parts, not the dark skin. This is also the UX plan's
   "protected surfaces" question: the room Scoreboard cards, Global Scoreboard, kiosk and title styles
   are the product's signature; fix their contrast and text size, never quiet or flatten them.
2. **The sketch is rejected in full** ("I'm not a big fan"; "I'm more a fan of the G20 styles"): no
   purple title plate, no violet-black ground, and none of its smaller swaps (slanted buttons and
   lamps, sentence-case headings, Doto scores). The shipped G20 page is the look; G21 extracts it as
   it is.
3. **base-ui (pop-ups, menus, selects) and Sonner (toasts), or hand-built:** the owner reviews
   mockups first. Blocks G23 only.
4. **Impeccable** (an outside design checker for Claude: a rule list, a scored review command, and a
   check that runs after every UI edit): not decided. Revisit once G21's rules exist (G25). Do not
   install it while agents are mid-task: its hook changes every session's edits.

## The guide (G21)

Three parts, so it cannot drift the way a document alone does:

1. **Shared parts in code**, taken from the shipped G20 page: page shell with the desktop widths,
   panel, group, button, page title, jump list. G20's `components/SettingsPanel.tsx`
   (`SettingsGroup`, `SettingsPanel`) and `public/aw-theme/aw-web.css` (`.aw-settings`, `.aw-group`,
   `.aw-jump`) are the start.
2. **A live page in the app** showing every part in every theme (super-admin only).
3. **A rule section** in `.claude/rules/admin-ui.md`: who the pages are for (players on a phone at a
   cabinet, often one-handed and in low light; room admins and mods, also on phones; unattended kiosk
   TVs), what to use, and what is banned. Write the banned list from G20 as shipped: its labels, chips
   and outlines are the standard on the dark pages, so the sketch-era bans on them do not apply. Add
   the UX plan's mechanics: no functional text under 12 px, no `transition-all`, no
   `focus:outline-none` without a visible ring, loading as skeletons not spinners, empty states that
   say what to do next, no new hex outside the tokens. `admin-ui.md` has room; check
   `npm run docs:check`.

## The rollout (G22)

One PR per page family, screenshots with mock data before each merge (owner preference):
personal/global pages first (the G20 look), then the narrow room pages (width, plus the scoreboard
contrast and text-size fixes only), then admin. Each page PR also takes that page's UX fixes from the
2026-10-19 analysis, recounted first: text sizes, boxes nested inside boxes, loading and empty states,
and (once G23 exists) its pop-ups and toasts on the shared parts. Player pages also get the phone
basics (tap highlight, `100dvh`, `theme-color`) and a worst-case-data check (32-character names,
13-digit scores).

## Merged with the UX plan (2026-11-22)

The 2026-10-19 UX investigation is `docs/design/ux-skills-analysis-2026-10-19.md` (findings, counts
from v2.163.0) and `docs/design/ux-skills-playbook.md` (its phased plan, now superseded by this file).
Its verdict: the colours and themes are strong; what reads as generic is the component layer
(bordered boxes everywhere, tiny tracked labels, 10 to 14 px type, hand-made pop-ups with no motion or
keyboard handling, copied spinners, bare empty states).

| UX plan phase | Where it went |
|---|---|
| 0. Broken animations, phantom colour classes, dev placeholders | Done: v2.258.1 (#432) |
| 1. `PRODUCT.md` / `DESIGN.md` from an interview; protected surfaces | One rulebook: G21's section in `admin-ui.md`. Protected surfaces = decision 1 |
| 2. Scored review of Scoreboard, Picks, Room Settings | G24, before G22 starts changing pages, and again at the end |
| 3. Primitives: dialog/sheet, toast, field, loading/empty, focus ring | G23, after G21's look parts; library choice is decision 3. Covers G5's dialog and toast half |
| 4-5. Admin and player page passes | G22: the same PR as the page's width and look change |
| 6. Scoreboard contrast and text size only | G22, room pages |
| 7. Edge cases, polish, re-review | End of G22; G24's second run |
| Docker sandbox on port 3002 | Dropped: the existing mock-data screenshot loop (local build + Playwright, live prod data for public pages) already covers pre-merge screenshots |
| Installing Impeccable and Emil Kowalski's skills | G25, decision 4 |
