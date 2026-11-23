---
status: accepted
date: 2026-11-22
deciders: owner (rulings 2026-11-22, from the G23 mockup)
supersedes:
superseded-by:
---

# Shared UI parts wear Arcaid's own look; libraries carry behaviour only

## Context

The style lane (G21 to G25, `docs/style-guide-plan.md`) needed shared parts that every page can use:
pop-ups (dialog, phone sheet), menus, selects and toasts. Hand-built versions in the app lacked focus traps,
dialog semantics and screen-reader announcements (G5's S20 a11y list). The G23 mockup
(https://claude.ai/artifact/R2DbdaxgPjL3ZGmeGkZbHs) put base-ui 1.9.0 and Sonner 2.0.8 side by side with
today's parts.

Its first toasts used Sonner's default look, restyled in the site's colours. The owner's verdict: they "look
pretty similar to a lot of other current AI generated website artifacts. Let's be unique with this." A second
version, built from Arcaid's own motifs, got "Arcaid look toasts are amazing". The same mockup also produced
the arcade-carpet page background ("Arcaid colours on Faint strength").

## Decision

1. **Every shared part wears Arcaid's own look.** It is built from Arcaid's motifs: the double-line neon
   triangle, the chrome pinball, score reels, the G20 panel's top light bar and the Witness kit's colours.
   A library's default look is never shipped, restyled or not.
2. **Libraries carry behaviour only:** base-ui for pop-ups, menus and selects; Sonner for toasts (owner: "Let's
   go with both"). They supply focus handling, Escape, stacking, timers and live regions. The look stays in
   Arcaid's own CSS (`index.css` "The Arcaid toast"; G23 for the rest).
3. **The owner chooses by looking.** A new shared part is offered as a switchable mockup with a recommended
   default before it is built.
4. **Toasts:** at most three; errors stay until Dismiss (v2.233.0); a pinball-rail clock that pauses on hover,
   on focus and in a hidden tab. Desktop shows them bottom-right; phones (600 px or less) show them top-centre
   below the safe area, because at the bottom a stack covered dialog buttons (owner, 2026-11-22; v2.260.1).
5. **Page background on the Arcaid-look pages:** the arcade carpet (`scripts/arcadeCarpet.mjs`, 16%, v2.259.0).
   Room pages keep their 16 themes (style plan decision 1).

## Consequences

- Sonner adds about 9.5 KB gzip and base-ui about 38 KB for the dialog and sheet. Visitors download them with the
  site; the full installs live only in `node_modules` and the Docker build stage.
- A part needs Arcaid-specific CSS and a mockup round before it ships, which is slower than dropping in a styled
  library component. That cost is accepted.
- Agents must not "simplify" a part back to a library's styled default (Sonner `richColors`, `closeButton`,
  shadcn-style recipes). Rule: `.claude/rules/admin-ui.md` "Toasts".
- Shipped so far: carpet v2.259.0 (#507), Arcaid toast v2.260.0 (#508), phones-top v2.260.1 (#510). Pop-ups on
  base-ui wait on G21.
