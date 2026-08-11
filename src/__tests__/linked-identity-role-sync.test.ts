import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityLinkService } from '../services/IdentityLinkService.js';
import { AdminService } from '../services/AdminService.js';
import { RoomAccessService } from '../services/RoomAccessService.js';
import { BanService } from '../services/BanService.js';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';
import type { TokenPayload } from '../api/auth.js';

/**
 * Field report fix (v2.9x.0) — a user whose Discord account is a room admin
 * logged in via their LINKED Google account and got no "Room admin"
 * affordances (though logging in via Discord directly worked). Root cause:
 * `AdminService.getRoomsForDiscordUser` and the membership/pending legs in
 * `RoomAccessService` only ever queried the exact id presented at login, not
 * the full linked-identity candidate set `BanService` already proved out for
 * ban enforcement.
 *
 * This suite covers:
 *   (a) `IdentityLinkService.expandCandidates` — the graph-walk moved here
 *       from `BanService.expandIdentityCandidates`, which now delegates.
 *   (b) `AdminService.getRoomsForDiscordUser` — link-aware admin-grant lookup.
 *   (c) `RoomAccessService.getViewerStatus` — membership/admin resolution
 *       across a link, from either side.
 */

const GOOGLE_ID = 'google:sub-9999';
const DISCORD_ID = '999988887777666655';
const UNLINKED_ID = '111100002222333344';

describe('IdentityLinkService.expandCandidates', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('an unlinked id expands to just itself', async () => {
        const candidates = await IdentityLinkService.expandCandidates(UNLINKED_ID);
        expect(candidates).toEqual(new Set([UNLINKED_ID]));
    });

    it('the google (non-canonical) side expands to {alias, canonical}', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const candidates = await IdentityLinkService.expandCandidates(GOOGLE_ID);
        expect(candidates).toEqual(new Set([GOOGLE_ID, DISCORD_ID]));
    });

    it('the canonical (Discord) side expands to the identical set as the alias side', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const fromCanonical = await IdentityLinkService.expandCandidates(DISCORD_ID);
        const fromAlias = await IdentityLinkService.expandCandidates(GOOGLE_ID);
        expect(fromCanonical).toEqual(fromAlias);
        expect(fromCanonical).toEqual(new Set([DISCORD_ID, GOOGLE_ID]));
    });

    it('multiple aliases linked to the same canonical all appear in the expansion of any one of them', async () => {
        await IdentityLinkService.createLink('google:a', DISCORD_ID);
        await IdentityLinkService.createLink('google:b', DISCORD_ID);
        const candidates = await IdentityLinkService.expandCandidates('google:a');
        expect(candidates).toEqual(new Set(['google:a', 'google:b', DISCORD_ID]));
    });

    it('BanService.expandIdentityCandidates delegates and returns the same set as an array', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const viaBanService = await BanService.expandIdentityCandidates(GOOGLE_ID);
        const viaIdentityLink = await IdentityLinkService.expandCandidates(GOOGLE_ID);
        expect(new Set(viaBanService)).toEqual(viaIdentityLink);
    });
});

describe('AdminService.getRoomsForDiscordUser — link-aware', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
    });

    it('finds a grant recorded on the google alias when queried by the linked Discord id', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        // Simulate a grant added directly against the (already-linked)
        // google id — e.g. via POST /:roomId/admins/discord accepting a
        // pasted google id, which createLink never retroactively normalizes.
        await db.run(
            `INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'admin')`,
            roomId, GOOGLE_ID,
        );

        const rooms = await AdminService.getRoomsForDiscordUser(DISCORD_ID);
        expect(rooms).toContain(roomId);
    });

    it('finds a grant recorded on the canonical Discord id when queried by the linked google alias', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        await AdminService.addRoomDiscordAdmin(roomId, DISCORD_ID, 'admin');

        const rooms = await AdminService.getRoomsForDiscordUser(GOOGLE_ID);
        expect(rooms).toContain(roomId);
    });

    it('does not return rooms for an unrelated id', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        await AdminService.addRoomDiscordAdmin(roomId, DISCORD_ID, 'admin');

        const rooms = await AdminService.getRoomsForDiscordUser(UNLINKED_ID);
        expect(rooms).not.toContain(roomId);
    });

    it('returns each room only once (DISTINCT) even though the candidate set has two ids', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        // Rows on BOTH sides of the link for the same room (a pre-link grant
        // on the google id that the link's INSERT-OR-IGNORE re-key skipped
        // because the snowflake already held its own row there too).
        await db.run(`INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'owner')`, roomId, DISCORD_ID);

        const rooms = await AdminService.getRoomsForDiscordUser(GOOGLE_ID);
        expect(rooms.filter(r => r === roomId)).toHaveLength(1);
    });
});

describe('RoomAccessService.getViewerStatus — link-aware membership/admin legs', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
    });

    function tokenFor(discordId: string): TokenPayload {
        return { role: 'player', gameRoomIds: [], discordId };
    }

    it('resolves \'admin\' when the admin grant sits on the OTHER side of the link from the token id', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        await db.run(`INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'admin')`, roomId, GOOGLE_ID);

        // Token carries the canonical Discord id (a normal post-link Discord
        // login) — the grant is on the google alias.
        const status = await RoomAccessService.getViewerStatus(tokenFor(DISCORD_ID), roomId);
        expect(status).toBe('admin');
    });

    it('resolves \'member\' when the room_members row sits on the OTHER side of the link from the token id', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        // A membership row written before the link (or via some path that
        // doesn't normalize) under the google id.
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, GOOGLE_ID, roomId);

        const status = await RoomAccessService.getViewerStatus(tokenFor(DISCORD_ID), roomId);
        expect(status).toBe('member');
    });

    it('resolves \'member\' from the google-alias token when the membership row sits on the canonical Discord id', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, DISCORD_ID, roomId);

        const status = await RoomAccessService.getViewerStatus(tokenFor(GOOGLE_ID), roomId);
        expect(status).toBe('member');
    });

    it('resolves \'none\' for an unrelated token id', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, GOOGLE_ID, roomId);

        const status = await RoomAccessService.getViewerStatus(tokenFor(UNLINKED_ID), roomId);
        expect(status).toBe('none');
    });

    it('canViewRoom mirrors getViewerStatus for the cross-link membership case', async () => {
        await IdentityLinkService.createLink(GOOGLE_ID, DISCORD_ID);
        const db = await getDatabase();
        await db.run(`INSERT INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, GOOGLE_ID, roomId);

        const canView = await RoomAccessService.canViewRoom(tokenFor(DISCORD_ID), roomId);
        expect(canView).toBe(true);
    });
});
