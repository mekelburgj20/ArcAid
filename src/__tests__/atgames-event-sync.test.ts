import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import axios from 'axios';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import {
    AtGamesPrivateClient, AtGamesAuthError, clearAtGamesSessions,
} from '../services/AtGamesPrivateClient.js';
import type { AtGamesPrivateTournamentDetail } from '../services/AtGamesPrivateClient.js';
import { resolveAtGamesCredsFromSettings } from '../utils/atgamesCreds.js';
import {
    AtGamesEventSyncService, AtGamesSyncError, parseAtGamesTimestamp,
} from '../services/AtGamesEventSyncService.js';
import { normalizeSubmitterUserId } from '../services/SubmissionContextService.js';
import { ENCRYPTED_SETTING_KEYS } from '../utils/secrets.js';

/**
 * P7 — AtGames private-tournament score sync.
 *
 * What these tests pin, in order of how expensive the bug would be:
 *
 *   1. **A score only counts inside its round's window.** AtGames timestamps
 *      arrive with no timezone marker; read as local time they shift by the
 *      server's offset and silently land in — or fall out of — the wrong round.
 *   2. **Identity is a link, never a name.** An unlinked AtGames account must
 *      never end up owning an Arcaid account's scores, and its synthetic id
 *      must stay out of `submitted_by_user_id`.
 *   3. **Re-running is free.** A host will press sync repeatedly during a
 *      round; the second press must add nothing.
 *   4. **The token is presented the way AtGames wants it** (`Authorization:
 *      Bearer` + `fp`), and a rejected token costs exactly one re-login.
 */

const MINUTE = 60_000;

/** A JWT-shaped token whose payload we control. Not signed — nothing verifies it. */
function fakeJwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2ln`;
}

describe('AtGames — timestamp parsing', () => {
    it('reads AtGames\' zone-less timestamps as UTC, not local time', () => {
        // This is the whole bug: `Date.parse('2026-08-23 20:54:42.0')` is
        // local-time in Node, so on a UTC-5 host the score moves 5 hours.
        expect(parseAtGamesTimestamp('2026-08-23 20:54:42.0'))
            .toBe(Date.parse('2026-08-23T20:54:42.000Z'));
        expect(parseAtGamesTimestamp('2026-08-23T20:54:42'))
            .toBe(Date.parse('2026-08-23T20:54:42.000Z'));
    });

    it('passes through timestamps that already carry a zone', () => {
        expect(parseAtGamesTimestamp('2026-08-23T20:54:42Z'))
            .toBe(Date.parse('2026-08-23T20:54:42.000Z'));
        expect(parseAtGamesTimestamp('2026-08-23T22:54:42+02:00'))
            .toBe(Date.parse('2026-08-23T20:54:42.000Z'));
    });

    it('returns null rather than a guess for anything else', () => {
        // A wrong guess would place a score in a window it never belonged to.
        expect(parseAtGamesTimestamp('2026/06/28 08:29:03 am PDT')).toBeNull();
        expect(parseAtGamesTimestamp('')).toBeNull();
        expect(parseAtGamesTimestamp(null)).toBeNull();
        expect(parseAtGamesTimestamp('yesterday')).toBeNull();
    });
});

describe('AtGames — credential resolution', () => {
    it('is off when the room says so, even with credentials present', () => {
        expect(resolveAtGamesCredsFromSettings('r1', {
            ATGAMES_ENABLED: 'false', ATGAMES_EMAIL: 'a@b.com', ATGAMES_PASSWORD: 'pw',
        })).toBeNull();
    });

    it('treats partial configuration as off rather than half-enabled', () => {
        expect(resolveAtGamesCredsFromSettings('r1', { ATGAMES_EMAIL: 'a@b.com' })).toBeNull();
        expect(resolveAtGamesCredsFromSettings('r1', { ATGAMES_PASSWORD: 'pw' })).toBeNull();
    });

    it('is off — silently — when nothing is configured', () => {
        expect(resolveAtGamesCredsFromSettings('r1', {})).toBeNull();
    });

    it('reuses a stored device fingerprint and mints one only when missing', () => {
        const stored = resolveAtGamesCredsFromSettings('r1', {
            ATGAMES_EMAIL: 'a@b.com', ATGAMES_PASSWORD: 'pw', ATGAMES_DEVICE_FP: 'fixed-uuid',
        });
        expect(stored?.deviceFp).toBe('fixed-uuid');

        const minted = resolveAtGamesCredsFromSettings('r1', {
            ATGAMES_EMAIL: 'a@b.com', ATGAMES_PASSWORD: 'pw',
        });
        expect(minted?.deviceFp).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('keeps the AtGames password on the encryption allowlist', () => {
        // ADR 0003 is an allowlist, not a convention — a key not listed here is
        // stored in the clear.
        expect(ENCRYPTED_SETTING_KEYS.has('ATGAMES_PASSWORD')).toBe(true);
    });
});

describe('AtGames — synthetic account ids', () => {
    it('never lets an unlinked AtGames id reach submitted_by_user_id', () => {
        // Same rule v2.125.2 established for `iscored:<name>`: a synthetic id
        // in that column hides the real account's name and avatar everywhere.
        expect(normalizeSubmitterUserId('atgames:50177')).toBeNull();
        expect(normalizeSubmitterUserId('ATGAMES:50177')).toBeNull();
        expect(normalizeSubmitterUserId('123456789012345678')).toBe('123456789012345678');
    });
});

describe('AtGamesPrivateClient — auth', () => {
    beforeEach(() => clearAtGamesSessions());
    afterEach(() => vi.restoreAllMocks());

    const creds = { email: 'owner@example.com', password: 'hunter2', deviceFp: 'device-uuid' };

    it('takes the token straight from /account/login when it is there', async () => {
        const token = fakeJwt({ id: 4242, user_name: 'RoomOwner', exp: Math.floor(Date.now() / 1000) + 604800 });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { account: { token } }, headers: {} } as never);

        const session = await new AtGamesPrivateClient(creds).ensureSession();

        expect(session.token).toBe(token);
        expect(session.accountId).toBe(4242);
        expect(session.userName).toBe('RoomOwner');
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]?.[0]).toContain('/account/login');
    });

    it('falls back to /account/sign_in when login returns no token', async () => {
        // The capture could not settle which of the two endpoints hands the
        // token back, so both readings have to work.
        const token = fakeJwt({ id: 7, exp: Math.floor(Date.now() / 1000) + 3600 });
        const post = vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ data: { ok: true }, headers: { 'set-cookie': ['sess=abc; Path=/'] } } as never)
            .mockResolvedValueOnce({ data: { account: { token } }, headers: {} } as never);

        const session = await new AtGamesPrivateClient(creds).ensureSession();

        expect(session.accountId).toBe(7);
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[1]?.[0]).toContain('/account/sign_in');
        // The cookie login set is the only thing that can carry the session.
        const signInHeaders = (post.mock.calls[1]?.[2] as { headers?: Record<string, string> })?.headers ?? {};
        expect(signInHeaders.Cookie).toBe('sess=abc');
    });

    it('reports an auth failure as AtGamesAuthError without leaking the password', async () => {
        vi.spyOn(axios, 'post').mockRejectedValue(
            Object.assign(new Error('Request failed'), { response: { status: 401 } }),
        );

        const err = await new AtGamesPrivateClient(creds).ensureSession().catch(e => e);

        expect(err).toBeInstanceOf(AtGamesAuthError);
        expect(err.status).toBe(401);
        expect(String(err.message)).not.toContain('hunter2');
        // The email is masked too — logs and API error bodies both carry this.
        expect(String(err.message)).not.toContain('owner@example.com');
    });

    it('presents the token as a Bearer header alongside fp', async () => {
        const token = fakeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
        vi.spyOn(axios, 'post').mockResolvedValue({ data: { account: { token } }, headers: {} } as never);
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: [] } as never);

        await new AtGamesPrivateClient(creds).listPrivateTournaments();

        const config = get.mock.calls[0]?.[1] as { headers: Record<string, string> };
        expect(config.headers.Authorization).toBe(`Bearer ${token}`);
        expect(config.headers.fp).toBe('device-uuid');
    });

    it('re-authenticates exactly once on a 401 and retries', async () => {
        const first = fakeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
        const second = fakeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
        const post = vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ data: { account: { token: first } }, headers: {} } as never)
            .mockResolvedValueOnce({ data: { account: { token: second } }, headers: {} } as never);
        const get = vi.spyOn(axios, 'get')
            .mockRejectedValueOnce(Object.assign(new Error('nope'), { response: { status: 401 } }))
            .mockResolvedValueOnce({ data: [{ id: 1, name: 'Stream Night' }] } as never);

        const list = await new AtGamesPrivateClient(creds).listPrivateTournaments();

        expect(list).toHaveLength(1);
        expect(post).toHaveBeenCalledTimes(2);
        expect(get).toHaveBeenCalledTimes(2);
        const retryHeaders = (get.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers;
        expect(retryHeaders.Authorization).toBe(`Bearer ${second}`);
    });

    it('does not re-login on a second 401 — bad creds must not become a hammer', async () => {
        const token = fakeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { account: { token } }, headers: {} } as never);
        vi.spyOn(axios, 'get').mockRejectedValue(
            Object.assign(new Error('nope'), { response: { status: 401 } }),
        );

        await expect(new AtGamesPrivateClient(creds).listPrivateTournaments()).rejects.toThrow();
        expect(post).toHaveBeenCalledTimes(2);
    });
});

describe('AtGamesPrivateClient — flattenRankings', () => {
    it('inherits the game id from its block and drops rows nobody can own', () => {
        const detail: AtGamesPrivateTournamentDetail = {
            id: 1, name: 'Stream Night',
            games: [{
                game_id: 50334,
                rankings: [
                    { account: 11, user_name: 'Wyo', game_id: 0 as number, score: '1234500', created_at: '2026-08-23 20:54:42.0' },
                    // No account id — unattributable, so it must not be stored.
                    { user_name: 'Ghost', game_id: 50334, score: '99', created_at: '2026-08-23 20:55:00.0' } as never,
                    // Unparseable score.
                    { account: 12, user_name: 'Bob', game_id: 50334, score: 'n/a', created_at: '2026-08-23 20:56:00.0' },
                ],
            }],
        };

        const rows = AtGamesPrivateClient.flattenRankings(detail);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.account).toBe(11);
        expect(rows[0]?.score).toBe(1234500);
    });
});

describe('AtGamesEventSyncService — ingest', () => {
    let roomId: string;
    let tournamentId: string;
    let roundOneId: string;
    let roundTwoId: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');
    const ATGAMES_GAME_ID = 50334;

    /** `2026-09-01 20:10:00.0` — the shape AtGames actually sends. */
    const atgamesTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19) + '.0';

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();

        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        for (const [key, value] of [['ATGAMES_EMAIL', 'owner@example.com'], ['ATGAMES_PASSWORD', 'pw'], ['ATGAMES_DEVICE_FP', 'fp-uuid']]) {
            await db.run(
                `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                roomId, key, value,
            );
        }

        // The catalogue row is the join between AtGames' game id and an Arcaid
        // round's name — the whole reason the importer chases `atgames_id`.
        await db.run(
            `INSERT INTO global_games (id, name, normalized_name, type, atgames_id, status, platforms, features)
             VALUES (?, 'Attack from Mars', ?, 'pinball', ?, 'approved', '["atgames_native"]', '[]')`,
            crypto.randomUUID(), normalizeGameName('Attack from Mars'), ATGAMES_GAME_ID,
        );

        tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, end_grace_sec, atgames_tournament_id)
             VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 60, '1170')`,
            tournamentId, roomId,
        );

        // Two rounds of the SAME table — the case that makes "match by window"
        // load-bearing rather than incidental.
        roundOneId = crypto.randomUUID();
        roundTwoId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Attack from Mars', 'SCHEDULED', ?, 1, ?, ?)`,
            roundOneId, tournamentId, roomId,
            new Date(base).toISOString(), new Date(base + 20 * MINUTE).toISOString(),
        );
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Attack from Mars', 'SCHEDULED', ?, 2, ?, ?)`,
            roundTwoId, tournamentId, roomId,
            new Date(base + 30 * MINUTE).toISOString(), new Date(base + 50 * MINUTE).toISOString(),
        );
    });

    afterEach(() => vi.restoreAllMocks());

    function stubAtGames(detail: Partial<AtGamesPrivateTournamentDetail>) {
        vi.spyOn(AtGamesPrivateClient.prototype, 'getPrivateTournament')
            .mockResolvedValue({ id: 1170, name: 'Stream Night', ...detail } as AtGamesPrivateTournamentDetail);
    }

    function ranking(account: number, userName: string, score: number, atMs: number) {
        return {
            account, user_name: userName, game_id: ATGAMES_GAME_ID,
            score: String(score), hardware: 'RK9920', created_at: atgamesTime(atMs),
        };
    }

    it('lands each score in the round whose window contains it', async () => {
        stubAtGames({
            games: [{
                game_id: ATGAMES_GAME_ID,
                rankings: [
                    ranking(11, 'Wyo', 1_200_000, base + 10 * MINUTE),       // round 1
                    ranking(12, 'DirtySocks', 900_000, base + 40 * MINUTE),  // round 2
                ],
            }],
        });

        const result = await AtGamesEventSyncService.syncTournament(tournamentId);

        expect(result.ingested).toBe(2);
        expect(result.outOfWindow).toBe(0);
        const db = await getDatabase();
        const rows = await db.all<Array<{ game_id: string; iscored_username: string; source: string }>>(
            `SELECT game_id, iscored_username, source FROM score_history
             WHERE submitted_during_tournament_id = ? ORDER BY score DESC`, tournamentId,
        );
        expect(rows.map(r => [r.iscored_username, r.game_id])).toEqual([
            ['Wyo', roundOneId], ['DirtySocks', roundTwoId],
        ]);
        expect(rows.every(r => r.source === 'atgames')).toBe(true);
    });

    it('accepts a score inside the end grace and refuses one past it', async () => {
        stubAtGames({
            games: [{
                game_id: ATGAMES_GAME_ID,
                rankings: [
                    // Exit-to-submit: the buzzer went at +20, this uploaded 30s later.
                    ranking(11, 'InGrace', 500_000, base + 20 * MINUTE + 30_000),
                    // Two minutes late, with a 60s grace.
                    ranking(12, 'TooLate', 999_999, base + 22 * MINUTE),
                    // Before round 1 opened at all.
                    ranking(13, 'GearedUp', 888_888, base - 5 * MINUTE),
                ],
            }],
        });

        const result = await AtGamesEventSyncService.syncTournament(tournamentId);

        expect(result.ingested).toBe(1);
        expect(result.outOfWindow).toBe(2);
        const db = await getDatabase();
        const names = await db.all<Array<{ iscored_username: string }>>(
            'SELECT iscored_username FROM score_history WHERE submitted_during_tournament_id = ?', tournamentId,
        );
        expect(names.map(n => n.iscored_username)).toEqual(['InGrace']);
    });

    it('attributes a linked AtGames account and leaves an unlinked one anonymous', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES ('atgames:11', '123456789012345678')`,
        );
        stubAtGames({
            games: [{
                game_id: ATGAMES_GAME_ID,
                rankings: [
                    ranking(11, 'Wyo', 1_200_000, base + 5 * MINUTE),
                    ranking(99, 'Stranger', 100_000, base + 6 * MINUTE),
                ],
            }],
        });

        const result = await AtGamesEventSyncService.syncTournament(tournamentId);

        expect(result.unlinkedAccounts).toBe(1);
        const rows = await db.all<Array<{ iscored_username: string; discord_user_id: string; submitted_by_user_id: string | null }>>(
            `SELECT iscored_username, discord_user_id, submitted_by_user_id FROM score_history
             WHERE submitted_during_tournament_id = ? ORDER BY score DESC`, tournamentId,
        );
        expect(rows[0]).toMatchObject({
            iscored_username: 'Wyo',
            discord_user_id: '123456789012345678',
            submitted_by_user_id: '123456789012345678',
        });
        // The synthetic id is kept where a later link can find it, and kept OUT
        // of submitted_by_user_id.
        expect(rows[1]).toMatchObject({ iscored_username: 'Stranger', discord_user_id: 'atgames:99' });
        expect(rows[1]?.submitted_by_user_id).toBeNull();
    });

    it('is idempotent — a second sync mid-round adds nothing', async () => {
        stubAtGames({
            games: [{ game_id: ATGAMES_GAME_ID, rankings: [ranking(11, 'Wyo', 1_200_000, base + 5 * MINUTE)] }],
        });

        const first = await AtGamesEventSyncService.syncTournament(tournamentId);
        const second = await AtGamesEventSyncService.syncTournament(tournamentId);

        expect(first.ingested).toBe(1);
        expect(second.ingested).toBe(0);
        expect(second.duplicates).toBe(1);
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM score_history WHERE submitted_during_tournament_id = ?', tournamentId,
        );
        expect(count?.n).toBe(1);
    });

    it('reports an AtGames game that matches no round instead of guessing one', async () => {
        stubAtGames({
            games: [{
                game_id: 99999,
                rankings: [{
                    account: 11, user_name: 'Wyo', game_id: 99999,
                    score: '1', created_at: atgamesTime(base + 5 * MINUTE),
                }],
            }],
        });

        const result = await AtGamesEventSyncService.syncTournament(tournamentId);

        expect(result.ingested).toBe(0);
        expect(result.unmatchedGame).toBe(1);
        expect(result.unmatchedGameIds).toEqual([99999]);
    });

    it('refuses a tournament with no AtGames link, and one with no credentials', async () => {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET atgames_tournament_id = NULL WHERE id = ?', tournamentId);
        await expect(AtGamesEventSyncService.syncTournament(tournamentId))
            .rejects.toMatchObject({ code: 'NOT_LINKED' });

        await db.run(`UPDATE tournaments SET atgames_tournament_id = '1170' WHERE id = ?`, tournamentId);
        await db.run(`DELETE FROM game_room_settings WHERE game_room_id = ? AND key LIKE 'ATGAMES_%'`, roomId);
        await expect(AtGamesEventSyncService.syncTournament(tournamentId))
            .rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
    });

    it('raises NOT_FOUND for a tournament that does not exist', async () => {
        const err = await AtGamesEventSyncService.syncTournament(crypto.randomUUID()).catch(e => e);
        expect(err).toBeInstanceOf(AtGamesSyncError);
        expect(err.code).toBe('NOT_FOUND');
    });
});

describe('score_history — the fourth source', () => {
    let roomId: string;
    beforeEach(async () => { await setupTestDb(); roomId = await createTestRoom(); });

    it('accepts source = atgames', async () => {
        // Migration 167 rebuilt the table for this one value; if the CHECK is
        // ever regenerated without it, every AtGames ingest fails at the INSERT.
        const db = await getDatabase();
        await expect(db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source)
             VALUES ('Attack from Mars', ?, 'Wyo', 'atgames:11', 100, 'atgames')`,
            roomId,
        )).resolves.toBeTruthy();
    });

    it('still refuses an unknown source', async () => {
        const db = await getDatabase();
        await expect(db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source)
             VALUES ('Attack from Mars', ?, 'Wyo', 'x', 100, 'whatever')`,
            roomId,
        )).rejects.toThrow();
    });
});
