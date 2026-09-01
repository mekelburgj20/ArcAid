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
import { AtGamesIdentityService, AtGamesLinkError } from '../services/AtGamesIdentityService.js';
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

    it('stores ATGAMES\' timestamp as created_at, not the moment of the pull', async () => {
        // v2.145.0 (P8): exit-to-submit makes AtGames' timestamp the moment the
        // player LEFT the table. Stamping `CURRENT_TIMESTAMP` instead — which is
        // what the pre-v2.145.0 write did — recorded the host's "Pull scores"
        // click, which makes `elapsed_sec` meaningless and leaves the witness
        // verify-join (`exit_ts ≈ created_at`) nothing real to join on.
        const scoredAt = base + 10 * MINUTE;
        stubAtGames({
            games: [{ game_id: ATGAMES_GAME_ID, rankings: [ranking(11, 'Wyo', 1_200_000, scoredAt)] }],
        });

        await AtGamesEventSyncService.syncTournament(tournamentId);

        const db = await getDatabase();
        const row = await db.get<{ created_at: string }>(
            'SELECT created_at FROM score_history WHERE submitted_during_tournament_id = ?', tournamentId,
        );
        // SQLite UTC shape, to the second, equal to AtGames' own instant.
        expect(row?.created_at).toBe(
            new Date(scoredAt).toISOString().replace('T', ' ').slice(0, 19),
        );
        expect(Math.abs(Date.parse(`${row!.created_at}Z`) - scoredAt)).toBeLessThan(1000);
        // Sanity: "now" is years away from the fixture window, so a
        // CURRENT_TIMESTAMP default would have failed the assertion above.
        expect(Math.abs(Date.now() - scoredAt)).toBeGreaterThan(60_000);
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

        // v2.153.0 (ADR 0023): the LINKED account's cabinet score also reaches
        // the Global Scoreboard — and the unlinked one does not, because there
        // is nobody to credit it to.
        const global = await db.all<Array<{ player_id: string; score: number }>>(
            `SELECT player_id, score FROM global_scores`,
        );
        expect(global).toHaveLength(1);
        expect(global[0]).toMatchObject({ player_id: '123456789012345678', score: 1_200_000 });
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

describe('AtGamesEventSyncService — dry run', () => {
    let roomId: string;
    let tournamentId: string;
    let roundOneId: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');
    const ATGAMES_GAME_ID = 50334;
    const atgamesTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19) + '.0';

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        for (const [key, value] of [['ATGAMES_EMAIL', 'owner@example.com'], ['ATGAMES_PASSWORD', 'pw'], ['ATGAMES_DEVICE_FP', 'fp']]) {
            await db.run(
                `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                roomId, key, value,
            );
        }
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
        roundOneId = crypto.randomUUID();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Attack from Mars', 'SCHEDULED', ?, 1, ?, ?)`,
            roundOneId, tournamentId, roomId,
            new Date(base).toISOString(), new Date(base + 20 * MINUTE).toISOString(),
        );

        vi.spyOn(AtGamesPrivateClient.prototype, 'getPrivateTournament').mockResolvedValue({
            id: 1170, name: 'Stream Night',
            games: [{
                game_id: ATGAMES_GAME_ID,
                rankings: [
                    { account: 11, user_name: 'Wyo', game_id: ATGAMES_GAME_ID, score: '1200000', created_at: atgamesTime(base + 5 * MINUTE) },
                    { account: 12, user_name: 'Late', game_id: ATGAMES_GAME_ID, score: '900000', created_at: atgamesTime(base + 40 * MINUTE) },
                ],
            }],
        } as AtGamesPrivateTournamentDetail);
    });

    afterEach(() => vi.restoreAllMocks());

    it('writes nothing and reports what it would have done', async () => {
        const preview = await AtGamesEventSyncService.syncTournament(tournamentId, { dryRun: true });

        expect(preview.dryRun).toBe(true);
        expect(preview.ingested).toBe(1);
        expect(preview.outOfWindow).toBe(1);
        // Nothing to refresh — a preview must never claim it changed anything.
        expect(preview.affectedGameIds).toEqual([]);

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM score_history WHERE submitted_during_tournament_id = ?', tournamentId,
        );
        expect(count?.n).toBe(0);
    });

    it('explains every score, including the ones that did not count', async () => {
        const preview = await AtGamesEventSyncService.syncTournament(tournamentId, { dryRun: true });

        const byName = Object.fromEntries(preview.rows.map(r => [r.userName, r]));
        expect(byName.Wyo).toMatchObject({ decision: 'ingested', roundNo: 1, roundName: 'Attack from Mars' });
        expect(byName.Late).toMatchObject({ decision: 'out_of_window', roundNo: null });
        // The timestamp is echoed back normalised, so a host can see the moment
        // AtGames recorded rather than having to trust the verdict.
        expect(byName.Wyo?.atIso).toBe(new Date(base + 5 * MINUTE).toISOString());
    });

    it('agrees with the real run it is previewing', async () => {
        const preview = await AtGamesEventSyncService.syncTournament(tournamentId, { dryRun: true });
        const real = await AtGamesEventSyncService.syncTournament(tournamentId);

        expect(real.ingested).toBe(preview.ingested);
        expect(real.outOfWindow).toBe(preview.outOfWindow);

        // And a preview AFTER the write reports the duplicate, through the same
        // predicate the write uses — this is what keeps the two from drifting.
        const second = await AtGamesEventSyncService.syncTournament(tournamentId, { dryRun: true });
        expect(second.ingested).toBe(0);
        expect(second.duplicates).toBe(1);
    });
});

describe('AtGamesIdentityService — who is who', () => {
    let roomId: string;
    let tournamentId: string;
    let roundId: string;
    const USER = '123456789012345678';

    async function ingest(username: string, account: number, score: number) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id,
                                        score, source, submitted_during_tournament_id, submitted_by_user_id)
             VALUES ('Attack from Mars', ?, ?, ?, ?, ?, 'atgames', ?, NULL)`,
            roomId, roundId, username, `atgames:${account}`, score, tournamentId,
        );
    }

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();
        tournamentId = crypto.randomUUID();
        roundId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
             VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event')`,
            tournamentId, roomId,
        );
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no)
             VALUES (?, ?, 'Attack from Mars', 'SCHEDULED', ?, 1)`,
            roundId, tournamentId, roomId,
        );
    });

    it('lists the unclaimed AtGames accounts on the board', async () => {
        await ingest('Wyo', 11, 1000);
        await ingest('Wyo', 11, 2000);
        await ingest('Stranger', 99, 500);

        const accounts = await AtGamesIdentityService.listAccountsForTournament(tournamentId);

        expect(accounts).toHaveLength(2);
        expect(accounts[0]).toMatchObject({ atgamesAccountId: 11, userName: 'Wyo', scoreCount: 2, linkedUserId: null });
        expect(accounts[1]).toMatchObject({ atgamesAccountId: 99, linkedUserId: null });
    });

    it('claims the past scores when an account is linked', async () => {
        await ingest('Wyo', 11, 1000);
        await ingest('Wyo', 11, 2000);
        await ingest('Stranger', 99, 500);

        const res = await AtGamesIdentityService.linkAccount(11, USER);

        expect(res.rowsAttributed).toBe(2);
        const db = await getDatabase();
        const mine = await db.all<Array<{ score: number }>>(
            'SELECT score FROM score_history WHERE submitted_by_user_id = ? ORDER BY score', USER,
        );
        expect(mine.map(r => r.score)).toEqual([1000, 2000]);
        // Somebody else's account is untouched.
        const stranger = await db.get<{ submitted_by_user_id: string | null }>(
            `SELECT submitted_by_user_id FROM score_history WHERE iscored_username = 'Stranger'`,
        );
        expect(stranger?.submitted_by_user_id).toBeNull();
    });

    it('shows the account as claimed afterwards', async () => {
        await ingest('Wyo', 11, 1000);
        await AtGamesIdentityService.linkAccount(11, USER);

        const accounts = await AtGamesIdentityService.listAccountsForTournament(tournamentId);
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({ atgamesAccountId: 11, linkedUserId: USER, scoreCount: 1 });
    });

    it('refuses to re-point a link onto a different player', async () => {
        await ingest('Wyo', 11, 1000);
        await AtGamesIdentityService.linkAccount(11, USER);

        // Last-write-wins here is how one player quietly inherits another's history.
        const err = await AtGamesIdentityService.linkAccount(11, '999999999999999999').catch(e => e);
        expect(err).toBeInstanceOf(AtGamesLinkError);
        expect(err.code).toBe('LINK_CONFLICT');
    });

    it('re-running the same link is a safe repair, not an error', async () => {
        await ingest('Wyo', 11, 1000);
        await AtGamesIdentityService.linkAccount(11, USER);
        await ingest('Wyo', 11, 3000);

        const again = await AtGamesIdentityService.linkAccount(11, USER);
        expect(again.rowsAttributed).toBe(1);
    });

    it('leaves a finished event alone — standings are history', async () => {
        await ingest('Wyo', 11, 1000);
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET is_active = 0 WHERE id = ?', tournamentId);

        const res = await AtGamesIdentityService.linkAccount(11, USER);

        expect(res.rowsAttributed).toBe(0);
        const row = await db.get<{ submitted_by_user_id: string | null }>(
            'SELECT submitted_by_user_id FROM score_history WHERE submitted_during_tournament_id = ?', tournamentId,
        );
        expect(row?.submitted_by_user_id).toBeNull();
    });

    it('unlinking returns only the AtGames scores to anonymous', async () => {
        await ingest('Wyo', 11, 1000);
        const db = await getDatabase();
        // A score the player submitted themselves — never touched by an unlink.
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score,
                                        source, submitted_during_tournament_id, submitted_by_user_id)
             VALUES ('Attack from Mars', ?, 'Wyo', ?, 4242, 'tournament', ?, ?)`,
            roomId, USER, tournamentId, USER,
        );
        await AtGamesIdentityService.linkAccount(11, USER);

        const res = await AtGamesIdentityService.unlinkAccount(11);

        expect(res.rowsReanonymized).toBe(1);
        const own = await db.get<{ submitted_by_user_id: string | null }>(
            'SELECT submitted_by_user_id FROM score_history WHERE score = 4242',
        );
        expect(own?.submitted_by_user_id).toBe(USER);
        const link = await db.get('SELECT 1 FROM user_identity_links WHERE provider_user_id = ?', 'atgames:11');
        expect(link).toBeUndefined();
    });

    it('rejects an account id that is not one', async () => {
        await expect(AtGamesIdentityService.linkAccount('not-a-number', USER))
            .rejects.toMatchObject({ code: 'BAD_ACCOUNT_ID' });
    });

    it('an event participant passes the link authorization even with no membership', async () => {
        // The route's rule, pinned at the data layer: member OR participant of
        // THIS tournament. A fresh test room has NO members — the admin adds
        // themselves to the event by hand, plays, and the link must not dead-end
        // (first live test, 2026-08-26).
        const db = await getDatabase();
        await db.run(
            `INSERT INTO tournament_participants (tournament_id, user_id, source, checked_in_at) VALUES (?, ?, 'admin', datetime('now'))`,
            tournamentId, USER,
        );

        const { RoomMembershipService } = await import('../services/RoomMembershipService.js');
        expect(await RoomMembershipService.isMember(USER, roomId)).toBe(false);
        const participant = await db.get(
            'SELECT 1 FROM tournament_participants WHERE tournament_id = ? AND user_id = ?',
            tournamentId, USER,
        );
        expect(participant).toBeTruthy();

        // And the link itself works for them end to end.
        await ingest('Wyo', 11, 1000);
        const res = await AtGamesIdentityService.linkAccount(11, USER);
        expect(res.rowsAttributed).toBe(1);
    });
});

describe('AtGamesEventSyncService — invitation-code resolution', () => {
    let roomId: string;
    let tournamentId: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');
    const ATGAMES_GAME_ID = 50334;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();
        for (const [key, value] of [['ISCORED_ENABLED', 'false'], ['ATGAMES_EMAIL', 'o@e.com'], ['ATGAMES_PASSWORD', 'pw'], ['ATGAMES_DEVICE_FP', 'fp']]) {
            await db.run(`INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`, roomId, key, value);
        }
        await db.run(
            `INSERT INTO global_games (id, name, normalized_name, type, atgames_id, status, platforms, features)
             VALUES (?, 'Attack from Mars', ?, 'pinball', ?, 'approved', '["atgames_native"]', '[]')`,
            crypto.randomUUID(), normalizeGameName('Attack from Mars'), ATGAMES_GAME_ID,
        );
        tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, end_grace_sec, atgames_tournament_id)
             VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 60, '9CTQSJF')`,
            tournamentId, roomId,
        );
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Attack from Mars', 'SCHEDULED', ?, 1, ?, ?)`,
            crypto.randomUUID(), tournamentId, roomId,
            new Date(base).toISOString(), new Date(base + 20 * MINUTE).toISOString(),
        );
    });

    afterEach(() => vi.restoreAllMocks());

    it('resolves an invitation code to the tournament id and stores it', async () => {
        // Hosts paste the CODE at least as often as the id — the code is what
        // AtGames shows players; the id only lives in the address bar.
        vi.spyOn(AtGamesPrivateClient.prototype, 'listPrivateTournaments').mockResolvedValue([
            { id: 1170, name: 'Stream Night', invitationCode: '9CTQSJF' },
            { id: 1171, name: 'Other Night', invitationCode: 'ZZZZZZZ' },
        ]);
        const detail = vi.spyOn(AtGamesPrivateClient.prototype, 'getPrivateTournament')
            .mockResolvedValue({ id: 1170, name: 'Stream Night', games: [] });

        await AtGamesEventSyncService.syncTournament(tournamentId, { dryRun: true });

        expect(detail).toHaveBeenCalledWith('1170');
        const db = await getDatabase();
        const row = await db.get<{ atgames_tournament_id: string; atgames_invite_code: string | null }>(
            'SELECT atgames_tournament_id, atgames_invite_code FROM tournaments WHERE id = ?', tournamentId,
        );
        expect(row?.atgames_tournament_id).toBe('1170');
        expect(row?.atgames_invite_code).toBe('9CTQSJF');
    });

    it('reports an unknown code instead of guessing a tournament', async () => {
        vi.spyOn(AtGamesPrivateClient.prototype, 'listPrivateTournaments').mockResolvedValue([
            { id: 1171, name: 'Other Night', invitationCode: 'ZZZZZZZ' },
        ]);
        await expect(AtGamesEventSyncService.syncTournament(tournamentId, { dryRun: true }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

describe('AtGamesEventSyncService — create on AtGames', () => {
    let roomId: string;
    let tournamentId: string;
    const base = Date.parse('2026-09-01T20:00:00.000Z');
    const ATGAMES_GAME_ID = 50334;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();
        for (const [key, value] of [['ISCORED_ENABLED', 'false'], ['ATGAMES_EMAIL', 'o@e.com'], ['ATGAMES_PASSWORD', 'pw'], ['ATGAMES_DEVICE_FP', 'fp']]) {
            await db.run(`INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`, roomId, key, value);
        }
        await db.run(
            `INSERT INTO global_games (id, name, normalized_name, type, atgames_id, status, platforms, features)
             VALUES (?, 'Attack from Mars', ?, 'pinball', ?, 'approved', '["atgames_native"]', '[]')`,
            crypto.randomUUID(), normalizeGameName('Attack from Mars'), ATGAMES_GAME_ID,
        );
        tournamentId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, end_grace_sec)
             VALUES (?, 'Stream Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 120)`,
            tournamentId, roomId,
        );
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Attack from Mars', 'SCHEDULED', ?, 1, ?, ?)`,
            crypto.randomUUID(), tournamentId, roomId,
            new Date(base).toISOString(), new Date(base + 20 * MINUTE).toISOString(),
        );
    });

    afterEach(() => vi.restoreAllMocks());

    it('derives the window and games from the event, and stores id + invite code', async () => {
        const create = vi.spyOn(AtGamesPrivateClient.prototype, 'createPrivateTournament')
            .mockResolvedValue({ id: 2001, name: 'Stream Night', invitationCode: 'ABCD123', createdAt: '2026-09-01' });

        const result = await AtGamesEventSyncService.createForTournament(tournamentId);

        // Window = first round start .. last round end + the event's grace, so
        // the AtGames window always CONTAINS every Arcaid round window.
        expect(create).toHaveBeenCalledWith({
            name: 'Stream Night',
            startDate: new Date(base).toISOString(),
            endDate: new Date(base + 20 * MINUTE + 120_000).toISOString(),
            gameIds: [ATGAMES_GAME_ID],
        });
        expect(result.atgamesTournamentId).toBe('2001');
        expect(result.inviteCode).toBe('ABCD123');

        const db = await getDatabase();
        const row = await db.get<{ atgames_tournament_id: string; atgames_invite_code: string }>(
            'SELECT atgames_tournament_id, atgames_invite_code FROM tournaments WHERE id = ?', tournamentId,
        );
        expect(row).toMatchObject({ atgames_tournament_id: '2001', atgames_invite_code: 'ABCD123' });
    });

    it('clamps a past start into the future — AtGames refuses windows that begin in the past', async () => {
        // The live 400 of 2026-08-26: Create pressed while round 1 was already
        // running. The owner's own successful manual create (cURL) confirmed
        // our field names and format exactly — the difference was the window.
        const db = await getDatabase();
        const pastStart = Date.now() - 10 * MINUTE;
        const futureEnd = Date.now() + 30 * MINUTE;
        await db.run(
            `UPDATE games SET scheduled_start_at = ?, scheduled_end_at = ? WHERE tournament_id = ?`,
            new Date(pastStart).toISOString(), new Date(futureEnd).toISOString(), tournamentId,
        );
        const create = vi.spyOn(AtGamesPrivateClient.prototype, 'createPrivateTournament')
            .mockResolvedValue({ id: 2002, name: 'Stream Night', invitationCode: 'XYZ' });

        await AtGamesEventSyncService.createForTournament(tournamentId);

        const sent = create.mock.calls[0]?.[0] as { startDate: string; endDate: string };
        expect(Date.parse(sent.startDate)).toBeGreaterThan(Date.now());
        // The end still covers the event: last round end + the 120s grace.
        expect(Date.parse(sent.endDate)).toBe(futureEnd + 120_000);
    });

    it('refuses outright when the event is already over', async () => {
        const db = await getDatabase();
        await db.run(
            `UPDATE games SET scheduled_start_at = ?, scheduled_end_at = ? WHERE tournament_id = ?`,
            new Date(Date.now() - 60 * MINUTE).toISOString(),
            new Date(Date.now() - 30 * MINUTE).toISOString(),
            tournamentId,
        );
        await expect(AtGamesEventSyncService.createForTournament(tournamentId))
            .rejects.toThrow(/already over/);
    });

    it('refuses when the event is already linked — no accidental duplicates', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET atgames_tournament_id = '1170' WHERE id = ?`, tournamentId);
        await expect(AtGamesEventSyncService.createForTournament(tournamentId))
            .rejects.toMatchObject({ code: 'NOT_LINKED' });
    });

    it('names the games that are not AtGames-linked instead of sending nothing', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE global_games SET atgames_id = NULL`);
        const err = await AtGamesEventSyncService.createForTournament(tournamentId).catch(e => e);
        expect(err).toBeInstanceOf(AtGamesSyncError);
        // The fix is a catalogue action on a NAMED game — a bare count would
        // leave the host guessing which round is the problem.
        expect(String(err.message)).toContain('Attack from Mars');
    });
});

describe('AtGamesPrivateClient — create rejection surfacing', () => {
    beforeEach(() => clearAtGamesSessions());
    afterEach(() => vi.restoreAllMocks());

    it("carries AtGames' response body instead of dying as an opaque error", async () => {
        // The first live create attempt (2026-08-26) came back HTTP 400 and the
        // admin saw "Internal Server Error". The payload contract is
        // reverse-engineered, so AtGames' own body is the only clue to which
        // field it disliked — it must reach the admin, not just the log.
        const { AtGamesApiError } = await import('../services/AtGamesPrivateClient.js');
        const token = fakeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
        vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ data: { account: { token } }, headers: {} } as never)
            .mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
                response: { status: 400, data: { status: 400, error: 'start_date is required' } },
            }));

        const client = new AtGamesPrivateClient({ email: 'o@e.com', password: 'pw', deviceFp: 'fp' });
        const err = await client.createPrivateTournament({
            name: 'Stream Night', startDate: '2026-09-01T20:00:00.000Z',
            endDate: '2026-09-01T21:00:00.000Z', gameIds: [50334],
        }).catch(e => e);

        expect(err).toBeInstanceOf(AtGamesApiError);
        expect(err.status).toBe(400);
        expect(String(err.message)).toContain('start_date is required');
    });
});

describe('announcements — the none sentinel and the event reopen', () => {
    beforeEach(async () => { await setupTestDb(); });

    it("resolveAnnouncementChannelId treats 'none' as announce-nowhere, before any fallback", async () => {
        const { resolveAnnouncementChannelId, ANNOUNCE_NONE } = await import('../utils/discord.js');
        const roomId = await createTestRoom();
        const db = await getDatabase();
        // A room WITH a default channel — the exact setup where the owner's
        // test event leaked into the live Daily Grind channel.
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID', '111222333')`,
            roomId,
        );

        expect(await resolveAnnouncementChannelId(roomId, ANNOUNCE_NONE)).toBeNull();
        expect(await resolveAnnouncementChannelId(roomId, '')).toBe('111222333');
        expect(await resolveAnnouncementChannelId(roomId, '999')).toBe('999');
    });

    it('saving a future round reopens a finished event', async () => {
        const { EventService } = await import('../services/EventService.js');
        const roomId = await createTestRoom();
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, 'ISCORED_ENABLED', 'false')`,
            roomId,
        );
        const tid = crypto.randomUUID();
        // Finished: the owner created an event whose only round was already
        // past, it froze within the minute, and adding round 2 did nothing.
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, event_finished_at, event_result)
             VALUES (?, 'Arcaid_Test', 'DG', 'pinball', '{"timezone":"UTC"}', 0, ?, 'event', '2026-08-25T23:30:00.001Z', '{}')`,
            tid, roomId,
        );
        const past = Date.now() - 3 * 60 * MINUTE;
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Aerobatics', 'COMPLETED', ?, 1, ?, ?)`,
            crypto.randomUUID(), tid, roomId,
            new Date(past).toISOString(), new Date(past + 30 * MINUTE).toISOString(),
        );

        const future = Date.now() + 60 * MINUTE;
        await EventService.createOrUpdateEvent(tid, {
            rounds: [
                {
                    roundNo: 1, gameName: 'Aerobatics',
                    scheduledStartAt: new Date(past).toISOString(),
                    scheduledEndAt: new Date(past + 30 * MINUTE).toISOString(),
                },
                {
                    roundNo: 2, gameName: 'Aerobatics',
                    scheduledStartAt: new Date(future).toISOString(),
                    scheduledEndAt: new Date(future + 30 * MINUTE).toISOString(),
                },
            ],
        });

        const row = await db.get<{ is_active: number; event_finished_at: string | null; event_result: string | null }>(
            'SELECT is_active, event_finished_at, event_result FROM tournaments WHERE id = ?', tid,
        );
        // Reopened: the scheduler will now run round 2 and re-freeze after it,
        // recomputing the result from score_history — nothing is lost.
        expect(row).toMatchObject({ is_active: 1, event_finished_at: null, event_result: null });
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
