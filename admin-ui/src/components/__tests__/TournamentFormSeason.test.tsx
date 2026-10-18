import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import TournamentFormFields, { defaultFormState, type TournamentFormState } from '../TournamentForm';
import { toPayload, tournamentToFormState, type Tournament } from '../../lib/tournamentFormPayload';
import { defaultSeasonState } from '../../lib/seasonForm';

/**
 * Season section of the tournament form (docs/season-format-plan.md §8.1).
 *
 * Locks: the toggle reveals the season fields with the plan's defaults; the
 * four fields a season forces (winner picks, auto-pick, active slots, cooldown
 * days) render
 * locked at their forced values; the poll-timing echo; the client-side
 * validation; and the wire shape of the season block.
 */

const WEEKLY: TournamentFormState['schedule'] = { cron: '0 0 * * 5', timezone: 'America/New_York' };

function Harness({ initial }: { initial?: Partial<TournamentFormState> }) {
  const [state, setState] = useState<TournamentFormState>({
    ...defaultFormState,
    schedule: WEEKLY,
    maxActiveGames: 3,
    ...initial,
  });
  return (
    <>
      <TournamentFormFields
        state={state}
        set={(field, value) => setState(s => ({ ...s, [field]: value }))}
        platforms={[]}
      />
      <pre data-testid="payload">{JSON.stringify(toPayload(state))}</pre>
    </>
  );
}

const payload = () => JSON.parse(screen.getByTestId('payload').textContent || '{}');

describe('TournamentForm — Season section', () => {
  it('is off by default and the rotation fields are editable', () => {
    render(<Harness />);
    const toggle = screen.getByLabelText('Run as a Season') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect((screen.getByLabelText('Winner picks next game') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Active Slots') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Active Slots') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Cooldown Days') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Cooldown Days') as HTMLInputElement).value).toBe('120');
    expect(payload().season_table_count).toBeNull();
    expect(payload().max_active_games).toBe(3);
    expect(payload().eligibility_days).toBe(120);
  });

  it('toggling on shows the defaults and locks the forced fields at their forced values', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Run as a Season'));

    expect((screen.getByLabelText('Tables in the season') as HTMLInputElement).value).toBe('12');
    // Points live on the season's ranking group (Rankings page), not here.
    expect(screen.queryByLabelText('Points for 1st')).toBeNull();
    expect((screen.getByLabelText('Poll opens hours before rotation') as HTMLInputElement).value).toBe('96');
    expect((screen.getByLabelText('Poll closes hours before rotation') as HTMLInputElement).value).toBe('3');

    const winner = screen.getByLabelText('Winner picks next game') as HTMLInputElement;
    const auto = screen.getByLabelText('Auto-pick if no selection') as HTMLInputElement;
    const slots = screen.getByLabelText('Active Slots') as HTMLInputElement;
    expect(winner.disabled).toBe(true);
    expect(winner.checked).toBe(false);
    expect(auto.disabled).toBe(true);
    expect(auto.checked).toBe(false);
    expect(slots.disabled).toBe(true);
    expect(slots.value).toBe('1');
    const cooldown = screen.getByLabelText('Cooldown Days') as HTMLInputElement;
    expect(cooldown.disabled).toBe(true);
    expect(cooldown.value).toBe('0');
    expect(screen.getAllByText(/Fixed while Season is on/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/a community vote overrides cooldown/).length).toBeGreaterThan(0);

    expect(payload()).toMatchObject({
      season_table_count: 12,
      season_poll_opens_before_h: 96,
      season_poll_closes_before_h: 3,
      season_tie_rule: 'admin',
      season_tie_fallback: 'random',
      winner_picks: false,
      auto_pick: false,
      max_active_games: 1,
      eligibility_days: 0,
    });
  });

  it('turning the season back off restores the admin\'s own values', () => {
    render(<Harness initial={{ eligibilityDays: 45 }} />);
    fireEvent.click(screen.getByLabelText('Run as a Season'));
    expect(payload().eligibility_days).toBe(0);
    fireEvent.click(screen.getByLabelText('Run as a Season'));
    expect((screen.getByLabelText('Active Slots') as HTMLInputElement).value).toBe('3');
    const cooldown = screen.getByLabelText('Cooldown Days') as HTMLInputElement;
    expect(cooldown.disabled).toBe(false);
    expect(cooldown.value).toBe('45');
    expect(payload().eligibility_days).toBe(45);
    expect((screen.getByLabelText('Winner picks next game') as HTMLInputElement).checked).toBe(true);
    expect(payload().season_table_count).toBeNull();
  });

  it('echoes the poll times in plain language for a weekly rotation', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Run as a Season'));
    expect(screen.getByTestId('season-echo').textContent).toMatch(
      /Opens Monday 12:00 AM .+ · closes Thursday 9:00 PM .+ · table starts Friday 12:00 AM/,
    );
  });

  it('falls back to the offsets for a cadence it cannot describe', () => {
    render(<Harness initial={{ schedule: { cron: '0 0 1 * *', timezone: 'America/New_York' } }} />);
    fireEvent.click(screen.getByLabelText('Run as a Season'));
    expect(screen.getByTestId('season-echo').textContent).toBe('Each poll opens 96 h and closes 3 h before its rotation.');
  });

  it('validates: the poll must open earlier than it closes', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Run as a Season'));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Poll closes hours before rotation'), { target: { value: '100' } });
    expect(screen.getByRole('alert').textContent).toMatch(/must open earlier than it closes/);
  });

  it('shows the tie fallback only when the rule is "admin"', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Run as a Season'));
    expect(screen.getByLabelText(/Until an admin decides/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/When the vote ties/), { target: { value: 'random' } });
    expect(screen.queryByLabelText(/Until an admin decides/)).toBeNull();
    expect(payload().season_tie_rule).toBe('random');
  });

  it('is not offered on an event', () => {
    render(<Harness initial={{ format: 'event' }} />);
    expect(screen.queryByLabelText('Run as a Season')).toBeNull();
    expect('season_table_count' in payload()).toBe(false);
  });
});

describe('tournamentToFormState — season columns', () => {
  const base: Tournament = {
    id: 't1', name: 'Grind', type: 'WG', mode: 'pinball',
    cadence: JSON.stringify({ cron: '0 0 * * 5', timezone: 'America/New_York' }),
    platform_rules: '{}', is_active: 1, display_order: 0, max_active_games: 1,
    cleanup_rule: '{"mode":"retain","count":1}', winner_picks: 0, auto_pick: 0,
    eligibility_days: 0, winner_pick_window_min: 60, runnerup_pick_window_min: 30,
  };

  it('reads a stored season', () => {
    const state = tournamentToFormState({
      ...base,
      season_table_count: 8, season_poll_opens_before_h: 72,
      season_poll_closes_before_h: 6, season_tie_rule: 'first_nominated', season_tie_fallback: 'first_nominated',
    });
    expect(state.season).toEqual({
      enabled: true, tableCount: 8, opensBeforeH: 72, closesBeforeH: 6,
      tieRule: 'first_nominated', tieFallback: 'first_nominated',
    });
  });

  it('a row without a season is off with the defaults ready', () => {
    expect(tournamentToFormState(base).season).toEqual(defaultSeasonState);
  });
});
