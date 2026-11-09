import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * A35 (v2.235.0) — the super-admin Game Names page: an unmatched name shows its
 * usage and catalogue suggestions; Merge is reachable only after a Preview with
 * no blockers; a past merge can be undone.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../lib/api', () => ({ api: apiMock }));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { default: GameNameReconcile } = await import('../GameNameReconcile');

const ORPHAN = {
  roomId: 'r1', roomName: 'Alpha Room', roomSlug: 'alpha', name: 'Arkanoid', spellings: ['Arkanoid'],
  counts: { games: 1, activeGames: 0, scores: 4, communityScores: 0, comments: 0 }, lastScoreAt: null,
  suggestions: [{ id: 'gg-ark', name: 'Arkanoid (Pinball)', manufacturer: null, year: null, platforms: ['atgames_native'], atgames: true }],
};
const PREVIEW = {
  roomId: 'r1', fromName: 'Arkanoid', spellings: ['Arkanoid'], to: { id: 'gg-ark', name: 'Arkanoid (Pinball)' },
  counts: { games: 1, activeGames: 0, scores: 4, communityScores: 0, comments: 0, library: 'none', suppressions: 0 },
  blockers: [], warnings: [],
};

beforeEach(() => {
  apiMock.get.mockReset().mockImplementation((path: string) => {
    if (path === '/admin/game-names/orphans') return Promise.resolve({ orphans: [ORPHAN] });
    if (path === '/admin/game-names/reconciles') {
      return Promise.resolve({ reconciles: [{ id: 'rec-1', roomId: 'r1', roomName: 'Alpha Room', fromName: 'Space Invaders', toName: 'Space Invaders (Pinball)', counts: {}, createdAt: '2026-11-08 10:00:00', undoneAt: null }] });
    }
    return Promise.resolve({ games: [] });
  });
  apiMock.post.mockReset().mockImplementation((path: string) => {
    if (path === '/admin/game-names/preview') return Promise.resolve(PREVIEW);
    return Promise.resolve({ success: true });
  });
});

describe('Game Names page', () => {
  it('previews, then merges the chosen catalogue game', async () => {
    render(<GameNameReconcile />);
    const row = await screen.findByTestId('orphan-row');
    expect(within(row).getByText('4 scores · 1 game')).toBeTruthy();
    expect(within(row).getByText('AtGames')).toBeTruthy();

    const merge = within(row).getByRole('button', { name: 'Merge' }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);

    fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
    await screen.findByTestId('reconcile-preview');
    expect(apiMock.post).toHaveBeenCalledWith('/admin/game-names/preview', { roomId: 'r1', fromName: 'Arkanoid', toGlobalGameId: 'gg-ark' });

    await waitFor(() => expect(merge.disabled).toBe(false));
    fireEvent.click(merge);
    // The confirm dialog adds a second Merge button; it is the last one.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Merge' }).length).toBe(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Merge' }).at(-1)!);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/admin/game-names/reconcile', { roomId: 'r1', fromName: 'Arkanoid', toGlobalGameId: 'gg-ark' }));
  });

  it('keeps Merge off while the preview has a blocker', async () => {
    apiMock.post.mockImplementation(() => Promise.resolve({ ...PREVIEW, blockers: ['1 game is linked to an iScored board, which matches by name.'] }));
    render(<GameNameReconcile />);
    const row = await screen.findByTestId('orphan-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
    expect(await within(row).findByText(/Can't merge: 1 game is linked to an iScored board/)).toBeTruthy();
    expect((within(row).getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('undoes a past merge after confirming', async () => {
    render(<GameNameReconcile />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    const buttons = await screen.findAllByRole('button', { name: 'Undo' });
    fireEvent.click(buttons.at(-1)!);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/admin/game-names/reconciles/rec-1/undo', {}));
  });
});
