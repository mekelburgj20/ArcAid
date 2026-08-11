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
 * Kept separate from `convertToSupportedPhoto` so the decision logic (pass
 * through / convert / fail) is unit-testable with the actual canvas-based
 * converter mocked out — jsdom has no real `<canvas>` implementation.
 */
export async function normalizePhotoFile(
    file: File,
    convert: (file: File) => Promise<File | null> = convertToSupportedPhoto,
): Promise<File | null> {
    if (isSupportedPhotoType(file.type)) return file;
    return convert(file);
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
