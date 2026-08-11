import { describe, it, expect, vi } from 'vitest';
import { normalizePhotoFile, isSupportedPhotoType, SUPPORTED_PHOTO_TYPES } from '../photoNormalize';

/**
 * Owner field report (2026-08-11): an iPhone score-photo upload (default
 * capture format `image/heic`) failed the backend's PNG/APNG/JPEG/WebP
 * allowlist with a bare, unlogged 500. The fix re-encodes unsupported formats
 * to JPEG client-side via canvas before upload.
 *
 * jsdom has no real `<canvas>` (tests print "Not implemented: getContext"
 * warnings if it's exercised), so this file tests only the DECISION logic in
 * `normalizePhotoFile` — pass-through / convert / fail — with the actual
 * canvas-based `convertToSupportedPhoto` swapped out for a mock. The real
 * conversion code lives entirely inside `photoNormalize.ts` and is exercised
 * manually / by the component in a real browser.
 */

function makeFile(name: string, type: string): File {
    return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

describe('isSupportedPhotoType', () => {
    it('accepts exactly the backend allowlist', () => {
        for (const type of SUPPORTED_PHOTO_TYPES) {
            expect(isSupportedPhotoType(type)).toBe(true);
        }
        expect(isSupportedPhotoType('image/heic')).toBe(false);
        expect(isSupportedPhotoType('image/gif')).toBe(false);
        expect(isSupportedPhotoType('')).toBe(false);
    });
});

describe('normalizePhotoFile — decision logic', () => {
    it('returns a supported-type file untouched, without invoking the converter', async () => {
        const file = makeFile('score.png', 'image/png');
        const convert = vi.fn();

        const result = await normalizePhotoFile(file, convert);

        expect(result).toBe(file);
        expect(convert).not.toHaveBeenCalled();
    });

    it('routes an unsupported-type file through the converter and returns its result', async () => {
        const file = makeFile('IMG_0001.heic', 'image/heic');
        const converted = makeFile('photo.jpg', 'image/jpeg');
        const convert = vi.fn().mockResolvedValue(converted);

        const result = await normalizePhotoFile(file, convert);

        expect(convert).toHaveBeenCalledTimes(1);
        expect(convert).toHaveBeenCalledWith(file);
        expect(result).toBe(converted);
    });

    it('propagates a converter failure (null) so the caller can show an inline error', async () => {
        const file = makeFile('IMG_0002.heic', 'image/heic');
        const convert = vi.fn().mockResolvedValue(null);

        const result = await normalizePhotoFile(file, convert);

        expect(result).toBeNull();
    });

    it('defaults to the real convertToSupportedPhoto when no converter is injected (still gated by type)', async () => {
        // No mock passed — this exercises the default-parameter wiring only;
        // a supported type short-circuits before the real converter runs, so
        // this stays canvas-free.
        const file = makeFile('score.webp', 'image/webp');
        const result = await normalizePhotoFile(file);
        expect(result).toBe(file);
    });
});
