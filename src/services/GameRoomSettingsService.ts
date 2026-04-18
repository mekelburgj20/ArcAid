import { getDatabase } from '../database/database.js';
import { OrphanService } from './OrphanService.js';
import { PickAwardGate, ENABLE_GAME_PICK_AWARD } from './PickAwardGate.js';

// Settings that trigger side-effects on change. Kept explicit so new settings must
// opt in deliberately.
const REQUIRE_LOGIN_KEY = 'REQUIRE_DISCORD_LOGIN';

async function invalidateLeaderboardCaches(_gameRoomId: string): Promise<void> {
    // After an orphan flip, regeneration must happen across room + global caches so
    // orphaned rows vanish / return on next read. Both services only expose a broad
    // invalidate — acceptable because flips are admin-initiated and infrequent.
    try {
        const { LeaderboardService } = await import('./LeaderboardService.js');
        await LeaderboardService.invalidateAll();
    } catch { /* best-effort */ }
    try {
        const { GlobalLeaderboardService } = await import('./GlobalLeaderboardService.js');
        await GlobalLeaderboardService.invalidateAll();
    } catch { /* best-effort */ }
}

export class GameRoomSettingsService {
    static async get(gameRoomId: string, key: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
        return row?.value ?? null;
    }

    static async getAll(gameRoomId: string): Promise<Record<string, string>> {
        const db = await getDatabase();
        const rows = await db.all(
            'SELECT key, value FROM game_room_settings WHERE game_room_id = ?',
            gameRoomId
        );
        return rows.reduce((acc: Record<string, string>, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    }

    static async set(gameRoomId: string, key: string, value: string): Promise<void> {
        const db = await getDatabase();
        // Capture previous value BEFORE the write so flip logic can diff.
        const prev = key === REQUIRE_LOGIN_KEY
            ? await GameRoomSettingsService.get(gameRoomId, key)
            : null;
        await db.run(
            'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
            gameRoomId, key, value
        );
        if (key === REQUIRE_LOGIN_KEY) {
            await OrphanService.handleRequireLoginFlip(gameRoomId, prev, value);
            await invalidateLeaderboardCaches(gameRoomId);
        }
        if (key === ENABLE_GAME_PICK_AWARD) {
            // Sprint 13: close the 5s staleness window after admin toggles.
            PickAwardGate.invalidate(gameRoomId);
        }
    }

    static async saveMany(gameRoomId: string, settings: Record<string, string>): Promise<void> {
        const db = await getDatabase();
        // Capture previous REQUIRE_LOGIN value before any writes so flip semantics
        // are correct even if the bulk save also touches other keys.
        const prevRequireLogin = REQUIRE_LOGIN_KEY in settings
            ? await GameRoomSettingsService.get(gameRoomId, REQUIRE_LOGIN_KEY)
            : null;
        for (const [key, value] of Object.entries(settings)) {
            if (value === '') continue;
            await db.run(
                'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
                gameRoomId, key, value
            );
        }
        if (REQUIRE_LOGIN_KEY in settings) {
            await OrphanService.handleRequireLoginFlip(gameRoomId, prevRequireLogin, settings[REQUIRE_LOGIN_KEY]!);
            await invalidateLeaderboardCaches(gameRoomId);
        }
        if (ENABLE_GAME_PICK_AWARD in settings) {
            PickAwardGate.invalidate(gameRoomId);
        }
    }

    static async delete(gameRoomId: string, key: string): Promise<void> {
        const db = await getDatabase();
        const prev = key === REQUIRE_LOGIN_KEY
            ? await GameRoomSettingsService.get(gameRoomId, key)
            : null;
        await db.run(
            'DELETE FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
        if (key === REQUIRE_LOGIN_KEY && prev === 'true') {
            // Deleting REQUIRE_DISCORD_LOGIN is equivalent to turning it off.
            await OrphanService.handleRequireLoginFlip(gameRoomId, prev, 'false');
            await invalidateLeaderboardCaches(gameRoomId);
        }
        if (key === ENABLE_GAME_PICK_AWARD) {
            PickAwardGate.invalidate(gameRoomId);
        }
    }
}
