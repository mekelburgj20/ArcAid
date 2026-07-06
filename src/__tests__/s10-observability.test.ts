import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { OpsAlertService } from '../services/OpsAlertService.js';
import { SettingsService } from '../services/SettingsService.js';
import { ScoreSyncPoller } from '../engine/ScoreSyncPoller.js';
import { TournamentEngine } from '../engine/TournamentEngine.js';
import { sendDirectMessage } from '../utils/discord.js';
import { IScoredSessionRegistry } from '../engine/IScoredSessionRegistry.js';
import type { IScoredClient } from '../engine/IScoredClient.js';

// Preserve the rest of discord.js (the engine tests below rely on the real
// resolveAnnouncementChannelId etc.) and stub ONLY the DM primitive that
// OpsAlertService uses.
vi.mock('../utils/discord.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/discord.js')>()),
    sendDirectMessage: vi.fn(async () => true),
}));

afterEach(() => {
    // No global restoreMocks in vitest.config — clean spies so they don't leak
    // across tests / files (files run sequentially, share the in-memory DB).
    vi.restoreAllMocks();
});

// Fake iScored client so maintenance runs (which resolve env-fallback creds and
// enter withSession) don't launch Playwright. Mirrors the S2 harness seam.
const fakeIScoredClient = { connect: async () => {}, disconnect: async () => {} } as unknown as IScoredClient;

describe('OpsAlertService — operator alerting (S10)', () => {
    beforeEach(() => {
        vi.mocked(sendDirectMessage).mockReset();
        vi.mocked(sendDirectMessage).mockResolvedValue(true);
    });

    it('is inert when OPS_ALERT_ENABLED is not "true"', async () => {
        vi.spyOn(SettingsService, 'get').mockResolvedValue(null);
        await OpsAlertService.sendOperatorAlert('boom');
        expect(sendDirectMessage).not.toHaveBeenCalled();
    });

    it('sends a DM when enabled and a recipient is configured', async () => {
        vi.spyOn(SettingsService, 'get').mockImplementation(async (key: string) =>
            key === 'OPS_ALERT_ENABLED' ? 'true' : key === 'OPS_ALERT_DISCORD_USER_ID' ? '123' : null,
        );
        await OpsAlertService.sendOperatorAlert('boom');
        expect(sendDirectMessage).toHaveBeenCalledTimes(1);
        expect(vi.mocked(sendDirectMessage).mock.calls[0][0]).toBe('123');
    });

    it('does not send when enabled but no recipient is configured', async () => {
        vi.spyOn(SettingsService, 'get').mockImplementation(async (key: string) =>
            key === 'OPS_ALERT_ENABLED' ? 'true' : null,
        );
        await OpsAlertService.sendOperatorAlert('boom');
        expect(sendDirectMessage).not.toHaveBeenCalled();
    });

    it('never throws even if the DM send rejects', async () => {
        vi.spyOn(SettingsService, 'get').mockImplementation(async (key: string) =>
            key === 'OPS_ALERT_ENABLED' ? 'true' : key === 'OPS_ALERT_DISCORD_USER_ID' ? '123' : null,
        );
        vi.mocked(sendDirectMessage).mockRejectedValueOnce(new Error('discord down'));
        await expect(OpsAlertService.sendOperatorAlert('boom')).resolves.toBeUndefined();
    });
});

describe('ScoreSyncPoller — status + operator-alert debounce (S10)', () => {
    // Access the extracted private state-transition helpers via the same cast
    // pattern the existing harness uses for cleanupCronMatchesNow.
    const poller = () => ScoreSyncPoller.getInstance() as unknown as {
        recordAccountFailure(name: string, msg: string): number;
        recordAccountSuccess(name: string): void;
        getStatus(): {
            running: boolean; paused: boolean;
            accounts: Array<{ name: string; consecutiveErrors: number; lastError: string | null; lastSuccessAt: number | null }>;
        };
    };

    it('getStatus() exposes global + per-account shape', () => {
        const s = ScoreSyncPoller.getInstance().getStatus();
        expect(s).toHaveProperty('running');
        expect(s).toHaveProperty('paused');
        expect(s).toHaveProperty('lastPollAt');
        expect(Array.isArray(s.accounts)).toBe(true);
    });

    it('fires the operator alert once on crossing the threshold, then re-arms after recovery', () => {
        const alertSpy = vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        const p = poller();
        const acct = `acct-${crypto.randomUUID()}`;

        // 4 failures — below the threshold of 5: no alert yet.
        for (let i = 0; i < 4; i++) p.recordAccountFailure(acct, 'iScored 500');
        expect(alertSpy).not.toHaveBeenCalled();

        // 5th failure crosses the threshold: exactly one alert.
        p.recordAccountFailure(acct, 'iScored 500');
        expect(alertSpy).toHaveBeenCalledTimes(1);

        // Further failures during the SAME outage do not re-alert (debounced).
        p.recordAccountFailure(acct, 'iScored 500');
        p.recordAccountFailure(acct, 'iScored 500');
        expect(alertSpy).toHaveBeenCalledTimes(1);

        // getStatus reflects the failing account.
        const failing = p.getStatus().accounts.find(a => a.name === acct)!;
        expect(failing.consecutiveErrors).toBe(7);
        expect(failing.lastError).toBe('iScored 500');

        // Recovery clears state and sends a one-time "recovered" note (alert #2),
        // re-arming the alert.
        p.recordAccountSuccess(acct);
        expect(alertSpy).toHaveBeenCalledTimes(2);
        const recovered = p.getStatus().accounts.find(a => a.name === acct)!;
        expect(recovered.consecutiveErrors).toBe(0);
        expect(recovered.lastError).toBeNull();
        expect(recovered.lastSuccessAt).not.toBeNull();

        // A fresh outage re-alerts on crossing again (alert #3).
        for (let i = 0; i < 5; i++) p.recordAccountFailure(acct, 'again');
        expect(alertSpy).toHaveBeenCalledTimes(3);
    });
});

describe('TournamentEngine — maintenance-run trail (S10)', () => {
    beforeEach(() => {
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(() => fakeIScoredClient);
    });
    afterEach(async () => {
        IScoredSessionRegistry.getInstance().setClientFactoryForTests(null);
        await IScoredSessionRegistry.getInstance().shutdown();
    });

    it('records a "skipped" row when the tournament is paused', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('mr-paused', 'MR Paused');
        const tId = await createTestTournament(roomId, { name: 'Paused T' });
        await db.run('UPDATE tournaments SET is_active = 0 WHERE id = ?', tId);

        await TournamentEngine.getInstance().runMaintenance(tId);

        const row = await db.get(
            'SELECT outcome, summary, game_room_id FROM maintenance_runs WHERE tournament_id = ?',
            tId,
        );
        expect(row).toBeTruthy();
        expect(row.outcome).toBe('skipped');
        expect(row.summary).toMatch(/paused/i);
        expect(row.game_room_id).toBe(roomId);
    });

    it('records a "skipped" row when there are no active or queued games', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('mr-empty', 'MR Empty');
        const tId = await createTestTournament(roomId, { name: 'Empty T' }); // is_active=1, no games

        await TournamentEngine.getInstance().runMaintenance(tId);

        const row = await db.get(
            'SELECT outcome, summary FROM maintenance_runs WHERE tournament_id = ?',
            tId,
        );
        expect(row).toBeTruthy();
        expect(row.outcome).toBe('skipped');
        expect(row.summary).toMatch(/no active or queued/i);
    });

    it('records an "error" row and rethrows when the run throws', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const badId = crypto.randomUUID(); // no such tournament -> runMaintenanceWork throws

        await expect(TournamentEngine.getInstance().runMaintenance(badId)).rejects.toThrow();

        const row = await db.get(
            'SELECT outcome FROM maintenance_runs WHERE tournament_id = ?',
            badId,
        );
        expect(row).toBeTruthy();
        expect(row.outcome).toBe('error');
    });
});
