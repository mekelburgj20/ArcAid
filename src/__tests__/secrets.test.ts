import { describe, it, expect } from 'vitest';
import {
    encryptSecret,
    decryptSecret,
    isEncrypted,
    isKeyConfigured,
    isEncryptedKey,
    ENCRYPTED_SETTING_KEYS,
    maskFor,
    isMask,
    maskEncryptedValues,
    ENC_PREFIX,
} from '../utils/secrets.js';

describe('secrets crypto', () => {
    it('round-trips plaintext through encrypt/decrypt', () => {
        const plaintext = 'hunter2 hunter2 hunter2';
        const ct = encryptSecret(plaintext);
        expect(ct.startsWith(ENC_PREFIX)).toBe(true);
        expect(isEncrypted(ct)).toBe(true);
        expect(decryptSecret(ct)).toBe(plaintext);
    });

    it('produces different ciphertext on every call (random IV)', () => {
        const a = encryptSecret('same');
        const b = encryptSecret('same');
        expect(a).not.toBe(b);
        expect(decryptSecret(a)).toBe(decryptSecret(b));
    });

    it('rejects non-ciphertext input on decryptSecret', () => {
        expect(() => decryptSecret('plain text, not a ciphertext')).toThrow();
    });

    it('rejects truncated ciphertext', () => {
        expect(() => decryptSecret(`${ENC_PREFIX}abc`)).toThrow();
    });

    it('rejects tampered ciphertext (authTag mismatch)', () => {
        const ct = encryptSecret('original value');
        // Flip a byte in the middle of the base64 payload — GCM authTag should reject.
        const body = ct.slice(ENC_PREFIX.length);
        const flipped = body.slice(0, -4) + (body.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
        expect(() => decryptSecret(`${ENC_PREFIX}${flipped}`)).toThrow();
    });

    it('supports empty string round-trip', () => {
        expect(decryptSecret(encryptSecret(''))).toBe('');
    });

    it('isKeyConfigured returns true when SECRETS_KEY is set', () => {
        expect(isKeyConfigured()).toBe(true);
    });

    it('isEncryptedKey honors the registry', () => {
        expect(isEncryptedKey('ISCORED_PASSWORD')).toBe(true);
        expect(isEncryptedKey('ISCORED_USERNAME')).toBe(false);
        expect(isEncryptedKey('some_random_key')).toBe(false);
        expect(ENCRYPTED_SETTING_KEYS.has('ISCORED_PASSWORD')).toBe(true);
    });

    it('mask helpers are symmetric', () => {
        const m = maskFor('ISCORED_PASSWORD');
        expect(isMask(m)).toBe(true);
        expect(isMask('plain')).toBe(false);
        expect(isMask('')).toBe(false);
    });

    it('maskEncryptedValues replaces secret values and leaves others alone', () => {
        const input = {
            ISCORED_PASSWORD: 'secret',
            ISCORED_USERNAME: 'alice',
            SOME_FLAG: 'true',
            EMPTY_SECRET: '',
        };
        const masked = maskEncryptedValues(input);
        expect(masked.ISCORED_PASSWORD).toBe(maskFor('ISCORED_PASSWORD'));
        expect(masked.ISCORED_USERNAME).toBe('alice');
        expect(masked.SOME_FLAG).toBe('true');
        // Empty secret stays empty — nothing to mask.
        expect(masked.EMPTY_SECRET).toBe('');
    });
});
