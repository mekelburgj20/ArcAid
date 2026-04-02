import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import NeonButton from './NeonButton';

interface ImageCropperProps {
  imageSrc: string;
  aspectRatio: number;
  maxOutputWidth: number;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
}

export default function ImageCropper({ imageSrc, aspectRatio, maxOutputWidth, onConfirm, onCancel }: ImageCropperProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);

  const onCropComplete = useCallback((_croppedArea: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels);
  }, []);

  const handleConfirm = async () => {
    if (!croppedAreaPixels) return;
    setProcessing(true);
    try {
      const blob = await cropImage(imageSrc, croppedAreaPixels, maxOutputWidth);
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
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
          style={{
            containerStyle: { background: '#111' },
          }}
        />
      </div>

      {/* Controls */}
      <div className="bg-surface border-t border-border p-4 space-y-3">
        {/* Zoom slider */}
        <div className="flex items-center gap-3 max-w-md mx-auto">
          <span className="text-xs text-muted w-10">Zoom</span>
          <input
            type="range"
            min={1}
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
async function cropImage(imageSrc: string, pixelCrop: Area, maxWidth: number): Promise<Blob> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');

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
