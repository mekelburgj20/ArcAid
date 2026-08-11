import { describe, it, expect } from 'vitest';
import { initDatabase, getDatabase, _resetForTesting } from '../database/database.js';

/**
 * Single-flight init guard (v2.99.2, flake-hunt fix).
 *
 * Pre-guard, two overlapping initDatabase()/getDatabase() calls could each
 * run the full schema+migration sequence (`db` is assigned mid-init, right
 * after open() and before the migrations), which is the root mechanism of
 * the "cannot start a transaction within a transaction" test-flake family:
 * an untracked background chain's late getDatabase() landing during a test
 * reset raced the next test's setupTestDb(). The primary fix registered the
 * escaped chains with trackBackground (rooms.ts syncScoreToIScored sites);
 * this guard is the belt-and-suspenders that makes any FUTURE escape settle
 * on the one shared init instead of detonating it.
 */
describe('database init single-flight (v2.99.2)', () => {
    it('concurrent getDatabase/initDatabase calls share one init and return the same handle', async () => {
        await _resetForTesting();
        const [a, b, c, d] = await Promise.all([
            getDatabase(),
            initDatabase(),
            getDatabase(),
            initDatabase(),
        ]);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(c).toBe(d);
        // The handle is fully migrated and usable.
        await a.get('SELECT 1');
    });
});
