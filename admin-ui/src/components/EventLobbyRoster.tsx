import { PlayerAvatar } from './ScoreboardComponents';
import { LOBBY_STATUS_META, type LobbyStatus } from '../lib/lobbyStatus';

export type { LobbyStatus } from '../lib/lobbyStatus';

/**
 * The check-in LOBBY roster (v2.159.0): everyone checked in to an event, each
 * with a witness readiness light. Shared by the public event page and the
 * host's rounds panel so the two can never disagree about what green means.
 *
 * The status is computed server-side (`EventLobbyService`); this component
 * only names it. Strict rule by owner ruling (2026-10-01): green means the
 * cabinet checked in since the window opened AND no table has been launched
 * on it since. The one honest gap — a cabinet powered off after checking in
 * still reads green, because the cabinet sends no heartbeat — is why the
 * green copy says "checked in", not "online".
 */

export interface LobbyEntry {
    userId: string;
    displayName: string | null;
    avatarHash: string | null;
    avatarUrl: string | null;
    checkedInAt: string;
    source: 'checkin' | 'qualifier' | 'admin';
    status: LobbyStatus;
    witnessCheckinAt: string | null;
    openTable: string | null;
    lastSeenAt: string | null;
}

function LobbyPill({ status, openTable }: { status: LobbyStatus; openTable: string | null }) {
    const meta = LOBBY_STATUS_META[status];
    const title = status === 'table_open' && openTable ? `${meta.hint} (${openTable})` : meta.hint;
    return (
        <span className={`inline-flex items-center gap-1.5 text-xs ${meta.text}`} title={title}>
            <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${meta.dot}`} />
            {meta.label}
        </span>
    );
}

export default function EventLobbyRoster({ entries, viewerId, compact = false }: {
    entries: LobbyEntry[];
    /** The signed-in viewer, to mark their own row. */
    viewerId?: string | null;
    /** Host panel: no avatar, tighter rows. */
    compact?: boolean;
}) {
    if (entries.length === 0) return null;
    return (
        <ul className={compact ? 'space-y-0.5' : 'space-y-1'} data-testid="event-lobby-roster">
            {entries.map(e => {
                const name = e.displayName ?? e.userId;
                const mine = !!viewerId && e.userId === viewerId;
                return (
                    <li
                        key={e.userId}
                        className={`flex items-center gap-2 ${compact ? 'py-0.5' : 'py-1.5 px-2 rounded border border-border/20'} ${mine ? 'bg-neon-cyan/5' : ''}`}
                    >
                        {!compact && (
                            <PlayerAvatar
                                username={name}
                                discordUserId={e.userId}
                                avatarHash={e.avatarHash}
                                avatarUrl={e.avatarUrl}
                                size={22}
                            />
                        )}
                        {/* break-words, never truncate (owner rule). */}
                        <span className="flex-1 min-w-0 text-sm text-primary break-words">
                            {name}
                            {mine && <span className="ml-1 text-xs text-faint">(you)</span>}
                        </span>
                        {e.status === 'table_open' && e.openTable && !compact && (
                            <span className="text-xs text-faint break-words max-w-[40%]">{e.openTable}</span>
                        )}
                        <LobbyPill status={e.status} openTable={e.openTable} />
                    </li>
                );
            })}
        </ul>
    );
}
