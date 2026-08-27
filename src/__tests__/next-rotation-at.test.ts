import { describe, it, expect } from 'vitest';
import { nextRotationIso } from '../utils/cronUtils.js';

/**
 * `nextRotationIso` powers `nextRotationAt` on `GET /:roomId/pick-status`'s
 * tournaments array (Picks-queue UX redesign, F1's "rotates <when>"
 * subtitle). Extracted as a standalone helper (rather than tested only
 * through the route) per the same reasoning `calloutActions.ts`'s
 * `renderTimeLeft` already established: parseable cron in → parseable
 * future ISO out, no cron → null, never a throw.
 */
describe('nextRotationIso', () => {
    it('a cron cadence yields a parseable future ISO timestamp', () => {
        const now = new Date('2026-08-27T12:00:00Z');
        const cadence = JSON.stringify({ cron: '0 22 * * *', timezone: 'America/Chicago' });
        const iso = nextRotationIso(cadence, now);

        expect(iso).not.toBeNull();
        const next = new Date(iso!);
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        // Round-trips cleanly.
        expect(next.toISOString()).toBe(iso);
    });

    it('a cadence with no cron (Live Events) yields null', () => {
        expect(nextRotationIso(JSON.stringify({ timezone: 'America/Chicago' }))).toBeNull();
        expect(nextRotationIso('{}')).toBeNull();
    });

    it('malformed cadence JSON yields null rather than throwing', () => {
        expect(nextRotationIso('not json')).toBeNull();
        expect(nextRotationIso(null)).toBeNull();
        expect(nextRotationIso(undefined)).toBeNull();
    });

    it('an unparseable cron expression yields null rather than throwing', () => {
        const cadence = JSON.stringify({ cron: 'not a cron', timezone: 'America/Chicago' });
        expect(nextRotationIso(cadence)).toBeNull();
    });
});
