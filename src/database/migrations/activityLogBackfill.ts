import type { Database } from 'sqlite';
import { mapRoomEvent, mapRotationEvent, idFromActor } from '../../utils/activityMappings.js';

/**
 * G14 (v2.227.0, ADR 0037 §8) - one-time backfill of `activity_log` from the
 * stores that already hold the last 90 days: score_history (non-witness),
 * witness_evidence (every witness outcome), attempts (voids), rotation_events,
 * room_events (only 7 days survive) and audit_log (room derived from its
 * target where it can be). Idempotent: every row carries a dedupe key, and
 * `score_history` rows use the SAME key (`sh:<id>`) the live writer uses.
 * Source tables are only read.
 */
export async function backfillActivityLog(db: Database): Promise<number> {
    const since = `datetime('now', '-90 days')`;
    let total = 0;
    const count = (r: { changes?: number }) => { total += r.changes ?? 0; };

    await db.exec('BEGIN');
    try {
        // Scores that landed (witness rows come from witness_evidence below).
        count(await db.run(`
            INSERT OR IGNORE INTO activity_log
                (created_at, game_room_id, category, event_type, severity, canonical_user_id, player_alias,
                 tournament_id, game_id, tournament_name, game_name, source, score, summary, details, dedupe_key)
            SELECT h.created_at, h.game_room_id, 'score', 'score_landed', 'info', h.submitted_by_user_id, h.iscored_username,
                   h.submitted_during_tournament_id, h.game_id, t.name, h.game_name, h.source, h.score,
                   'Score ' || h.score || ' landed on ' || h.game_name || ' (' ||
                     CASE h.source WHEN 'tournament' THEN 'typed' WHEN 'community' THEN 'typed, community'
                                   WHEN 'sync' THEN 'iScored sync' WHEN 'atgames' THEN 'AtGames' ELSE h.source END || ')',
                   json_object('scoreHistoryId', h.id, 'backfilled', 1),
                   'sh:' || h.id
              FROM score_history h
              LEFT JOIN tournaments t ON t.id = h.submitted_during_tournament_id
             WHERE h.created_at >= ${since} AND h.source <> 'vpx'
        `));

        // Every witness play that reached the server. Room rows only for an
        // outcome inside a room's tournament; Global / unmatched are room-less.
        count(await db.run(`
            INSERT OR IGNORE INTO activity_log
                (created_at, game_room_id, category, event_type, severity, canonical_user_id, device_id,
                 tournament_id, game_id, tournament_name, game_name, table_name, source, score, summary, details, dedupe_key)
            SELECT e.created_at,
                   CASE WHEN e.outcome IN ('ingested','duplicate','attempt_refused','not_sanctioned','suppressed') THEN e.game_room_id END,
                   'score', 'witness_' || e.outcome,
                   CASE WHEN e.outcome IN ('attempt_refused','not_sanctioned','no_match','invalid')
                          OR (e.outcome = 'global' AND e.reasons NOT IN ('[]', '')) THEN 'problem' ELSE 'info' END,
                   e.canonical_user_id, e.device_id,
                   CASE WHEN e.outcome IN ('ingested','duplicate','attempt_refused','not_sanctioned','suppressed') THEN e.tournament_id END,
                   CASE WHEN e.outcome IN ('ingested','duplicate','attempt_refused','not_sanctioned','suppressed') THEN e.game_id END,
                   t.name, g.name, e.table_name, 'vpx', e.score,
                   'Score ' || e.score || ' on ' || COALESCE(g.name, e.table_name) || ': ' ||
                     CASE e.outcome
                       WHEN 'ingested' THEN 'landed'
                       WHEN 'duplicate' THEN 'a repeat of one already on the board'
                       WHEN 'attempt_refused' THEN 'refused by Limited attempts'
                       WHEN 'not_sanctioned' THEN 'refused by Sanctioned play'
                       WHEN 'suppressed' THEN 'ignored - the player deleted this play'
                       WHEN 'global' THEN 'went to the Global Scoreboard'
                       WHEN 'global_duplicate' THEN 'already on the Global Scoreboard'
                       WHEN 'no_match' THEN 'matched no open game'
                       ELSE e.outcome END,
                   json_object('reasons', json(CASE WHEN json_valid(e.reasons) THEN e.reasons ELSE '[]' END),
                               'playedAt', e.played_at, 'rom', e.rom,
                               'deviceType', COALESCE(d.device_type, 'atgames'), 'backfilled', 1),
                   'we:' || e.id
              FROM witness_evidence e
              LEFT JOIN tournaments t ON t.id = e.tournament_id
              LEFT JOIN games g ON g.id = e.game_id
              LEFT JOIN witness_devices d ON d.atgames_unique_id = e.device_id
             WHERE e.created_at >= ${since}
        `));

        // Attempts an admin voided.
        count(await db.run(`
            INSERT OR IGNORE INTO activity_log
                (created_at, game_room_id, category, event_type, severity, canonical_user_id, actor_user_id, device_id,
                 tournament_id, game_id, tournament_name, game_name, table_name, source, score, summary, details, dedupe_key)
            SELECT a.voided_at, COALESCE(a.game_room_id, t.game_room_id), 'score', 'attempt_voided', 'info',
                   a.canonical_user_id, a.voided_by, a.device_id, a.tournament_id, a.game_id, t.name, g.name, a.table_name,
                   'vpx', a.score, 'Attempt ' || a.attempt_no || ' on ' || COALESCE(g.name, a.table_name, 'a game') || ' voided',
                   json_object('attemptId', a.id, 'backfilled', 1),
                   'att-void:' || a.id
              FROM attempts a
              LEFT JOIN tournaments t ON t.id = a.tournament_id
              LEFT JOIN games g ON g.id = a.game_id
             WHERE a.status = 'void' AND a.voided_at IS NOT NULL AND a.voided_at >= ${since}
        `));

        const insert = async (row: Record<string, unknown>) => {
            const cols = Object.keys(row);
            count(await db.run(
                `INSERT OR IGNORE INTO activity_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                ...cols.map(c => row[c]),
            ));
        };

        // Rotation decisions.
        const rotations = await db.all<Array<{
            id: number; game_room_id: string; tournament_id: string | null; tournament_name: string | null;
            event_type: string; actor: string; source: string | null; queue_owner: string | null;
            game_id: string | null; game_name: string | null; details: string | null; created_at: string;
        }>>(`SELECT * FROM rotation_events WHERE created_at >= ${since}`);
        for (const r of rotations) {
            let details: Record<string, unknown> | null = null;
            try { details = r.details ? JSON.parse(r.details) : null; } catch { details = null; }
            const m = mapRotationEvent({
                eventType: r.event_type, actor: r.actor, source: r.source, queueOwner: r.queue_owner,
                gameName: r.game_name, details,
            });
            await insert({
                created_at: r.created_at, game_room_id: r.game_room_id, category: m.category, event_type: m.eventType,
                severity: 'info', canonical_user_id: m.userId ?? null, actor_user_id: m.actorUserId ?? null,
                tournament_id: r.tournament_id, game_id: r.game_id, tournament_name: r.tournament_name,
                game_name: r.game_name, source: r.source, summary: m.summary,
                details: JSON.stringify({ actor: r.actor, ...(details ?? {}), backfilled: 1 }),
                dedupe_key: `re:${r.id}`,
            });
        }

        // Room events (7 days survive).
        const events = await db.all<Array<{ id: number; game_room_id: string; event_type: string; event_data: string | null; created_at: string }>>(
            `SELECT * FROM room_events WHERE created_at >= ${since}`,
        );
        for (const e of events) {
            let data: Record<string, any> = {};
            try { data = e.event_data ? JSON.parse(e.event_data) : {}; } catch { data = {}; }
            const m = mapRoomEvent(e.event_type, data);
            if (!m) continue;
            await insert({
                created_at: e.created_at, game_room_id: e.game_room_id, category: m.category, event_type: m.eventType,
                severity: m.severity ?? 'info', player_alias: m.playerAlias ?? null,
                tournament_name: m.tournamentName ?? null, game_name: m.gameName ?? null, score: m.score ?? null,
                summary: m.summary,
                details: JSON.stringify({ ...data, ...(e.event_type === 'admin_login' && data.username ? { actorName: data.username } : {}), backfilled: 1 }),
                dedupe_key: `rev:${e.id}`,
            });
        }

        // Admin writes. The room comes from the target when the target says
        // it; otherwise the row is room-less (super-admin only). IPs are not copied.
        const audits = await db.all<Array<{
            id: number; actor: string; action: string; target_type: string; target_id: string; created_at: string;
        }>>(`SELECT id, actor, action, target_type, target_id, created_at FROM audit_log WHERE created_at >= ${since}`);
        for (const a of audits) {
            let roomId: string | null = null;
            let tournamentId: string | null = null;
            if (a.target_type === 'room' && a.target_id) {
                roomId = (await db.get<{ id: string }>('SELECT id FROM game_rooms WHERE id = ?', a.target_id))?.id ?? null;
            } else if (a.target_type === 'tournament' && a.target_id) {
                const t = await db.get<{ game_room_id: string | null }>('SELECT game_room_id FROM tournaments WHERE id = ?', a.target_id);
                if (t) { roomId = t.game_room_id; tournamentId = a.target_id; }
            }
            const actorId = /^\d{15,22}$/.test(a.actor) ? a.actor : idFromActor(a.actor);
            await insert({
                created_at: a.created_at, game_room_id: roomId, category: 'admin', event_type: 'admin_action',
                severity: 'info', actor_user_id: actorId, tournament_id: tournamentId,
                summary: `Admin action: ${a.action}`,
                details: JSON.stringify({ actorName: actorId ? null : a.actor, targetType: a.target_type, backfilled: 1 }),
                dedupe_key: `al:${a.id}`,
            });
        }
        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK').catch(() => {});
        throw err;
    }
    return total;
}
