import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GameQuickView from '../GameQuickView';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import type { RankedEntry } from '../ScoreboardComponents';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/**
 * v2.109.0 (score-gesture-photos) — photo evidence inside the game quick
 * popup. Companion to GameQuickView.delete.test.tsx (same fixtures/helpers
 * shape, extended rather than duplicated): +/- and trash keep their own
 * click targets (delete.test.tsx covers that); this file covers the NEW
 * row-body gesture — clicking a ranked row or an expanded nested history row
 * opens that score's photo when one exists, and does nothing when it
 * doesn't.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signInAs(discordId: string, claims: Record<string, unknown> = {}) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({
    discordId, username: 'Tester', avatar: null, exp, role: 'player', gameRoomIds: [], ...claims,
  }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

const RANKINGS: RankedEntry[] = [
  {
    rank: 1, discord_user_id: 'disc-ada', iscored_username: 'Ada', score: 4200,
    history_id: 11, source: 'tournament', submitted_by_user_id: 'disc-ada',
    photo_url: '/api/score-photos/ada.jpg',
  },
  {
    rank: 2, discord_user_id: 'disc-ben', iscored_username: 'Ben', score: 3100,
    history_id: 12, source: 'tournament', submitted_by_user_id: 'disc-ben',
    photo_url: null,
  },
];

const HISTORY = [
  { id: 11, score: 4200, source: 'tournament', photo_url: '/api/score-photos/ada.jpg', created_at: '2026-08-01T00:00:00Z', submitted_by_user_id: 'disc-ada' },
  { id: 10, score: 900, source: 'tournament', photo_url: null, created_at: '2026-07-01T00:00:00Z', submitted_by_user_id: 'disc-ada' },
];

function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/score-counts')) {
      return Promise.resolve({
        ok: true, json: () => Promise.resolve({ counts: { 'game-1': { ada: 2 } } }),
      });
    }
    if (url.includes('/score-history/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(HISTORY) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/**
 * G23c: the popup is the Arcaid dialog; wait until its real (base-ui) half has
 * replaced the stand-in, or a click found on the stand-in lands on a detached node.
 */
async function renderPopup(props: Partial<React.ComponentProps<typeof GameQuickView>> = {}) {
  const utils = render(
    <MemoryRouter>
      <ViewerAuthProvider>
        <GameQuickView
          lb={{ gameName: 'Whirlwind', gameId: 'game-1', rankings: RANKINGS }}
          slug="rtx_pinball"
          onClose={() => {}}
          {...props}
        />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
  await waitForRealDialog();
  return utils;
}

describe('GameQuickView — photo evidence on main ranked rows', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows the camera glyph only on the row that has a photo', async () => {
    await renderPopup({ roomId: 'room-1' });
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());

    // lucide-react renders an <svg> with no accessible name; assert via the
    // row structure instead — Ada's row is clickable (has the photo), Ben's
    // row is not.
    const adaRow = screen.getByText('Ada').closest('div') as HTMLElement;
    const benRow = screen.getByText('Ben').closest('div') as HTMLElement;
    expect(adaRow.className).toContain('cursor-pointer');
    expect(benRow.className).not.toContain('cursor-pointer');
  });

  it('opens the photo lightbox when a photo-carrying row body is clicked', async () => {
    await renderPopup({ roomId: 'room-1' });
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Ada').closest('div') as HTMLElement);

    expect(await screen.findByAltText('Ada — 4,200 photo evidence')).toBeInTheDocument();
  });

  it('does nothing when a photo-less row body is clicked (no dead click)', async () => {
    await renderPopup({ roomId: 'room-1' });
    await waitFor(() => expect(screen.getByText('Ben')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Ben').closest('div') as HTMLElement);

    expect(screen.queryByAltText(/photo evidence/)).not.toBeInTheDocument();
  });

  it('clicking the expand or delete control does NOT also open the lightbox', async () => {
    signInAs('disc-ada');
    await renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Show score history'));
    expect(screen.queryByAltText(/photo evidence/)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByLabelText('Delete this score (4,200)'));
    // The confirm dialog opened, not the lightbox.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByAltText(/photo evidence/)).not.toBeInTheDocument();
  });

  // G23c: the lightbox is a dialog nested in the quick view's, so Escape and a
  // press outside close the photo only and leave the quick view open. Escape is
  // pressed where focus is (the dialog listens on the document; the old
  // hand-built viewer listened on window).
  it('Esc and clicking the backdrop both close the lightbox, and only the lightbox', async () => {
    await renderPopup({ roomId: 'room-1' });
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Ada').closest('div') as HTMLElement);
    await screen.findByAltText('Ada — 4,200 photo evidence');
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Ada' })).toContainElement(document.activeElement as HTMLElement));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByAltText(/photo evidence/)).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Whirlwind' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Ada').closest('div') as HTMLElement);
    await screen.findByAltText('Ada — 4,200 photo evidence');
    // A press on the lightbox's own backdrop: its viewport, the last one in the document.
    const viewports = document.querySelectorAll<HTMLElement>('.arc-dialog-vp');
    const vp = viewports[viewports.length - 1]!;
    fireEvent.pointerDown(vp);
    fireEvent.mouseDown(vp);
    fireEvent.pointerUp(vp);
    fireEvent.mouseUp(vp);
    fireEvent.click(vp);
    await waitFor(() => expect(screen.queryByAltText(/photo evidence/)).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Whirlwind' })).toBeInTheDocument();
  });
});

describe('GameQuickView — photo evidence on nested per-player history rows', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows the camera glyph and opens the lightbox for a photo-carrying history row', async () => {
    await renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Show score history'));
    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());

    // The h.id=11 (4,200) history row carries a photo; h.id=10 (900) does
    // not. "4,200" also matches the main ranked row above it (same score) —
    // the nested one is the SECOND match in document order.
    const matches = screen.getAllByText('4,200');
    fireEvent.click(matches[matches.length - 1]!);
    expect(await screen.findByAltText('Ada — 4,200 photo evidence')).toBeInTheDocument();
  });

  it('does nothing for a photo-less history row', async () => {
    await renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Show score history'));
    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());

    fireEvent.click(screen.getByText('900'));
    expect(screen.queryByAltText(/photo evidence/)).not.toBeInTheDocument();
  });
});
