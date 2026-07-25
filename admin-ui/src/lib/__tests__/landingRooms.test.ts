import { describe, it, expect } from 'vitest';
import { splitLandingRooms, type PublicRoom, type MemberRoom } from '../landingRooms';

function publicRoom(overrides: Partial<PublicRoom> = {}): PublicRoom {
  return {
    id: 'room-1',
    slug: 'rtx_pinball',
    name: 'RTX Pinball',
    description: 'A room',
    is_public: true,
    logo_url: '/logo.png',
    activeGames: 3,
    activePlayers: 12,
    discordInviteUrl: 'https://discord.gg/xyz',
    ...overrides,
  };
}

function memberRoom(overrides: Partial<MemberRoom> = {}): MemberRoom {
  return {
    roomId: 'room-1',
    name: 'RTX Pinball',
    slug: 'rtx_pinball',
    logoUrl: '/logo.png',
    joinedAt: '2026-01-01T00:00:00Z',
    source: 'submission',
    lastActivityAt: null,
    ...overrides,
  };
}

describe('splitLandingRooms', () => {
  it('dedupes: a room the user belongs to is removed from the public grid', () => {
    const pub = [publicRoom({ id: 'room-1' }), publicRoom({ id: 'room-2', slug: 'other', name: 'Other Room' })];
    const mine = [memberRoom({ roomId: 'room-1' })];

    const { myRooms, publicRooms } = splitLandingRooms(pub, mine);

    expect(myRooms.map(r => r.id)).toEqual(['room-1']);
    expect(publicRooms.map(r => r.id)).toEqual(['room-2']);
  });

  it('enriches My Game Rooms cards from the public list when the room is listed there', () => {
    const pub = [publicRoom({ id: 'room-1', activeGames: 5, activePlayers: 40 })];
    const mine = [memberRoom({ roomId: 'room-1' })];

    const { myRooms } = splitLandingRooms(pub, mine);

    expect(myRooms[0].activeGames).toBe(5);
    expect(myRooms[0].activePlayers).toBe(40);
  });

  it('gracefully degrades member rooms absent from the public list (unlisted/private rooms)', () => {
    const pub: PublicRoom[] = [];
    const mine = [memberRoom({ roomId: 'private-room', name: 'Private Room', slug: 'private', logoUrl: null })];

    const { myRooms, publicRooms } = splitLandingRooms(pub, mine);

    expect(myRooms).toHaveLength(1);
    expect(myRooms[0]).toMatchObject({ id: 'private-room', name: 'Private Room', slug: 'private', logoUrl: null });
    expect(myRooms[0].activeGames).toBeUndefined();
    expect(myRooms[0].activePlayers).toBeUndefined();
    expect(publicRooms).toHaveLength(0);
  });

  it('returns everything as public when the user has no rooms', () => {
    const pub = [publicRoom({ id: 'room-1' }), publicRoom({ id: 'room-2' })];
    const { myRooms, publicRooms } = splitLandingRooms(pub, []);

    expect(myRooms).toHaveLength(0);
    expect(publicRooms).toHaveLength(2);
  });
});
