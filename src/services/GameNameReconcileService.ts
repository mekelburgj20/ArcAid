import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { ActivityLogService } from './ActivityLogService.js';

/**
 * A35 (v2.235.0, owner 2026-11-08) — reconcile game names the catalogue does
 * not have.
 *
 * Score rows, rounds and a room's game list tie to a game by its NAME. A round
 * typed "Arkanoid" (the catalogue and AtGames call it "Arkanoid (Pinball)")
 * collected history that joins nothing: not the catalogue game, not the Global
 * Scoreboard, not AtGames. A34 stopped new ones; this merges the old ones, ONE
 * ROOM AT A TIME (the same name in another room may mean another game).
 *
 * A merge renames, in one transaction, every row in that room under the old
 * name: `games` (and points it at the catalogue row), `score_history`,
 * `community_scores`, `game_comments`, the room's `game_room_game_library` row,
 * and the name-derived key on `auto_score_suppressions` (so a deleted cabinet
 * score stays deleted). The previous value of every changed row is kept in
 * `game_name_reconcile_rows`, so Undo restores exactly those rows and leaves
 * anything written since alone. Logs (`activity_log`, `rotation_events`,
 * `lobby_feed_events`) are history and are not rewritten.
 *
 * Not done here: scores that never reached the Global Scoreboard because their
 * name matched nothing are not fanned out after the fact.
 */

export class GameNameReconcileError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'GameNameReconcileError';
        this.code = code;
    }
}

export interface CatalogueSuggestion {
    id: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
    platforms: string[];
    atgames: boolean;
    /** Suggestions only: a clear winner the page may preselect. */
    sure?: boolean;
}

export interface OrphanName {
    roomId: string;
    roomName: string;
    roomSlug: string;
    /** The most-used spelling. */
    name: string;
    /** Every case variant in use in this room. */
    spellings: string[];
    counts: { games: number; activeGames: number; scores: number; communityScores: number; comments: number };
    lastScoreAt: string | null;
    suggestions: CatalogueSuggestion[];
}

export interface ReconcilePreview {
    roomId: string;
    fromName: string;
    spellings: string[];
    to: { id: string; name: string };
    counts: {
        games: number; activeGames: number; scores: number; communityScores: number; comments: number;
        library: 'rename' | 'merge' | 'none'; suppressions: number;
    };
    /** Reasons the merge cannot run. Empty = it can. */
    blockers: string[];
    warnings: string[];
}

interface CatalogueRow {
    id: string; name: string; manufacturer: string | null; year: number | null;
    platforms: string | null; atgames_id: number | string | null; normalized_name: string | null;
}

function parsePlatforms(raw: string | null): string[] {
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function toSuggestion(r: CatalogueRow): CatalogueSuggestion {
    const platforms = parsePlatforms(r.platforms);
    return {
        id: r.id, name: r.name, manufacturer: r.manufacturer ?? null, year: r.year ?? null,
        platforms, atgames: r.atgames_id != null || platforms.includes('atgames_native'),
    };
}

/**
 * Catalogue rows that look like the name a room used. Ranked: same normalized
 * name first, then by how many words the two names share (Dice overlap,
 * ignoring "The" and "Pinball"). Only suggestions: the super-admin picks;
 * `sure` marks the one row the page may preselect.
 */
export function suggestFor(
    orphan: string,
    catalogue: Array<{ row: CatalogueRow; norm: string; lower: string }>,
    limit = 5,
): CatalogueSuggestion[] {
    const n = normalizeGameName(orphan);
    const words = nameWords(n);
    if (words.size === 0) return [];
    const scored: Array<{ score: number; exact: boolean; covers: boolean; row: CatalogueRow }> = [];
    for (const c of catalogue) {
        const theirs = nameWords(c.norm);
        let shared = 0;
        for (const w of words) if (theirs.has(w)) shared++;
        if (shared === 0) continue;
        // Dice overlap of the two word sets: "Kung Fu Panda Pinball" is far
        // closer to "DreamWorks Kung Fu Panda Pinball" than to "Kung Fu".
        const dice = (2 * shared) / (words.size + theirs.size);
        const exact = c.norm === n ? 1 : 0;
        if (!exact && dice < 0.3) continue;
        scored.push({ score: exact * 2 + dice, exact: exact === 1, covers: shared === words.size, row: c.row });
    }
    scored.sort((a, b) => b.score - a.score || a.row.name.length - b.row.name.length || a.row.name.localeCompare(b.row.name));
    const top = scored.slice(0, limit);
    // Preselect only a clear winner: the same normalized name, or the one
    // suggestion that holds every word of the room's name.
    const covering = top.filter(s => s.covers);
    return top.map((s, i) => ({
        ...toSuggestion(s.row),
        sure: i === 0 && (s.exact || (s.covers && covering.length === 1)),
    }));
}

const FILLER_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'pinball']);

/** The words of a normalized name, without filler ("The", trailing ", The", "Pinball"). */
function nameWords(norm: string): Set<string> {
    const all = norm.split(/[\s-]+/).filter(Boolean);
    const kept = all.filter(w => !FILLER_WORDS.has(w));
    return new Set(kept.length ? kept : all);
}

export class GameNameReconcileService {
    private static async loadCatalogue(): Promise<Array<{ row: CatalogueRow; norm: string; lower: string }>> {
        const db = await getDatabase();
        const rows = await db.all<CatalogueRow[]>(
            `SELECT id, name, manufacturer, year, platforms, atgames_id, normalized_name
               FROM global_games WHERE status = 'approved'`,
        );
        return rows.map(row => ({
            row, norm: row.normalized_name || normalizeGameName(row.name), lower: row.name.toLowerCase(),
        }));
    }

    /** Every (room, name) with history whose name no approved catalogue row has. */
    static async listOrphans(): Promise<OrphanName[]> {
        const db = await getDatabase();
        const catalogue = await this.loadCatalogue();
        const known = new Set(catalogue.map(c => c.lower));

        type Acc = {
            roomId: string; spellings: Map<string, number>;
            games: number; activeGames: number; scores: number; communityScores: number; comments: number;
            lastScoreAt: string | null;
        };
        const acc = new Map<string, Acc>();
        const add = (roomId: string | null, name: string | null, field: 'games' | 'scores' | 'communityScores' | 'comments', n: number, extra?: { active?: number; last?: string | null }) => {
            if (!roomId || !name || !name.trim()) return;
            const lower = name.trim().toLowerCase();
            if (known.has(lower)) return;
            const key = `${roomId}\u0000${lower}`;
            let a = acc.get(key);
            if (!a) {
                a = { roomId, spellings: new Map(), games: 0, activeGames: 0, scores: 0, communityScores: 0, comments: 0, lastScoreAt: null };
                acc.set(key, a);
            }
            a.spellings.set(name, (a.spellings.get(name) ?? 0) + n);
            a[field] += n;
            if (extra?.active) a.activeGames += extra.active;
            if (extra?.last && (!a.lastScoreAt || extra.last > a.lastScoreAt)) a.lastScoreAt = extra.last;
        };

        for (const r of await db.all<Array<{ room: string; name: string; n: number; active: number }>>(
            `SELECT game_room_id AS room, name, COUNT(*) AS n, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active
               FROM games WHERE game_room_id IS NOT NULL GROUP BY game_room_id, name`,
        )) add(r.room, r.name, 'games', r.n, { active: r.active });
        for (const r of await db.all<Array<{ room: string; name: string; n: number; last: string | null }>>(
            `SELECT game_room_id AS room, game_name AS name, COUNT(*) AS n, MAX(created_at) AS last
               FROM score_history WHERE game_room_id IS NOT NULL GROUP BY game_room_id, game_name`,
        )) add(r.room, r.name, 'scores', r.n, { last: r.last });
        for (const r of await db.all<Array<{ room: string; name: string; n: number; last: string | null }>>(
            `SELECT game_room_id AS room, game_name AS name, COUNT(*) AS n, MAX(created_at) AS last
               FROM community_scores GROUP BY game_room_id, game_name`,
        )) add(r.room, r.name, 'communityScores', r.n, { last: r.last });
        for (const r of await db.all<Array<{ room: string; name: string; n: number }>>(
            `SELECT game_room_id AS room, game_name AS name, COUNT(*) AS n FROM game_comments GROUP BY game_room_id, game_name`,
        )) add(r.room, r.name, 'comments', r.n);

        const rooms = new Map((await db.all<Array<{ id: string; name: string; slug: string }>>(
            'SELECT id, name, slug FROM game_rooms',
        )).map(r => [r.id, r]));

        const out: OrphanName[] = [];
        for (const a of acc.values()) {
            const room = rooms.get(a.roomId);
            if (!room) continue;
            const spellings = [...a.spellings.entries()].sort((x, y) => y[1] - x[1]).map(([s]) => s);
            out.push({
                roomId: a.roomId, roomName: room.name, roomSlug: room.slug,
                name: spellings[0]!, spellings,
                counts: { games: a.games, activeGames: a.activeGames, scores: a.scores, communityScores: a.communityScores, comments: a.comments },
                lastScoreAt: a.lastScoreAt,
                suggestions: suggestFor(spellings[0]!, catalogue),
            });
        }
        out.sort((x, y) => x.roomName.localeCompare(y.roomName)
            || (y.counts.scores + y.counts.communityScores) - (x.counts.scores + x.counts.communityScores)
            || x.name.localeCompare(y.name));
        return out;
    }

    /** Approved catalogue rows by name, for picking a target the suggestions missed. */
    static async searchCatalogue(q: string, limit = 15): Promise<CatalogueSuggestion[]> {
        const term = (q || '').trim();
        if (term.length < 2) return [];
        const db = await getDatabase();
        const rows = await db.all<CatalogueRow[]>(
            `SELECT id, name, manufacturer, year, platforms, atgames_id, normalized_name
               FROM global_games WHERE status = 'approved' AND name LIKE ? COLLATE NOCASE
              ORDER BY LENGTH(name), name LIMIT ?`,
            `%${term}%`, limit,
        );
        return rows.map(toSuggestion);
    }

    /** What a merge would change, and anything that stops it. Changes nothing. */
    static async preview(roomId: string, fromName: string, toGlobalGameId: string): Promise<ReconcilePreview> {
        const db = await getDatabase();
        const from = (fromName || '').trim();
        if (!from) throw new GameNameReconcileError('BAD_REQUEST', 'Pick the name to merge');
        const room = await db.get<{ id: string }>('SELECT id FROM game_rooms WHERE id = ?', roomId);
        if (!room) throw new GameNameReconcileError('NOT_FOUND', 'Room not found');
        const target = await db.get<{ id: string; name: string }>(
            `SELECT id, name FROM global_games WHERE id = ? AND status = 'approved'`, toGlobalGameId,
        );
        if (!target) throw new GameNameReconcileError('NOT_FOUND', 'That catalogue game was not found (or is not approved)');
        const inCatalogue = await db.get(
            `SELECT 1 FROM global_games WHERE status = 'approved' AND LOWER(name) = LOWER(?)`, from,
        );
        if (inCatalogue) {
            throw new GameNameReconcileError('IN_CATALOGUE', `"${from}" is already a catalogue game. Merging catalogue games is the Global Catalogue merge.`);
        }

        const games = await db.all<Array<{ id: string; name: string; status: string; iscored_id: string | null }>>(
            `SELECT id, name, status, iscored_id FROM games WHERE game_room_id = ? AND LOWER(name) = LOWER(?)`, roomId, from,
        );
        const count = async (sql: string) => ((await db.get<{ n: number }>(sql, roomId, from))?.n ?? 0);
        const scores = await count(`SELECT COUNT(*) AS n FROM score_history WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`);
        const communityScores = await count(`SELECT COUNT(*) AS n FROM community_scores WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`);
        const comments = await count(`SELECT COUNT(*) AS n FROM game_comments WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`);
        const libraryFrom = await db.all<Array<{ game_name: string }>>(
            `SELECT game_name FROM game_room_game_library WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`, roomId, from,
        );
        const libraryTo = await db.get(
            `SELECT 1 FROM game_room_game_library WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`, roomId, target.name,
        );
        const fromKey = normalizeGameName(from);
        const toKey = normalizeGameName(target.name);
        const suppressions = fromKey && fromKey !== toKey
            ? ((await db.get<{ n: number }>(
                'SELECT COUNT(*) AS n FROM auto_score_suppressions WHERE game_room_id = ? AND game_key = ?', roomId, fromKey,
            ))?.n ?? 0)
            : 0;

        const spellings = new Set<string>();
        for (const g of games) spellings.add(g.name);
        for (const r of await db.all<Array<{ n: string }>>(
            `SELECT DISTINCT game_name AS n FROM score_history WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`, roomId, from,
        )) spellings.add(r.n);

        const blockers: string[] = [];
        const warnings: string[] = [];
        const iscored = games.filter(g => g.iscored_id);
        if (iscored.length > 0) {
            // iScored matches its board to Arcaid BY NAME; renaming here would
            // make the poller write the old name straight back.
            blockers.push(`${iscored.length} game${iscored.length === 1 ? ' is' : 's are'} linked to an iScored board, which matches by name. Rename it on iScored first, or leave it.`);
        }
        const activeFrom = games.filter(g => g.status === 'ACTIVE').length;
        if (activeFrom > 0) {
            const activeTo = await db.get(
                `SELECT 1 FROM games WHERE game_room_id = ? AND status = 'ACTIVE' AND LOWER(name) = LOWER(?)`, roomId, target.name,
            );
            if (activeTo) {
                blockers.push(`Both "${from}" and "${target.name}" have a live card in this room. Two live cards with one name make score entry ambiguous; wait until one closes.`);
            } else {
                warnings.push(`${activeFrom} live card${activeFrom === 1 ? '' : 's'} will show "${target.name}" straight away.`);
            }
        }
        if (games.length + scores + communityScores + comments + libraryFrom.length === 0) {
            blockers.push(`Nothing in this room uses "${from}".`);
        }

        return {
            roomId, fromName: from, spellings: [...spellings], to: { id: target.id, name: target.name },
            counts: {
                games: games.length, activeGames: activeFrom, scores, communityScores, comments,
                library: libraryFrom.length === 0 ? 'none' : libraryTo ? 'merge' : 'rename',
                suppressions,
            },
            blockers, warnings,
        };
    }

    /** Runs the merge. Throws BLOCKED with the preview's reasons when it cannot. */
    static async apply(roomId: string, fromName: string, toGlobalGameId: string, actorUserId: string | null): Promise<{ id: string; preview: ReconcilePreview; affectedGameIds: string[] }> {
        const preview = await this.preview(roomId, fromName, toGlobalGameId);
        if (preview.blockers.length > 0) {
            throw new GameNameReconcileError('BLOCKED', preview.blockers.join(' '));
        }
        const db = await getDatabase();
        const id = crypto.randomUUID();
        const from = preview.fromName;
        const to = preview.to;
        const affectedGameIds: string[] = [];

        await db.exec('BEGIN TRANSACTION');
        try {
            await db.run(
                `INSERT INTO game_name_reconciles (id, game_room_id, from_name, to_name, to_global_game_id, counts, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                id, roomId, from, to.name, to.id, JSON.stringify(preview.counts), actorUserId,
            );

            const games = await db.all<Array<{ id: string; name: string; global_game_id: string | null }>>(
                `SELECT id, name, global_game_id FROM games WHERE game_room_id = ? AND LOWER(name) = LOWER(?)`, roomId, from,
            );
            for (const g of games) {
                await db.run(
                    `INSERT INTO game_name_reconcile_rows (reconcile_id, table_name, row_key, old_value) VALUES (?, 'games', ?, ?)`,
                    id, g.id, JSON.stringify({ name: g.name, global_game_id: g.global_game_id }),
                );
                await db.run('UPDATE games SET name = ?, global_game_id = ? WHERE id = ?', to.name, to.id, g.id);
                affectedGameIds.push(g.id);
            }

            // Set-based for the big tables: record every old value, then rename.
            for (const table of ['score_history', 'community_scores', 'game_comments'] as const) {
                await db.run(
                    `INSERT INTO game_name_reconcile_rows (reconcile_id, table_name, row_key, old_value)
                     SELECT ?, '${table}', CAST(id AS TEXT), game_name FROM ${table}
                      WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
                    id, roomId, from,
                );
                await db.run(
                    `UPDATE ${table} SET game_name = ? WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
                    to.name, roomId, from,
                );
            }

            // The room's game-list row (per-game style overlay). Keep the
            // target's when it has one; otherwise the old row becomes it.
            const libRows = await db.all<Array<Record<string, unknown>>>(
                `SELECT * FROM game_room_game_library WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`, roomId, from,
            );
            let targetHasRow = !!(await db.get(
                `SELECT 1 FROM game_room_game_library WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`, roomId, to.name,
            ));
            for (const row of libRows) {
                const oldName = String(row.game_name);
                if (targetHasRow) {
                    await db.run(
                        `INSERT INTO game_name_reconcile_rows (reconcile_id, table_name, row_key, old_value) VALUES (?, 'library_deleted', ?, ?)`,
                        id, oldName, JSON.stringify(row),
                    );
                    await db.run('DELETE FROM game_room_game_library WHERE game_room_id = ? AND game_name = ?', roomId, oldName);
                } else {
                    await db.run(
                        `INSERT INTO game_name_reconcile_rows (reconcile_id, table_name, row_key, old_value) VALUES (?, 'library_renamed', ?, ?)`,
                        id, to.name, JSON.stringify({ name: oldName, global_game_id: row.global_game_id ?? null }),
                    );
                    await db.run(
                        'UPDATE game_room_game_library SET game_name = ?, global_game_id = ? WHERE game_room_id = ? AND game_name = ?',
                        to.name, to.id, roomId, oldName,
                    );
                    targetHasRow = true;
                }
            }

            // A deleted cabinet score is tombstoned under normalizeGameName(name);
            // move the key so the next pull still recognises it.
            const fromKey = normalizeGameName(from);
            const toKey = normalizeGameName(to.name);
            if (fromKey && fromKey !== toKey) {
                await db.run(
                    `INSERT INTO game_name_reconcile_rows (reconcile_id, table_name, row_key, old_value)
                     SELECT ?, 'auto_score_suppressions', CAST(id AS TEXT), game_key FROM auto_score_suppressions
                      WHERE game_room_id = ? AND game_key = ?`,
                    id, roomId, fromKey,
                );
                // OR IGNORE: a tombstone already under the new key wins; the old one is then inert.
                await db.run(
                    'UPDATE OR IGNORE auto_score_suppressions SET game_key = ? WHERE game_room_id = ? AND game_key = ?',
                    toKey, roomId, fromKey,
                );
            }
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }

        await this.afterChange(affectedGameIds);
        logInfo(`Game name reconcile ${id}: room ${roomId} "${from}" -> "${to.name}" (${JSON.stringify(preview.counts)})`);
        void ActivityLogService.record({
            roomId, category: 'admin', eventType: 'game_name_reconciled', actorUserId,
            gameName: to.name,
            summary: `Merged the game name "${from}" into catalogue game "${to.name}"`,
            details: { reconcileId: id, from, to: to.name, toGlobalGameId: to.id, counts: preview.counts },
        });
        return { id, preview, affectedGameIds };
    }

    /** Puts back exactly the rows a merge changed. */
    static async undo(reconcileId: string, actorUserId: string | null): Promise<{ restored: number; affectedGameIds: string[] }> {
        const db = await getDatabase();
        const rec = await db.get<{ id: string; game_room_id: string; from_name: string; to_name: string; undone_at: string | null }>(
            'SELECT id, game_room_id, from_name, to_name, undone_at FROM game_name_reconciles WHERE id = ?', reconcileId,
        );
        if (!rec) throw new GameNameReconcileError('NOT_FOUND', 'Merge not found');
        if (rec.undone_at) throw new GameNameReconcileError('ALREADY_UNDONE', 'This merge was already undone');

        const rows = await db.all<Array<{ table_name: string; row_key: string; old_value: string | null }>>(
            'SELECT table_name, row_key, old_value FROM game_name_reconcile_rows WHERE reconcile_id = ?', reconcileId,
        );
        const affectedGameIds: string[] = [];
        await db.exec('BEGIN TRANSACTION');
        try {
            for (const table of ['score_history', 'community_scores', 'game_comments'] as const) {
                await db.run(
                    `UPDATE ${table} SET game_name = (
                        SELECT r.old_value FROM game_name_reconcile_rows r
                         WHERE r.reconcile_id = ? AND r.table_name = '${table}' AND r.row_key = CAST(${table}.id AS TEXT))
                      WHERE CAST(id AS TEXT) IN (
                        SELECT row_key FROM game_name_reconcile_rows WHERE reconcile_id = ? AND table_name = '${table}')`,
                    reconcileId, reconcileId,
                );
            }
            for (const r of rows) {
                if (r.table_name === 'games') {
                    const old = JSON.parse(r.old_value ?? '{}') as { name?: string; global_game_id?: string | null };
                    await db.run('UPDATE games SET name = ?, global_game_id = ? WHERE id = ?', old.name, old.global_game_id ?? null, r.row_key);
                    affectedGameIds.push(r.row_key);
                } else if (r.table_name === 'auto_score_suppressions') {
                    await db.run('UPDATE OR IGNORE auto_score_suppressions SET game_key = ? WHERE id = ?', r.old_value, Number(r.row_key));
                } else if (r.table_name === 'library_renamed') {
                    const old = JSON.parse(r.old_value ?? '{}') as { name?: string; global_game_id?: string | null };
                    const taken = await db.get(
                        'SELECT 1 FROM game_room_game_library WHERE game_room_id = ? AND game_name = ?', rec.game_room_id, old.name,
                    );
                    if (!taken) {
                        await db.run(
                            'UPDATE game_room_game_library SET game_name = ?, global_game_id = ? WHERE game_room_id = ? AND game_name = ?',
                            old.name, old.global_game_id ?? null, rec.game_room_id, r.row_key,
                        );
                    }
                } else if (r.table_name === 'library_deleted') {
                    const old = JSON.parse(r.old_value ?? '{}') as Record<string, unknown>;
                    const cols = Object.keys(old).filter(c => /^[a-z_]+$/.test(c));
                    if (cols.length > 0) {
                        await db.run(
                            `INSERT OR IGNORE INTO game_room_game_library (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                            ...cols.map(c => old[c]),
                        );
                    }
                }
            }
            await db.run(
                `UPDATE game_name_reconciles SET undone_at = datetime('now'), undone_by = ? WHERE id = ? AND undone_at IS NULL`,
                actorUserId, reconcileId,
            );
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }

        await this.afterChange(affectedGameIds);
        logInfo(`Game name reconcile ${reconcileId} undone (${rows.length} row(s))`);
        void ActivityLogService.record({
            roomId: rec.game_room_id, category: 'admin', eventType: 'game_name_reconcile_undone', actorUserId,
            gameName: rec.from_name,
            summary: `Undid the merge of "${rec.from_name}" into "${rec.to_name}"`,
            details: { reconcileId, rows: rows.length },
        });
        return { restored: rows.length, affectedGameIds };
    }

    /** Recent merges, newest first, with their room. */
    static async history(limit = 100): Promise<Array<{
        id: string; roomId: string; roomName: string | null; fromName: string; toName: string;
        counts: Record<string, unknown>; createdAt: string; createdBy: string | null; undoneAt: string | null;
    }>> {
        const db = await getDatabase();
        const rows = await db.all<Array<{
            id: string; game_room_id: string; room_name: string | null; from_name: string; to_name: string;
            counts: string; created_at: string; created_by: string | null; undone_at: string | null;
        }>>(
            `SELECT r.id, r.game_room_id, g.name AS room_name, r.from_name, r.to_name, r.counts, r.created_at, r.created_by, r.undone_at
               FROM game_name_reconciles r LEFT JOIN game_rooms g ON g.id = r.game_room_id
              ORDER BY r.created_at DESC LIMIT ?`,
            limit,
        );
        return rows.map(r => {
            let counts: Record<string, unknown> = {};
            try { counts = JSON.parse(r.counts); } catch { /* keep empty */ }
            return {
                id: r.id, roomId: r.game_room_id, roomName: r.room_name, fromName: r.from_name, toName: r.to_name,
                counts, createdAt: r.created_at, createdBy: r.created_by, undoneAt: r.undone_at,
            };
        });
    }

    /** Cached boards for the renamed games recompute on next read. */
    private static async afterChange(gameIds: string[]): Promise<void> {
        try {
            const { LeaderboardService } = await import('./LeaderboardService.js');
            for (const gameId of gameIds) await LeaderboardService.invalidate(gameId);
            const { RankingService } = await import('./RankingService.js');
            await RankingService.invalidateAll();
        } catch (err) {
            logWarn(`Game name reconcile: cache invalidation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
