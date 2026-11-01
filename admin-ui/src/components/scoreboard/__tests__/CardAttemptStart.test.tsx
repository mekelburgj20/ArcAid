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
  roundNo: null, started: false, startedTs: null,
  limit: 3, used: 0, left: 3, requireStart: true, ...over,
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

  it('W82: no strip for a limited table that does not require the press', async () => {
    stubApi([item({ requireStart: false })]);
    render(<MemoryRouter><Harness token="tok">{cards('banner')}</Harness></MemoryRouter>);
    const congo = screen.getByTestId('card-congo');
    expect(await within(congo).findByTestId('card-attempts-left')).toBeInTheDocument();
    expect(within(congo).queryByTestId('card-attempt-start')).toBeNull();
    expect(within(congo).queryByRole('button', { name: /Start attempts/ })).toBeNull();
  });
});

/**
 * W82 (owner 2026-10-31) — the viewer's own "N attempts left" badge at the
 * top-left of a Limited-attempts card. Same room-level list and provider as
 * the strip, so the same absences: no provider (admin preview / kiosk), no
 * token (guest), a card not in the list, a card no longer ACTIVE.
 */
describe('CardAttemptsLeft on every card style', () => {
  for (const style of ['banner', 'showcase', 'minimal', 'arcade'] as ScoreboardStyle[]) {
    it(`${style}: "3 attempts left" on the listed game only`, async () => {
      stubApi([item()]);
      render(<MemoryRouter><Harness token="tok">{cards(style)}</Harness></MemoryRouter>);
      const badge = await within(screen.getByTestId('card-congo')).findByTestId('card-attempts-left');
      expect(badge).toHaveTextContent(/^3 attempts left$/);
      expect(badge).toHaveAttribute('aria-label', '3 of 3 attempts left on Congo');
      expect(within(screen.getByTestId('card-other')).queryByTestId('card-attempts-left')).toBeNull();
    });

    it(`${style}: singular at 1, "No attempts left" at 0`, async () => {
      stubApi([item({ used: 2, left: 1 }), item({ gameId: 'g-other', gameName: 'Other Table', used: 3, left: 0 })]);
      render(<MemoryRouter><Harness token="tok">{cards(style)}</Harness></MemoryRouter>);
      expect(await within(screen.getByTestId('card-congo')).findByTestId('card-attempts-left'))
        .toHaveTextContent(/^1 attempt left$/);
      const none = await within(screen.getByTestId('card-other')).findByTestId('card-attempts-left');
      expect(none).toHaveTextContent(/^No attempts left$/);
      expect(none).toHaveAttribute('title', '0 of 3 attempts left on Other Table');
      expect(none.className).toContain('text-neon-amber');
    });

    it(`${style}: the badge shows without the press control when the table needs no Start attempts`, async () => {
      stubApi([item({ requireStart: false, used: 1, left: 2 })]);
      render(<MemoryRouter><Harness token="tok">{cards(style)}</Harness></MemoryRouter>);
      const congo = screen.getByTestId('card-congo');
      expect(await within(congo).findByTestId('card-attempts-left')).toHaveTextContent('2 attempts left');
      expect(within(congo).queryByTestId('card-attempt-start')).toBeNull();
    });
  }

  it('banner with header art: one badge, beside the corner "i" (the title row is hidden)', async () => {
    stubApi([item()]);
    render(
      <MemoryRouter>
        <Harness token="tok">
          <div data-testid="card-congo">
            <CardRouter lb={makeLb({ logoStyleId: 'style-1', notes: 'House rules' })} slug="wizard" roomId={ROOM} style="banner" maxScores={5} />
          </div>
        </Harness>
      </MemoryRouter>,
    );
    const congo = screen.getByTestId('card-congo');
    const badges = await within(congo).findAllByTestId('card-attempts-left');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('3 attempts left');
    expect(badges[0].parentElement?.className).toContain('left-3 top-3');
  });

  it('still shows the count on a table whose Start attempts is not pressed yet', async () => {
    stubApi([item({ started: false, requireStart: true })]);
    render(<MemoryRouter><Harness token="tok">{cards('showcase')}</Harness></MemoryRouter>);
    const congo = screen.getByTestId('card-congo');
    expect(await within(congo).findByTestId('card-attempts-left')).toHaveTextContent('3 attempts left');
    expect(within(congo).getByRole('button', { name: 'Start attempts on Congo' })).toBeInTheDocument();
  });

  it('draws nothing without a provider (admin preview / kiosk)', () => {
    render(<MemoryRouter>{cards('arcade')}</MemoryRouter>);
    expect(screen.queryByTestId('card-attempts-left')).toBeNull();
  });

  it('draws nothing for a guest', async () => {
    stubApi([item()]);
    render(<MemoryRouter><Harness token={null}>{cards('minimal')}</Harness></MemoryRouter>);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByTestId('card-attempts-left')).toBeNull();
  });

  it('does not draw on a card that is no longer ACTIVE', async () => {
    stubApi([item()]);
    render(
      <MemoryRouter>
        <Harness token="tok">
          <div data-testid="card-locked">
            <CardRouter lb={makeLb({ gameStatus: 'COMPLETED' })} slug="wizard" roomId={ROOM} style="showcase" maxScores={5} />
          </div>
        </Harness>
      </MemoryRouter>,
    );
    await new Promise(r => setTimeout(r, 0));
    expect(within(screen.getByTestId('card-locked')).queryByTestId('card-attempts-left')).toBeNull();
  });
});
