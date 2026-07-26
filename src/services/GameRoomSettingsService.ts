import { getDatabase } from '../database/database.js';
import { OrphanService } from './OrphanService.js';
import { JoinPolicyService } from './JoinPolicyService.js';
import { PickAwardGate, ENABLE_GAME_PICK_AWARD } from './PickAwardGate.js';
import { logInfo } from '../utils/logger.js';
import {
    decryptSecret,
    encryptSecret,
    isEncrypted,
    isEncryptedKey,
    isMask,
} from '../utils/secrets.js';

// Settings that trigger side-effects on change. Kept explicit so new settings must
// opt in deliberately.
const REQUIRE_LOGIN_KEY = 'REQUIRE_DISCORD_LOGIN';
// v2.39.0 — approval rooms. Flip dispatch lives in JoinPolicyService (scrubs
// the room's Global Scoreboard footprint on open -> approval).
const JOIN_POLICY_KEY = 'JOIN_POLICY';
// v2.40.0 — private-room opt-in to the Global Scoreboard. Only meaningful for
// approval-policy rooms (open rooms fan out unconditionally and ignore this
// key entirely — see handleShareToGlobalFlip). ON->OFF scrubs the room's
// global footprint; OFF->ON back-fills it. Both idempotent (safe to re-run
// or double-toggle) — see GlobalScoreService.backfillRoomToGlobal.
const SHARE_TO_GLOBAL_KEY = 'SHARE_TO_GLOBAL';

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

function decodeValue(key: string, stored: string): string {
    if (!isEncryptedKey(key)) return stored;
    if (isEncrypted(stored)) return decryptSecret(stored);
    // Legacy plaintext row (before startup migration ran). Returned as-is so
    // callers don't break during the migration window.
    return stored;
}

/**
 * Per-room key/value settings. Transparent encryption for keys listed in
 * `ENCRYPTED_SETTING_KEYS` — callers see and write plaintext; on-disk is
 * ciphertext. Empty-string writes on `saveMany`/`set` delete the row so admin
 * UI "clear field" actions persist.
 */
export class GameRoomSettingsService {
    /**
     * SHARE_TO_GLOBAL flip dispatch (v2.40.0). Only consulted for
     * approval-policy rooms — an open room already fans out unconditionally,
     * so a no-op here is correct even if the key happens to be set on one
     * (e.g. left over from a room that was previously approval-policy).
     * Reads JOIN_POLICY fresh so it sees the post-write value even when both
     * keys change in the same saveMany call.
     */
    static async handleShareToGlobalFlip(
        gameRoomId: string,
        prevValue: string | null,
        newValue: string,
    ): Promise<void> {
        const policy = await GameRoomSettingsService.get(gameRoomId, JOIN_POLICY_KEY);
        if (policy !== 'approval') return;

        const prevOn = prevValue === 'true';
        const nextOn = newValue === 'true';
        if (prevOn === nextOn) return;

        const { GlobalScoreService } = await import('./GlobalScoreService.js');
        if (nextOn) {
            const { restored, fannedOut } = await GlobalScoreService.backfillRoomToGlobal(gameRoomId);
            logInfo(`GameRoomSettingsService: SHARE_TO_GLOBAL -> on for room ${gameRoomId} — restored ${restored}, fanned out ${fannedOut} new row(s).`);
        } else {
            const n = await GlobalScoreService.scrubRoomFromGlobal(gameRoomId, 'system:share_to_global_off');
            logInfo(`GameRoomSettingsService: SHARE_TO_GLOBAL -> off for room ${gameRoomId} — scrubbed ${n} global_scores row(s).`);
        }
    }

    static async get(gameRoomId: string, key: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
        if (!row) return null;
        return decodeValue(key, row.value);
    }

    static async getAll(gameRoomId: string): Promise<Record<string, string>> {
        const db = await getDatabase();
        const rows = await db.all(
            'SELECT key, value FROM game_room_settings WHERE game_room_id = ?',
            gameRoomId
        );
        return rows.reduce((acc: Record<string, string>, row: any) => {
            acc[row.key] = decodeValue(row.key, row.value);
            return acc;
        }, {});
    }

    static async set(gameRoomId: string, key: string, value: string): Promise<void> {
        // Empty value → delete so clearing a field via admin UI persists.
        if (value === '') {
            await GameRoomSettingsService.delete(gameRoomId, key);
            return;
        }
        // Mask sentinel → no-op (secret unchanged).
        if (isMask(value)) return;

        const db = await getDatabase();
        // Capture previous value BEFORE the write so flip logic can diff.
        const prev = (key === REQUIRE_LOGIN_KEY || key === JOIN_POLICY_KEY || key === SHARE_TO_GLOBAL_KEY)
            ? await GameRoomSettingsService.get(gameRoomId, key)
            : null;

        const storedValue = isEncryptedKey(key) ? encryptSecret(value) : value;
        await db.run(
            'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
            gameRoomId, key, storedValue
        );
        if (key === REQUIRE_LOGIN_KEY) {
            await OrphanService.handleRequireLoginFlip(gameRoomId, prev, value);
            await invalidateLeaderboardCaches(gameRoomId);
        }
        if (key === JOIN_POLICY_KEY) {
            await JoinPolicyService.handlePolicyFlip(gameRoomId, prev, value);
        }
        if (key === SHARE_TO_GLOBAL_KEY) {
            await GameRoomSettingsService.handleShareToGlobalFlip(gameRoomId, prev, value);
        }
        if (key === ENABLE_GAME_PICK_AWARD) {
            // Sprint 13: close the 5s staleness window after admin toggles.
            PickAwardGate.invalidate(gameRoomId);
        }
    }

    static async saveMany(gameRoomId: string, settings: Record<string, string>): Promise<void> {
        const db = await getDatabase();
        // Capture previous REQUIRE_LOGIN/JOIN_POLICY values before any writes so
        // flip semantics are correct even if the bulk save also touches other keys.
        const prevRequireLogin = REQUIRE_LOGIN_KEY in settings
            ? await GameRoomSettingsService.get(gameRoomId, REQUIRE_LOGIN_KEY)
            : null;
        const prevJoinPolicy = JOIN_POLICY_KEY in settings
            ? await GameRoomSettingsService.get(gameRoomId, JOIN_POLICY_KEY)
            : null;
        const prevShareToGlobal = SHARE_TO_GLOBAL_KEY in settings
            ? await GameRoomSettingsService.get(gameRoomId, SHARE_TO_GLOBAL_KEY)
            : null;

        for (const [key, value] of Object.entries(settings)) {
            // Mask sentinel → user did not change this secret; skip.
            if (isMask(value)) continue;

            // Empty value → delete (so admin UI "clear field" persists).
            if (value === '') {
                await db.run(
                    'DELETE FROM game_room_settings WHERE game_room_id = ? AND key = ?',
                    gameRoomId, key,
                );
                continue;
            }

            const storedValue = isEncryptedKey(key) ? encryptSecret(value) : value;
            await db.run(
                'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
                gameRoomId, key, storedValue
            );
        }

        if (REQUIRE_LOGIN_KEY in settings && !isMask(settings[REQUIRE_LOGIN_KEY]!)) {
            await OrphanService.handleRequireLoginFlip(gameRoomId, prevRequireLogin, settings[REQUIRE_LOGIN_KEY]!);
            await invalidateLeaderboardCaches(gameRoomId);
        }
        if (JOIN_POLICY_KEY in settings && !isMask(settings[JOIN_POLICY_KEY]!)) {
            await JoinPolicyService.handlePolicyFlip(gameRoomId, prevJoinPolicy, settings[JOIN_POLICY_KEY]!);
        }
        if (SHARE_TO_GLOBAL_KEY in settings && !isMask(settings[SHARE_TO_GLOBAL_KEY]!)) {
            await GameRoomSettingsService.handleShareToGlobalFlip(gameRoomId, prevShareToGlobal, settings[SHARE_TO_GLOBAL_KEY]!);
        }
        if (ENABLE_GAME_PICK_AWARD in settings) {
            PickAwardGate.invalidate(gameRoomId);
        }
    }

    static async delete(gameRoomId: string, key: string): Promise<void> {
        const db = await getDatabase();
        const prev = (key === REQUIRE_LOGIN_KEY || key === JOIN_POLICY_KEY || key === SHARE_TO_GLOBAL_KEY)
            ? await GameRoomSettingsService.get(gameRoomId, key)
            : null;
        await db.run(
            'DELETE FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
        if (key === REQUIRE_LOGIN_KEY && (prev === 'true' || prev === 'discord')) {
            // Deleting REQUIRE_DISCORD_LOGIN is equivalent to turning it off.
            await OrphanService.handleRequireLoginFlip(gameRoomId, prev, 'false');
            await invalidateLeaderboardCaches(gameRoomId);
        }
        if (key === JOIN_POLICY_KEY && prev === 'approval') {
            // Deleting JOIN_POLICY is equivalent to reverting to 'open' (the
            // absent-key default) — but per JoinPolicyService's contract this
            // direction (approval -> open) has no scrub side-effect anyway.
            await JoinPolicyService.handlePolicyFlip(gameRoomId, prev, 'open');
        }
        if (key === SHARE_TO_GLOBAL_KEY && prev === 'true') {
            // Deleting SHARE_TO_GLOBAL is equivalent to turning it off.
            await GameRoomSettingsService.handleShareToGlobalFlip(gameRoomId, prev, 'false');
        }
        if (key === ENABLE_GAME_PICK_AWARD) {
            PickAwardGate.invalidate(gameRoomId);
        }
    }
}
