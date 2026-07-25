import { describe, it, expect } from 'vitest';
import {
    isDiscordUserId,
    isGoogleUserId,
    isProviderUserId,
    providerOfUserId,
} from '../utils/identityProvider.js';

describe('identityProvider helpers (Google login, v2.35.0)', () => {
    describe('isDiscordUserId', () => {
        it('accepts 17-20 digit snowflakes', () => {
            expect(isDiscordUserId('12345678901234567')).toBe(true); // 17
            expect(isDiscordUserId('123456789012345678901')).toBe(false); // 21 (too long)
            expect(isDiscordUserId('1234567890123456789')).toBe(true); // 19
            expect(isDiscordUserId('12345678901234567890')).toBe(true); // 20
        });

        it('rejects non-snowflake strings', () => {
            expect(isDiscordUserId('google:abc123')).toBe(false);
            expect(isDiscordUserId('SYSTEM')).toBe(false);
            expect(isDiscordUserId('')).toBe(false);
            expect(isDiscordUserId('123')).toBe(false); // too short
            expect(isDiscordUserId('iscored:bob')).toBe(false);
        });
    });

    describe('isGoogleUserId', () => {
        it('accepts google:-prefixed ids', () => {
            expect(isGoogleUserId('google:1234567890')).toBe(true);
            expect(isGoogleUserId('google:')).toBe(true); // prefix match only, edge case
        });

        it('rejects everything else', () => {
            expect(isGoogleUserId('123456789012345678')).toBe(false);
            expect(isGoogleUserId('iscored:bob')).toBe(false);
            expect(isGoogleUserId('')).toBe(false);
            expect(isGoogleUserId('Google:notlowercase')).toBe(false);
        });
    });

    describe('isProviderUserId', () => {
        it('accepts both discord and google ids', () => {
            expect(isProviderUserId('123456789012345678')).toBe(true);
            expect(isProviderUserId('google:xyz')).toBe(true);
        });

        it('rejects usernames/handles', () => {
            expect(isProviderUserId('Bob')).toBe(false);
            expect(isProviderUserId('iscored:bob')).toBe(false);
            expect(isProviderUserId('')).toBe(false);
        });
    });

    describe('providerOfUserId', () => {
        it('returns google for google:-prefixed ids', () => {
            expect(providerOfUserId('google:12345')).toBe('google');
        });

        it('defaults to discord for anything else (legacy/absent = discord)', () => {
            expect(providerOfUserId('123456789012345678')).toBe('discord');
            expect(providerOfUserId('Bob')).toBe('discord');
            expect(providerOfUserId('')).toBe('discord');
        });
    });
});
