/**
 * Magic-byte validation for uploaded image files.
 *
 * multer's memoryStorage only exposes the client-supplied MIME type, which is
 * fully spoofable. This inspects the actual leading bytes of the buffer so only
 * genuine PNG/APNG, JPEG, and WebP images are persisted.
 */

/** PNG (and APNG, which shares the signature): 89 50 4E 47 0D 0A 1A 0A */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** JPEG (JFIF/EXIF/raw): FF D8 FF */
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
/** WebP container markers: ASCII "RIFF" at bytes 0-3 and "WEBP" at bytes 8-11. */
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii');

/**
 * Returns true only when the buffer's leading bytes match an allowed image
 * signature (PNG/APNG, JPEG, or WebP). Returns false for any other content and
 * for buffers shorter than 12 bytes (the minimum needed to check WebP).
 */
export function isAllowedImage(buffer: Buffer): boolean {
    if (!buffer || buffer.length < 12) {
        return false;
    }

    // PNG / APNG share the same 8-byte signature.
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return true;
    }

    // JPEG: FF D8 FF.
    if (buffer.subarray(0, 3).equals(JPEG_SIGNATURE)) {
        return true;
    }

    // WebP: raw-byte "RIFF" at 0-3 AND "WEBP" at 8-11. Compared as bytes (not via
    // toString('ascii'), which masks the high bit and would accept crafted
    // high-bit-set buffers that alias to RIFF/WEBP).
    if (buffer.subarray(0, 4).equals(RIFF_SIGNATURE) && buffer.subarray(8, 12).equals(WEBP_SIGNATURE)) {
        return true;
    }

    return false;
}
