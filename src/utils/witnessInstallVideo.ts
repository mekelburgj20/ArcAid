/**
 * The install-video address the super-admin can set (global setting
 * `WITNESS_INSTALL_VIDEO_URL`). Pure: `null` clears, a string is a valid
 * absolute https address, `undefined` is invalid.
 */
export const INSTALL_VIDEO_SETTING_KEY = 'WITNESS_INSTALL_VIDEO_URL';
export const INSTALL_VIDEO_MAX_LENGTH = 500;

export function normalizeInstallVideoUrl(raw: unknown): string | null | undefined {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    if (value === '') return null;
    if (value.length > INSTALL_VIDEO_MAX_LENGTH) return undefined;
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f\u007f"<>]/.test(value)) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname) return undefined;
    return value;
}
