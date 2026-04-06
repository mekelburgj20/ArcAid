import { useState, useEffect, useCallback } from 'react';
import { Search, X, Image, ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import NeonButton from './NeonButton';
import ImageCropper from './ImageCropper';
import { api } from '../lib/api';

interface Style {
  id: string;
  name: string;
  author: string;
  has_background: number;
  has_header: number;
  source: string;
}

export type ImageApplyType = 'both' | 'logo' | 'background';

interface StylePickerProps {
  /** Currently assigned style ID, if any */
  currentStyleId?: string | null;
  /** Whether header is currently disabled */
  headerDisabled?: boolean;
  /** Called when a style is selected (or cleared) */
  onSelect: (styleId: string | null, headerDisabled: boolean, setAsDefault?: boolean, imageType?: ImageApplyType) => void;
  onClose: () => void;
  /** Show "Set as default style for this game" checkbox */
  showDefaultOption?: boolean;
  /** Whether the library already has a default style for this game */
  libraryHasDefault?: boolean;
  /** Show image type selector (logo/background/both) */
  showImageTypeSelector?: boolean;
  /** API path for uploading custom styles. When provided, shows Upload button. */
  uploadPath?: string;
  /** Game name to pre-fill the upload form name field */
  gameName?: string;
}

const PAGE_SIZE = 30;

export default function StylePicker({ currentStyleId, headerDisabled = false, onSelect, onClose, showDefaultOption = false, libraryHasDefault = false, showImageTypeSelector = false, uploadPath, gameName }: StylePickerProps) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(currentStyleId || null);
  const [disableHeader, setDisableHeader] = useState(headerDisabled);
  const [setAsDefault, setSetAsDefault] = useState(!libraryHasDefault);
  const [imageType, setImageType] = useState<ImageApplyType>('both');
  const [showUpload, setShowUpload] = useState(false);

  const fetchStyles = useCallback(async (q: string, off: number) => {
    setLoading(true);
    try {
      const data = await api.get<{ styles: Style[]; total: number }>(
        `/styles?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=${off}`
      );
      setStyles(data.styles);
      setTotal(data.total);
    } catch {
      // Silent fail — toast is handled by parent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStyles(query, offset);
  }, [query, offset, fetchStyles]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      setQuery(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const selectedStyle = styles.find(s => s.id === selectedId);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h3 className="font-display text-sm font-bold text-primary">
            {showUpload ? 'Upload Art Pack' : 'Select Art Pack'}
          </h3>
          <div className="flex items-center gap-2">
            {uploadPath && (
              <button
                onClick={() => setShowUpload(!showUpload)}
                className="flex items-center gap-1.5 text-xs text-neon-cyan hover:text-neon-cyan/80 bg-transparent border-0 cursor-pointer"
              >
                {showUpload ? <Search size={14} /> : <Upload size={14} />}
                {showUpload ? 'Browse' : 'Upload'}
              </button>
            )}
            <button onClick={onClose} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer">
              <X size={18} />
            </button>
          </div>
        </div>

        {showUpload && uploadPath ? (
          <UploadForm
            uploadPath={uploadPath}
            gameName={gameName}
            onUploaded={(newStyleId) => {
              setShowUpload(false);
              setSelectedId(newStyleId);
              fetchStyles(query, offset);
            }}
            onCancel={() => setShowUpload(false)}
          />
        ) : (
        <>
        {/* Search */}
        <div className="p-4 border-b border-border shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search styles by name or author..."
              className="w-full pl-10 pr-4 py-2 bg-raised border border-border rounded text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
              autoFocus
            />
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="h-28 bg-raised border border-border rounded animate-pulse" />
              ))}
            </div>
          ) : styles.length === 0 ? (
            <div className="text-center text-muted py-8">No styles found.</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {styles.map(style => {
                const isSelected = style.id === selectedId;
                const bgUrl = style.has_background ? `/api/styles/images/backgrounds/${style.id}.png` : null;
                const headerUrl = style.has_header ? `/api/styles/images/headers/${style.id}.png` : null;

                return (
                  <div
                    key={style.id}
                    onClick={() => setSelectedId(style.id)}
                    className={`rounded overflow-hidden cursor-pointer border-2 transition-colors ${
                      isSelected ? 'border-neon-cyan' : 'border-transparent hover:border-border'
                    }`}
                  >
                    <div
                      className="h-20 bg-raised bg-cover bg-center relative"
                      style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : undefined}
                    >
                      {headerUrl && (
                        <img src={headerUrl} alt="" className="absolute inset-0 w-full h-full object-contain" />
                      )}
                      {!bgUrl && !headerUrl && (
                        <div className="flex items-center justify-center h-full text-faint">
                          <Image size={16} />
                        </div>
                      )}
                      {/* Image type badges */}
                      <div className="absolute bottom-1 left-1 flex gap-0.5">
                        {style.has_background ? <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-black/60 text-neon-green">BG</span> : null}
                        {style.has_header ? <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-black/60 text-neon-amber">HDR</span> : null}
                      </div>
                    </div>
                    <div className="bg-surface p-1.5">
                      <div className="text-xs text-primary truncate">{style.name}</div>
                      <div className="text-xs text-faint truncate">{style.author}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-4">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="text-muted hover:text-primary disabled:opacity-30 bg-transparent border-0 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-xs text-muted">{currentPage} / {totalPages}</span>
              <button
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="text-muted hover:text-primary disabled:opacity-30 bg-transparent border-0 cursor-pointer disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-4 shrink-0">
          {/* Image type selector */}
          {showImageTypeSelector && selectedId ? (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm text-muted">Apply as:</span>
              <div className="inline-flex rounded border border-border overflow-hidden">
                {(['both', 'background', 'logo'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setImageType(t)}
                    className={`px-3 py-1 text-xs border-0 cursor-pointer transition-colors ${
                      imageType === t ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-surface text-muted hover:text-primary'
                    }`}
                  >
                    {t === 'both' ? 'Both' : t === 'background' ? 'Background' : 'Identifier'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Hint when image type selector is not shown */}
          {!showImageTypeSelector && selectedId && selectedStyle?.has_header ? (
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={disableHeader}
                onChange={e => setDisableHeader(e.target.checked)}
                className="accent-neon-cyan"
              />
              <span className="text-sm text-muted">Hide game identifier (show background only)</span>
            </label>
          ) : null}

          {/* Set as default toggle */}
          {showDefaultOption && selectedId ? (
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={setAsDefault}
                onChange={e => setSetAsDefault(e.target.checked)}
                className="accent-neon-cyan"
              />
              <span className="text-sm text-muted">
                {libraryHasDefault
                  ? 'Update default style for this game in the library'
                  : 'Set as default style for this game in the library'}
              </span>
            </label>
          ) : null}

          <div className="flex justify-between gap-2">
            <NeonButton variant="ghost" onClick={() => onSelect(null, false, showDefaultOption ? setAsDefault : undefined, showImageTypeSelector ? imageType : undefined)}>
              Clear Style
            </NeonButton>
            <div className="flex gap-2">
              <NeonButton variant="ghost" onClick={onClose}>Cancel</NeonButton>
              <NeonButton
                disabled={!selectedId}
                onClick={() => onSelect(selectedId, disableHeader, showDefaultOption ? setAsDefault : undefined, showImageTypeSelector ? imageType : undefined)}
              >
                Apply Style
              </NeonButton>
            </div>
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

// ─── Inline Upload Form ────────────────────────────────────────────────────────

const MAX_UPLOAD_SIZE = 30 * 1024 * 1024; // 30 MB

function UploadForm({ uploadPath, gameName, onUploaded, onCancel }: {
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

  const handleFileSelect = (file: File | null, target: 'bg' | 'header') => {
    if (!file) {
      if (target === 'bg') { setBgFile(null); setBgPreview(null); }
      else { setHeaderFile(null); setHeaderPreview(null); }
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      setError('Image must be under 30 MB');
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
