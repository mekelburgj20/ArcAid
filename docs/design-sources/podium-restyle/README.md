# Handoff: Room Card Podium Restyle — "Holo Steps"

## Overview

Restyle of the podium block on the room Showcase score card. The solid gold/silver/bronze rectangles are replaced with a literal stepped podium: translucent metal-tinted glass risers (2·1·3 arrangement), a slow breathing glow per metal, and ranks 4–5 as quiet glass list rows beneath.

**Target file:** `admin-ui/src/components/scoreboard/ShowcasePodium.tsx`
**Ship as:** a new podium variant option (e.g. `holo-steps`) alongside the existing variants in the scoreboard style config (`admin-ui/src/lib/scoreboardConfig.ts` / `scoreboardThemes.ts`), selectable per room — not a hard replacement.

The JSX in `reference/PodiumRedesign.jsx` is a **browser prototype** (inline styles, mock data). Recreate it with Tailwind + the existing `@theme` tokens; do not port inline styles verbatim. `PodiumHoloSteps` (with `filled` and `busyBg` props) is the canonical spec — variants A/B/C in the same file were explored and rejected.

## Decisions (user-approved)

- Direction: **D2 — Holo Steps + list** (fake 3rd filled, 4th/5th as normal rows)
- Risers **breathe**: slowly glow bright then dim, each in its own metal color, staggered so they don't pulse in unison
- Riser fill is **more opaque** metal color (reads as gold/silver/bronze blocks, art still visible through blur)
- **Scanline shimmer on the gold riser only** — user explicitly rejected it on silver and bronze
- Must stay legible over **busy backglass art** (see `screenshots/03`)

## Metal colors

| Metal | Value | Note |
|---|---|---|
| Gold | `var(--color-neon-amber)` = `oklch(82% 0.189 84.429)` | existing token |
| Silver | `#c0c0c0` | `--color-medal-silver` (added in the Global Scoreboard handoff; add if not present) |
| Bronze | `#cd7f32` | `--color-medal-bronze` — **never** `neon-coral` (reads pink) |

## Riser spec

Arrangement: flex row, `gap: 6px`, `align-items: flex-end`, visual order **2 · 1 · 3**. Step heights: 1st `64px`, 2nd `44px`, 3rd `32px`. Container padding `4px 16px 12px`.

Each occupied riser (`{m}` = metal color):
- `border-radius: 6px 6px 0 0`
- Fill: `linear-gradient(180deg, {m}66 0%, {m}3a 55%, {m}18 100%)` layered over `rgba(8,10,16,0.5)`; `backdrop-filter: blur(8px)`
- `border-top: 2px solid {m}`
- Rank numeral inside, top-center, `margin-top: 6px`: `font-display` 22/800, **white**, `text-shadow: 0 0 14px {m}, 0 1px 3px rgba(0,0,0,0.8)`
- Breathing glow (CSS vars `--pr-glow: {m}44`, `--pr-glow-hi: {m}99`):

```css
@keyframes pr-breathe {
  0%, 100% { filter: brightness(1); box-shadow: 0 -1px 14px var(--pr-glow); }
  50% { filter: brightness(1.45); box-shadow: 0 -2px 30px var(--pr-glow-hi); }
}
/* duration 3.6s + rank*0.6s; delay rank*0.4s; ease-in-out infinite */
```

- **Gold only** — scanline shimmer overlay:

```css
/* overlay div, absolute inset 0 */
background: repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,0.045) 3px 4px);
background-size: 100% 300%;
animation: pr-scan 7s linear infinite;
@keyframes pr-scan { 0% { background-position: 0 -120%; } 100% { background-position: 0 220%; } }
```

- `prefers-reduced-motion`: disable both `pr-breathe` and `pr-scan`.

**Empty riser:** fill `rgba(255,255,255,0.03)`, `border-top: 2px solid rgba(255,255,255,0.12)`, numeral `rgba(255,255,255,0.12)`, no animation, no glow.

## Above each riser

Stacked, centered, `gap: 3px`, `margin-bottom: 8px`:
- `PlayerAvatar` — 30px for 1st, 24px for 2nd/3rd
- Name — 12.5px (1st) / 11px, weight 600, truncated, `text-shadow: 0 1px 4px rgba(0,0,0,0.9)` (busy-art legibility)
- Score — `font-mono` 13px (1st) / 11px, weight 700, color `{m}`, `text-shadow: 0 0 10px {m}55, 0 1px 4px rgba(0,0,0,0.9)`. Append the expand affordance (`+`) where the existing card exposes it.

## Runners-up list (ranks 4–5)

Below the steps, column `gap: 3px`, padding `0 16px 14px`. Each row:
- `padding: 5px 10px`, `radius: 6px`, `background: rgba(8,10,16,0.55)`, `backdrop-filter: blur(6px)`, `border: 1px solid rgba(255,255,255,0.06)`
- Rank: 16px-wide cell, `font-mono` 10/700, `rgba(255,255,255,0.45)`
- `PlayerAvatar` 16px · name 11/500 truncated `flex: 1` · score `font-mono` 11/700 `rgba(255,255,255,0.85)`
- Show as many rows as the card currently shows beyond the podium (mock shows 2); keep the existing data source/limits.

## Busy-background legibility (screenshots/03)

The dark text-shadows on names/scores and the white-with-metal-glow numerals are **required**, not decorative — they're what keeps the podium readable over loud backglass art. Card scrim stays as the Showcase card has it today; do not rely on the scrim alone.

## Preserve from the existing component

Data shape, expand/collapse behavior, empty-slot handling, avatar component, score formatting, and the card's header/footer — this is a restyle of the podium block only.

## Files

| File | What |
|---|---|
| `README.md` | This spec |
| `reference/PodiumRedesign.jsx` | Prototype source — `PodiumHoloSteps` is canonical; A/B/C rejected |
| `reference/shared.jsx`, `reference/icons.jsx` | Token values, mock shapes, Lucide glyphs used |
| `screenshots/01-holo-steps-empty-3rd.png` | D — empty 3rd slot state (unlit riser) |
| `screenshots/02-holo-steps-full-list.png` | **D2 — the target**: full podium + ranks 4–5 |
| `screenshots/03-holo-steps-busy-bg.png` | Legibility stress test over loud art |

Screenshots are static frames of an animated design — the breathing glow won't show; build it from the keyframes above.
