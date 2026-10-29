import { useEffect, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CardRouter from '../CardRouter';
import { CardAttemptStartContext } from '../cardAttemptStartContext';
import { useRoomAttemptStarts } from '../../../hooks/useRoomAttemptStarts';
import { ATTEMPT_STARTS_CHANGED_EVENT, type RoomAttemptStart } from '../../../lib/attemptStarts';
import type { ScoreboardStyle } from '../../../lib/scoreboardThemes';
import type { GameLeaderboard } from '../../ScoreboardComponents';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * W56 (ADR 0033 §4) — "Start attempts" on the room scoreboard card. Pins:
 *   - every card style carries the control, and only for a game in the
 *     viewer's room list (one room-level read, `useRoomAttemptStarts`);
 *   - no provider (admin preview, kiosk) or no token (guest) = no control;
 *   - a press POSTs the existing per-game route, re-reads the list, flips the
 *     card to "Attempts started" and tells the strip.
 * Queries are scoped to each card (`within`) — several cards render at once.
 */

const ROOM = 'room-1';

function makeLb(over: Partial<GameLeaderboard> = {}): GameLeaderboard {
  return {
    gameId: 'g-congo', gameName: 'Congo', displayName: null,
    tournamentName: 'Five Shots', tournamentType: 'WG',
    imageUrl: null, gameStatus: 'ACTIVE',
    catalogueStyleId: null, logoStyleId: null, bgStyleId: null, styleHeaderDisabled: false,
    notes: null, rankings: [],
    ...over,
  };
}

const item = (over: Partial<RoomAttemptStart> = {}): RoomAttemptStart => ({
  gameId: 'g-congo', gameName: 'Congo', tournamentId: 't-1', tournamentName: 'Five Shots',
  roundNo: null, started: false, startedTs: null, ...over,
});

function Harness({ token, children }: { token: string | null; children: ReactNode }) {
  const { value, reload } = useRoomAttemptStarts(ROOM, token);
  useEffect(() => { void reload(); }, [reload]);
  return <CardAttemptStartContext.Provider value={value}>{children}</CardAttemptStartContext.Provider>;
}

function cards(style: ScoreboardStyle) {
  return (
    <>
      <div data-testid="card-congo">
        <CardRouter lb={makeLb()} slug="wizard" roomId={ROOM} style={style} maxScores={5} />
      </div>
      <div data-testid="card-other">
        <CardRouter lb={makeLb({ gameId: 'g-other', gameName: 'Other Table' })} slug="wizard" roomId={ROOM} style={style} maxScores={5} />
      </div>
    </>
  );
}

/** GET → the list (first `before`, then `after` once a POST happened); POST → startedTs. */
function stubApi(before: RoomAttemptStart[], after: RoomAttemptStart[] = before) {
  let pressed = false;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      pressed = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ startedTs: 1_800_000_000 }) });
    }
    if (url === `/api/rooms/${ROOM}/attempt-starts/me`) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ games: pressed ? after : before }) });
    }
    // Card-internal reads (score counts etc.) — empty.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CardAttemptStart on every card style', () => {
  for (const style of ['banner', 'showcase', 'minimal', 'arcade'] as ScoreboardStyle[]) {
    it(`${style}: renders only on the listed game`, async () => {
      stubApi([item()]);
      render(<MemoryRouter><Harness token="tok">{cards(style)}</Harness></MemoryRouter>);
      const congo = screen.getByTestId('card-congo');
      expect(await within(congo).findByRole('button', { name: 'Start attempts on Congo' })).toBeInTheDocument();
      expect(within(screen.getByTestId('card-other')).queryByTestId('card-attempt-start')).toBeNull();
    });
  }

  it('draws nothing without a provider (admin preview / kiosk)', () => {
    render(<MemoryRouter>{cards('banner')}</MemoryRouter>);
    expect(screen.queryByTestId('card-attempt-start')).toBeNull();
  });

  it('draws nothing for a guest, and never reads the list', async () => {
    const fetchMock = stubApi([item()]);
    render(<MemoryRouter><Harness token={null}>{cards('banner')}</Harness></MemoryRouter>);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByTestId('card-attempt-start')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('attempt-starts'))).toBe(false);
  });

  it('does not draw on a card that is no longer ACTIVE', async () => {
    stubApi([item()]);
    render(
      <MemoryRouter>
        <Harness token="tok">
          <div data-testid="card-locked">
            <CardRouter lb={makeLb({ gameStatus: 'COMPLETED' })} slug="wizard" roomId={ROOM} style="banner" maxScores={5} />
          </div>
        </Harness>
      </MemoryRouter>,
    );
    await new Promise(r => setTimeout(r, 0));
    expect(within(screen.getByTestId('card-locked')).queryByTestId('card-attempt-start')).toBeNull();
  });

  it('a press POSTs the existing route, re-reads the list and flips to "Attempts started"', async () => {
    const fetchMock = stubApi([item()], [item({ started: true, startedTs: 1_800_000_000 })]);
    const changed = vi.fn();
    window.addEventListener(ATTEMPT_STARTS_CHANGED_EVENT, changed);
    render(<MemoryRouter><Harness token="tok">{cards('minimal')}</Harness></MemoryRouter>);
    const congo = screen.getByTestId('card-congo');
    fireEvent.click(await within(congo).findByRole('button', { name: 'Start attempts on Congo' }));

    expect(await within(congo).findByTestId('card-attempts-started')).toHaveTextContent('Attempts started');
    expect(within(congo).queryByRole('button', { name: 'Start attempts on Congo' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM}/tournaments/t-1/games/g-congo/attempt-start`,
      { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    );
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    window.removeEventListener(ATTEMPT_STARTS_CHANGED_EVENT, changed);
  });

  it('a game already started shows the muted state, no button', async () => {
    stubApi([item({ started: true, startedTs: 1_700_000_000 })]);
    render(<MemoryRouter><Harness token="tok">{cards('showcase')}</Harness></MemoryRouter>);
    const congo = screen.getByTestId('card-congo');
    expect(await within(congo).findByTestId('card-attempts-started')).toBeInTheDocument();
    expect(within(congo).queryByRole('button', { name: /Start attempts/ })).toBeNull();
  });
});
