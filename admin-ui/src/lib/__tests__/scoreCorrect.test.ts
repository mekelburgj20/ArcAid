import { describe, it, expect } from 'vitest';
import { canCorrectRow } from '../scoreCorrect';
import type { ViewerClaims } from '../viewerClaims';

/**
 * The pencil gate. Owner ruling 2026-10-25: a Witness / cabinet score is never
 * editable (admins included), and a Sanctioned or Limited-attempts tournament
 * closes the submitter's self-correction.
 */
const ROOM = 'room-1';
const owner: ViewerClaims = { role: 'player', gameRoomIds: [], discordId: 'disc-ada' };
const admin: ViewerClaims = { role: 'room_admin', gameRoomIds: [ROOM], discordId: 'disc-admin' };
const superAdmin: ViewerClaims = { role: 'super_admin', gameRoomIds: [], discordId: 'disc-super' };

const typed = { history_id: 7, source: 'tournament', submitted_by_user_id: 'disc-ada' };

describe('canCorrectRow', () => {
  it('the submitter may correct a typed score on an ACTIVE, open-play board', () => {
    expect(canCorrectRow(typed, owner, ROOM, 'ACTIVE')).toBe(true);
    expect(canCorrectRow(typed, owner, ROOM, 'ACTIVE', false)).toBe(true);
  });

  it('a Sanctioned / Limited-attempts board closes the submitter tier but not the admin tier', () => {
    expect(canCorrectRow(typed, owner, ROOM, 'ACTIVE', true)).toBe(false);
    expect(canCorrectRow(typed, admin, ROOM, 'ACTIVE', true)).toBe(true);
  });

  it.each(['vpx', 'atgames'])('a %s (Witness) score is not correctable by anyone', (source) => {
    const row = { ...typed, source };
    expect(canCorrectRow(row, owner, ROOM, 'ACTIVE')).toBe(false);
    expect(canCorrectRow(row, admin, ROOM, 'ACTIVE')).toBe(false);
    expect(canCorrectRow(row, superAdmin, ROOM, 'COMPLETED')).toBe(false);
  });
});
