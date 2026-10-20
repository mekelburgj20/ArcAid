/**
 * Room default timezone (game_room_settings `ROOM_TIMEZONE`, an IANA zone).
 *
 * Every admin surface where a time is entered or shown defaults to — and is
 * labelled with — the ROOM's zone. A saved tournament's own
 * `cadence.timezone` stays the per-object override. Public pages are out of
 * scope: they render in the viewer's browser zone.
 */
export { zoneLabel } from './pollForm';

export const ROOM_TIMEZONE_KEY = 'ROOM_TIMEZONE';

/** Pre-setting behaviour: every admin time used to be hard-coded to Chicago. */
export const DEFAULT_TIMEZONE = 'America/Chicago';

/** The room's zone from a settings map; DEFAULT when absent or blank. */
export function resolveRoomTimezone(settings: Record<string, string> | null | undefined): string {
  const raw = settings?.[ROOM_TIMEZONE_KEY];
  const tz = typeof raw === 'string' ? raw.trim() : '';
  return tz || DEFAULT_TIMEZONE;
}

/**
 * Parse the timestamp shapes the API ships: SQLite `YYYY-MM-DD HH:MM:SS`
 * (UTC, no zone marker) and ISO strings with `Z` or an offset.
 */
function parseTimestamp(iso: string): Date {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso.trim());
  return new Date(hasZone ? iso : `${iso.trim().replace(' ', 'T')}Z`);
}

const FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
};

/** "Oct 20, 10:00 PM CDT" in `timeZone`; `'--'` for null, raw input when unparseable. */
export function formatInZone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '--';
  const d = parseTimestamp(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, { ...FORMAT, timeZone });
  } catch {
    // Invalid zone string — fall back to the browser's own zone, still labelled.
    return d.toLocaleString(undefined, FORMAT);
  }
}
