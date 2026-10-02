import { describe, it, expect } from 'vitest';
import { CreateTournamentSchema, UpdateTournamentSchema } from '../api/schemas.js';

/**
 * `max_active_games` ceiling (v2.158.1).
 *
 * Owner, 2026-10-01: "it seems there is a max limit of 10 tables per
 * tournament right now. I want that cap removed. I don't want to impose a
 * limit. Unless one is needed to prevent abuse in which case maybe 100."
 *
 * The UI stepper has no ceiling of its own, so the 10 lived only in the Zod
 * schema and surfaced as a 400 on save. A ceiling is kept at 100 purely as a
 * typo guard: every active slot is an iScored board, a Discord embed and a
 * maintenance pass.
 */
const base = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Big Rotation',
    type: 'BR',
    cadence: { cron: '0 0 * * *', autoRotate: true, autoLock: true },
};

describe('max_active_games ceiling', () => {
    it('accepts more than ten active tables (the old ceiling)', () => {
        expect(CreateTournamentSchema.parse({ ...base, max_active_games: 11 }).max_active_games).toBe(11);
        expect(CreateTournamentSchema.parse({ ...base, max_active_games: 100 }).max_active_games).toBe(100);
        const { id: _id, ...update } = base;
        expect(UpdateTournamentSchema.parse({ ...update, max_active_games: 42 }).max_active_games).toBe(42);
    });

    it('still refuses an absurd value and zero', () => {
        expect(CreateTournamentSchema.safeParse({ ...base, max_active_games: 101 }).success).toBe(false);
        expect(CreateTournamentSchema.safeParse({ ...base, max_active_games: 0 }).success).toBe(false);
    });
});
