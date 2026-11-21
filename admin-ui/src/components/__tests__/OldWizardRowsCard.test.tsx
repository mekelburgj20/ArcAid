import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import OldWizardRowsCard, { type OldWizardRowPlan } from '../OldWizardRowsCard';

/**
 * C14 (v2.257.0) — Global Catalogue -> Old Wizard Rows. The server proposes a
 * survivor per README-era row; only the pre-ticked pairs and the owner's own
 * ticks are sent to the merge.
 */

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const zero = { globalScores: 0, globalPlayers: 0, ratings: 0, comments: 0, myTables: 0, pins: 0, roomGames: 0, activeRoomGames: 0 };

function plan(over: Partial<OldWizardRowPlan> & Pick<OldWizardRowPlan, 'id' | 'name'>): OldWizardRowPlan {
  return {
    manufacturer: null, year: null, status: 'approved', folder: null, counts: zero,
    suggestion: null, alternatives: [], preselect: false, ...over,
  };
}

const ROWS: OldWizardRowPlan[] = [
  plan({
    id: 'old-getaway', name: 'Getaway - High Speed II, The', manufacturer: 'Williams', year: 1992, folder: 'vpx-getaway',
    counts: { ...zero, globalScores: 3, globalPlayers: 2, roomGames: 1, activeRoomGames: 1 },
    suggestion: { target: { id: 'vps-getaway', name: 'The Getaway: High Speed II', manufacturer: 'Williams', year: 1992, vps_id: 'abc' }, tier: 'folder', disagreements: [], conflict: null },
    preselect: true,
  }),
  plan({
    id: 'old-metro', name: 'Metropolis', manufacturer: 'Original', year: 2022,
    suggestion: {
      target: { id: 'vps-metro', name: 'Metropolis', manufacturer: 'Maresa', year: 1982, vps_id: 'm1' }, tier: 'name',
      disagreements: ['maker', 'year'], conflict: 'A fan original (Original) and a real machine (Maresa) are different games (ADR 0014)',
    },
  }),
  plan({
    id: 'old-godzilla', name: 'Godzilla',
    alternatives: [
      { id: 'g1', name: 'Godzilla', manufacturer: 'Sega', year: 1998, vps_id: 'g1' },
      { id: 'g2', name: 'Godzilla', manufacturer: 'Stern', year: 2021, vps_id: 'g2' },
    ],
  }),
  plan({ id: 'old-nothing', name: 'Nothing Like It', manufacturer: 'Nobody', year: 1999 }),
];

function routeGets() {
  mockedGet.mockImplementation((url: string) => {
    if (url === '/admin/catalogue/old-wizard-rows') {
      return Promise.resolve({ rows: ROWS, summary: { total: 4, suggested: 2, preselected: 1, ambiguous: 1, none: 1 } });
    }
    if (url.startsWith('/admin/catalogue/old-wizard-rows/targets')) {
      return Promise.resolve({ games: [{ id: 'vps-nothing', name: 'Nothing Like It Pinball', manufacturer: 'Nobody', year: 1999, vps_id: 'n1' }] });
    }
    return Promise.resolve({});
  });
}

async function loadCard() {
  render(<OldWizardRowsCard />);
  fireEvent.click(screen.getByRole('button', { name: /find old wizard rows/i }));
  await screen.findByText('Getaway - High Speed II, The');
}

describe('OldWizardRowsCard', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedPost.mockReset();
    routeGets();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows each row with what it holds and pre-ticks only the clean pairs', async () => {
    await loadCard();
    expect(screen.getByText('3 Global scores (2 players) · 1 room game (1 live)')).toBeInTheDocument();
    expect(screen.getByText('Same Wizard folder')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Merge Getaway - High Speed II, The' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Merge Metropolis' })).not.toBeChecked();
    expect(screen.getByText(/ADR 0014/)).toBeInTheDocument();
    expect(screen.getByText(/The makers differ; The years differ/)).toBeInTheDocument();
    // No game yet: nothing to tick.
    expect(screen.getByRole('checkbox', { name: 'Merge Godzilla' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Merge Nothing Like It' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /merge 1 ticked/i })).toBeEnabled();
  });

  it('sends only the ticked pairs, the owner\'s picks included', async () => {
    mockedPost.mockResolvedValue({ merged: [], failed: [] });
    await loadCard();

    fireEvent.click(screen.getByRole('button', { name: 'Godzilla (Stern 2021)' }));
    expect(screen.getByRole('checkbox', { name: 'Merge Godzilla' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Merge Metropolis' }));
    fireEvent.click(screen.getByRole('button', { name: /merge 3 ticked/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1));
    expect(mockedPost).toHaveBeenCalledWith('/admin/catalogue/old-wizard-rows/merge', {
      pairs: [
        { sourceId: 'old-getaway', targetId: 'vps-getaway' },
        { sourceId: 'old-metro', targetId: 'vps-metro' },
        { sourceId: 'old-godzilla', targetId: 'g2' },
      ],
    });
  });

  it('lets a row with no match be pointed at a game found by search', async () => {
    await loadCard();
    const row = screen.getByText('Nothing Like It').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /choose another game/i }));
    fireEvent.click(await within(row).findByRole('button', { name: /Nothing Like It Pinball/ }));

    expect(within(row).getByText('Chosen by you')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Merge Nothing Like It' })).toBeChecked();
  });

  it('does nothing when the owner cancels the confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await loadCard();
    fireEvent.click(screen.getByRole('button', { name: /merge 1 ticked/i }));
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('reports what the merge refused', async () => {
    mockedPost.mockResolvedValue({ merged: [{ sourceId: 'old-getaway', targetId: 'vps-getaway', scoresMoved: 3 }], failed: [{ sourceId: 'x', targetId: 'y', error: 'The survivor is not approved' }] });
    await loadCard();
    fireEvent.click(screen.getByRole('button', { name: /merge 1 ticked/i }));
    expect(await screen.findByText('The survivor is not approved')).toBeInTheDocument();
    expect(screen.getByText(/Merged 1 row, 1 refused/)).toBeInTheDocument();
  });
});
