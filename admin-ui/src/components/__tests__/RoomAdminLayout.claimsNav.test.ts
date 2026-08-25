import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guard for the v2.137.2 fix: the Identity Claims nav must reach OPEN rooms.
 *
 * The "Identity Claims" nav item only renders when its pending COUNT is > 0.
 * That count used to be fetched inside a `useEffect` that early-returned unless
 * `join_policy === 'approval'`, so on an open room the count stayed 0, the nav
 * item never appeared, and pending claims were unreachable — two real claims
 * sat stuck in an open room for a day (2026-08-25). Claims are orthogonal to
 * join policy; only JOIN REQUESTS are approval-only.
 *
 * A full render harness for this is disproportionate; this encodes the exact
 * regression structurally, the same way `playerApi.test.ts` guards its rule.
 */
describe('RoomAdminLayout — identity-claims count is not approval-gated', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../RoomAdminLayout.tsx'), 'utf8',
    );

    it('fetches the identity-claims count', () => {
        expect(src).toMatch(/admin\/identity-claims\/count/);
    });

    it('does not place an approval early-return before the claims-count fetch in its effect', () => {
        // Look at the slice from the effect that fetches the count back to the
        // nearest useEffect opening; an unconditional `!== 'approval') return`
        // there is precisely the bug.
        const idx = src.indexOf('admin/identity-claims/count');
        expect(idx).toBeGreaterThan(-1);
        const effectStart = src.lastIndexOf('useEffect', idx);
        const slice = src.slice(effectStart, idx);
        expect(
            /!==\s*['"]approval['"]\s*\)\s*return/.test(slice),
            'the identity-claims count fetch must NOT be gated behind `join_policy !== "approval") return`',
        ).toBe(false);
    });

    it('still gates the JOIN-REQUESTS count on approval policy', () => {
        // The join-requests count is legitimately approval-only; make sure the
        // fix did not accidentally start polling it on every room.
        const idx = src.indexOf('admin/join-requests/count');
        expect(idx).toBeGreaterThan(-1);
        const before = src.slice(Math.max(0, idx - 400), idx);
        expect(before).toMatch(/join_policy\s*===\s*['"]approval['"]/);
    });
});
