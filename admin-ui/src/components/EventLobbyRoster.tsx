import { PlayerAvatar } from './ScoreboardComponents';

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

export type LobbyStatus = 'ready' | 'table_open' | 'no_checkin' | 'no_cabinet';

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

export const LOBBY_STATUS_META: Record<LobbyStatus, { label: string; dot: string; text: string; hint: string }> = {
    ready: {
        label: 'Ready',
        dot: 'bg-neon-green',
        text: 'text-neon-green',
        hint: 'Arcaid Witness checked in and no table is open on the cabinet.',
    },
    table_open: {
        label: 'Exit the table',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'A table was opened after the Witness checked in. Exit to the cabinet menu, then open the Arcaid Witness tile again.',
    },
    no_checkin: {
        label: 'Open the Witness tile',
        dot: 'bg-neon-amber',
        text: 'text-neon-amber',
        hint: 'A cabinet is paired but has not checked in since check-in opened. Open the Arcaid Witness tile on the cabinet.',
    },
    no_cabinet: {
        label: 'No cabinet',
        dot: 'bg-faint',
        text: 'text-faint',
        hint: 'No paired cabinet. Scores will post, unverified.',
    },
};

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
