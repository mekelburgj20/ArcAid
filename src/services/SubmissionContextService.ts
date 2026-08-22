import type { SubmissionContext } from '../types/index.js';

export type SubmissionContextInput = {
    roomId?: string | null;
    tournamentId?: string | null;
    userId?: string | null;
    anonymousName?: string | null;
    mergedFromAnonymousIdentityId?: number | null;
};

const IMMUTABLE_FIELDS: readonly string[] = [
    'submitted_from_room_id',
    'submitted_during_tournament_id',
    'submitted_by_user_id',
    'submitted_by_anonymous_name',
    'merged_from_anonymous_identity_id',
];

export const SUBMISSION_CONTEXT_COLUMNS = IMMUTABLE_FIELDS;

const ANON_USER_SENTINELS = new Set(['ANON', 'SYSTEM', 'COMMUNITY', '']);

export function normalizeSubmitterUserId(discordUserId?: string | null): string | null {
    if (!discordUserId) return null;
    if (ANON_USER_SENTINELS.has(discordUserId.toUpperCase())) return null;
    // v2.125.2: `iscored:<name>` is the sync poller's synthetic "nobody owns this
    // row" id. It must never land in submitted_by_user_id — every profile
    // resolver keys on that column first and only falls back to user_mappings
    // when it is NULL, so a synthetic value there hid the linked user's avatar
    // and display name (Wyo / DennisB on rtx_pinball, 2026-08-21).
    if (discordUserId.toLowerCase().startsWith('iscored:')) return null;
    return discordUserId;
}

export class SubmissionContextService {
    static build(input: SubmissionContextInput): SubmissionContext {
        return {
            submittedFromRoomId: input.roomId ?? null,
            submittedDuringTournamentId: input.tournamentId ?? null,
            submittedByUserId: input.userId ?? null,
            submittedByAnonymousName: input.anonymousName ?? null,
            mergedFromAnonymousIdentityId: input.mergedFromAnonymousIdentityId ?? null,
        };
    }

    static toRowValues(ctx: SubmissionContext): [string | null, string | null, string | null, string | null, number | null] {
        return [
            ctx.submittedFromRoomId,
            ctx.submittedDuringTournamentId,
            ctx.submittedByUserId,
            ctx.submittedByAnonymousName,
            ctx.mergedFromAnonymousIdentityId,
        ];
    }

    static columnList(): string {
        return IMMUTABLE_FIELDS.join(', ');
    }

    static placeholders(): string {
        return IMMUTABLE_FIELDS.map(() => '?').join(', ');
    }

    static assertNotMutating(updateSql: string): void {
        const lowered = updateSql.toLowerCase();
        if (!lowered.includes('update ')) return;
        for (const field of IMMUTABLE_FIELDS) {
            const re = new RegExp(`\\bset\\b[\\s\\S]*\\b${field}\\s*=`, 'i');
            if (re.test(updateSql)) {
                throw new Error(
                    `SubmissionContextService: attempt to UPDATE immutable context field "${field}". ` +
                    `These fields may only be written on INSERT or mutated via merge operations.`
                );
            }
        }
    }
}
