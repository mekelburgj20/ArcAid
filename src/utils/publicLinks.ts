import { tournamentUrlSlug } from './tournamentSlug.js';

/**
 * The deployment's public origin, for links written into Discord copy.
 *
 * `PUBLIC_URL` is the pre-existing knob (`submitscore.ts`,
 * `NotificationService`, `WebPushService` all read it); `https://arcaid.app`
 * is the hardcoded fallback those call sites — and `TournamentEngine`'s pick
 * links — already use. Centralised here so a new link doesn't have to pick a
 * side. Trailing slashes are trimmed so callers can always concatenate.
 */
export function publicBaseUrl(): string {
    return (process.env.PUBLIC_URL || 'https://arcaid.app').replace(/\/+$/, '');
}

/**
 * A room's public page — the scoreboard, since `/:slug` renders it as the
 * index route. Used by the callout responders and by any Discord copy that
 * needs to point a player at 'where the scores live'.
 */
export function roomUrl(slug: string): string {
    return `${publicBaseUrl()}/${slug}`;
}

/**
 * A room's Picks page. With `tournamentName` it deep-links to that
 * tournament's tab via the human slug (`?t=daily_grind`), matching
 * `TournamentEngine.announceNomineeOnboarding`.
 */
export function roomPicksUrl(slug: string, tournamentName?: string | null): string {
    const base = `${publicBaseUrl()}/${slug}/picks`;
    return tournamentName ? `${base}?t=${tournamentUrlSlug(tournamentName)}` : base;
}

/**
 * Account Settings — the surface that owns iScored-name claiming (P1). Used by
 * rotation copy that has to tell an unlinked leader where to go; a room-scoped
 * link would be wrong, because `user_mappings` is global and Account Settings
 * is where the claim form lives.
 */
export function accountSettingsUrl(): string {
    return `${publicBaseUrl()}/account/settings`;
}
