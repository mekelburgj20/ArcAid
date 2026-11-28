import { CABINET_SCREEN_CHOICES, type CabinetScreenKey } from '../services/cabinetFrameTypes.js';

/**
 * W132.2 (ADR 0046) - `witness_device_players.cabinet_screens`, one player's
 * choice of what their cabinet's backglass and DMD show while the Witness tile
 * is open, as stored and as every reader takes it:
 *
 *   NULL                          every screen on, 10 s each (the default)
 *   {"screens":[...],"seconds":N} those screens (in the fixed screen order),
 *                                 N seconds each, clamped to 6..30
 *
 * Unknown keys and unknown screen names are dropped; a malformed value reads
 * as the default, never as "nothing on". `screens: []` is a real choice (all
 * off). `pair` is never a choice. The ONE reader of the column.
 */

export type CabinetScreenChoice = Exclude<CabinetScreenKey, 'pair'>;

export interface CabinetScreenPrefs {
    screens: CabinetScreenChoice[];
    seconds: number;
}

export const CABINET_SECONDS_DEFAULT = 10;
export const CABINET_SECONDS_MIN = 6;
export const CABINET_SECONDS_MAX = 30;

/** The default: every choice on, 10 s. A fresh object each call (callers may keep it). */
export function defaultCabinetScreens(): CabinetScreenPrefs {
    return { screens: [...CABINET_SCREEN_CHOICES], seconds: CABINET_SECONDS_DEFAULT };
}

/** Seconds as a whole number in 6..30; anything that is not a finite number is the default. */
function clampSeconds(value: unknown): number {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return CABINET_SECONDS_DEFAULT;
    return Math.min(CABINET_SECONDS_MAX, Math.max(CABINET_SECONDS_MIN, Math.round(n)));
}

/** The known screen names in `value`, in the fixed screen order, each once. */
function knownScreens(value: unknown[]): CabinetScreenChoice[] {
    const wanted = new Set(value.filter((v): v is string => typeof v === 'string'));
    return CABINET_SCREEN_CHOICES.filter(key => wanted.has(key));
}

/** Normalise an already-parsed object (a stored value or a PUT body). */
export function normalizeCabinetScreens(value: unknown): CabinetScreenPrefs {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultCabinetScreens();
    const raw = value as { screens?: unknown; seconds?: unknown };
    return {
        screens: Array.isArray(raw.screens) ? knownScreens(raw.screens) : [...CABINET_SCREEN_CHOICES],
        seconds: clampSeconds(raw.seconds),
    };
}

/** The column as stored (TEXT JSON or NULL) -> the player's choices. */
export function parseCabinetScreens(stored: string | null | undefined): CabinetScreenPrefs {
    if (stored == null || stored === '') return defaultCabinetScreens();
    try {
        return normalizeCabinetScreens(JSON.parse(stored));
    } catch {
        return defaultCabinetScreens();
    }
}
