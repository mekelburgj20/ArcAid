import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { pollPickedRefusal } from '../services/PickQueueService.js';
import { pickgame } from '../discord/commands/pickgame.js';

/**
 * Pick by poll (ADR 0026): a poll_picks tournament refuses player picks on
 * both paths (shared predicate `pollPickedRefusal`), 409 POLL_PICKED on web.
 */
async function pollTournament(slug: string, poll: number) {
    const roomId = await createTestRoom(slug, 'Poll Room');
    const tid = await createTestTournament(roomId, { name: 'Weekly Poll' });
    const db = await getDatabase();
    await db.run('UPDATE tournaments SET poll_picks = ? WHERE id = ?', poll, tid);
    return { roomId, tid };
}

describe('pollPickedRefusal', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('is null for an ordinary tournament and for an unknown id', async () => {
        const { tid } = await pollTournament('poll-off', 0);
        expect(await pollPickedRefusal(tid)).toBeNull();
        expect(await pollPickedRefusal('nope')).toBeNull();
    });

    it('names the tournament and the room lobby for a poll-picked one', async () => {
        const { tid } = await pollTournament('poll-on', 1);
        const msg = await pollPickedRefusal(tid);
        expect(msg).toContain('**Weekly Poll** picks its tables by community poll.');
        expect(msg).toContain('/poll-on/lobby');
    });
});

describe('POST /:roomId/pick-game on a poll-picked tournament', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('answers 409 POLL_PICKED before any write', async () => {
        const { roomId, tid } = await pollTournament('poll-web', 1);
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        const token = signToken({ role: 'player', discordId: '111111111111111111', username: 'P' } as never);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/pick-game`)
            .set('Authorization', `Bearer ${token}`)
            .send({ tournamentId: tid, gameName: 'Anything' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('POLL_PICKED');
        expect(res.body.error).toContain('community poll');
        const db = await getDatabase();
        const queued = await db.get(`SELECT COUNT(*) AS c FROM games WHERE tournament_id = ?`, tid);
        expect(queued.c).toBe(0);
    });
});

describe('/pick-game on a poll-picked tournament', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('replies with the refusal and writes nothing', async () => {
        const { tid } = await pollTournament('poll-discord', 1);
        const replies: unknown[] = [];
        const interaction = {
            user: { id: '222222222222222222' },
            guildId: 'g1',
            options: {
                getString: (n: string) => (n === 'tournament' ? 'Weekly Poll' : n === 'game' ? 'Some Game' : null),
                getBoolean: () => null,
                getUser: () => null,
            },
            deferReply: async () => {},
            editReply: async (p: unknown) => { replies.push(p); return p; },
            reply: async (p: unknown) => { replies.push(p); return p; },
        } as never;
        await pickgame.execute(interaction);
        expect(String(replies[replies.length - 1])).toContain('picks its tables by community poll');
        const db = await getDatabase();
        const c = await db.get(`SELECT COUNT(*) AS c FROM games WHERE tournament_id = ?`, tid);
        expect(c.c).toBe(0);
    });
});
