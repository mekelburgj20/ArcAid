import { useState } from 'react';
import { X } from 'lucide-react';
import NeonButton from './NeonButton';
import ImageCropper from './ImageCropper';
import { resizeImageToMaxBox } from '../lib/imageResize';
import { api } from '../lib/api';

/**
 * The art-pack upload form, lifted verbatim out of `StylePicker.tsx` in
 * v2.119.0 (C2) so the new `CardStyleEditor` can host the SAME form the modal
 * hosts. Nothing about it changed in the move — 30MB cap, cropper for
 * identifiers (square 1:1 or wide 3:1), 1920² box resize for backgrounds,
 * at least one image required.
 *
 * It lives here rather than being exported from StylePicker because C3 deletes
 * StylePicker outright; the form outlives it.
 */
const MAX_UPLOAD_SIZE = 30 * 1024 * 1024; // 30 MB

export default function StyleUploadForm({ uploadPath, gameName, onUploaded, onCancel }: {
  uploadPath: string;
  gameName?: string;
  onUploaded: (newStyleId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(gameName || '');
  const [author, setAuthor] = useState('');
  const [bgFile, setBgFile] = useState<File | null>(null);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [bgPreview, setBgPreview] = useState<string | null>(null);
  const [headerPreview, setHeaderPreview] = useState<string | null>(null);
  const [cropperSrc, setCropperSrc] = useState<string | null>(null);
  const [cropperTarget, setCropperTarget] = useState<'bg' | 'header' | null>(null);
  const [identifierShape, setIdentifierShape] = useState<'square' | 'wide'>('square');

  const handleFileSelect = async (file: File | null, target: 'bg' | 'header') => {
    if (!file) {
      if (target === 'bg') { setBgFile(null); setBgPreview(null); }
      else { setHeaderFile(null); setHeaderPreview(null); }
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      setError('Image must be under 30 MB');
      return;
    }
    if (target === 'bg') {
      // Backgrounds skip the cropper — live render uses CSS cover.
      try {
        const blob = await resizeImageToMaxBox(file, 1920, 1920);
        setBgFile(new File([blob], 'background.png', { type: 'image/png' }));
        setBgPreview(URL.createObjectURL(blob));
      } catch (err: any) {
        setError(err?.message || 'Image processing failed');
      }
      return;
    }
    setCropperSrc(URL.createObjectURL(file));
    setCropperTarget(target);
  };

  const handleCropConfirm = (blob: Blob) => {
    const croppedUrl = URL.createObjectURL(blob);
    const croppedFile = new File([blob], cropperTarget === 'bg' ? 'background.png' : 'identifier.png', { type: 'image/png' });
    if (cropperTarget === 'bg') {
      setBgFile(croppedFile);
      setBgPreview(croppedUrl);
    } else {
      setHeaderFile(croppedFile);
      setHeaderPreview(croppedUrl);
    }
    setCropperSrc(null);
    setCropperTarget(null);
  };

  const handleCropCancel = () => {
    if (cropperSrc) URL.revokeObjectURL(cropperSrc);
    setCropperSrc(null);
    setCropperTarget(null);
  };

  const handleSubmit = async () => {
    if (!name.trim() || !author.trim() || (!bgFile && !headerFile)) {
      setError('Name, author, and at least one image are required');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('author', author.trim());
      if (bgFile) formData.append('background', bgFile);
      if (headerFile) formData.append('header', headerFile);

      const result = await api.upload<{ style: { id: string } }>(uploadPath, formData);
      onUploaded(result.style.id);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {error && (
        <div className="text-xs text-neon-magenta bg-neon-magenta/10 border border-neon-magenta/30 rounded px-3 py-2">{error}</div>
      )}

      {/* Name */}
      <div>
        <label className="text-xs text-muted block mb-1">Style Name *</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Medieval Madness"
          className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50"
        />
      </div>

      {/* Author */}
      <div>
        <label className="text-xs text-muted block mb-1">Author *</label>
        <input
          type="text"
          value={author}
          onChange={e => setAuthor(e.target.value)}
          placeholder="Your name"
          className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50"
        />
      </div>

      {/* Background image */}
      <div>
        <label className="text-xs text-muted block mb-1">Background Image</label>
        {bgPreview ? (
          <div className="relative rounded overflow-hidden">
            <img src={bgPreview} alt="Background preview" className="w-full h-32 object-cover" />
            <button
              onClick={() => handleFileSelect(null, 'bg')}
              className="absolute top-1 right-1 p-1 bg-black/60 rounded text-muted hover:text-neon-magenta border-0 cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <label className="flex items-center justify-center h-24 border border-dashed border-border rounded cursor-pointer hover:border-neon-cyan/50 transition-colors">
            <input
              type="file"
              accept="image/png,image/apng,image/jpeg,image/webp"
              className="hidden"
              onChange={e => handleFileSelect(e.target.files?.[0] || null, 'bg')}
            />
            <span className="text-sm text-faint">Click to select background image (16:9 crop)</span>
          </label>
        )}
      </div>

      <p className="text-[11px] text-faint">At least one image is required. Upload both, or just a background or identifier.</p>

      {/* Game identifier image */}
      <div>
        <label className="text-xs text-muted block mb-1">Game Identifier Image</label>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted">Shape:</span>
          <div className="inline-flex rounded border border-border overflow-hidden">
            <button
              onClick={() => setIdentifierShape('square')}
              className={`px-3 py-1 text-xs border-0 cursor-pointer transition-colors ${
                identifierShape === 'square' ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-surface text-muted hover:text-primary'
              }`}
            >Square 1:1</button>
            <button
              onClick={() => setIdentifierShape('wide')}
              className={`px-3 py-1 text-xs border-0 cursor-pointer transition-colors ${
                identifierShape === 'wide' ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-surface text-muted hover:text-primary'
              }`}
            >Wide 3:1</button>
          </div>
        </div>
        {headerPreview ? (
          <div className="relative rounded overflow-hidden">
            <img src={headerPreview} alt="Identifier preview" className="w-full h-24 object-contain bg-raised" />
            <button
              onClick={() => handleFileSelect(null, 'header')}
              className="absolute top-1 right-1 p-1 bg-black/60 rounded text-muted hover:text-neon-magenta border-0 cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <label className="flex items-center justify-center h-20 border border-dashed border-border rounded cursor-pointer hover:border-neon-cyan/50 transition-colors">
            <input
              type="file"
              accept="image/png,image/apng,image/jpeg,image/webp"
              className="hidden"
              onChange={e => handleFileSelect(e.target.files?.[0] || null, 'header')}
            />
            <span className="text-sm text-faint">Click to select game identifier image</span>
          </label>
        )}
      </div>

      {/* Image cropper overlay */}
      {cropperSrc && cropperTarget && (
        <ImageCropper
          imageSrc={cropperSrc}
          aspectRatio={cropperTarget === 'bg' ? 16 / 9 : (identifierShape === 'square' ? 1 : 3)}
          maxOutputWidth={cropperTarget === 'bg' ? 1920 : 600}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-2">
        <NeonButton variant="ghost" onClick={onCancel}>Cancel</NeonButton>
        <NeonButton onClick={handleSubmit} disabled={uploading || !name.trim() || !author.trim() || (!bgFile && !headerFile)}>
          {uploading ? 'Uploading...' : 'Upload & Select'}
        </NeonButton>
      </div>
    </div>
  );
}
