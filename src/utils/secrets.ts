import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Symmetric encryption for at-rest secrets (per-room iScored passwords today,
 * future credential fields by allowlist). AES-256-GCM via Node stdlib.
 *
 * Format: `enc:v1:<base64(iv || ciphertext || authTag)>`
 *   - iv:          12 bytes (GCM standard nonce size)
 *   - ciphertext:  variable
 *   - authTag:     16 bytes
 *
 * The `enc:v1:` prefix is both a detection marker (distinguishes ciphertext
 * from plaintext during migrations) and a scheme version (future rotation
 * without a breaking change).
 *
 * Master key: SECRETS_KEY env var, 32 raw bytes base64-encoded. Generate via
 * `npm run generate-secrets-key`. Missing key is fail-closed — any encrypt/
 * decrypt throws. A dedicated env var (not HKDF(JWT_SECRET)) keeps rotation
 * concerns separate.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
export const ENC_PREFIX = 'enc:v1:';
export const ENC_MASK_PREFIX = 'mask:';

/** Sentinel returned to the admin UI in place of decrypted secret values. */
export function maskFor(key: string): string {
    return `${ENC_MASK_PREFIX}${key}`;
}

export function isMask(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(ENC_MASK_PREFIX);
}

export function isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Keys that MUST be stored encrypted. SettingsService and GameRoomSettingsService
 * consult this registry to encrypt on write and decrypt on read. Deliberate
 * allowlist — no convention-based auto-encryption (a typo like `IS_CORED_PASSWORD`
 * would never land here without a code review).
 */
export const ENCRYPTED_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
    'ISCORED_PASSWORD',
]);

export function isEncryptedKey(key: string): boolean {
    return ENCRYPTED_SETTING_KEYS.has(key);
}

function loadKey(): Buffer {
    const raw = process.env.SECRETS_KEY;
    if (!raw) {
        throw new Error(
            'SECRETS_KEY is not set. Generate one with `npm run generate-secrets-key` and add it to .env.',
        );
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
        throw new Error(
            `SECRETS_KEY must decode to ${KEY_BYTES} bytes (base64). Got ${buf.length}. Regenerate with \`npm run generate-secrets-key\`.`,
        );
    }
    return buf;
}

/**
 * Returns true when `SECRETS_KEY` is configured and decodes to the expected
 * length. Used by the startup guard — if any encrypted row exists but the key
 * is missing, we fail fast rather than silently break.
 */
export function isKeyConfigured(): boolean {
    try {
        loadKey();
        return true;
    } catch {
        return false;
    }
}

export function encryptSecret(plaintext: string): string {
    if (typeof plaintext !== 'string') {
        throw new Error('encryptSecret: plaintext must be a string');
    }
    const key = loadKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, ct, tag]);
    return ENC_PREFIX + payload.toString('base64');
}

/**
 * Replaces values of encrypted keys with a mask sentinel so decrypted plaintext
 * never reaches the admin UI. Non-secret keys and empty secrets pass through.
 * Call this on any settings record headed for an HTTP response.
 */
export function maskEncryptedValues(settings: Record<string, string>): Record<string, string> {
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
        if (isEncryptedKey(key) && value !== '' && value != null) {
            masked[key] = maskFor(key);
        } else {
            masked[key] = value;
        }
    }
    return masked;
}

export function decryptSecret(ciphertext: string): string {
    if (!isEncrypted(ciphertext)) {
        throw new Error('decryptSecret: value is not an enc:v1: ciphertext');
    }
    const key = loadKey();
    const payload = Buffer.from(ciphertext.slice(ENC_PREFIX.length), 'base64');
    if (payload.length < IV_BYTES + TAG_BYTES) {
        throw new Error('decryptSecret: ciphertext too short to be valid');
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(payload.length - TAG_BYTES);
    const ct = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
}
