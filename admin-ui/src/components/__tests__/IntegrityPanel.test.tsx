import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import IntegrityPanel, { type EvidenceRow } from '../IntegrityPanel';
import type { Tournament } from '../../lib/tournamentFormPayload';

/**
 * Integrity panel (v2.166.0, ADR 0027) — the runner names the required table
 * per game and reads the Castcade evidence trail.
 */

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);
const mockedPatch = vi.mocked(api.patch);

const ROOM = 'room-1';
const TOURNAMENT: Tournament = {
  id: 't-1', name: 'Flippin Fear Fest', type: 'FFF', mode: 'pinball',
  cadence: '{"cron":"0 0 * * *"}', platform_rules: '{}', is_active: 1, display_order: 0,
  max_active_games: 1, cleanup_rule: '{}', winner_picks: 1, auto_pick: 1, eligibility_days: 120,
  winner_pick_window_min: 60, runnerup_pick_window_min: 30,
  integrity_mode: 'sanctioned', sanctioned_rules: null,
};

const INTEGRITY = {
  tournamentId: 't-1',
  mode: 'sanctioned',
  rules: {},
  games: [
    { gameId: 'g-mb', name: 'Monster Bash', status: 'ACTIVE', requiredVpsTableId: null, requiredRom: null, requiredFingerprint: null, globalGameId: 'gg-mb' },
    { gameId: 'g-x', name: 'Mystery Table', status: 'COMPLETED', requiredVpsTableId: null, requiredRom: null, requiredFingerprint: null, globalGameId: null },
  ],
  verdicts: {},
};

const TABLES = {
  gameId: 'gg-mb', vpsGameId: 'mb-vps',
  tables: [
    { vpsTableId: 'tbl-vr', name: 'Sixtoe, Flupper vVR 1.0 VR edition', authors: ['Sixtoe', 'Flupper'], version: 'VR 1.0', tableFormat: 'VPX', features: ['VR'], updatedAt: null },
    { vpsTableId: 'tbl-desk', name: 'JPSalas v2.1 desktop', authors: ['JPSalas'], version: '2.1', tableFormat: 'VPX', features: [], updatedAt: null },
  ],
};

const EVIDENCE: EvidenceRow[] = [
  {
    id: 7, deviceId: 'dev-1', canonicalUserId: '123456789012345678', outcome: 'not_sanctioned',
    gameId: 'g-mb', gameName: 'Monster Bash', scoreHistoryId: null, globalScoreId: 'gs-1', integrityMode: 'sanctioned',
    verdict: 'flagged', reasons: ['tilt sensitivity 200 is below the minimum 300'],
    checks: [
      { rule: 'evidence', status: 'pass', detail: 'evidence present' },
      { rule: 'named_table', status: 'skipped', detail: 'no required table set for this game' },
      { rule: 'tilt_sensitivity', status: 'fail', detail: 'tilt sensitivity 200 is below the minimum 300' },
    ],
    tableName: 'Monster Bash (Williams 1998)', rom: 'mb_10', score: 123456780, playedAt: '2026-10-20 18:00:00',
    evidence: {
      vpsGame: 'mb-vps', vpsTable: 'tbl-vr', tableSha256: 'c'.repeat(64),
      ini: { stock: true, accel: true, tilt_sens: 200, accel_gain_x: 150, accel_gain_y: 150, nudge_filter: false },
      adjustments: { total: 40, non_factory: [] },
      build: { vpx: { sha256: null, version: '10.8.0', known: 'vpx-10.8.0', family: 'official' }, vpinmame: { sha256: null, version: '3.6.0', known: null, family: 'nightly' }, cheat: false },
    },
    createdAt: '2026-10-20 18:00:05',
  },
  {
    id: 6, deviceId: 'dev-1', canonicalUserId: '123456789012345678', outcome: 'ingested',
    gameId: 'g-mb', gameName: 'Monster Bash', scoreHistoryId: 55, globalScoreId: null, integrityMode: 'sanctioned',
    verdict: 'pass', reasons: [], checks: [{ rule: 'evidence', status: 'pass', detail: 'evidence present' }],
    tableName: 'Monster Bash (Williams 1998)', rom: 'mb_10', score: 98765430, playedAt: '2026-10-19 18:00:00',
    evidence: { vpsGame: 'mb-vps', vpsTable: 'tbl-vr', tableSha256: null, ini: null, adjustments: null, build: null },
    createdAt: '2026-10-19 18:00:05',
  },
];

function stubApi() {
  mockedGet.mockImplementation((path: string) => {
    if (path.endsWith('/integrity')) return Promise.resolve(INTEGRITY);
    if (path.includes('/evidence')) return Promise.resolve({ evidence: EVIDENCE });
    if (path === '/global/games/gg-mb/tables') return Promise.resolve(TABLES);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  mockedPatch.mockImplementation((_path: string, body: unknown) => {
    const b = body as Record<string, string | null>;
    return Promise.resolve({
      success: true,
      game: {
        ...INTEGRITY.games[0],
        requiredVpsTableId: 'required_vps_table_id' in b ? b.required_vps_table_id : null,
        requiredRom: 'required_rom' in b ? b.required_rom : null,
      },
    });
  });
}

describe('IntegrityPanel', () => {
  const toast = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    stubApi();
  });

  it('shows the mode, one row per game with the catalogue tables, and the evidence', async () => {
    render(<IntegrityPanel roomId={ROOM} tournament={TOURNAMENT} onClose={() => {}} toast={toast} />);

    expect(await screen.findByTestId('integrity-mode')).toHaveTextContent('Sanctioned play');
    expect(mockedGet).toHaveBeenCalledWith(`/rooms/${ROOM}/tournaments/t-1/integrity`);
    expect(mockedGet).toHaveBeenCalledWith(`/rooms/${ROOM}/tournaments/t-1/evidence?limit=50`);

    const select = await screen.findByLabelText('Required table for Monster Bash') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual([
      'Any table of this game',
      'Sixtoe, Flupper vVR 1.0 VR edition',
      'JPSalas v2.1 desktop',
    ]);

    // A game with no catalogue link cannot name a table.
    const unlinked = screen.getByLabelText('Required table for Mystery Table') as HTMLSelectElement;
    expect(unlinked.disabled).toBe(true);
    expect(within(unlinked).getAllByRole('option').map(o => o.textContent)).toEqual(['Not linked to the catalogue']);

    // Evidence rows: newest first, verdict chips, reasons, outcome.
    const flagged = screen.getByTestId('evidence-row-7');
    expect(within(flagged).getByTestId('evidence-verdict-flagged')).toBeInTheDocument();
    expect(within(flagged).getByText('tilt sensitivity 200 is below the minimum 300')).toBeInTheDocument();
    expect(within(flagged).getByText('held out (Sanctioned)')).toBeInTheDocument();
    expect(within(flagged).getByText('123,456,780')).toBeInTheDocument();
    const passed = screen.getByTestId('evidence-row-6');
    expect(within(passed).getByTestId('evidence-verdict-pass')).toBeInTheDocument();
    expect(within(passed).getByText('on the board')).toBeInTheDocument();
  });

  it('choosing a table PATCHes the game requirements and toasts', async () => {
    render(<IntegrityPanel roomId={ROOM} tournament={TOURNAMENT} onClose={() => {}} toast={toast} />);
    const select = await screen.findByLabelText('Required table for Monster Bash') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));

    fireEvent.change(select, { target: { value: 'tbl-vr' } });

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith(
      `/rooms/${ROOM}/tournaments/t-1/games/g-mb/requirements`,
      { required_vps_table_id: 'tbl-vr' },
    ));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Required table saved', 'success'));
    expect(select.value).toBe('tbl-vr');

    // Back to "any table" clears it with null, never an empty string.
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(mockedPatch).toHaveBeenLastCalledWith(
      `/rooms/${ROOM}/tournaments/t-1/games/g-mb/requirements`,
      { required_vps_table_id: null },
    ));
  });

  it('the ROM field PATCHes on blur, empty clearing to null, unchanged not at all', async () => {
    render(<IntegrityPanel roomId={ROOM} tournament={TOURNAMENT} onClose={() => {}} toast={toast} />);
    const rom = await screen.findByLabelText('Required ROM for Monster Bash') as HTMLInputElement;

    fireEvent.blur(rom);
    expect(mockedPatch).not.toHaveBeenCalled();

    fireEvent.change(rom, { target: { value: ' mb_10 ' } });
    fireEvent.blur(rom);
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith(
      `/rooms/${ROOM}/tournaments/t-1/games/g-mb/requirements`,
      { required_rom: 'mb_10' },
    ));
    await waitFor(() => expect(rom.value).toBe('mb_10'));

    fireEvent.change(rom, { target: { value: '' } });
    fireEvent.blur(rom);
    await waitFor(() => expect(mockedPatch).toHaveBeenLastCalledWith(
      `/rooms/${ROOM}/tournaments/t-1/games/g-mb/requirements`,
      { required_rom: null },
    ));
  });

  it('expanding an evidence row shows the rule checks and the measurements', async () => {
    render(<IntegrityPanel roomId={ROOM} tournament={TOURNAMENT} onClose={() => {}} toast={toast} />);
    const flagged = await screen.findByTestId('evidence-row-7');
    fireEvent.click(within(flagged).getByLabelText('Show details'));

    // Once as the rule check's name, once as the measurement's label.
    expect(screen.getAllByText('Tilt sensitivity')).toHaveLength(2);
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('150 / 150%')).toBeInTheDocument();
    expect(screen.getByText('10.8.0 (official)')).toBeInTheDocument();
    expect(screen.getByText('3.6.0 (nightly)')).toBeInTheDocument();
    expect(screen.getByText('tbl-vr')).toBeInTheDocument();
    expect(screen.getByText('Named table')).toBeInTheDocument();
    expect(screen.getByText(/no required table set for this game/)).toBeInTheDocument();

    fireEvent.click(within(flagged).getByLabelText('Hide details'));
    expect(screen.queryByText('10.8.0 (official)')).toBeNull();
  });

  it('a failed evidence read still shows the required tables', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path.endsWith('/integrity')) return Promise.resolve(INTEGRITY);
      if (path.includes('/evidence')) return Promise.reject(new Error('Forbidden'));
      if (path === '/global/games/gg-mb/tables') return Promise.resolve(TABLES);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    render(<IntegrityPanel roomId={ROOM} tournament={TOURNAMENT} onClose={() => {}} toast={toast} />);
    expect(await screen.findByLabelText('Required table for Monster Bash')).toBeInTheDocument();
    expect(screen.getByText('No witness scores with evidence yet.')).toBeInTheDocument();
  });
});
