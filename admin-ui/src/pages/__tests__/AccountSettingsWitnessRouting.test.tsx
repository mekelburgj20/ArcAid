import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AccountSettings from '../AccountSettings';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

/**
 * v2.153.1 — the "Send scores to" picker on a paired Witness cabinet.
 *
 * This file exists because of a live bug: the picker read `id` off
 * `/api/me/rooms`, which returns **`roomId`** (`RoomForUser`). Every option was
 * therefore rendered with `value={undefined}`, and a valueless `<option>` falls
 * back to its own TEXT — so choosing "RTX_Pinball" submitted the room's NAME as
 * the room id, and the server correctly answered *"You are not a member of that
 * room"*. The failure looked like a permissions problem and was a field name.
 *
 * What this pins is the CONTRACT BETWEEN TWO ENDPOINTS: whatever the rooms list
 * calls its identifier, the PATCH must carry that exact value.
 */

const ROOM_ID = '3f2b1c88-0000-4a11-9e77-aaaabbbbcccc';

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signIn(discordId = '123456789012345678') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username: 'Tester', avatar: null, exp }));
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

type FetchArgs = [url: string, init?: RequestInit];

function stubFetch() {
    const patches: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn((...args: FetchArgs) => {
        const [url, init] = args;
        const method = (init?.method || 'GET').toUpperCase();
        const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

        if (url.includes('/me/witness/devices')) {
            if (method === 'PATCH') {
                patches.push({ url, body: JSON.parse(String(init!.body)) });
                return j({ success: true, device: {} });
            }
            return j([{
                atgamesUniqueId: '8819D107B10040F0',
                atgamesUsername: 'CabinetOwner',
                lastSeenAt: '2026-09-01T12:00:00.000Z',
                targetRoomId: null, targetRoomName: null,
                targetTournamentId: null, targetTournamentName: null,
                globalFallback: true,
            }]);
        }
        // The REAL shape of /api/me/rooms — `roomId`, not `id`. That is the
        // whole point of this fixture; do not "tidy" it to `id`.
        if (url.includes('/me/rooms')) {
            return j([{
                roomId: ROOM_ID, name: 'RTX_Pinball', slug: 'rtx_pinball',
                logoUrl: null, joinedAt: '2026-01-01T00:00:00.000Z',
                source: 'submission', lastActivityAt: null,
            }]);
        }
        if (url.includes('/tournaments')) return j([]);
        if (url.includes('/identity/claims')) return j({ aliases: [], pending: [] });
        if (url.includes('/me/profile')) {
            return j({ discordUserId: '123456789012345678', displayName: 'Tester', avatarHash: null, identities: [] });
        }
        if (url.includes('/me/notification-settings')) {
            return j({
                prefs: {},
                types: ['tournamentWin'],
                webPushTypes: [],
                discord: { available: false, reachable: false, via: null, viaRoomName: null, gatewayReady: false, connectAvailable: false, inviteUrl: null },
            });
        }
        return j({});
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    return { fetchMock, patches };
}

function renderPage() {
    return render(
        <MemoryRouter initialEntries={['/account/settings']}>
            <ThemeProvider>
                <ViewerAuthProvider>
                    <AccountSettings />
                </ViewerAuthProvider>
            </ThemeProvider>
        </MemoryRouter>,
    );
}

describe('AccountSettings — Witness cabinet score routing', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        signIn();
    });

    it('sends the room ID the rooms list gave it, not the room name', async () => {
        const { patches } = stubFetch();
        renderPage();

        const picker = await screen.findByDisplayValue('Global Scoreboard only');
        await waitFor(() => expect(screen.getByRole('option', { name: 'RTX_Pinball' })).toBeInTheDocument());

        fireEvent.change(picker, { target: { value: ROOM_ID } });

        await waitFor(() => expect(patches).toHaveLength(1));
        expect(patches[0]!.body).toEqual({ roomId: ROOM_ID, tournamentId: null });
        // The name must never travel as an id — that is the exact bug.
        expect(JSON.stringify(patches[0]!.body)).not.toContain('RTX_Pinball');
    });

    it('offers the undesignated default as a real choice', async () => {
        stubFetch();
        renderPage();

        // "Global Scoreboard only" is the DEFAULT, not an empty state: an
        // undesignated cabinet still publishes to the player's global record.
        const option = await screen.findByRole('option', { name: 'Global Scoreboard only' });
        expect(option).toHaveValue('');
    });
});
