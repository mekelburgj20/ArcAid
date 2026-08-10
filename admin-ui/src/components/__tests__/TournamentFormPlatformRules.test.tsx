import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import TournamentFormFields, {
  defaultFormState,
  defaultPlatformRules,
  deviceOptionsFor,
  engineOptionsFor,
  getPlatformRuleConflicts,
  liftLegacyPlatformIds,
  parsePlatformRules,
  type PlatformRules,
  type TournamentFormState,
} from '../TournamentForm';

/**
 * ADR 0016 P2 §2 — the tournament form's platform section is two controls now,
 * engines and devices, each keeping ADR 0009's Must / Not-allowed pair.
 *
 * The FE has its own copy of the engine/device taxonomy
 * (`lib/scoreProvenance.ts`, parity-tested against the backend), so these
 * assertions check the FORM's use of it — the lift, the per-axis conflict rule,
 * and that a chip toggle lands on the axis it belongs to.
 */

const WHO_DUNNIT = ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'];

describe('parsePlatformRules', () => {
  it('reads the two-axis shape the API now ships', () => {
    const parsed = parsePlatformRules(JSON.stringify({
      engines: { required: ['fx'], excluded: [] },
      devices: { required: ['atgames'], excluded: ['vr_headset'] },
      restrictedText: 'AtGames only',
    }));
    expect(parsed).toEqual({
      engines: { required: ['fx'], excluded: [] },
      devices: { required: ['atgames'], excluded: ['vr_headset'] },
      restrictedText: 'AtGames only',
    });
  });

  it('lifts a legacy flat blob, keeping BOTH halves of a dual-axis id', () => {
    // `vpxs` is the VPX engine on AtGames hardware. Dropping the device half
    // would quietly widen the restriction to all of VPX.
    const parsed = parsePlatformRules(JSON.stringify({ required: ['vpxs'], excluded: ['real'] }));
    expect(parsed).toEqual({
      engines: { required: ['vpx'], excluded: ['real'] },
      devices: { required: ['atgames'], excluded: ['real_cabinet'] },
      restrictedText: '',
    });
  });

  it('lifts a device-only id to the device axis alone', () => {
    // An AtGames cabinet runs four engines, so `atgames` makes no engine claim.
    expect(parsePlatformRules(JSON.stringify({ required: ['atgames'] }))).toEqual({
      engines: { required: [], excluded: [] },
      devices: { required: ['atgames'], excluded: [] },
      restrictedText: '',
    });
  });

  it('keeps an unrecognised id rather than dropping the restriction', () => {
    expect(liftLegacyPlatformIds(['steam'])).toEqual({ engines: ['steam'], devices: [] });
  });

  it('degrades malformed JSON to no rules', () => {
    expect(parsePlatformRules('{ not json')).toEqual(defaultPlatformRules);
    expect(parsePlatformRules('["vpx"]')).toEqual(defaultPlatformRules);
  });
});

describe('getPlatformRuleConflicts', () => {
  it('flags an id that is required AND excluded on the same axis', () => {
    const rules: PlatformRules = {
      engines: { required: ['vpx'], excluded: ['vpx'] },
      devices: { required: [], excluded: [] },
      restrictedText: '',
    };
    expect(getPlatformRuleConflicts(rules)).toEqual(['Visual Pinball X']);
  });

  it('does NOT flag a cross-axis pair — that is the intended configuration', () => {
    // "FX titles, but not on AtGames cabinets" is a legitimate rule, not a
    // contradiction: the axes are independent.
    const rules: PlatformRules = {
      engines: { required: ['fx'], excluded: [] },
      devices: { required: [], excluded: ['atgames'] },
      restrictedText: '',
    };
    expect(getPlatformRuleConflicts(rules)).toEqual([]);
  });
});

describe('option lists', () => {
  it('folds the room catalogue into engines', () => {
    // `vpxs` and `pinball_fx_vr` collapse into the engines they really are.
    expect(engineOptionsFor(WHO_DUNNIT, defaultPlatformRules)).toEqual(['vpx', 'real', 'fx']);
  });

  it('offers devices the room can plausibly have', () => {
    const devices = deviceOptionsFor(WHO_DUNNIT, defaultPlatformRules);
    expect(devices).toEqual(expect.arrayContaining(['pc', 'atgames', 'vr_headset', 'real_cabinet']));
  });

  it('keeps an already-selected id visible even when the catalogue lost it', () => {
    const rules: PlatformRules = {
      engines: { required: ['zaccaria'], excluded: [] },
      devices: { required: [], excluded: ['console'] },
      restrictedText: '',
    };
    expect(engineOptionsFor(['vpx'], rules)).toContain('zaccaria');
    expect(deviceOptionsFor(['vpx'], rules)).toContain('console');
  });
});

function Harness({ platforms, initial }: { platforms: string[]; initial?: PlatformRules }) {
  const [state, setState] = useState<TournamentFormState>({
    ...defaultFormState,
    platformRules: initial ?? { ...defaultPlatformRules },
  });
  return (
    <TournamentFormFields
      state={state}
      set={(field, value) => setState(s => ({ ...s, [field]: value }))}
      platforms={platforms}
    />
  );
}

describe('TournamentFormFields platform section', () => {
  it('renders two controls, each with the plain-language Must / Not-allowed pair', () => {
    render(<Harness platforms={WHO_DUNNIT} />);
    expect(screen.getByText('Engines')).toBeTruthy();
    expect(screen.getByText('Devices')).toBeTruthy();
    // One pair per axis — the labels are unchanged from the single-control form.
    expect(screen.getAllByText(/Must be available on/)).toHaveLength(2);
    expect(screen.getAllByText(/Not allowed on/)).toHaveLength(2);
  });

  it('shows engine chips and device chips, not raw platform ids', () => {
    render(<Harness platforms={WHO_DUNNIT} />);
    expect(screen.getAllByRole('button', { name: 'Visual Pinball X' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'AtGames Cabinet' }).length).toBe(2);
    // `vpxs` is not an engine or a device — it decomposed into both.
    expect(screen.queryByRole('button', { name: 'VPX Standalone' })).toBeNull();
  });

  it('a legacy-shaped tournament loads with both halves selected', () => {
    render(<Harness platforms={WHO_DUNNIT} initial={parsePlatformRules(JSON.stringify({ required: ['vpxs'] }))} />);
    // First of each pair is the "Must be available on" row.
    const vpx = screen.getAllByRole('button', { name: 'Visual Pinball X' })[0];
    const atgames = screen.getAllByRole('button', { name: 'AtGames Cabinet' })[0];
    // `bg-neon-cyan/20` is the selected marker; the unselected chip carries a
    // `hover:border-neon-cyan/50` class, so border alone is not a signal.
    expect(vpx.className).toContain('bg-neon-cyan/20');
    expect(atgames.className).toContain('bg-neon-cyan/20');
  });

  it('toggling an engine chip does not touch the device axis', () => {
    render(<Harness platforms={WHO_DUNNIT} />);
    const engineMust = screen.getAllByRole('button', { name: 'Visual Pinball X' })[0];
    fireEvent.click(engineMust);
    expect(screen.getAllByRole('button', { name: 'Visual Pinball X' })[0].className)
      .toContain('bg-neon-cyan/20');
    // Devices untouched: no device chip is selected.
    const deviceMust = screen.getAllByRole('button', { name: 'AtGames Cabinet' })[0];
    expect(deviceMust.className).not.toContain('bg-neon-cyan/20');
  });

  it('warns only when an axis contradicts itself', () => {
    const conflicting: PlatformRules = {
      engines: { required: ['vpx'], excluded: ['vpx'] },
      devices: { required: [], excluded: [] },
      restrictedText: '',
    };
    render(<Harness platforms={WHO_DUNNIT} initial={conflicting} />);
    expect(screen.getByText(/can't be both required and not allowed/)).toBeTruthy();
  });
});

/**
 * Next-win disposition (ROADMAP, locked 2026-08-09) — the "Allow Dynasty"
 * checkbox lives in the Game Rotation section, grouped with the other
 * winner-picks settings (same conditional-visibility pattern as the pick
 * windows: no winner-picks flow, no dynasty rule to configure).
 */
describe('TournamentFormFields — Allow Dynasty checkbox', () => {
  it('defaults to CHECKED (matches the backend default of allow_dynasty=1)', () => {
    expect(defaultFormState.allowDynasty).toBe(true);
    render(<Harness platforms={WHO_DUNNIT} />);
    const checkbox = screen.getByLabelText(/Allow Dynasty/) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('toggling it off flips state.allowDynasty', () => {
    render(<Harness platforms={WHO_DUNNIT} />);
    const checkbox = screen.getByLabelText(/Allow Dynasty/) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it('is hidden entirely when "Winner picks next game" is off — nothing to configure', () => {
    render(<Harness platforms={WHO_DUNNIT} />);
    const winnerPicksToggle = screen.getByLabelText(/Winner picks next game/);
    fireEvent.click(winnerPicksToggle);
    expect(screen.queryByLabelText(/Allow Dynasty/)).toBeNull();
  });
});
