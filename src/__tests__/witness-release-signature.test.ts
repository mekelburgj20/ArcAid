import { describe, it, expect } from 'vitest';
import {
    WITNESS_RELEASE_PUBLIC_KEY_HEX,
    isElf,
    parseReleaseSignature,
    releaseSignedMessage,
    verifyReleaseSignature,
} from '../utils/witnessReleaseSignature.js';
import { compareVersions, isReleaseVersion, logsSupported, WITNESS_LOGS_MIN_VERSION } from '../utils/witnessVersion.js';

/**
 * W100 (ADR 0040) - the release signature and the version rules both the log
 * pull (W99) and the self-update offer (W100) read.
 *
 * The test vector was made with the REAL release key (contract §3): message
 * "AW1 9.9.9\n" + "hello". The private key is never in this repo.
 */
const VECTOR_SIG_HEX = 'ea76914dfe1c57460f9cf76ae2590ac019a2b64caca258ec8712c422b1c56d3566bb83d9069590029ef46e3f927cc495a13913cd0be682f3e6e0b90b6344d001';
const VECTOR_SIG = Buffer.from(VECTOR_SIG_HEX, 'hex').toString('base64');
const VECTOR_ELF = Buffer.from('hello', 'ascii');

describe('release signature (W100)', () => {
    it('bakes the contract public key', () => {
        expect(WITNESS_RELEASE_PUBLIC_KEY_HEX).toBe('648b18ecac9ca30b24a4420d66c6c01a9ac2220676dbebde7f2fb7e5b336e520');
    });

    it('the signed message is "AW1 <version>\\n" followed by the ELF bytes', () => {
        expect(releaseSignedMessage('9.9.9', VECTOR_ELF).toString('latin1')).toBe('AW1 9.9.9\nhello');
    });

    it('the contract test vector verifies with the baked key', () => {
        expect(VECTOR_SIG).toHaveLength(88);
        expect(verifyReleaseSignature('9.9.9', VECTOR_ELF, VECTOR_SIG)).toBe(true);
        // A .sig file's trailing newline is fine.
        expect(verifyReleaseSignature('9.9.9', VECTOR_ELF, `${VECTOR_SIG}\n`)).toBe(true);
    });

    it('flipping any bit of the signature fails', () => {
        const raw = Buffer.from(VECTOR_SIG_HEX, 'hex');
        for (let bit = 0; bit < raw.length * 8; bit++) {
            const bad = Buffer.from(raw);
            bad[bit >> 3] ^= 1 << (bit & 7);
            expect(verifyReleaseSignature('9.9.9', VECTOR_ELF, bad.toString('base64'))).toBe(false);
        }
    });

    it('flipping any bit of the ELF fails', () => {
        for (let bit = 0; bit < VECTOR_ELF.length * 8; bit++) {
            const bad = Buffer.from(VECTOR_ELF);
            bad[bit >> 3] ^= 1 << (bit & 7);
            expect(verifyReleaseSignature('9.9.9', bad, VECTOR_SIG)).toBe(false);
        }
    });

    it('another version (the replay of a genuine build under a new number) fails', () => {
        for (const v of ['9.9.8', '9.9.10', '9.9.9.0', ' 9.9.9', '9.9.9-rc1', '']) {
            expect(verifyReleaseSignature(v, VECTOR_ELF, VECTOR_SIG)).toBe(false);
        }
        // Appending or dropping a byte fails too.
        expect(verifyReleaseSignature('9.9.9', Buffer.from('hello!'), VECTOR_SIG)).toBe(false);
        expect(verifyReleaseSignature('9.9.9', Buffer.from('hell'), VECTOR_SIG)).toBe(false);
    });

    it('a malformed signature is false, never a throw', () => {
        for (const bad of [undefined, null, '', 'abc', VECTOR_SIG.slice(0, 87), `${VECTOR_SIG}A`, VECTOR_SIG.replace(/=+$/, ''),
            Buffer.from(VECTOR_SIG_HEX, 'hex').toString('base64url'), VECTOR_SIG_HEX, 42, {}]) {
            expect(verifyReleaseSignature('9.9.9', VECTOR_ELF, bad)).toBe(false);
        }
        expect(parseReleaseSignature(VECTOR_SIG)?.toString('hex')).toBe(VECTOR_SIG_HEX);
        // A wrong public key is just "does not verify".
        expect(verifyReleaseSignature('9.9.9', VECTOR_ELF, VECTOR_SIG, '00'.repeat(32))).toBe(false);
        expect(verifyReleaseSignature('9.9.9', VECTOR_ELF, VECTOR_SIG, 'not-hex')).toBe(false);
    });

    it('isElf checks the 4-byte magic', () => {
        expect(isElf(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))).toBe(true);
        expect(isElf(Buffer.from([0x7f, 0x45, 0x4c]))).toBe(false);
        expect(isElf(Buffer.from('MZ\x90\x00'))).toBe(false);
        expect(isElf(Buffer.alloc(0))).toBe(false);
    });
});

describe('Witness versions (W99 / W100)', () => {
    it('compares numerically, part by part', () => {
        expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
        expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0);
        expect(compareVersions('1.10.0', '1.9.99')).toBeGreaterThan(0);
        expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
        expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
        expect(compareVersions('1.1', '1.1.0')).toBe(0);
        expect(compareVersions('1.1.0.1', '1.1.0')).toBeGreaterThan(0);
    });

    it('ignores a -suffix for ordering', () => {
        expect(compareVersions('1.1.0-rc2', '1.1.0')).toBe(0);
        expect(compareVersions('1.1.1', '1.1.0-rc9')).toBeGreaterThan(0);
        expect(compareVersions('1.0.9-rc1', '1.1.0')).toBeLessThan(0);
    });

    it('a release version is a canonical dotted-numeric triple (the path guard)', () => {
        for (const ok of ['1.1.0', '0.0.1', '10.20.300', '1.0.10']) expect(isReleaseVersion(ok)).toBe(true);
        for (const bad of ['1.1', '1.1.0.0', '1.1.0-rc1', '01.1.0', '1.01.0', ' 1.1.0', '1.1.0 ', '../1.1.0', '1.1.0/..',
            '1.1.0\0', '..', '.', '', '1..0', 'a.b.c', '1.1.0\\x', '1234567.0.0', undefined, null, 110, ['1.1.0']]) {
            expect(isReleaseVersion(bad)).toBe(false);
        }
    });

    it('logs are supported on a cabinet that reported 1.1.0 or later', () => {
        expect(WITNESS_LOGS_MIN_VERSION).toBe('1.1.0');
        expect(logsSupported('atgames', '1.1.0')).toBe(true);
        expect(logsSupported('atgames', '1.1.0-rc1')).toBe(true);
        expect(logsSupported('atgames', '1.0.10')).toBe(false);
        expect(logsSupported('atgames', '1.0.9')).toBe(false);
        expect(logsSupported('atgames', '2.0.0')).toBe(true);
        expect(logsSupported('atgames', null)).toBe(false);
        expect(logsSupported('atgames', '')).toBe(false);
        // W102: a Castcade desktop reports no build and can always be asked.
        expect(logsSupported('desktop', null)).toBe(true);
        expect(logsSupported('desktop', '1.2.0')).toBe(true);
        expect(logsSupported(null, '1.2.0')).toBe(false);
    });
});
