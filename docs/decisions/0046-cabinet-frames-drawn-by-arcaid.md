---
status: accepted
date: 2026-11-28
deciders: owner (ruling 2026-11-28)
supersedes:
superseded-by:
---

# The cabinet's backglass and DMD show pictures drawn by arcaid.app

Not built (W132). Design: `docs/cabinet-frames-plan.md`.

## Context

A Legends Pinball has a backglass (1920x1080) and a DMD (a full 1920x1200
panel) that the Witness tile can draw on while it is open. The owner wants the
web app's Arcaid look there: the arcade carpet, the kit's panels and type, and
the table's art filling a card the way the web's score cards do.

Drawing that look on the cabinet means re-implementing CSS (art under a scrim,
glows, the carpet, the kit's type) in C++ against an SDL older than the SDK's
(lab build 1 died on `SDL_RenderFillRectF`), and shipping a signed cabinet
release for every change of look. The Display Lab showed the alternative works:
pictures rendered in a browser from the web app's own files, shown as they are,
with only the live dots drawn on the cabinet.

## Decision

1. **arcaid.app renders the frames** (a headless Chromium on the server,
   loading the app's own `/cabinet-frame` page with the web's kit CSS), as JPEG
   pictures named by a hash of their data.
2. **The cabinet downloads and shows them**, drawing only what changes by the
   second: the DMD's dot lines (countdowns, tickers, the dot logo). A picture
   never contains a running clock.
3. **Players choose their screens on arcaid.app**, per device and per player;
   the cabinet has no screen picker.
4. The frames are for the device's **current player** (ADR 0045), never simply
   the account that paired it.

## Consequences

- One look, kept in one place (the web's kit CSS); a change of look is a server
  deploy, not a cabinet release.
- The server runs a headless browser for this: one shared instance, one render
  at a time, an idle close, a disk cache with a cap.
- A picture can trail the live board by up to the cabinet's refresh (a minute)
  plus a render.
- An unpaired cabinet fetches its pair picture without a token, so that
  endpoint is public and carries only the code.
- The cabinet needs the network for anything but its fallback screen.
