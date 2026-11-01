import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import NeonButton from './NeonButton';
import { visibleCropRect } from '../lib/cropRect';

/**
 * What you see in the box is what gets saved.
 *
 * react-easy-crop's `croppedAreaPixels` always has the requested aspect: for a
 * wide image under a 1:1 crop it reports a square the height of the image, no
 * matter how far out the user zooms (`computeCroppedArea` sizes the output from
 * the image's height, then clamps). Zooming out so a wide logo "fits inside
 * the box" therefore still saved a square with the logo's right side cut off
 * and transparent padding on the left (ProBros Gaming, 2026-11-01). So the
 * output rectangle is computed here instead: the crop box in image pixels
 * (from the PERCENTAGE area, which is not aspect-forced), intersected with the
 * image. Zoomed in, that is the same aspect-true crop as before; zoomed out,
 * it is the whole image at its own shape — never padding, never a clamp.
 */
interface ImageCropperProps {
  imageSrc: string;
  aspectRatio: number;
  maxOutputWidth: number;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
  notice?: string;
}

export default function ImageCropper({ imageSrc, aspectRatio, maxOutputWidth, onConfirm, onCancel, notice }: ImageCropperProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPct, setCroppedAreaPct] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);
  const [sourceIsSquare, setSourceIsSquare] = useState<boolean | null>(null);
  const [mediaLoaded, setMediaLoaded] = useState(false);

  const handleMediaLoaded = useCallback((media: { naturalWidth: number; naturalHeight: number }) => {
    const ratio = media.naturalWidth / media.naturalHeight;
    // Consider within 1% of square to be square (accounts for PNG rounding)
    setSourceIsSquare(Math.abs(ratio - 1) < 0.01);
    setMediaLoaded(true);
  }, []);

  const showNonSquareWarning = notice === 'square-badge' && mediaLoaded && sourceIsSquare === false;

  const onCropComplete = useCallback((croppedArea: Area) => {
    setCroppedAreaPct(croppedArea);
  }, []);

  const handleConfirm = async () => {
    if (!croppedAreaPct) return;
    setProcessing(true);
    try {
      const blob = await cropImage(imageSrc, croppedAreaPct, maxOutputWidth);
      onConfirm(blob);
    } catch {
      // If canvas fails, pass the original
      onCancel();
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex flex-col">
      {/* Crop area */}
      <div className="flex-1 relative">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={aspectRatio}
          // The slider goes below 100% so a logo that is wider than the box
          // can be kept whole. Below 100% the image is smaller than the box,
          // so the library's position clamp (which assumes the image covers
          // the box) is switched off and the reported area is left unclamped
          // — cropImage() intersects it with the image itself.
          minZoom={0.25}
          restrictPosition={zoom >= 1}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
          onMediaLoaded={handleMediaLoaded}
          style={{
            containerStyle: { background: '#111' },
          }}
        />
        {showNonSquareWarning && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-neon-cyan/15 border border-neon-cyan/50 text-neon-cyan text-xs px-4 py-2 rounded max-w-md text-center">
            This logo isn't square. Zoom out to keep the whole logo, or zoom in to pick a square. The Global Scoreboard badge shows its centre square either way.
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-surface border-t border-border p-4 space-y-3">
        {/* Zoom slider */}
        <div className="flex items-center gap-3 max-w-md mx-auto">
          <span className="text-xs text-muted w-10">Zoom</span>
          <input
            type="range"
            min={0.25}
            max={3}
            step={0.05}
            value={zoom}
            onChange={e => setZoom(Number(e.target.value))}
            className="flex-1 accent-neon-cyan cursor-pointer"
          />
          <span className="text-xs text-muted w-10 text-right">{Math.round(zoom * 100)}%</span>
        </div>

        {/* Aspect ratio label */}
        <p className="text-center text-xs text-faint">
          {aspectRatio === 1 ? 'Square (1:1)' : aspectRatio === 16 / 9 ? 'Landscape (16:9)' : `Wide (${Math.round(aspectRatio)}:1)`}
        </p>

        {/* Buttons */}
        <div className="flex justify-center gap-3">
          <NeonButton variant="ghost" onClick={onCancel} disabled={processing}>Cancel</NeonButton>
          <NeonButton onClick={handleConfirm} disabled={processing}>
            {processing ? 'Processing...' : 'Confirm Crop'}
          </NeonButton>
        </div>
      </div>
    </div>
  );
}

/**
 * Crops and resizes an image using a canvas.
 */
async function cropImage(imageSrc: string, pct: Area, maxWidth: number): Promise<Blob> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');

  const pixelCrop = visibleCropRect(pct, image.naturalWidth, image.naturalHeight);

  // Calculate output dimensions respecting maxWidth
  const scale = pixelCrop.width > maxWidth ? maxWidth / pixelCrop.width : 1;
  canvas.width = Math.round(pixelCrop.width * scale);
  canvas.height = Math.round(pixelCrop.height * scale);

  ctx.drawImage(
    image,
    pixelCrop.x, pixelCrop.y,
    pixelCrop.width, pixelCrop.height,
    0, 0,
    canvas.width, canvas.height,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas toBlob failed'));
    }, 'image/png');
  });
}

function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', reject);
    img.src = url;
  });
}
