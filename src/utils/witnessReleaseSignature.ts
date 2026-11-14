/**
 * W100 - the signature on an Arcaid Witness cabinet release (ADR 0040).
 *
 * A release is an ELF plus an Ed25519 signature (RFC 8032 pure: what Node's
 * `crypto.sign(null, msg, key)` produces) over
 *
 *     ASCII "AW1 " + version + "\n"  ||  the exact ELF bytes
 *
 * carried as standard base64 (64 bytes -> 88 characters). Binding the version
 * into the signed bytes means a genuine old build cannot be offered under a
 * new number; the cabinet's own "newer than what I run" rule closes the rest
 * of the replay.
 *
 * The PUBLIC key below is compiled into the cabinet app too. The private key
 * never touches this repo: it stays on the owner's PC and is only read by
 * `scripts/witness-release.ts`. The server checks the signature at upload so a
 * build every cabinet would reject is refused at the door; the cabinet checks
 * it again before installing, so the server is never what is trusted.
 *
 * Pure: no database, no clock.
 */
import crypto from 'crypto';

/** Raw 32-byte Ed25519 public key, hex. Baked into the cabinet app AND the server. */
export const WITNESS_RELEASE_PUBLIC_KEY_HEX = '648b18ecac9ca30b24a4420d66c6c01a9ac2220676dbebde7f2fb7e5b336e520';

/** The 4 bytes every ELF starts with. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** Standard base64 of exactly 64 bytes: 86 characters and `==`. */
const SIG_B64_RE = /^[A-Za-z0-9+/]{86}==$/;

const keyCache = new Map<string, crypto.KeyObject | null>();

/** Raw 32-byte Ed25519 key (hex) -> a Node public key object, or null when it is not one. */
export function ed25519PublicKeyFromHex(hex: string): crypto.KeyObject | null {
    if (keyCache.has(hex)) return keyCache.get(hex)!;
    let key: crypto.KeyObject | null = null;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        try {
            key = crypto.createPublicKey({
                key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
                format: 'jwk',
            });
        } catch {
            key = null;
        }
    }
    keyCache.set(hex, key);
    return key;
}

/** The bytes the signature covers: `"AW1 <version>\n"` followed by the ELF. */
export function releaseSignedMessage(version: string, elf: Buffer): Buffer {
    return Buffer.concat([Buffer.from(`AW1 ${version}\n`, 'ascii'), elf]);
}

/** Does this buffer start with the ELF magic (`\x7fELF`)? */
export function isElf(bytes: Buffer): boolean {
    return bytes.length >= ELF_MAGIC.length && bytes.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC);
}

/**
 * Standard base64 of a 64-byte signature -> the bytes, or null when it is not
 * exactly that (surrounding whitespace, e.g. a `.sig` file's newline, is allowed).
 */
export function parseReleaseSignature(sigBase64: unknown): Buffer | null {
    if (typeof sigBase64 !== 'string') return null;
    const s = sigBase64.trim();
    if (!SIG_B64_RE.test(s)) return null;
    const sig = Buffer.from(s, 'base64');
    return sig.length === 64 ? sig : null;
}

/**
 * Does `sigBase64` verify over `releaseSignedMessage(version, elf)`? Checked
 * against the baked public key unless another raw key (hex) is passed. Never
 * throws: anything malformed is simply `false`.
 */
export function verifyReleaseSignature(
    version: string, elf: Buffer, sigBase64: unknown,
    publicKeyHex: string = WITNESS_RELEASE_PUBLIC_KEY_HEX,
): boolean {
    const sig = parseReleaseSignature(sigBase64);
    if (!sig || typeof version !== 'string' || !Buffer.isBuffer(elf)) return false;
    const key = ed25519PublicKeyFromHex(publicKeyHex);
    if (!key) return false;
    try {
        return crypto.verify(null, releaseSignedMessage(version, elf), key, sig);
    } catch {
        return false;
    }
}
