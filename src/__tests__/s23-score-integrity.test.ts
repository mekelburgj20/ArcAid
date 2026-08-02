import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { resolveActiveSubmitGame } from '../discord/commands/submitscore.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';
import { ScoreReportService } from '../services/ScoreReportService.js';

/**
 * S23 — Discord submit for standalone rooms, bulk score import, and the two
 * integrity residuals (room-scoped score reports + the verified-score loop).
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string, discordId = 'admin-1') =>
    signToken({ role: 'room_admin', discordId, username: 'Admin', gameRoomIds: [roomId] });
const playerToken = (discordId: string, username = 'someone') =>
    signToken({ role: 'player', discordId, username, gameRoomIds: [] });

/** Puts an approved catalogue row behind a game name so provenance resolves. */
async function seedCatalogueGame(name: string, opts: {
    platforms?: string[]; features?: string[]; manufacturer?: string | null; year?: number | null;
} = {}) {
    const db = await getDatabase();
    const crypto = await import('crypto');
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, features, status, manufacturer, year)
         VALUES (?, ?, 'pinball', ?, ?, 'approved', ?, ?)`,
        id, name,
        JSON.stringify(opts.platforms ?? ['vpx']),
        JSON.stringify(opts.features ?? []),
        opts.manufacturer ?? null, opts.year ?? null,
    );
    return id;
}

// ---------------------------------------------------------------------------
// S23.1 — Discord /submit-score no longer requires iScored
// ---------------------------------------------------------------------------

describe('S23.1 — resolveActiveSubmitGame without iScored', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('resolves an ACTIVE game that was never pushed to iScored (iscored_id NULL)', async () => {
        const roomId = await createTestRoom('s23-standalone');
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Standalone Game' });

        // Pre-S23 this returned not_found, locking every ISCORED_ENABLED=false
        // room out of /submit-score entirely.
        const result = await resolveActiveSubmitGame('Standalone Game');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.game.iscored_id).toBeNull();
            expect(result.game.game_room_id).toBe(roomId);
        }
    });

    it('still resolves an iScored-linked game unchanged', async () => {
        const roomId = await createTestRoom('s23-iscored');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Linked Game' });
        const db = await getDatabase();
        await db.run('UPDATE games SET iscored_id = ? WHERE id = ?', 'iscored-99', gameId);

        const result = await resolveActiveSubmitGame('Linked Game');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.game.iscored_id).toBe('iscored-99');
    });

    it('still refuses a suspended room — the suspension guard is untouched', async () => {
        const roomId = await createTestRoom('s23-susp');
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Suspended Room Game' });
        const { GameRoomService } = await import('../services/GameRoomService.js');
        await GameRoomService.suspend(roomId, 'super-1', 'testing');

        const result = await resolveActiveSubmitGame('Suspended Room Game');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('suspended');
    });

    it('still not_found for a game that does not exist', async () => {
        const result = await resolveActiveSubmitGame('No Such Game At All');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('not_found');
    });
});

describe('S23.1 — iScored creds resolution for a disabled room', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('getIScoredCredsForRoom returns null when the room has ISCORED_ENABLED=false', async () => {
        // This null is the whole mechanism: the submit path treats it as
        // "skip the sync", exactly as IScoredSubmitSync does on the web.
        const roomId = await createTestRoom('s23-creds-off');
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');
        const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
        expect(await getIScoredCredsForRoom(roomId)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// S23.4 — bulk score import
// ---------------------------------------------------------------------------

describe('S23.4 — score import preview binning', () => {
    it('bins ok / needs_review / error correctly', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-preview');
        await seedCatalogueGame('Medieval Madness', { platforms: ['vpx'] });
        // Two same-name rows from different manufacturers — legal under the
        // catalogue identity index, and genuinely ambiguous by bare name.
        await seedCatalogueGame('Twilight Zone', { manufacturer: 'Bally', year: 1993 });
        await seedCatalogueGame('Twilight Zone', { manufacturer: 'Other', year: 1994 });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-preview`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({
                rows: [
                    { game_name: 'Medieval Madness', player_name: 'Alice', score: '1,234,567', engine: 'vpx', device: 'pc' },
                    { game_name: 'Twilight Zone', player_name: 'Bob', score: '500', engine: 'vpx', device: 'pc' },
                    { game_name: 'Nonexistent Game', player_name: 'Carol', score: '100', engine: 'vpx', device: 'pc' },
                    { game_name: 'Medieval Madness', player_name: 'Dave', score: 'not-a-number', engine: 'vpx', device: 'pc' },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body.summary.ok).toBe(1);
        expect(res.body.summary.needs_review).toBe(1);
        expect(res.body.summary.error).toBe(2);
        expect(res.body.summary.total).toBe(4);
        // Thousands separators are stripped, not rejected.
        expect(res.body.rows[0].resolved.score).toBe(1234567);
        expect(res.body.rows[1].candidates).toHaveLength(2);
    });

    it('rejects an unparseable date rather than silently importing it as now', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-date');
        await seedCatalogueGame('Attack From Mars');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-preview`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ rows: [{ game_name: 'Attack From Mars', player_name: 'Al', score: '10', engine: 'vpx', device: 'pc', date: 'last tuesday' }] });

        expect(res.body.summary.error).toBe(1);
        expect(res.body.rows[0].error).toMatch(/date/i);
    });

    it('requires room access', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-auth');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-preview`)
            .set('Authorization', `Bearer ${adminToken('some-other-room')}`)
            .send({ rows: [{ game_name: 'X', player_name: 'Y', score: '1', engine: 'vpx', device: 'pc' }] });
        expect([401, 403]).toContain(res.status);
    });
});

describe('S23.4 — score import commit', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('writes score_history rows with source=community and NO tournament linkage', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-commit');
        // An ACTIVE tournament for the same game exists — the imported rows
        // must NOT attach to it.
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Medieval Madness' });
        await seedCatalogueGame('Medieval Madness');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-commit`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({
                rows: [
                    { game_name: 'Medieval Madness', player_name: 'Alice', score: '5000', engine: 'vpx', device: 'pc' },
                    { game_name: 'Medieval Madness', player_name: 'Bob', score: '3000', engine: 'vpx', device: 'pc' },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body.counts.imported).toBe(2);

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT * FROM score_history WHERE game_room_id = ? ORDER BY score DESC`, roomId,
        );
        expect(rows).toHaveLength(2);
        for (const r of rows) {
            expect(r.source).toBe('community');
            expect(r.submitted_during_tournament_id).toBeNull();
            expect(r.submitted_by_user_id).toBeNull();
            expect(r.engine).toBe('vpx');
        }
    });

    it('NEVER calls the Global Scoreboard fan-out', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-nofanout');
        await seedCatalogueGame('Attack From Mars');

        const { GlobalScoreService } = await import('../services/GlobalScoreService.js');
        const spy = vi.spyOn(GlobalScoreService, 'fanOutFromRoomSubmission');

        await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-commit`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ rows: [{ game_name: 'Attack From Mars', player_name: 'Alice', score: '5000', engine: 'vpx', device: 'pc' }] });

        expect(spy).not.toHaveBeenCalled();
    });

    it('is idempotent — re-importing the same file adds no duplicate rows', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-idem');
        await seedCatalogueGame('Theatre of Magic');
        const body = {
            rows: [{ game_name: 'Theatre of Magic', player_name: 'Alice', score: '5000', engine: 'vpx', device: 'pc' }],
        };
        const token = adminToken(roomId);

        await request(app).post(`/api/rooms/${roomId}/scores/import-csv-commit`).set('Authorization', `Bearer ${token}`).send(body);
        await request(app).post(`/api/rooms/${roomId}/scores/import-csv-commit`).set('Authorization', `Bearer ${token}`).send(body);

        const db = await getDatabase();
        const rows = await db.all('SELECT id FROM score_history WHERE game_room_id = ?', roomId);
        expect(rows).toHaveLength(1);
    });

    it('honours a supplied ISO date instead of stamping now', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-backdate');
        await seedCatalogueGame('Funhouse');

        await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-commit`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ rows: [{ game_name: 'Funhouse', player_name: 'Alice', score: '777', engine: 'vpx', device: 'pc', date: '2020-03-04' }] });

        const db = await getDatabase();
        const row = await db.get('SELECT created_at FROM score_history WHERE game_room_id = ?', roomId);
        expect(row.created_at).toMatch(/^2020-03-04/);
    });

    it('collects per-row errors without failing the batch', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-partial');
        await seedCatalogueGame('Medieval Madness');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-commit`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({
                rows: [
                    { game_name: 'Medieval Madness', player_name: 'Alice', score: '5000', engine: 'vpx', device: 'pc' },
                    { game_name: 'Not In Catalogue', player_name: 'Bob', score: '10', engine: 'vpx', device: 'pc' },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body.counts.imported).toBe(1);
        expect(res.body.counts.skipped).toBe(1);
        expect(res.body.errors).toHaveLength(1);
        expect(res.body.errors[0].index).toBe(1);
    });

    it('writes an audit row naming the actor and the counts', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-audit');
        await seedCatalogueGame('Whitewater');

        await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-commit`)
            .set('Authorization', `Bearer ${adminToken(roomId, 'admin-audit-1')}`)
            .send({ rows: [{ game_name: 'Whitewater', player_name: 'Alice', score: '1', engine: 'vpx', device: 'pc' }] });

        const db = await getDatabase();
        const audit = await db.get(
            `SELECT * FROM audit_log WHERE action = 'scores_bulk_imported' AND target_id = ?`, roomId,
        );
        expect(audit).toBeTruthy();
        expect(audit.actor).toBe('admin-audit-1');
        expect(JSON.parse(audit.details).imported).toBe(1);
    });

    it('keeps submissions in step when the game is live in the room', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-imp-subs');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Cirqus Voltaire' });
        await seedCatalogueGame('Cirqus Voltaire');

        await request(app)
            .post(`/api/rooms/${roomId}/scores/import-csv-commit`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ rows: [{ game_name: 'Cirqus Voltaire', player_name: 'Alice', score: '4242', engine: 'vpx', device: 'pc' }] });

        const db = await getDatabase();
        const sub = await db.get('SELECT * FROM submissions WHERE id = ?', `${gameId}-alice`);
        expect(sub).toBeTruthy();
        expect(sub.score).toBe(4242);
        expect(sub.engine).toBe('vpx');
    });
});

// ---------------------------------------------------------------------------
// S23.6 — room-scoped score reports
// ---------------------------------------------------------------------------

describe('S23.6 — room-scoped score report', () => {
    it('files a report tagged room_history with the room id', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-rep-file');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Report Me' });
        await createTestSubmission(gameId, { username: 'Cheater', discordUserId: 'disc-cheat', score: 999999 });

        const db = await getDatabase();
        const hist = await db.get('SELECT id FROM score_history WHERE game_room_id = ?', roomId);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/score-history/${hist.id}/report`)
            .set('Authorization', `Bearer ${playerToken('disc-reporter')}`)
            .send({ reason: 'impossible score' });

        expect(res.status).toBe(201);
        const report = await db.get('SELECT * FROM score_reports WHERE id = ?', res.body.id);
        expect(report.score_source).toBe('room_history');
        expect(report.game_room_id).toBe(roomId);
        expect(report.score_id).toBe(String(hist.id));
    });

    it('409s a duplicate open report from the same reporter', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-rep-dupe');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Dupe Me' });
        await createTestSubmission(gameId, { username: 'P', discordUserId: 'disc-p', score: 10 });
        const db = await getDatabase();
        const hist = await db.get('SELECT id FROM score_history WHERE game_room_id = ?', roomId);
        const token = playerToken('disc-dupe-reporter');

        await request(app).post(`/api/rooms/${roomId}/score-history/${hist.id}/report`).set('Authorization', `Bearer ${token}`).send({});
        const second = await request(app).post(`/api/rooms/${roomId}/score-history/${hist.id}/report`).set('Authorization', `Bearer ${token}`).send({});
        expect(second.status).toBe(409);
    });

    it('404s a history row belonging to a different room', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('s23-rep-a');
        const roomB = await createTestRoom('s23-rep-b');
        const tId = await createTestTournament(roomA);
        const gameId = await createTestGame(tId, { name: 'Room A Game' });
        await createTestSubmission(gameId, { username: 'P', discordUserId: 'disc-x', score: 10 });
        const db = await getDatabase();
        const hist = await db.get('SELECT id FROM score_history WHERE game_room_id = ?', roomA);

        const res = await request(app)
            .post(`/api/rooms/${roomB}/score-history/${hist.id}/report`)
            .set('Authorization', `Bearer ${playerToken('disc-reporter-2')}`)
            .send({});
        expect(res.status).toBe(404);
    });

    it('requires a logged-in reporter', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s23-rep-anon');
        const res = await request(app).post(`/api/rooms/${roomId}/score-history/1/report`).send({});
        expect([401, 403]).toContain(res.status);
    });
});

describe('S23.6 — ScoreReportService branching', () => {
    beforeEach(async () => { await setupTestDb(); });

    /** Files a room report against a fresh score_history row. */
    async function seedRoomReport(opts: { anonymous?: boolean } = {}) {
        const roomId = await createTestRoom(`s23-svc-${Math.random().toString(36).slice(2, 8)}`);
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Service Game' });
        await createTestSubmission(gameId, {
            username: 'Suspect',
            discordUserId: opts.anonymous ? 'SYSTEM' : 'disc-suspect',
            score: 8888,
        });
        const db = await getDatabase();
        const hist = await db.get('SELECT id FROM score_history WHERE game_room_id = ?', roomId);
        if (opts.anonymous) {
            await db.run('UPDATE score_history SET submitted_by_user_id = NULL WHERE id = ?', hist.id);
        } else {
            await db.run('UPDATE score_history SET submitted_by_user_id = ? WHERE id = ?', 'disc-suspect', hist.id);
        }
        const crypto = await import('crypto');
        const reportId = crypto.randomUUID();
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason, score_source, game_room_id)
             VALUES (?, ?, 'disc-reporter', 'cheating', 'room_history', ?)`,
            reportId, String(hist.id), roomId,
        );
        return { roomId, gameId, historyId: hist.id as number, reportId };
    }

    it('listPending resolves player/score/game for a room report', async () => {
        const { reportId, roomId } = await seedRoomReport();
        const pending = await ScoreReportService.listPending();
        const row = pending.find(r => r.id === reportId)!;
        expect(row).toBeTruthy();
        expect(row.score_source).toBe('room_history');
        expect(row.game_room_id).toBe(roomId);
        expect(row.iscored_username).toBe('Suspect');
        expect(row.score).toBe(8888);
        expect(row.game_name).toBe('Service Game');
        expect(row.room_name).toBeTruthy();
    });

    it('global reports are unaffected — still join global_scores and read as scope Global', async () => {
        const db = await getDatabase();
        const crypto = await import('crypto');
        const roomId = await createTestRoom('s23-svc-global');
        const ggId = await seedCatalogueGame('Global Report Game');
        const scoreId = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id, submitted_at)
             VALUES (?, ?, 'disc-gp', 'GlobalPlayer', 4321, 'room', ?, datetime('now'))`,
            scoreId, ggId, roomId,
        );
        const reportId = crypto.randomUUID();
        // No score_source supplied — the column DEFAULT must make this 'global',
        // which is exactly how every pre-S23 row behaves after the migration.
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason)
             VALUES (?, ?, 'disc-reporter', 'looks fake')`,
            reportId, scoreId,
        );

        const pending = await ScoreReportService.listPending();
        const row = pending.find(r => r.id === reportId)!;
        expect(row.score_source).toBe('global');
        expect(row.game_room_id).toBeNull();
        expect(row.iscored_username).toBe('GlobalPlayer');
        expect(row.score).toBe(4321);
        expect(row.game_name).toBe('Global Report Game');
    });

    it('hardDeleteScore removes the score_history row through the shared delete machinery', async () => {
        const { reportId, historyId, gameId } = await seedRoomReport();
        const db = await getDatabase();

        const ok = await ScoreReportService.hardDeleteScore(reportId, 'admin-1');
        expect(ok).toBe(true);

        expect(await db.get('SELECT id FROM score_history WHERE id = ?', historyId)).toBeUndefined();
        // The suppression tombstone is the shared machinery's signature — proof
        // the recompute path was reused rather than forked.
        const tomb = await db.get(
            'SELECT * FROM deleted_score_suppressions WHERE game_id = ?', gameId,
        );
        expect(tomb).toBeTruthy();
        expect(tomb.suppressed_score).toBe(8888);
        // Report resolved.
        const report = await db.get('SELECT resolution FROM score_reports WHERE id = ?', reportId);
        expect(report.resolution).toBe('deleted');
    });

    it('banUser refuses an anonymous room score instead of guessing an identity', async () => {
        const { reportId } = await seedRoomReport({ anonymous: true });
        const result = await ScoreReportService.banUser(reportId, 'admin-1', null);
        expect(typeof result).toBe('object');
        expect((result as { error: string }).error).toMatch(/anonymous/i);

        // Nothing was banned and the report stays open for a human to handle.
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM user_bans')).toBeUndefined();
        const report = await db.get('SELECT resolved_at FROM score_reports WHERE id = ?', reportId);
        expect(report.resolved_at).toBeNull();
    });

    it('banUser on an attributed room score bans within that room only', async () => {
        const { reportId, roomId } = await seedRoomReport();
        const result = await ScoreReportService.banUser(reportId, 'admin-1', null, 'cheating');
        expect(result).toBe(true);

        const db = await getDatabase();
        const ban = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ?', 'disc-suspect');
        expect(ban).toBeTruthy();
        expect(ban.game_room_id).toBe(roomId);
    });
});

// ---------------------------------------------------------------------------
// S23.7 — verified-score loop
// ---------------------------------------------------------------------------

describe('S23.7 — verify / unverify', () => {
    async function seedScore(slug: string) {
        const roomId = await createTestRoom(slug);
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Verify Me' });
        await createTestSubmission(gameId, { username: 'Player', discordUserId: 'disc-v', score: 1234 });
        const db = await getDatabase();
        const hist = await db.get('SELECT id FROM score_history WHERE game_room_id = ?', roomId);
        return { roomId, historyId: hist.id as number };
    }

    it('round-trips: unverified → verified → unverified', async () => {
        const app = await createTestApp();
        const { roomId, historyId } = await seedScore('s23-ver-round');
        const db = await getDatabase();
        const token = adminToken(roomId, 'admin-verifier');

        const before = await db.get('SELECT verified_by, verified_at FROM score_history WHERE id = ?', historyId);
        expect(before.verified_at).toBeNull();

        const verify = await request(app)
            .post(`/api/rooms/${roomId}/score-history/${historyId}/verify`)
            .set('Authorization', `Bearer ${token}`).send({});
        expect(verify.status).toBe(200);

        const verified = await db.get('SELECT verified_by, verified_at FROM score_history WHERE id = ?', historyId);
        expect(verified.verified_by).toBe('admin-verifier');
        expect(verified.verified_at).toBeTruthy();

        const unverify = await request(app)
            .post(`/api/rooms/${roomId}/score-history/${historyId}/unverify`)
            .set('Authorization', `Bearer ${token}`).send({});
        expect(unverify.status).toBe(200);

        const cleared = await db.get('SELECT verified_by, verified_at FROM score_history WHERE id = ?', historyId);
        expect(cleared.verified_by).toBeNull();
        expect(cleared.verified_at).toBeNull();
    });

    it('writes an audit row for both directions', async () => {
        const app = await createTestApp();
        const { roomId, historyId } = await seedScore('s23-ver-audit');
        const token = adminToken(roomId, 'admin-auditor');

        await request(app).post(`/api/rooms/${roomId}/score-history/${historyId}/verify`).set('Authorization', `Bearer ${token}`).send({});
        await request(app).post(`/api/rooms/${roomId}/score-history/${historyId}/unverify`).set('Authorization', `Bearer ${token}`).send({});

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT action, actor FROM audit_log WHERE target_id = ? ORDER BY id ASC`, String(historyId),
        );
        expect(rows.map((r: any) => r.action)).toEqual(['score_verified', 'score_unverified']);
        expect(rows.every((r: any) => r.actor === 'admin-auditor')).toBe(true);
    });

    it('is admin-only — a player cannot verify their own score', async () => {
        const app = await createTestApp();
        const { roomId, historyId } = await seedScore('s23-ver-player');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/score-history/${historyId}/verify`)
            .set('Authorization', `Bearer ${playerToken('disc-v')}`).send({});
        expect([401, 403]).toContain(res.status);
    });

    it('404s a history row from another room', async () => {
        const app = await createTestApp();
        const { historyId } = await seedScore('s23-ver-other-a');
        const otherRoom = await createTestRoom('s23-ver-other-b');
        const res = await request(app)
            .post(`/api/rooms/${otherRoom}/score-history/${historyId}/verify`)
            .set('Authorization', `Bearer ${adminToken(otherRoom)}`).send({});
        expect(res.status).toBe(404);
    });

    it('surfaces verification state on the per-player history read', async () => {
        const app = await createTestApp();
        const { roomId, historyId } = await seedScore('s23-ver-read');
        await request(app)
            .post(`/api/rooms/${roomId}/score-history/${historyId}/verify`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({});

        const history = await ScoreHistoryService.getPlayerGameHistory(roomId, 'Verify Me', 'Player');
        expect(history[0].verified_at).toBeTruthy();
        expect(history[0].verified_by).toBeTruthy();
    });
});
