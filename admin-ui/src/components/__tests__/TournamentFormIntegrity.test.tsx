import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import TournamentFormFields, { defaultFormState, type TournamentFormState } from '../TournamentForm';
import { toPayload } from '../../lib/tournamentFormPayload';
import { defaultSanctionedRules, getIntegrityErrors } from '../../lib/integrityForm';

/**
 * Integrity section (v2.166.0, ADR 0027; Castcade ADR 0005).
 *
 * Locks: Open play is the default and shows no rule fields; Sanctioned play
 * reveals them with the server's defaults; the payload always carries
 * `integrity_mode` and the FULL rule set in both modes; a mistyped hash is
 * reported and gates the save (the server would silently drop it).
 */

function Harness({ initial }: { initial?: Partial<TournamentFormState> }) {
  const [state, setState] = useState<TournamentFormState>({ ...defaultFormState, ...initial });
  return (
    <>
      <TournamentFormFields
        state={state}
        set={(field, value) => setState(s => ({ ...s, [field]: value }))}
        platforms={[]}
      />
      <pre data-testid="payload">{JSON.stringify(toPayload(state))}</pre>
      <pre data-testid="errors">{JSON.stringify(getIntegrityErrors(state.integrityMode, state.sanctionedRules))}</pre>
    </>
  );
}

const payload = () => JSON.parse(screen.getByTestId('payload').textContent || '{}');
const errors = () => JSON.parse(screen.getByTestId('errors').textContent || '[]') as string[];
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const DEFAULT_WIRE = {
  require_named_table: true,
  require_stock_physics: true,
  require_factory_adjustments: true,
  adjustments_allowed: ['Free Play'],
  require_known_build: true,
  allow_nightly_builds: true,
  blessed_build_hashes: [],
  min_tilt_sensitivity: 300,
  max_accel_gain: 150,
  require_nudge_filter: false,
};

describe('TournamentForm — Integrity section', () => {
  it('defaults to Open play with no rule fields and still sends the default rules', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Open play' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Any table of the game counts/)).toBeInTheDocument();
    expect(screen.queryByTestId('sanctioned-rules')).toBeNull();
    expect(payload()).toMatchObject({ integrity_mode: 'open', sanctioned_rules: DEFAULT_WIRE });
  });

  it('switching to Sanctioned play shows the rule fields with the server defaults', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Sanctioned play' }));

    expect(screen.getByText(/held out of this tournament/)).toBeInTheDocument();
    expect(screen.getByTestId('sanctioned-rules')).toBeInTheDocument();
    expect(box('Require the named table').checked).toBe(true);
    expect(box('Require stock physics').checked).toBe(true);
    expect(box('Require factory adjustments').checked).toBe(true);
    expect(box('Require a known build').checked).toBe(true);
    expect(box('Allow nightly builds').checked).toBe(true);
    expect(box('Require the nudge filter').checked).toBe(false);
    expect(box('Minimum tilt sensitivity').value).toBe('300');
    expect(box('Maximum accelerometer gain').value).toBe('150');
    expect(box('Allowed adjustments').value).toBe('Free Play');
    expect((screen.getByLabelText('Blessed build hashes') as HTMLTextAreaElement).value).toBe('');
    expect(payload()).toMatchObject({ integrity_mode: 'sanctioned', sanctioned_rules: DEFAULT_WIRE });
  });

  it('edited rules reach the payload as the wire shape (lists parsed, hashes lower-cased)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Sanctioned play' }));
    fireEvent.click(box('Require the nudge filter'));
    fireEvent.click(box('Allow nightly builds'));
    fireEvent.change(box('Minimum tilt sensitivity'), { target: { value: '450' } });
    fireEvent.change(box('Maximum accelerometer gain'), { target: { value: '200' } });
    fireEvent.change(box('Allowed adjustments'), { target: { value: 'Free Play, Balls Per Game ,,' } });
    const hash = 'A'.repeat(64);
    fireEvent.change(screen.getByLabelText('Blessed build hashes'), { target: { value: `${hash}\n\n` } });

    expect(payload().sanctioned_rules).toEqual({
      ...DEFAULT_WIRE,
      require_nudge_filter: true,
      allow_nightly_builds: false,
      min_tilt_sensitivity: 450,
      max_accel_gain: 200,
      adjustments_allowed: ['Free Play', 'Balls Per Game'],
      blessed_build_hashes: ['a'.repeat(64)],
    });
    expect(errors()).toEqual([]);
  });

  it('tuned rules survive a switch to Open play and back', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Sanctioned play' }));
    fireEvent.change(box('Minimum tilt sensitivity'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open play' }));
    expect(payload()).toMatchObject({ integrity_mode: 'open', sanctioned_rules: { min_tilt_sensitivity: 500 } });
    fireEvent.click(screen.getByRole('button', { name: 'Sanctioned play' }));
    expect(box('Minimum tilt sensitivity').value).toBe('500');
  });

  it('reports a hash that is not 64 hex characters, only in Sanctioned play', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Sanctioned play' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Blessed build hashes'), { target: { value: 'not-a-hash' } });
    expect(screen.getByRole('alert').textContent).toMatch(/not a SHA-256/);
    expect(errors()).toHaveLength(1);
    // The same text is harmless in Open play: the rules are kept, not enforced.
    fireEvent.click(screen.getByRole('button', { name: 'Open play' }));
    expect(errors()).toEqual([]);
  });

  it('clamps the number rules to their ranges', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Sanctioned play' }));
    fireEvent.change(box('Minimum tilt sensitivity'), { target: { value: '5000' } });
    expect(payload().sanctioned_rules.min_tilt_sensitivity).toBe(1000);
    fireEvent.change(box('Maximum accelerometer gain'), { target: { value: '10' } });
    expect(payload().sanctioned_rules.max_accel_gain).toBe(50);
  });

  it('renders a stored Sanctioned tournament with its own rules', () => {
    render(<Harness initial={{
      integrityMode: 'sanctioned',
      sanctionedRules: { ...defaultSanctionedRules, requireStockPhysics: false, adjustmentsAllowed: 'Free Play, Tilt Warnings' },
    }} />);
    expect(screen.getByRole('button', { name: 'Sanctioned play' })).toHaveAttribute('aria-pressed', 'true');
    expect(box('Require stock physics').checked).toBe(false);
    expect(box('Allowed adjustments').value).toBe('Free Play, Tilt Warnings');
  });

  it('is offered on an event too', () => {
    render(<Harness initial={{ format: 'event' }} />);
    expect(screen.getByRole('button', { name: 'Sanctioned play' })).toBeInTheDocument();
    expect(payload().integrity_mode).toBe('open');
  });
});
