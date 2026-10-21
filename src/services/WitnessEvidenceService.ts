import { getDatabase } from '../database/database.js';
import {
    normalizeIntegrityMode, normalizeSanctionedRules,
    type GameRequirements, type IntegrityMode, type SanctionedRules, type Verdict, type WitnessEvidence,
} from '../utils/sanctionedRules.js';

/**
 * Integrity mode — storage and the runner's view (v2.165.0, ADR 0027).
 *
 * `witness_evidence` keeps, for EVERY witness score the ingest saw (both modes,
 * every outcome), what the companion measured and what the rules said. It is
 * the runner's review trail: per score, pass/flag per rule; per tournament,
 * what Sanctioned play held out and why. A row outlives the score it describes
 * (no FKs) — a deleted score's evidence is still the record of what happened.
 *
 * Nothing here is consulted by a leaderboard query. Boards fetch the verdict
 * map separately and render a badge from it; a verdict never filters or
 * re-ranks (ADR 0017/0020/0021).
 */

export type IngestOutcome =
    | 'ingested' | 'duplicate' | 'global' | 'global_duplicate' | 'no_match'
    | 'invalid' | 'suppressed' | 'not_sanctioned';

export type EvidenceRecordInput = {
    deviceId: string;
    canonicalUserId: string;
    outcome: IngestOutcome;
    /** The matched game, when there was one (also for a refused `not_sanctioned`). */
    gameId?: string | null;
    tournamentId?: string | null;
    gameRoomId?: string | null;
    scoreHistoryId?: number | null;
    globalScoreId?: string | null;
    /** The tournament's mode at the time; null when no tournament matched. */
    integrityMode?: IntegrityMode | null;
    /** null = not evaluated (no tournament matched). */
    verdict?: Verdict | null;
    tableName: string;
    rom?: string | null;
    score: number;
    /** SQLite UTC datetime of the play's end. */
    playedAt: string;
    evidence: WitnessEvidence | null;
};

export type EvidenceRow = {
    id: number;
    deviceId: string;
    canonicalUserId: string;
    outcome: IngestOutcome;
    gameId: string | null;
    gameName: string | null;
    tournamentId: string | null;
    gameRoomId: string | null;
    scoreHistoryId: number | null;
    globalScoreId: string | null;
    integrityMode: IntegrityMode | null;
    verdict: 'pass' | 'flagged' | null;
    reasons: string[];
    checks: Verdict['checks'];
    tableName: string;
    rom: string | null;
    score: number;
    playedAt: string;
    evidence: WitnessEvidence | null;
    createdAt: string;
};

export type TournamentIntegrity = {
    tournamentId: string;
    mode: IntegrityMode;
    rules: SanctionedRules;
    games: Array<{
        gameId: string; name: string; status: string;
        /**
         * v2.166.0 — the catalogue game this room game is (for the required-table
         * picker, which lists `global_game_tables` by catalogue id): the pinned
         * `games.global_game_id` when there is one, else the approved catalogue
         * row with exactly this name (the join the room leaderboard uses), else
         * null — "not linked to the catalogue".
         */
        globalGameId: string | null;
    } & GameRequirements>;
};

type DbRow = {
    id: number; device_id: string; canonical_user_id: string; outcome: string;
    game_id: string | null; game_name: string | null; tournament_id: string | null; game_room_id: string | null;
    score_history_id: number | null; global_score_id: string | null;
    integrity_mode: string | null; verdict: string | null; reasons: string | null; checks: string | null;
    table_name: string; rom: string | null; score: number; played_at: string;
    vps_game: string | null; vps_table: string | null; table_sha256: string | null; table_save_rev: number | null;
    fingerprint: string | null; ini: string | null; adjustments: string | null; build: string | null;
    created_at: string;
};

function parseJson<T>(s: string | null, fallback: T): T {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
}

function rowToEvidence(r: DbRow): EvidenceRow {
    const hasEvidence = r.vps_game || r.vps_table || r.table_sha256 || r.fingerprint || r.ini || r.adjustments || r.build;
    return {
        id: r.id,
        deviceId: r.device_id,
        canonicalUserId: r.canonical_user_id,
        outcome: r.outcome as IngestOutcome,
        gameId: r.game_id,
        gameName: r.game_name,
        tournamentId: r.tournament_id,
        gameRoomId: r.game_room_id,
        scoreHistoryId: r.score_history_id,
        globalScoreId: r.global_score_id,
        integrityMode: r.integrity_mode ? normalizeIntegrityMode(r.integrity_mode) : null,
        verdict: r.verdict === 'pass' || r.verdict === 'flagged' ? r.verdict : null,
        reasons: parseJson<string[]>(r.reasons, []),
        checks: parseJson<Verdict['checks']>(r.checks, []),
        tableName: r.table_name,
        rom: r.rom,
        score: r.score,
        playedAt: r.played_at,
        evidence: hasEvidence ? {
            vpsGame: r.vps_game, vpsTable: r.vps_table, tableSha256: r.table_sha256, tableSaveRev: r.table_save_rev,
            fingerprint: r.fingerprint,
            ini: parseJson(r.ini, null), adjustments: parseJson(r.adjustments, null), build: parseJson(r.build, null),
        } : null,
        createdAt: r.created_at,
    };
}

export class WitnessEvidenceService {
    /** One row per witness score the ingest saw. Never throws into the ingest: a logging failure must not cost the score. */
    static async record(input: EvidenceRecordInput): Promise<number | null> {
        const db = await getDatabase();
        const e = input.evidence;
        const res = await db.run(
            `INSERT INTO witness_evidence (
                device_id, canonical_user_id, outcome, game_id, tournament_id, game_room_id,
                score_history_id, global_score_id, integrity_mode, verdict, reasons, checks,
                table_name, rom, score, played_at,
                vps_game, vps_table, table_sha256, table_save_rev, fingerprint, ini, adjustments, build
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            input.deviceId, input.canonicalUserId, input.outcome,
            input.gameId ?? null, input.tournamentId ?? null, input.gameRoomId ?? null,
            input.scoreHistoryId ?? null, input.globalScoreId ?? null,
            input.integrityMode ?? null,
            input.verdict?.verdict ?? null,
            JSON.stringify(input.verdict?.reasons ?? []),
            JSON.stringify(input.verdict?.checks ?? []),
            input.tableName, input.rom ?? null, input.score, input.playedAt,
            e?.vpsGame ?? null, e?.vpsTable ?? null, e?.tableSha256 ?? null, e?.tableSaveRev ?? null,
            e?.fingerprint ?? null,
            e?.ini ? JSON.stringify(e.ini) : null,
            e?.adjustments ? JSON.stringify(e.adjustments) : null,
            e?.build ? JSON.stringify(e.build) : null,
        );
        return typeof res.lastID === 'number' ? res.lastID : null;
    }

    /** The runner's trail for one tournament, newest first. */
    static async listForTournament(tournamentId: string, opts: { gameId?: string | null; limit?: number } = {}): Promise<EvidenceRow[]> {
        const db = await getDatabase();
        const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
        const rows = await db.all<DbRow[]>(
            `SELECT e.*, g.name AS game_name
               FROM witness_evidence e
               LEFT JOIN games g ON g.id = e.game_id
              WHERE e.tournament_id = ?
                ${opts.gameId ? 'AND e.game_id = ?' : ''}
              ORDER BY e.created_at DESC, e.id DESC
              LIMIT ?`,
            ...(opts.gameId ? [tournamentId, opts.gameId, limit] : [tournamentId, limit]),
        );
        return rows.map(rowToEvidence);
    }

    /**
     * Board badges: `score_history.id` → verdict, for the scores of one
     * tournament that have one. Public-safe (verdict + reasons only). A score
     * with no row — typed by hand, or from a cabinet — is simply absent.
     */
    static async verdictMap(tournamentId: string): Promise<Record<string, { verdict: 'pass' | 'flagged'; reasons: string[] }>> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ score_history_id: number; verdict: string; reasons: string | null }>>(
            `SELECT score_history_id, verdict, reasons
               FROM witness_evidence
              WHERE tournament_id = ? AND score_history_id IS NOT NULL AND verdict IS NOT NULL
              ORDER BY id ASC`,
            tournamentId,
        );
        const out: Record<string, { verdict: 'pass' | 'flagged'; reasons: string[] }> = {};
        for (const r of rows) {
            if (r.verdict !== 'pass' && r.verdict !== 'flagged') continue;
            out[String(r.score_history_id)] = { verdict: r.verdict, reasons: parseJson<string[]>(r.reasons, []) };
        }
        return out;
    }

    /**
     * The player's own most recent evidence (any tournament, any outcome) —
     * what the "bless the one I just played" button reads so a runner can
     * require the table they are looking at without typing an id.
     */
    static async latestForUser(canonicalUserId: string, opts: { vpsGame?: string | null } = {}): Promise<EvidenceRow | null> {
        const db = await getDatabase();
        const row = await db.get<DbRow>(
            `SELECT e.*, g.name AS game_name
               FROM witness_evidence e
               LEFT JOIN games g ON g.id = e.game_id
              WHERE e.canonical_user_id = ?
                ${opts.vpsGame ? 'AND e.vps_game = ?' : ''}
              ORDER BY e.created_at DESC, e.id DESC
              LIMIT 1`,
            ...(opts.vpsGame ? [canonicalUserId, opts.vpsGame] : [canonicalUserId]),
        );
        return row ? rowToEvidence(row) : null;
    }

    /** A tournament's mode, its (normalised) rules and each game's requirements. */
    static async getIntegrity(tournamentId: string): Promise<TournamentIntegrity | null> {
        const db = await getDatabase();
        const t = await db.get<{ id: string; integrity_mode: string | null; sanctioned_rules: string | null }>(
            'SELECT id, integrity_mode, sanctioned_rules FROM tournaments WHERE id = ?', tournamentId,
        );
        if (!t) return null;
        const games = await db.all<Array<{
            id: string; name: string; status: string; global_game_id: string | null;
            required_vps_table_id: string | null; required_rom: string | null; required_fingerprint: string | null;
        }>>(
            `SELECT g.id, g.name, g.status, g.required_vps_table_id, g.required_rom, g.required_fingerprint,
                    COALESCE(g.global_game_id,
                             (SELECT gg.id FROM global_games gg
                               WHERE LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved' LIMIT 1)) AS global_game_id
               FROM games g WHERE g.tournament_id = ?
              ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 WHEN 'SCHEDULED' THEN 1 WHEN 'QUEUED' THEN 2 ELSE 3 END, g.start_date DESC, g.created_at DESC`,
            tournamentId,
        );
        return {
            tournamentId,
            mode: normalizeIntegrityMode(t.integrity_mode),
            rules: normalizeSanctionedRules(t.sanctioned_rules),
            games: games.map(g => ({
                gameId: g.id, name: g.name, status: g.status, globalGameId: g.global_game_id,
                requiredVpsTableId: g.required_vps_table_id, requiredRom: g.required_rom, requiredFingerprint: g.required_fingerprint,
            })),
        };
    }

    /**
     * The runner names the table for one game. `null` clears a requirement;
     * an omitted key leaves it as it is. Returns false when the game is not in
     * the tournament (so the route can 404 without a second lookup).
     */
    static async setGameRequirements(
        tournamentId: string, gameId: string,
        patch: { requiredVpsTableId?: string | null; requiredRom?: string | null; requiredFingerprint?: string | null },
    ): Promise<boolean> {
        const db = await getDatabase();
        const game = await db.get<{ id: string }>(
            'SELECT id FROM games WHERE id = ? AND tournament_id = ?', gameId, tournamentId,
        );
        if (!game) return false;
        const sets: string[] = [];
        const args: unknown[] = [];
        const clean = (v: string | null | undefined, max: number) =>
            v == null ? null : (v.trim().slice(0, max) || null);
        if ('requiredVpsTableId' in patch) { sets.push('required_vps_table_id = ?'); args.push(clean(patch.requiredVpsTableId, 40)); }
        if ('requiredRom' in patch) { sets.push('required_rom = ?'); args.push(clean(patch.requiredRom, 40)); }
        if ('requiredFingerprint' in patch) { sets.push('required_fingerprint = ?'); args.push(clean(patch.requiredFingerprint, 128)); }
        if (sets.length === 0) return true;
        await db.run(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`, ...args, gameId);
        return true;
    }
}
