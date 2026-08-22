import { describe, it, expect } from 'vitest';
import {
    SubmissionContextService,
    normalizeSubmitterUserId,
} from '../services/SubmissionContextService.js';

describe('SubmissionContextService', () => {
    describe('normalizeSubmitterUserId', () => {
        it('returns null for the sync poller iscored:* synthetic ids (v2.125.2)', () => {
            expect(normalizeSubmitterUserId('iscored:Wyo')).toBeNull();
            expect(normalizeSubmitterUserId('ISCORED:wyo')).toBeNull();
            expect(normalizeSubmitterUserId('310966414196604928')).toBe('310966414196604928');
        });

        it('returns null for anon sentinels', () => {
            expect(normalizeSubmitterUserId('ANON')).toBeNull();
            expect(normalizeSubmitterUserId('anon')).toBeNull();
            expect(normalizeSubmitterUserId('SYSTEM')).toBeNull();
            expect(normalizeSubmitterUserId('COMMUNITY')).toBeNull();
            expect(normalizeSubmitterUserId('')).toBeNull();
            expect(normalizeSubmitterUserId(null)).toBeNull();
            expect(normalizeSubmitterUserId(undefined)).toBeNull();
        });

        it('returns the id for real Discord user ids', () => {
            expect(normalizeSubmitterUserId('123456789012345678')).toBe('123456789012345678');
        });
    });

    describe('assertNotMutating', () => {
        it('throws when UPDATE sets submitted_from_room_id', () => {
            expect(() =>
                SubmissionContextService.assertNotMutating(
                    `UPDATE submissions SET submitted_from_room_id = 'abc' WHERE id = 'x'`
                )
            ).toThrow(/submitted_from_room_id/);
        });

        it('throws when UPDATE sets submitted_by_user_id', () => {
            expect(() =>
                SubmissionContextService.assertNotMutating(
                    `UPDATE global_scores SET submitted_by_user_id = '1' WHERE id = 'x'`
                )
            ).toThrow(/submitted_by_user_id/);
        });

        it('throws when UPDATE sets merged_from_anonymous_identity_id', () => {
            expect(() =>
                SubmissionContextService.assertNotMutating(
                    `UPDATE community_scores SET merged_from_anonymous_identity_id = 1 WHERE id = 2`
                )
            ).toThrow(/merged_from_anonymous_identity_id/);
        });

        it('allows UPDATE on unrelated fields', () => {
            expect(() =>
                SubmissionContextService.assertNotMutating(
                    `UPDATE submissions SET score = 1000 WHERE id = 'x'`
                )
            ).not.toThrow();
        });

        it('allows INSERT statements', () => {
            expect(() =>
                SubmissionContextService.assertNotMutating(
                    `INSERT INTO submissions (submitted_from_room_id) VALUES (?)`
                )
            ).not.toThrow();
        });
    });

    describe('build/toRowValues', () => {
        it('round-trips input through build and toRowValues', () => {
            const ctx = SubmissionContextService.build({
                roomId: 'room-1',
                tournamentId: 'tourn-1',
                userId: 'user-1',
                anonymousName: null,
                mergedFromAnonymousIdentityId: null,
            });
            expect(SubmissionContextService.toRowValues(ctx)).toEqual([
                'room-1',
                'tourn-1',
                'user-1',
                null,
                null,
            ]);
        });

        it('defaults missing fields to null', () => {
            const ctx = SubmissionContextService.build({});
            expect(SubmissionContextService.toRowValues(ctx)).toEqual([null, null, null, null, null]);
        });
    });

    describe('column metadata helpers', () => {
        it('placeholders() matches columnList() field count', () => {
            const cols = SubmissionContextService.columnList().split(',').length;
            const placeholders = SubmissionContextService.placeholders().split(',').length;
            expect(placeholders).toBe(cols);
            expect(cols).toBe(5);
        });
    });
});
