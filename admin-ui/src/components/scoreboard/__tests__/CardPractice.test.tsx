import { useEffect, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CardRouter from '../CardRouter';
import { CardAttemptStartContext } from '../cardAttemptStartContext';
import { useRoomAttemptStarts } from '../../../hooks/useRoomAttemptStarts';
import {
  ATTEMPT_STARTS_CHANGED_EVENT, NO_PRACTICE, PRACTICE_ON_TEXT, canPausePractice, isPracticing, practiceLeftText,
  practicingTables, type PracticeState, type RoomAttemptStart,
} from '../../../lib/attemptStarts';
import { practiceNoticeKey } from '../../../lib/roomNotices';
import type { ScoreboardStyle } from '../../../lib/scoreboardThemes';
import type { GameLeaderboard } from '../../ScoreboardComponents';
import { ToastProvider } from '../../Toast';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * W126 (ADR 0043) — Practice mode on the room scoreboard card. Pins:
 *   - "Pause to practice" shows only where the press would be accepted
 *     (practice offered, a practice game and an attempt left, Start pressed);
 *   - while paused, every card style says plays do not count, the badge reads
 *     "Practice mode", and "Resume attempts" is beside it;
 *   - each press POSTs its route, re-reads the list and tells the strip.
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

const practice = (over: Partial<PracticeState> = {}): PracticeState => ({
  offered: true, limit: 3, used: 0, left: 3, paused: false, pausedTs: null, ...over,
});

const item = (over: Partial<RoomAttemptStart> = {}): RoomAttemptStart => ({
  gameId: 'g-congo', gameName: 'Congo', tournamentId: 't-1', tournamentName: 'Five Shots',
  roundNo: null, started: false, startedTs: null,
  limit: 3, used: 0, left: 3, requireStart: false, practice: practice(), ...over,
});

function Harness({ children }: { children: ReactNode }) {
  const { value, reload } = useRoomAttemptStarts(ROOM, 'tok');
  useEffect(() => { void reload(); }, [reload]);
  return <CardAttemptStartContext.Provider value={value}>{children}</CardAttemptStartContext.Provider>;
}

const card = (style: ScoreboardStyle) => (
  <MemoryRouter>
    <ToastProvider>
      <Harness>
        <div data-testid="card-congo">
          <CardRouter lb={makeLb()} slug="wizard" roomId={ROOM} style={style} maxScores={5} />
        </div>
      </Harness>
    </ToastProvider>
  </MemoryRouter>
);

/** GET → the list (`before`, then `after` once a POST happened); POST → the new practice state. */
function stubApi(before: RoomAttemptStart[], after: RoomAttemptStart[] = before, post: { ok: boolean; body: unknown } = { ok: true, body: { practice: practice({ paused: true, pausedTs: 1_800_000_000 }) } }) {
  let pressed = false;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      pressed = post.ok;
      return Promise.resolve({ ok: post.ok, json: () => Promise.resolve(post.body) });
    }
    if (url === `/api/rooms/${ROOM}/attempt-starts/me`) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ games: pressed ? after : before }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('practice mode rules (lib/attemptStarts)', () => {
  it('canPausePractice mirrors the server: offered, not already on, a practice game and an attempt left, Start pressed', () => {
    expect(canPausePractice(item())).toBe(true);
    expect(canPausePractice(item({ practice: practice({ limit: 0, left: null }) }))).toBe(true); // unlimited
    expect(canPausePractice(item({ practice: undefined }))).toBe(false);                 // an older server
    expect(canPausePractice(item({ practice: NO_PRACTICE }))).toBe(false);               // not offered
    expect(canPausePractice(item({ practice: practice({ paused: true }) }))).toBe(false); // already on
    expect(canPausePractice(item({ practice: practice({ used: 3, left: 0 }) }))).toBe(false);
    expect(canPausePractice(item({ used: 3, left: 0 }))).toBe(false);                    // no attempts left
    expect(canPausePractice(item({ requireStart: true, started: false }))).toBe(false);
    expect(canPausePractice(item({ requireStart: true, started: true }))).toBe(true);
  });

  it('practiceLeftText', () => {
    expect(practiceLeftText(practice({ left: 2 }))).toBe('2 practice games left');
    expect(practiceLeftText(practice({ left: 1 }))).toBe('1 practice game left');
    expect(practiceLeftText(practice({ left: 0 }))).toBe('No practice games left');
    expect(practiceLeftText(practice({ limit: 0, left: null }))).toBe('Unlimited practice games');
  });

  it('practicingTables names each paused table once, or null', () => {
    const on = item({ practice: practice({ paused: true, pausedTs: 100 }) });
    expect(isPracticing(on)).toBe(true);
    expect(isPracticing(item())).toBe(false);
    expect(practicingTables([item(), item({ gameId: 'g-2', gameName: 'Taxi' })])).toBeNull();
    expect(practicingTables([on, on, item({ gameId: 'g-2', gameName: 'Taxi' })])!.map(g => g.gameName)).toEqual(['Congo']);
  });

  it('the room notice key changes with every new pause, so a dismissed line returns', () => {
    const a = practiceNoticeKey([{ gameId: 'g-congo', pausedTs: 100 }]);
    expect(practiceNoticeKey([{ gameId: 'g-congo', pausedTs: 100 }])).toBe(a);
    expect(practiceNoticeKey([{ gameId: 'g-congo', pausedTs: 200 }])).not.toBe(a);
    expect(practiceNoticeKey([{ gameId: 'g-2', pausedTs: 5 }, { gameId: 'g-congo', pausedTs: 100 }]))
      .toBe(practiceNoticeKey([{ gameId: 'g-congo', pausedTs: 100 }, { gameId: 'g-2', pausedTs: 5 }]));
  });
});

describe('practice mode on the scoreboard card', () => {
  for (const style of ['banner', 'showcase', 'minimal', 'arcade'] as ScoreboardStyle[]) {
    it(`${style}: offers "Pause to practice" with what is left`, async () => {
      stubApi([item()]);
      render(card(style));
      const congo = screen.getByTestId('card-congo');
      expect(await within(congo).findByRole('button', { name: 'Pause attempts on Congo to practice' })).toBeInTheDocument();
      expect(within(congo).getByTestId('card-practice-left')).toHaveTextContent('3 practice games left');
      expect(within(congo).getByTestId('card-attempts-left')).toHaveTextContent('3 attempts left');
    });

    it(`${style}: while paused, says plays do not count, the badge reads Practice mode, and Resume is offered`, async () => {
      stubApi([item({ practice: practice({ used: 1, left: 2, paused: true, pausedTs: 1_800_000_000 }) })]);
      render(card(style));
      const congo = screen.getByTestId('card-congo');
      const on = await within(congo).findByTestId('card-practice-on');
      expect(on).toHaveTextContent(PRACTICE_ON_TEXT);
      expect(on).toHaveTextContent('2 practice games left');
      expect(within(congo).getByRole('button', { name: 'Resume attempts on Congo' })).toBeInTheDocument();
      expect(within(congo).queryByRole('button', { name: /Pause attempts/ })).toBeNull();
      const badge = within(congo).getByTestId('card-attempts-left');
      expect(badge).toHaveTextContent(/^Practice mode$/);
      expect(badge.className).toContain('text-neon-amber');
    });
  }

  it('no practice control where practice is not offered, used up, or there is no attempt left', async () => {
    stubApi([item({ practice: NO_PRACTICE })]);
    const { unmount } = render(card('banner'));
    expect(await within(screen.getByTestId('card-congo')).findByTestId('card-attempts-left')).toBeInTheDocument();
    expect(screen.queryByTestId('card-attempt-start')).toBeNull();
    unmount();

    stubApi([item({ practice: practice({ used: 3, left: 0 }) })]);
    const second = render(card('banner'));
    expect(await within(screen.getByTestId('card-congo')).findByTestId('card-attempts-left')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pause attempts/ })).toBeNull();
    second.unmount();

    stubApi([item({ used: 3, left: 0 })]);
    render(card('banner'));
    expect(await within(screen.getByTestId('card-congo')).findByTestId('card-attempts-left')).toHaveTextContent('No attempts left');
    expect(screen.queryByRole('button', { name: /Pause attempts/ })).toBeNull();
  });

  it('a table that needs Start attempts offers the pause only after the press', async () => {
    stubApi([item({ requireStart: true, started: false })]);
    const { unmount } = render(card('minimal'));
    const congo = screen.getByTestId('card-congo');
    expect(await within(congo).findByRole('button', { name: 'Start attempts on Congo' })).toBeInTheDocument();
    expect(within(congo).queryByRole('button', { name: /Pause attempts/ })).toBeNull();
    unmount();

    stubApi([item({ requireStart: true, started: true, startedTs: 1 })]);
    render(card('minimal'));
    const after = screen.getByTestId('card-congo');
    expect(await within(after).findByTestId('card-attempts-started')).toBeInTheDocument();
    expect(within(after).getByRole('button', { name: 'Pause attempts on Congo to practice' })).toBeInTheDocument();
  });

  it('Pause POSTs attempt-pause, re-reads the list, flips the card and tells the strip', async () => {
    const paused = item({ practice: practice({ paused: true, pausedTs: 1_800_000_000 }) });
    const fetchMock = stubApi([item()], [paused]);
    const changed = vi.fn();
    window.addEventListener(ATTEMPT_STARTS_CHANGED_EVENT, changed);
    render(card('showcase'));
    const congo = screen.getByTestId('card-congo');
    fireEvent.click(await within(congo).findByRole('button', { name: 'Pause attempts on Congo to practice' }));

    expect(await within(congo).findByTestId('card-practice-on')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM}/tournaments/t-1/games/g-congo/attempt-pause`,
      { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    );
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    window.removeEventListener(ATTEMPT_STARTS_CHANGED_EVENT, changed);
  });

  it('Resume POSTs attempt-resume and the card goes back to counting', async () => {
    const paused = item({ practice: practice({ used: 1, left: 2, paused: true, pausedTs: 1_800_000_000 }) });
    const fetchMock = stubApi([paused], [item({ practice: practice({ used: 1, left: 2 }) })], {
      ok: true, body: { resumed: true, practice: practice({ used: 1, left: 2 }) },
    });
    render(card('arcade'));
    const congo = screen.getByTestId('card-congo');
    fireEvent.click(await within(congo).findByRole('button', { name: 'Resume attempts on Congo' }));

    expect(await within(congo).findByRole('button', { name: 'Pause attempts on Congo to practice' })).toBeInTheDocument();
    expect(within(congo).queryByTestId('card-practice-on')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/rooms/${ROOM}/tournaments/t-1/games/g-congo/attempt-resume`,
      { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    );
  });

  it('a refused pause shows the server\'s sentence and leaves the card as it was', async () => {
    stubApi([item()], [item()], { ok: false, body: { error: 'You have used all your practice games on this table', code: 'NO_PRACTICE_LEFT' } });
    render(card('banner'));
    const congo = screen.getByTestId('card-congo');
    fireEvent.click(await within(congo).findByRole('button', { name: 'Pause attempts on Congo to practice' }));
    expect(await screen.findByText('You have used all your practice games on this table')).toBeInTheDocument();
    expect(within(congo).queryByTestId('card-practice-on')).toBeNull();
  });
});
