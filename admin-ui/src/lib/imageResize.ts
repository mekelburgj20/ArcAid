/**
 * Resize an image File/Blob so its longest side fits within a (maxWidth ×
 * maxHeight) bounding box, preserving aspect ratio. Returns a PNG Blob.
 *
 * Used for image uploads where no fixed-aspect crop is desired — the live
 * render handles aspect adaptation via CSS `background-size: cover` /
 * `object-fit: cover`. Compare with `cropImage` in `ImageCropper.tsx`,
 * which crops to a fixed aspect.
 */
export async function resizeImageToMaxBox(
    source: File | Blob,
    maxWidth: number,
    maxHeight: number,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
): Promise<Blob> {
    const url = URL.createObjectURL(source);
    try {
        const image = await loadImage(url);
        const w = image.naturalWidth;
        const h = image.naturalHeight;
        if (!w || !h) throw new Error('Invalid image dimensions');

        const scale = Math.min(1, maxWidth / w, maxHeight / h);
        const outW = Math.max(1, Math.round(w * scale));
        const outH = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');
        ctx.drawImage(image, 0, 0, outW, outH);

        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                blob => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
                mimeType,
            );
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.addEventListener('load', () => resolve(img));
        img.addEventListener('error', reject);
        img.src = url;
    });
}
