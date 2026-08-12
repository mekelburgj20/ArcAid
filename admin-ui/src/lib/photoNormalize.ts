/**
 * Client-side photo-format normalization for score submissions.
 *
 * Owner field report (2026-08-11): a player's mobile score submission (photo
 * attached, iPhone) failed with the bare generic "Submission failed" and ZERO
 * server log lines. Root cause: the iPhone camera's default capture format is
 * `image/heic`, which isn't in the backend's PNG/APNG/JPEG/WebP allowlist
 * (`src/api/routes/rooms.ts`'s `roomAssetUpload` / `src/api/routes/global.ts`'s
 * `globalScoreUpload`) — multer's `fileFilter` rejected it before the route
 * handler ever ran.
 *
 * Fix: re-encode unsupported formats to JPEG on-device before upload. Safari
 * decodes HEIC natively (`createImageBitmap`/`<img>` both understand it via
 * the OS codec), so an iPhone camera photo converts right on the device — no
 * server-side transcoding needed. If decode fails (format truly unsupported
 * by this browser), the caller shows an inline error instead of uploading a
 * garbage file.
 */

/** Mimetypes the backend's upload allowlist accepts unmodified. */
export const SUPPORTED_PHOTO_TYPES = ['image/png', 'image/apng', 'image/jpeg', 'image/webp'] as const;

export function isSupportedPhotoType(type: string): boolean {
    return (SUPPORTED_PHOTO_TYPES as readonly string[]).includes(type);
}

/**
 * Decides whether `file` needs conversion and returns the file to use, or
 * `null` if conversion was needed but failed.
 *
 * v2.100.4 — supported-type files are MATERIALIZED (read fully into memory)
 * instead of passed through. Field evidence (2026-08-12, prod log lines
 * `Upload rejected ... Unexpected end of form {"mimetype":"unknown","size":"0"}`
 * from two different iPhones): iOS Safari hands the page a LAZY reference to
 * a camera-roll photo and only reads it from disk while the upload streams —
 * that read can end early, truncating the multipart body before the file
 * part arrives (busboy's "Unexpected end of form"). Reading the bytes into a
 * fresh in-memory File at pick time removes the lazy reference entirely; the
 * upload then streams from RAM. The canvas-converted path was already
 * in-memory by construction. Materialization failure falls back to the
 * original file — a lazy file that MIGHT truncate beats no photo at all.
 *
 * Kept separate from `convertToSupportedPhoto` so the decision logic (pass
 * through / convert / fail) is unit-testable with the actual canvas-based
 * converter mocked out — jsdom has no real `<canvas>` implementation.
 */
export async function normalizePhotoFile(
    file: File,
    convert: (file: File) => Promise<File | null> = convertToSupportedPhoto,
): Promise<File | null> {
    if (isSupportedPhotoType(file.type)) return materializePhotoFile(file);
    return convert(file);
}

/**
 * Reads `file` fully into memory and returns a fresh `File` over the buffer
 * (same name/type). See `normalizePhotoFile`'s doc comment for why. Falls
 * back to the original file if the read fails.
 */
export async function materializePhotoFile(file: File): Promise<File> {
    try {
        const buf = await file.arrayBuffer();
        return new File([buf], file.name || 'photo', { type: file.type });
    } catch {
        return file;
    }
}

/**
 * Re-encodes `file` to a JPEG `File` via canvas. Returns `null` if the browser
 * can't decode the source format at all (neither `createImageBitmap` nor an
 * `<img>` element could load it) or canvas export fails.
 */
export async function convertToSupportedPhoto(file: File): Promise<File | null> {
    try {
        const source = await decodeImageSource(file);
        const blob = await drawToJpegBlob(source);
        if (!blob) return null;
        return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    } catch {
        return null;
    }
}

async function decodeImageSource(file: File): Promise<ImageBitmap | HTMLImageElement> {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(file);
        } catch {
            // Fall through to the <img> decode path below — some browsers
            // reject createImageBitmap for formats their <img> tag still
            // renders (and vice versa).
        }
    }
    return decodeViaImageElement(file);
}

function decodeViaImageElement(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Image decode failed'));
        };
        img.src = url;
    });
}

function drawToJpegBlob(source: ImageBitmap | HTMLImageElement): Promise<Blob | null> {
    const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (!width || !height) return Promise.resolve(null);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(source, 0, 0, width, height);

    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.9);
    });
}
