# Contract: room-exit nav + NumberStepper empty-field fix (v2.34.1)

Two small FE-only fixes from play-tester feedback. No backend, no migration (113 stays free).

## D1 — Escape hatch from room pages to the landing page

`admin-ui/src/components/PublicLayout.tsx` ~:111-114 currently renders ONE `<Link to={/${slug}}>` wrapping both the ArcAid logo img and the room name. Split it:

1. **Logo** (`/arcaid-logo.png` img) → its own `<Link to="/">` with `aria-label="All game rooms"` and `title="All game rooms"`. Keep exact sizing/spacing classes so the header layout is pixel-identical.
2. **Room name** → keeps `<Link to={/${slug}}>` (room home), styling unchanged.
3. Preserve the flex container's `min-w-0` truncation behavior and mobile sizing (`sm:` variants).

`admin-ui/src/components/UserMenu.tsx` (~:150-155 has the "My Rooms" item): add an **"All Game Rooms"** menu item linking to `/`, adjacent to "My Rooms". Check the component's logged-out/guest rendering: if the menu (or a variant of it) renders for guests, include the item there too; if guests get no menu at all, note that in the report — the logo link is then their only path, which is acceptable. Match existing item markup/iconography conventions (pick a sensible lucide icon consistent with neighbors).

Do NOT touch: nav item list (Lobby/Scores/Stats/Global), ticker mounting, footer, admin layouts, GlobalScoreboard/landing headers.

## D2 — NumberStepper allows empty-while-typing

`admin-ui/src/components/TournamentForm.tsx` ~:112-123. Current: `value={value}` + `onChange(Math.max(min, parseInt(e.target.value) || 0))` — deleting the last char snaps to min; the field can never be empty. Fix with the draft-state pattern:

1. Local `draft: string | null` state — `null` = not editing (render `String(value)`); string = user's in-progress text (empty allowed).
2. `onChange`: set draft to the raw string; if it parses to a valid number, ALSO propagate the clamped value live (so previews/validation stay current); if empty/invalid, propagate nothing yet.
3. `onBlur`: commit — parse draft; invalid/empty → revert to last valid `value` (clamped to min); clear draft to null.
4. The − / + buttons: operate on the committed `value` as today AND clear any draft (explicit click owns state).
5. If the parent `value` prop changes externally while not editing, the field must reflect it (draft null → renders prop — verify no stale-draft case when the same stepper is reused across form opens; reset draft on value-prop identity change if needed, or on modal open).
6. Behavior contract: type Select-All+"45" works; delete-all then blur → snaps back to previous valid value; delete-all then type "5" → 5 propagates; min clamping preserved on commit and on ± clicks.

All `NumberStepper` call sites (winner window, runner-up window, cleanup count, etc.) get the fix for free — do not change call sites.

## Tests

Add a small vitest for NumberStepper (mount directly): (a) clearing the field does not force min into the input, (b) blur after clear reverts to prior value, (c) typing a valid number propagates clamped, (d) ± still works. If TournamentForm's module has heavy imports that make mounting painful, extract NumberStepper to its own file ONLY if necessary (prefer not to move it; report if you do).

Gates: admin-ui `npm run build` + `npx vitest run` (59 currently), root `npm run build`, `docker compose build`.

## Process

1. Branch `nav-escape-numberstepper` off current `main`.
2. Implement, gates, version → **2.34.1** (Edit tool). No CHANGELOG edit.
3. Commit `fix:` prefix. Do NOT push or open PR.
4. Report: files, decisions, verbatim gate results, SHA, deviations/blockers. STOP on semantic conflicts.

Hygiene: NEVER `git add -A`; no SW bump; admin-ui ESM.
