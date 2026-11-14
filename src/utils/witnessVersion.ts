/**
 * W99 / W100 - Arcaid Witness build versions.
 *
 * A cabinet reports its build as `v=` on the check-in and the heartbeat
 * (`parseAppVersion` in WitnessService decides what is stored: `1.0.8`,
 * `1.0.8.2`, `1.0.8-rc2`). Two features read that string as a NUMBER rather
 * than as a label: the log pull (a cabinet must be on 1.1.0 or later to answer
 * a log request; a Castcade desktop reports no build and is always asked) and the self-update offer (a release is offered only when it
 * is numerically newer than what the cabinet runs). This module is the ONE
 * comparison both use, so `1.0.10` is newer than `1.0.9` everywhere.
 *
 * Pure: no database, no clock.
 */

/** The first cabinet build that can answer a log request (W99). */
export const WITNESS_LOGS_MIN_VERSION = '1.1.0';

/**
 * The shape a RELEASE version must have: a dotted-numeric triple with no
 * suffix and no leading zeros (so two spellings of one number, `1.01.0` and
 * `1.1.0`, can never be two releases). A release's files live under a
 * directory named by its version, so this test is also the path-traversal
 * guard: nothing that fails it ever reaches the filesystem.
 */
const RELEASE_VERSION_RE = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

export function isReleaseVersion(value: unknown): value is string {
    return typeof value === 'string' && RELEASE_VERSION_RE.test(value);
}

function numericParts(version: string): number[] {
    // A `-suffix` (`1.1.0-rc2`) is ignored for ordering: it compares as `1.1.0`.
    const core = version.trim().split('-')[0] ?? '';
    return core.split('.').map(p => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    });
}

/**
 * Numeric dotted compare: negative when `a` is older than `b`, 0 when equal,
 * positive when newer. Parts compare as numbers (`1.0.10` > `1.0.9`), a
 * missing part is 0 (`1.1` = `1.1.0`), and a `-suffix` is ignored.
 */
export function compareVersions(a: string, b: string): number {
    const pa = numericParts(a);
    const pb = numericParts(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/**
 * W99 - can this device answer a log request? A CABINET (`device_type`
 * `atgames`) that last reported a build of at least
 * `WITNESS_LOGS_MIN_VERSION`; a cabinet that never reported a build cannot.
 *
 * W102 - a Castcade DESKTOP always can be asked. Castcade sends no `v` on its
 * heartbeat (a version there would meet the cabinet update offer), so there
 * is nothing to compare: Castcade 0.2.41 and later answer, an older one
 * leaves the request to expire after 15 minutes like a cabinet that is off.
 */
export function logsSupported(deviceType: string | null | undefined, appVersion: string | null | undefined): boolean {
    if (deviceType === 'desktop') return true;
    if (deviceType !== 'atgames') return false;
    if (!appVersion || !appVersion.trim()) return false;
    return compareVersions(appVersion, WITNESS_LOGS_MIN_VERSION) >= 0;
}
