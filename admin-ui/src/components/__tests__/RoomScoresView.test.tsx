import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RoomScoresView from '../RoomScoresView';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import type { GameLeaderboard } from '../ScoreboardComponents';

/**
 * Owner field report (2026-08-11): submitting from Room Scores showed "This
 * score won't count toward the active tournament (cooldown)…" for games that
 * had rotated out of past tournaments (COMPLETED status). The caption is
 * correct on the Tournaments tab/GameDetail — every submission there really
 * is against a specific tournament window — but on Room Scores every
 * submission is a room-leaderboard post by definition, so the caption was
 * pure noise. Fix: RoomScoresView stops threading `gameStatus` into the
 * SubmissionSheet target (SubmissionSheet's ONLY consumer of that field is
 * the cooldown caption). This guards the regression.
 */

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signIn(discordId = '111111111111111111', username = 'Tester') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

/** A room-scores row for a game whose tournament has rotated to COMPLETED. */
const COMPLETED_ROW: GameLeaderboard & {
    globalGameId: string | null;
    lastPlayed: string;
    playerCount: number;
    totalScores: number;
} = {
    gameId: 'game-1',
    gameName: 'WHO Dunnit',
    tournamentName: 'Legacy Weekly',
    tournamentType: 'WG',
    imageUrl: null,
    gameStatus: 'COMPLETED',
    catalogueStyleId: null,
    logoStyleId: null,
    bgStyleId: null,
    styleHeaderDisabled: false,
    rankings: [],
    globalGameId: null,
    lastPlayed: '2026-01-01T00:00:00Z',
    playerCount: 1,
    totalScores: 1,
};

function stubFetch() {
    return vi.fn((url: string) => {
        if (url.includes('/room-scores')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ data: [COMPLETED_ROW], total: 1, hasMore: false }),
            });
        }
        if (url.includes('/api/submit/platforms')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    platforms: ['real'],
                    submittable: ['real'],
                    features: [],
                    tournamentRules: { engines: { required: [], excluded: [] }, devices: { required: [], excluded: [] } },
                }),
            });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
}

describe('RoomScoresView — cooldown caption suppression', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('opens the submission sheet for a COMPLETED-status row without the tournament-cooldown caption', async () => {
        signIn();
        vi.stubGlobal('fetch', stubFetch() as unknown as typeof fetch);

        render(
            <MemoryRouter>
                <ViewerAuthProvider>
                    <RoomScoresView roomId="room-1" slug="test-room" config={{}} roomName="Test Room" />
                </ViewerAuthProvider>
            </MemoryRouter>,
        );

        const submitBtn = await screen.findByRole('button', { name: /submit score for who dunnit/i });
        fireEvent.click(submitBtn);

        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(screen.queryByText(/won't count toward the active tournament/i)).not.toBeInTheDocument();
    });
});
