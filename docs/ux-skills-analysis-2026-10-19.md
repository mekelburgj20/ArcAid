# How Impeccable and Emil Kowalski's skills would change ArcAid's UI/UX

Investigation only. Nothing in `admin-ui/` was changed for this document. Date: 2026-10-19. Repo state: `aff178a` on `main` (v2.163.0).

Sources read in full: [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (skill 4.6.0, engine 0.1.15, all 24 command references, the 61-rule detector registry, hooks and DESIGN.md/PRODUCT.md formats) and [emilkowalski/skills](https://github.com/emilkowalski/skills) (all 15 skills). ArcAid evidence comes from a full read of `admin-ui/src` (63k lines of TSX, 2,026 lines of `index.css`), a static run of the Impeccable detector over the source, and a rendered run against the app booted locally with seeded data (section 6).

---

## 1. Verdict

**ArcAid does not look generic because of its palette. It looks generic because of its component layer.**

The token layer is unusually deliberate: an oklch neon-arcade palette with 16 named themes, a contrast audit script that enforces 4.5:1 on every theme, Orbitron and Press Start 2P as display voices, CRT scanlines, skeuomorphic pinball buttons, glitching card frames, an "attract mode" sweep on the hero card. Only 155 raw Tailwind palette classes survive in 63k lines, and almost all are error reds. That is better token discipline than most hand-built apps.

What reads as "AI boilerplate" is everything the tokens are poured into:

| Tell | Evidence |
|---|---|
| The universal bordered box | `border border-` ×630; the literal string `bg-surface border border-border rounded-lg …` repeated 14, 11 and 8 times in three variants; cards nested 2–3 deep in Reports, GameDetail, LobbyAdmin, Settings, Help |
| Eyebrow labels | `uppercase tracking-wider` ×230, nearly always `text-xs` or `text-[10px]`, including every `NeonCard` title bar |
| Microscopic type | `text-xs` 1,055 + `text-sm` 918 + `text-[10px]` 185 + `text-[11px]` 94 + `text-[9px]` 16 + `text-[8px]` 4, against `text-base` 11. The UI lives at 10–14px with almost nothing above `text-lg` |
| 4-up stat grids | big coloured number over tiny label: `GameDetail.tsx:984`, `Stats.tsx:161,210` |
| Copy-pasted modals | 39 files hand-roll `fixed inset-0 …`; two competing overlay recipes ×16 each; 14 of 39 carry `role="dialog"`; none animate in or out |
| Spinner + "Loading..." | the same spinner markup in 26 files, 28 "Loading..." strings with three different ellipses, skeletons in 2 places |
| Bare empty states | "No scores yet", "No data found.", "No activity yet" as a centred muted line, no next action |
| Icon in a tinted circle above a heading | `DiscordCallback.tsx:296`, `GoogleCallback.tsx:251`, `SubmissionSheet.tsx:1076`, `Picks.tsx:927` |
| Glass chrome | `backdrop-blur-sm` ×51 (every overlay, the public nav); the Glass Deck theme is `blur(24px)` on `rgba(18,18,24,.9)` with a centre-fade hairline |
| Stock gradient | `--sb-ticker-cta-bg` is the violet→pink `rgba(139,92,246) → rgba(236,72,153)`; `--sb-arcade-neon-*` are Tailwind's own `#ec4899 #3b82f6 #a855f7 #fb923c #22d3ee` |
| Default motion | `transition-colors` ×362 at the default 150ms; no easing tokens anywhere; `NeonButton` uses `transition-all` and has no `:active` or focus style; modals and the mobile submit sheet mount with no transition |

Two of the enter animations are literally broken: `Toast.tsx:58` animates `fadeIn`, and no `@keyframes fadeIn` exists; `GlobalScoreboard.tsx:931,948` uses `animate-slide-down`, which is undefined (the defined class is `animate-slideDown`, local to `ScoreboardSurface`). Five token classes used in markup do not exist in the theme (`bg-surface-alt` ×25, `text-secondary` ×8, `bg-card` ×6, `text-accent` ×2, `border-default` ×1) and silently render nothing.

**The two skill sets attack different halves of this.** Impeccable is about structure: hierarchy, typography scale, colour roles, copy, states, and a deterministic linter that stops the patterns coming back. Emil's skills are about feel: motion, press feedback, sheets and toasts, the phone-specific tells, and worst-case data. Together they cover every row in the table above. Neither replaces the owner's design decisions, and both are opinionated in ways that need steering for a product whose public face is deliberately loud (section 8).

---

## 2. What the two repositories actually contain

### 2.1 Impeccable (pbakaus)

One skill, `/impeccable <command> <target>`, with 24 commands grouped as Build (`init`, `document`, `extract`, `shape`), Evaluate (`critique`, `audit`), Refine (`polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`), Enhance (`animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`), Fix (`clarify`, `adapt`, `optimize`) and Iterate (`live`, `generate`). Three pieces matter most for ArcAid:

- **The detector.** A 21 MB Rust binary (downloaded once, SHA-256 verified) with 61 deterministic rules in two categories. "Slop" rules name the AI tells directly: `side-tab` (thick one-side border), `overused-font` (Inter, Roboto, Geist, Space Grotesk…), `gradient-text`, `ai-color-palette` (violet gradients, cyan-on-dark), `nested-cards`, `monotonous-spacing`, `dark-glow` (zero-offset chromatic halo), `radial-halo`, `icon-tile-stack`, `kicker-above-heading`, `hero-eyebrow-chip`, `pulsing-dot`, `bounce-easing`, `marquee`, `marketing-buzzword`, `em-dash-overuse`, `gpt-thin-border-wide-shadow`, `repeating-stripes-gradient`, `codex-grid-background`. "Quality" rules are WCAG and typography mechanics: `low-contrast`, `gray-on-color`, `tiny-text`, `undersized-ui-text` (<11px functional text), `tight-leading`, `line-length`, `cramped-padding`, `text-overflow`, `skipped-heading`, `heading-rhythm`, `clipped-overflow-container`, `broken-image`, plus `design-system-font/color/radius/font-size` drift rules that only activate once a `DESIGN.md` exists. Static mode regex-scans TSX/CSS; URL mode drives a headless Chromium and reads computed styles, which is where most rules live.
- **The hook.** `/impeccable hooks on` wires a Claude Code post-edit hook that runs the immediate-tier rules on every UI file edit and the full set at session stop, pushing findings back into the agent's context. This is the regression guard: it changes what the *next* hundred Claude-authored edits produce, which is the real source of the current look.
- **The doctrine.** `craft-floor.md` is a refuse list the agent loads before any UI edit (cards as page structure, nested cards, eyebrow labels, gradient text, glass as decoration, side-stripe borders, glyph icons, modal by reflex, same-size icon-heading-text card grids). `operate.md` is the rule set for app UI: one type family, fixed rem scale at 1.125–1.2 ratio, no display fonts in labels or buttons or data, accent only on actions and selection, skeletons not spinners, empty states that teach, every control with all seven states, 150–250 ms transitions, no page-load choreography. Every surface is classified as Persuade / Operate / Read / Experience, and ambition is scaled to that mode.

Setup is `init` (interviews the owner, writes `PRODUCT.md` with users, operating context, constraints) then `document` (extracts the existing tokens into a spec-conformant `DESIGN.md` with YAML frontmatter). `critique` runs two isolated sub-agents (a design review scoring Nielsen's ten heuristics and persona walk-throughs, and the detector) and persists a scored snapshot so `polish` can later consume it and the score can be trended.

### 2.2 Emil Kowalski's skills

Fifteen skills built from the Sonner and Vaul author's rules. The relevant ones for ArcAid:

| Skill | What it does | Where it bites in ArcAid |
|---|---|---|
| `emil-design-eng` | The philosophy plus a Before/After review table: `transition: all` → named properties, `ease-in` never on UI, enter from `scale(0.95)+opacity 0` never `scale(0)`, popovers scale from the trigger, buttons `scale(0.97)` on `:active`, UI motion under 300 ms, strong custom curves (`cubic-bezier(0.23,1,0.32,1)`) | `NeonButton`, every modal, the toasts |
| `animate` / `review-animations` | Build or grade one animation against a fixed decision sequence (should it animate → purpose → tool → properties → curve/duration → interruption → reduced motion) with exact values, never approximated | the submit sheet, score toast, admin drawer, card expand |
| `improve-animations` | Read-only audit of a whole codebase across eight categories, producing self-contained plans in `plans/` any agent can execute | the first motion pass over `admin-ui` |
| `find-animation-opportunities` | Finds where motion is missing and, deliberately, rejects most candidates (keyboard actions and 100+/day interactions never animate) | which of ArcAid's state swaps deserve a bridge |
| `mobile-native` | The eleven phone tells with the one-line fix each: sticky hover, tap-highlight flash, `100vh`, inputs under 16px zooming the page, laggy taps, pull-to-refresh, notch, long-press selecting button text, `theme-color` per scheme, real hardware | ArcAid is a PWA used on phones in arcades; several tells are present (section 4.6) |
| `break-ui` | Worst-case data behind a dev-only Demo/Worst toggle: long names, one-letter names, 1,284 members, 13-digit scores, empty, one, huge | scoreboard rows, GameDetail history, Members lists, Discord display names |
| `pick-ui-library` | A curated list: base-ui for dialogs/popovers/menus, Sonner for toasts, cmdk for the ⌘K palette, motion for springs, Virtuoso for long lists, NumberFlow for animated numbers | ArcAid hand-rolls all of these today |
| `prototype` | Several versions of one UI piece behind a switcher | the Picks redesign and Room Settings reorganisation already on the roadmap |
| `apple-design` | Springs, velocity handoff, rubber-banding, translucent materials with vibrancy | the drag-reorder queue, the bottom sheet |

The remaining skills (`animate-expo`, `write-swift`, `ask-sonner`, `animation-vocabulary`, `animation-performance`) are either React Native/Swift or become relevant only after Sonner or motion is adopted.

---

## 3. ArcAid's UI as it stands (the inventory)

Counts are over `admin-ui/src` excluding tests. There is no `tailwind.config`; the whole theme is a Tailwind v4 `@theme {}` block at `index.css:18-284`.

### 3.1 Typography

Fonts load from Google Fonts (`index.html:9`): Inter 400–700, JetBrains Mono, Orbitron 500/700/900, Press Start 2P. Tokens: `--font-body` Inter, `--font-display` Orbitron, `--font-pixel`, `--font-mono`. Showcase themes load two more families at runtime (DM Sans/DM Mono, Share Tech Mono).

`font-display` (Orbitron) is used 384 times, including `NeonCard` titles, `LoadingState`, badges and nav. Size usage is inverted from a healthy scale: 1,973 uses of `xs`/`sm` plus 299 arbitrary 8–11px sizes, versus 11 `text-base`, 71 `text-lg`, 46 `text-2xl`. Weight is binary (`font-bold` 293, `font-medium` 292). `tabular-nums` is used 52 times, which is good for scores but not universal.

### 3.2 Colour

Core tokens are three surfaces (`deep/surface/raised`), two borders, seven neon accents (two of which duplicate others: `neon-blue` = `neon-cyan`, `neon-purple` = `border-glow`), three text levels. About 90 further `--sb-*` scoreboard tokens. Token classes are used ~5,780 times against 155 raw palette classes, concentrated in `AccountSettings.tsx` (25) and `GlobalCatalogue.tsx` (22). Pure black appears only as overlay scrims (`bg-black/60` ×31). Gradient utilities are nearly absent in markup (3), but 41 inline `linear-gradient` strings live in `scoreboardThemes.ts` and `ShowcasePodium.tsx`, and the four opt-in title styles (`.title-chrome/-fire/-plasma/-holo`) are gradient text.

### 3.3 Shape and primitives

Radii are modest (`rounded` 587, `rounded-lg` 210, `rounded-full` 130). The primitive set is thin: `NeonButton` (278 uses, 4 variants, 41 lines), `NeonCard` (110), `ConfirmModal` (22), `LoadingState` (34), `DataTable` (9), `StatusBadge` (1). There is no Input, Select, Modal shell, Tabs, Badge, EmptyState or Skeleton primitive: `<button>` 392 raw vs 278 `NeonButton`, `<input>` 197, `<select>` 66; `inputClass` constants are redefined in 16 files.

### 3.4 Icons and emoji

Lucide only (120 distinct icons across 99 files), 23 inline SVGs, and just 21 pictographic characters in copy (mostly ✓ ⚠ ✦). This is clean; the one AI tell is the icon-in-a-tinted-circle composition, not the icons.

### 3.5 Motion

No motion library. `transition-colors` ×362, `transition-all` ×20, explicit durations 9 times, easing classes 7 times, `ease-in` on the admin drawer (`SuperAdminLayout.tsx:107`, `RoomAdminLayout.tsx:181`). `animate-spin` ×34, `animate-pulse` ×4. Custom keyframes exist for title effects, the `.pulse` status dot, the glitch rings, podium breathe and the hero attract sweep. Reduced motion is handled well: a global guard at `index.css:1689-1721` plus 12 component blocks and two `matchMedia` checks. No `cubic-bezier` or `--ease-*` token exists anywhere.

### 3.6 Layout

`SuperAdminLayout` and `RoomAdminLayout` are near-identical copies of the standard dashboard shell (`w-60` sidebar, icon+label nav, active item `bg-neon-cyan/10 border-r-2 border-neon-cyan`, user/logout footer). `PublicLayout` is a sticky translucent top nav at `max-w-5xl` with icon-over-`text-[10px]`-label items on mobile and a `text-[10px]` footer. Page shells are `max-w-3xl`/`4xl`/`5xl` stacks of bordered panels. 393 inline `style={{}}` blocks, mostly config-driven card sizing.

### 3.7 Copy and states

Placeholders are domain-specific and good ("e.g. Medieval Madness"), with two dev leftovers (`placeholder="mekelburj"`). Errors are 140 terse "Failed to X" strings. Empty states are one centred muted line. Loading is spinner + "Loading..." in Orbitron.

### 3.8 Accessibility

376 `aria-*` attributes, 25 `aria-pressed`, 13 `aria-modal`. But: `focus:outline-none` ×104 followed by a border-colour change is the dominant focus pattern, `focus-visible:` is used 16 times, there is no global `:focus-visible` rule, and `NeonButton` has no focus style. 38 `<div onClick>`. `contrastAudit.cjs` checks the three text tokens against the three surfaces per theme and nothing else.

### 3.9 Scoreboard card system

`CardRouter` → `ArcadeCard` (default, token-only, neon frame keyed to tournament type), `BannerCard`, `ShowcaseCard` (two themes: Glass Deck and Neon Circuit, ~40 raw CSS strings each), `MinimalCard`. ~30 config knobs. This is the most distinctive surface in the app and the one place the neon world is fully committed.

### 3.10 Design documentation

There is no `DESIGN.md`, style guide or component catalogue. The design rationale lives in `index.css` comments and `CLAUDE.md`. `docs/design-sources/` holds prior direction explorations (Global Scoreboard directions A–E, podium restyle, Delta House chrome) and `docs/arcaid-glass-deck-v6.html` / `arcaid-neon-circuit-v10.html` are the Showcase theme mockups.

---

## 4. Pattern by pattern: which skill changes what

### 4.1 The bordered box and nested cards

Impeccable's `nested-cards` rule fires on the rendered DOM; `craft-floor` says "cards are the lazy container; nested cards are always wrong"; `layout` asks the squint test (can you see primary, secondary, groups with detail blurred?) and "are containers compensating for weak proximity?"; `distill` flattens. Concretely, `Reports.tsx:671→677→709` (NeonCard → raised row → surface quote), `LobbyAdmin.tsx:285→322` and `Settings.tsx:1005→1024` would lose their inner boxes in favour of spacing, a hairline divider, or type weight. `extract` would then turn the three literal repeated strings into one `Panel` with a density prop, so the pattern cannot be re-typed.

### 4.2 Eyebrow labels and the small-caps habit

`kicker-above-heading` is a ban in Impeccable, not a default: "the heading carries its own weight; delete the label." `NeonCard`'s title bar (`font-display text-sm font-bold uppercase tracking-wider text-neon-cyan`) is the template for 110 of these, and `DataTable.tsx:27` and the `MiniStat` labels (`GameDetail.tsx:2235`) are the rest. `typeset` would replace them with a real heading role at a readable size and let case carry only short chips. `operate.md`'s "no display fonts in UI labels, buttons, data" removes Orbitron from admin chrome entirely and keeps it for page titles, scoreboard headers and the kiosk, which is where it earns its place.

### 4.3 The 10–14px type scale

`undersized-ui-text` (functional text under 11px) and `tiny-text` would fire on the 205 `text-[8-10px]` uses and the mobile nav labels. `typeset` sets a fixed rem role scale at a 1.125–1.2 ratio for Operate surfaces with a 16px body floor, and `mobile-native` adds the hard reason: inputs under 16px make iOS Safari zoom the page and never zoom back. The 4-up stat grid (`hero-metric` in craft-floor's refuse list) gets rewritten as a sentence or a single leading number.

### 4.4 Modals, toasts, sheets and the primitive gap

Impeccable `operate.md`: "modals are usually laziness; exhaust inline alternatives first"; `polish` classifies the 39 hand-rolled overlays as "one-off implementation: an existing shared component should replace it." Emil's `pick-ui-library` names the replacement: base-ui dialogs and popovers (focus trap, dismissal, `transform-origin` from the trigger) and Sonner for toasts (interruptible transitions, pause when hidden, swipe-to-dismiss on phones). The two-recipe overlay (`bg-deep/80 backdrop-blur-sm` vs `bg-black/60`) becomes one, the 25 missing `role="dialog"`s come for free, and the undefined `fadeIn`/`animate-slide-down` bugs disappear because the toast is no longer hand-animated.

### 4.5 Motion

`improve-animations` would produce roughly this audit on day one: HIGH `transition-all` on `NeonButton` and 19 other sites; HIGH no press feedback on any pressable element; HIGH `ease-in` on the admin drawer; MEDIUM modals and the mobile submit sheet appear and vanish with no bridge; MEDIUM `Toast.tsx` and `GlobalScoreboard.tsx` reference undefined animations; LOW five hand-typed near-duplicate durations with no `--ease-out`/`--duration-*` tokens. `animate` then writes the fixes with its fixed values: `transition: transform 160ms var(--ease-out)` + `scale(0.97)` on `:active`; the sheet entering with `translateY(100%)` and the iOS drawer curve `cubic-bezier(0.32,0.72,0,1)` under 300 ms; `@starting-style` for toast entry. `find-animation-opportunities` would reject animating the ⌘K palette (`GlobalSearchPalette.tsx`) and list navigation, and accept the pick-queue reorder and the score toast as the two places motion carries meaning.

The scoreboard's own effects (fire/plasma title sweeps, glitch rings, attract sweep, phosphor flicker) will be flagged by both skill sets as decoration. On a kiosk or display surface they are the signature move Impeccable's Operate/Experience rules explicitly allow once. The right move is to record them as intentional in `DESIGN.md` and the detector ignore list, not to remove them (section 8).

### 4.6 Phone feel

`mobile-native`'s baseline is largely missing from `index.css` and `index.html`: no `-webkit-tap-highlight-color: transparent`, no `overscroll-behavior`, no `100dvh` (one use), no `user-select: none` on controls, a single `theme-color` of `#00e5ff` (the brand cyan, which the skill says should instead match the top-of-page surface and be declared per colour scheme), 25 `safe-area-inset` uses but only in TSX. Hover gating is handled, because Tailwind v4 compiles `hover:` to `@media (hover: hover)`. Expected effect: no grey flash on tap, no stuck hover after tapping a card, no page zoom when the score field focuses, the sheet tracking the visible viewport when the URL bar collapses.

### 4.7 Loading, empty and error states

Impeccable `operate.md`: "skeleton states for loading, not spinners in the middle of content; empty states that teach the interface." `onboard` prescribes what-will-be-here, why it matters, one CTA. `clarify` rewrites "Failed to save." into what failed and how to recover, and unifies the three ellipsis spellings. For ArcAid the empty states are also onboarding: a new room's scoreboard with no active tournament is the first thing a room admin sees.

### 4.8 Colour

`colorize` is the least needed command. The palette is already committed. What it would fix is mechanical: the duplicate tokens (`neon-blue`, `neon-purple`), the Tailwind hex values hiding in `--sb-arcade-neon-*`, the violet→pink CTA gradient (`ai-color-palette` fires on exactly this hue pair), the five undefined token classes, and the 155 raw error reds becoming `--color-danger`. `quieter` applies to admin surfaces: fewer `glow-*` borders, accent only on the primary action and the selected nav item.

### 4.9 Worst-case data

`break-ui` would target the scoreboard row (Discord display names up to 32 chars, 13-digit scores, "1 members"), GameDetail's per-player history expand, Members and Identity Merge lists, and the Picks available-games grid. ArcAid already handles ≥1T score abbreviation and comma grouping well; the exposure is names and counts.

### 4.10 Focus and keyboard

Impeccable `audit` scores accessibility 0–4 and `craft-floor` requires themed focus rings ("the parts you did not draw still carry the design: selection, caret, scrollbars, focus rings"). A global `:focus-visible` ring in the accent, removal of the 104 `focus:outline-none`, and base-ui's keyboard handling in dialogs would address the biggest gap the inventory found.

---

## 5. Where the skills would say ArcAid is already right

Worth stating so the work does not undo it:

- Semantic oklch tokens and a 16-theme system with `LEGACY_THEME_MAP`, parity tests and a contrast bar. Impeccable's `document` would export this almost verbatim.
- `prefers-reduced-motion` handled globally and per component. Both skill sets treat this as a hard requirement; ArcAid passes.
- One icon family, essentially no emoji in UI copy, lucide trophies rather than 🏆.
- Domain-specific placeholders and copy voice ("Nothing to clean up — iScored matches Arcaid").
- The `sb-on-art` dark-token island for art-filled cards, which is exactly the "derive text colour from the surface" rule.
- `viewport-fit=cover` already set; `tabular-nums` already used on scores.
- Themes whose labels describe the rendered palette (a `CLAUDE.md` rule) are what `DESIGN.md`'s "descriptive names, not blue-800" asks for.

---

## 6. Detector results against ArcAid

### 6.1 Static scan (source files)

`impeccable detect --json --no-config admin-ui/src admin-ui/index.html` exits 2 with 3 findings, all `gradient-text` on the opt-in title styles at `index.css:1182,1191,1205`. This is expected and is the main limitation to understand: in static mode on TSX the engine is a regex matcher and sees Tailwind class names, not computed styles. Nearly all 61 rules (contrast, nested cards, undersized text, side-tab, dark-glow, spacing rhythm, heading rhythm) need the rendered DOM. The hook has the same limit per edit, which is why Impeccable positions the hook as the floor and `critique`/`audit` in a browser as the real pass.

### 6.2 Rendered scan (app running locally)

RENDERED_RESULTS_PLACEHOLDER

---

## 7. How the two skill sets fit together on this codebase

Impeccable owns the sequence; Emil's skills plug into it at two points.

| Step | Command | What ArcAid gets |
|---|---|---|
| 0 | `npx impeccable install` → `/impeccable hooks on`; `npx skills add emilkowalski/skills`; `impeccable telemetry off` if wanted | Every later Claude edit to a `.tsx`/`.css` is scanned; findings return to the agent's context |
| 1 | `/impeccable init` | `PRODUCT.md`: players submitting from a phone in an arcade or bar, room admins and mods (mobile admin editing is first-class per the 2026-08-19 ruling), kiosk displays, Discord-first communities. This is the file that stops future surfaces defaulting to a desktop SaaS frame |
| 2 | `/impeccable document` | `DESIGN.md` extracted from the `@theme` block, the 15 `.theme-*` classes, `NeonButton`/`NeonCard`, the card system. Activates the four `design-system-*` drift rules in the detector, so a new raw hex or an off-ramp 10px becomes a finding |
| 3 | `/impeccable critique` on three surfaces: `/:slug` Scoreboard (Experience), `/:slug/picks` (Operate, phone), `/:slug/admin/settings` (Operate, desktop and phone) | Nielsen scores, P0–P3 list, persona red flags (power user, first-timer, screen reader, phone), persisted snapshots to trend |
| 4 | `/impeccable extract` | `Panel`, `Input`/`Select`, `Dialog`/`Sheet` (on base-ui), `EmptyState`, `Skeleton`, a `Toaster` (Sonner), `focus-visible` ring; migration of the 39 overlays, 16 `inputClass` definitions, 26 spinners |
| 5 | `/impeccable typeset` + `layout` on `admin-ui` Operate pages | One family for admin chrome, fixed rem scale, eyebrow labels removed, 16px floor, 4-up stat grids rewritten, spacing rhythm instead of one `p-4` everywhere |
| 6 | `improve-animations` → plans; `animate` / `review-animations` per plan | Easing and duration tokens, press feedback, sheet and dialog transitions, broken keyframes fixed, `transition-all` gone |
| 7 | `mobile-native` baseline, `break-ui` on the card row and history rows | The eleven phone tells closed; long-name and count fixtures kept as regression fixtures |
| 8 | `/impeccable distill` + `quieter` on admin; `/impeccable bolder` only if a public surface reads flat | Admin disappears into the task; the scoreboard keeps its world |
| 9 | `/impeccable clarify` + `onboard` | Empty states that teach, actionable errors, consistent loading copy |
| 10 | `/impeccable harden` → `polish` → re-run `critique` | Edge cases, final consistency pass, a second score to compare against step 3 |

Several of these steps coincide with items already on the roadmap: the Room Settings reorganisation (tabs or sections), the Picks page redesign, the Leaderboard settings consolidation, the deferred S20 a11y items (`confirm()`/`alert()` → modals and toasts in `GlobalCatalogue.tsx`), and the "mobile scoreboard polish batch". The skills do not add work so much as give those items a method and a checker.

---

## 8. Risks, costs and where to steer against the skills' defaults

- **Impeccable is heavy and writes to the repo.** It adds `PRODUCT.md`, `DESIGN.md`, `.impeccable/` (config, critique snapshots, live-mode state), a hook entry in `.claude/settings.local.json`, and downloads a 21 MB engine per machine. Its `critique` insists on two sub-agents and emits a "DEGRADED" banner otherwise. The engine has anonymous telemetry (`impeccable telemetry off`). The `new-work` flow ("concept-seed", dealt directions, re-roll registers) is designed for inventing a visual world; ArcAid has one, so the refinement path (`document → critique → polish`) is the right one and `new-work` should be avoided unless a redesign is actually wanted.
- **`overused-font` will flag Inter.** Inter is ArcAid's body face. The decision is either a one-line `ignore-value overused-font Inter` or a swap; the Operate guidance says one well-tuned sans is fine and system fonts are permitted on product UI, so this is a taste call, not a defect.
- **Both skill sets lean toward restraint; the scoreboard is meant to be loud.** Emil's bar is Vercel/Linear; Impeccable's Operate mode says a grey screen with one accent is not restraint but also that "the world lends type, palette, density and one signature move, never the layout or the controls." The useful reading for ArcAid: apply restraint to admin and forms, keep full commitment on the room Scoreboard, Global Scoreboard and kiosk, and document the fire/plasma/glitch/attract effects as the signature move so the detector and the review skills stop re-litigating them. The risk is an agent following the skills literally and quieting the one surface that is already distinctive.
- **Expected false positives to decide once.** `side-tab` on the active nav item's `border-r-2` (both admin layouts); `pulsing-dot` on `.pulse`; `dark-glow` on `glow-cyan/green/magenta/amber` card borders and the Neon Circuit shadows; `marquee` on the rankings ticker; `gradient-text` on the opt-in title styles; `kicker-above-heading` on `NeonCard` titles. Several of these are the real tells, not false positives, but the ticker and title styles are owner-chosen features and belong in the ignore list with a reason.
- **Static detection is weak on TSX.** Three findings on 63k lines. The hook will catch gradient text, obvious glows and design-system drift per edit, but contrast, nesting, spacing and text size need the rendered pass, which needs the app running. A rendered scan could be added to CI using the existing Playwright setup against a seeded dev database; that is a small infrastructure item, not a skill feature.
- **Library adoption is a real dependency decision.** `pick-ui-library` would add base-ui, Sonner and possibly motion. ArcAid has deliberately hand-built its palette, toasts and dialogs. The gain is accessibility and interruptible motion for free; the cost is three dependencies and a migration touching 39 files.
- **Interaction with `CLAUDE.md` rules.** Nothing conflicts. `contrastAudit.cjs` covers token pairs per theme; Impeccable's `low-contrast` covers rendered pairs including `--sb-*` and raw classes it does not. The admin-ui vitest suite rule and the "build before commit" rule still apply to every change these skills would propose.

---

## 9. Bottom line

Installing the two skill sets would not by itself change a pixel. What they would change is the default output of every future UI edit: the hook stops the bordered-box, eyebrow-label, glow-shadow and gradient-text reflexes at the moment of typing; `DESIGN.md` makes the existing token system enforceable instead of advisory; `critique` turns "it feels AI-generated" into a scored list with file lines; and Emil's skills supply the motion, press-feedback, sheet, toast and phone-platform rules that ArcAid currently has no vocabulary for at all. The highest-leverage first moves are not visual: write `PRODUCT.md` and `DESIGN.md`, turn on the hook, build the six missing primitives, and fix the two broken animations and five undefined token classes that are already shipping.
