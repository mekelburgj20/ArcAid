import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import TournamentFormFields, { defaultFormState, type TournamentFormState } from '../TournamentForm';
import { toPayload, tournamentToFormState, type Tournament } from '../../lib/tournamentFormPayload';
import { defaultSeasonState } from '../../lib/seasonForm';
import { defaultPollState } from '../../lib/pollForm';

/**
 * Season section + "Pick by poll" in Game Rotation (ADR 0026, plan §8.1, §13).
 *
 * Locks: "Pick by poll" is a third Game Rotation checkbox that unticks and
 * disables winner picks + auto-pick and locks Active Slots (1) and Cooldown
 * Days (0); its poll fields, plain-language echo and the three-option "Poll
 * Tie-breaker" live under it; the Season section holds only the table count
 * and forces nothing; and the wire shape of both blocks.
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
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('TournamentForm — Pick by poll (Game Rotation)', () => {
  it('is off by default and the rotation fields are editable', () => {
    render(<Harness />);
    expect(box('Pick by poll').checked).toBe(false);
    expect(box('Winner picks next game').disabled).toBe(false);
    expect(box('Active Slots').disabled).toBe(false);
    expect(box('Active Slots').value).toBe('3');
    expect(box('Cooldown Days').disabled).toBe(false);
    expect(box('Cooldown Days').value).toBe('120');
    expect(screen.queryByLabelText('Poll opens hours before rotation')).toBeNull();
    expect(payload()).toMatchObject({ poll_picks: false, max_active_games: 3, eligibility_days: 120 });
  });

  it('turning it on unticks + disables the other two, locks slots/cooldown, and shows the poll fields', () => {
    render(<Harness />);
    fireEvent.click(box('Pick by poll'));

    expect(box('Winner picks next game').disabled).toBe(true);
    expect(box('Winner picks next game').checked).toBe(false);
    expect(box('Auto-pick if no selection').disabled).toBe(true);
    expect(box('Auto-pick if no selection').checked).toBe(false);
    expect(box('Active Slots').disabled).toBe(true);
    expect(box('Active Slots').value).toBe('1');
    expect(box('Cooldown Days').disabled).toBe(true);
    expect(box('Cooldown Days').value).toBe('0');
    expect(screen.getByText(
      'Fixed while Pick by poll is on: the poll picks each table, one table is live at a time; a community vote overrides cooldown.',
    )).toBeTruthy();

    expect(box('Poll opens hours before rotation').value).toBe('96');
    expect(box('Poll closes hours before rotation').value).toBe('3');
    expect(payload()).toMatchObject({
      poll_picks: true,
      poll_opens_before_h: 96,
      poll_closes_before_h: 3,
      poll_tie_rule: 'admin',
      winner_picks: false,
      auto_pick: false,
      max_active_games: 1,
      eligibility_days: 0,
      season_table_count: null,
    });
    expect('poll_tie_fallback' in payload()).toBe(false);
    expect('season_tie_fallback' in payload()).toBe(false);
  });

  it('turning it back off restores the admin\'s own values', () => {
    render(<Harness initial={{ eligibilityDays: 45 }} />);
    fireEvent.click(box('Pick by poll'));
    expect(payload().eligibility_days).toBe(0);
    fireEvent.click(box('Pick by poll'));
    expect(box('Active Slots').value).toBe('3');
    expect(box('Cooldown Days').disabled).toBe(false);
    expect(box('Cooldown Days').value).toBe('45');
    expect(box('Winner picks next game').checked).toBe(true);
    expect(payload()).toMatchObject({ poll_picks: false, eligibility_days: 45, winner_picks: true });
  });

  it('echoes the poll times in plain language for a weekly rotation', () => {
    render(<Harness />);
    fireEvent.click(box('Pick by poll'));
    expect(screen.getByTestId('poll-echo').textContent).toMatch(
      /Opens Monday 12:00 AM .+ · closes Thursday 9:00 PM .+ · table starts Friday 12:00 AM/,
    );
  });

  it('falls back to the offsets for a cadence it cannot describe', () => {
    render(<Harness initial={{ schedule: { cron: '0 0 1 * *', timezone: 'America/New_York' } }} />);
    fireEvent.click(box('Pick by poll'));
    expect(screen.getByTestId('poll-echo').textContent).toBe('Each poll opens 96 h and closes 3 h before its rotation.');
  });

  it('validates: the poll must open earlier than it closes', () => {
    render(<Harness />);
    fireEvent.click(box('Pick by poll'));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(box('Poll closes hours before rotation'), { target: { value: '100' } });
    expect(screen.getByRole('alert').textContent).toMatch(/must open earlier than it closes/);
  });

  it('"Poll Tie-breaker" has exactly three options and no fallback select', () => {
    render(<Harness />);
    fireEvent.click(box('Pick by poll'));
    const select = screen.getByLabelText(/Poll Tie-breaker/) as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual([
      'Admin decides — no table is queued until an admin chooses',
      'Random pick among the tied',
      'First nominated wins',
    ]);
    expect(screen.queryByLabelText(/Until an admin decides/)).toBeNull();
    expect(screen.queryByText(/When the vote ties/)).toBeNull();
    fireEvent.change(select, { target: { value: 'random' } });
    expect(payload().poll_tie_rule).toBe('random');
  });
});

describe('TournamentForm — Season section', () => {
  it('holds only the table count, forces nothing, and has no poll fields', () => {
    render(<Harness />);
    const season = screen.getByTestId('season-section');
    fireEvent.click(box('Run as a Season'));

    expect(box('Tables in the season').value).toBe('12');
    expect(within(season).queryByLabelText('Poll opens hours before rotation')).toBeNull();
    expect(within(season).queryByLabelText(/Tie-breaker/)).toBeNull();
    expect(screen.queryByText(/fixed for a Season/)).toBeNull();
    // A Season alone forces nothing.
    expect(box('Winner picks next game').disabled).toBe(false);
    expect(box('Active Slots').disabled).toBe(false);
    expect(box('Cooldown Days').disabled).toBe(false);
    expect(payload()).toMatchObject({
      season_table_count: 12, poll_picks: false, max_active_games: 3, eligibility_days: 120, winner_picks: true,
    });
  });

  it('a poll-picked Season sends both blocks', () => {
    render(<Harness />);
    fireEvent.click(box('Run as a Season'));
    fireEvent.click(box('Pick by poll'));
    expect(payload()).toMatchObject({ season_table_count: 12, poll_picks: true, max_active_games: 1 });
  });

  it('neither is offered on an event', () => {
    render(<Harness initial={{ format: 'event' }} />);
    expect(screen.queryByLabelText('Run as a Season')).toBeNull();
    expect(screen.queryByLabelText('Pick by poll')).toBeNull();
    expect('season_table_count' in payload()).toBe(false);
    expect('poll_picks' in payload()).toBe(false);
  });
});

describe('tournamentToFormState — season + poll columns', () => {
  const base: Tournament = {
    id: 't1', name: 'Grind', type: 'WG', mode: 'pinball',
    cadence: JSON.stringify({ cron: '0 0 * * 5', timezone: 'America/New_York' }),
    platform_rules: '{}', is_active: 1, display_order: 0, max_active_games: 1,
    cleanup_rule: '{"mode":"retain","count":1}', winner_picks: 0, auto_pick: 0,
    eligibility_days: 0, winner_pick_window_min: 60, runnerup_pick_window_min: 30,
  };

  it('reads a stored poll-picked season', () => {
    const state = tournamentToFormState({
      ...base,
      season_table_count: 8, poll_picks: 1, poll_opens_before_h: 72,
      poll_closes_before_h: 6, poll_tie_rule: 'first_nominated',
    });
    expect(state.season).toEqual({ enabled: true, tableCount: 8 });
    expect(state.poll).toEqual({ enabled: true, opensBeforeH: 72, closesBeforeH: 6, tieRule: 'first_nominated' });
  });

  it('a row with neither is off with the defaults ready', () => {
    const state = tournamentToFormState(base);
    expect(state.season).toEqual(defaultSeasonState);
    expect(state.poll).toEqual(defaultPollState);
  });
});
