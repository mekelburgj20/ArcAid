import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { playerApi } from '../playerApi';
import { ApiError } from '../api';

/**
 * The player HTTP client, and the guard that keeps player surfaces off the
 * admin one (v2.137.1).
 *
 * ## The incident this exists to prevent
 *
 * `lib/api.ts` is the ADMIN client: it sends `arcaid_token` and, on a 401 it
 * cannot refresh, it NAVIGATES — to `/:slug/login` inside an admin route, and
 * otherwise to `/superadmin`.
 *
 * A signed-in player holds `arcaid_player_token`, which that client knows
 * nothing about. So a player-facing call routed through `api.*` went out with
 * no `Authorization` header at all, 401'd, matched no admin slug, and dumped
 * the player on the **super-admin login page**. To the player it looked like an
 * endless loop: sign in with Discord, land back on the scoreboard, press the
 * "+" on a game card, get bounced to an operator login screen.
 *
 * A live user hit exactly that (2026-08-25) after three player surfaces —
 * the submission sheet and two Account Settings sections — were wired to
 * `api.*` by mistake. Nothing in the codebase prevented it; the convention
 * lived only in the existing code's habits.
 */

const originalFetch = global.fetch;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { global.fetch = originalFetch; });

function mockFetch(status: number, body: unknown) {
    const spy = vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    });
    global.fetch = spy as unknown as typeof fetch;
    return spy;
}

describe('playerApi', () => {
    it('sends the PLAYER token, which is the entire point', async () => {
        const spy = mockFetch(200, { ok: true });
        await playerApi.get('/me/preferences', { token: 'player.jwt.here' });

        const [, init] = spy.mock.calls[0]!;
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer player.jwt.here');
    });

    it('omits the header when there is no token rather than inventing one', async () => {
        const spy = mockFetch(200, {});
        await playerApi.get('/throwdowns/ABC', { token: null });

        const [, init] = spy.mock.calls[0]!;
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it('NEVER navigates on a 401 — the whole reason this client exists', async () => {
        mockFetch(401, { error: 'Authentication required' });
        const before = window.location.href;

        await expect(playerApi.get('/me/preferences', { token: null })).rejects.toThrow(ApiError);

        // A player-facing 401 means "sign in for this action", and the surface
        // shows a login affordance in place. Redirecting a player to an
        // operator login is never the answer.
        expect(window.location.href).toBe(before);
    });

    it('keeps the server body on a failure so callers can read structured fields', async () => {
        mockFetch(409, { error: 'Already started', code: 'REMATCH_EXISTS', existingCode: 'K7QMX3PD' });

        try {
            await playerApi.post('/throwdowns', {}, { token: 't' });
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ApiError);
            expect((err as ApiError).status).toBe(409);
            expect((err as ApiError).body.existingCode).toBe('K7QMX3PD');
        }
    });

    it('survives an empty success body', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true, status: 204, text: async () => '', json: async () => undefined,
        }) as unknown as typeof fetch;
        await expect(playerApi.delete('/x', { token: 't' })).resolves.toBeUndefined();
    });
});

/**
 * Structural guard. The convention "player surfaces use playerApi" is only
 * worth anything if something enforces it — the incident happened precisely
 * because it was folklore. Source-scanning tests are an established pattern
 * here (see `scoreProvenance-parity.test.ts`).
 */
describe('player surfaces must not use the admin API client', () => {
    const SRC = path.resolve(__dirname, '../..');

    /**
     * Components reachable by a signed-in PLAYER. Admin-only surfaces
     * (`pages/Tournaments`, `EventRoundsPanel`, …) legitimately use `api.*`,
     * where the admin token is the right credential and its login redirect is
     * the right behaviour.
     */
    const PLAYER_SURFACES = [
        'components/SubmissionSheet.tsx',
        'components/GlobalSharingSection.tsx',
        'components/ThrowdownsSection.tsx',
        'pages/EventDetail.tsx',
        'pages/ThrowdownDetail.tsx',
    ];

    it.each(PLAYER_SURFACES)('%s calls no api.get/post/put/delete', (rel) => {
        const file = path.join(SRC, rel);
        const source = fs.readFileSync(file, 'utf8');
        // Strip comments so the explanatory notes about `api.*` do not trip this.
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        const offenders = [...code.matchAll(/\bapi\.(get|post|put|delete)\b/g)].map(m => m[0]);
        expect(offenders, `${rel} must use playerApi — see lib/playerApi.ts`).toEqual([]);
    });
});
