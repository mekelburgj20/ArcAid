import { useState, useEffect, useCallback } from 'react';
import { Search, Upload, Trash2, Image, X, ChevronLeft, ChevronRight } from 'lucide-react';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';

interface Style {
  id: string;
  iscored_style_id: number | null;
  name: string;
  author: string;
  notes: string;
  has_background: number;
  has_header: number;
  source: string;
  created_at: string;
}

const PAGE_SIZE = 50;

export default function StyleCatalogue() {
  const { toast } = useToast();
  const [styles, setStyles] = useState<Style[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [previewStyle, setPreviewStyle] = useState<Style | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [importing, setImporting] = useState(false);

  const fetchStyles = useCallback(async (q: string, off: number) => {
    setLoading(true);
    try {
      const data = await api.get<{ styles: Style[]; total: number }>(
        `/styles?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=${off}`
      );
      setStyles(data.styles);
      setTotal(data.total);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchStyles(query, offset);
  }, [query, offset, fetchStyles]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      setQuery(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleImport = async () => {
    setImporting(true);
    try {
      const result = await api.post<{ imported: number; total: number }>('/admin/styles/import', {});
      toast(`Imported ${result.imported} styles (${result.total} total in source)`, 'success');
      fetchStyles(query, 0);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (style: Style) => {
    if (!confirm(`Delete style "${style.name}" by ${style.author}?`)) return;
    try {
      await api.delete(`/admin/styles/${encodeURIComponent(style.id)}`);
      toast('Style deleted', 'success');
      fetchStyles(query, offset);
      if (previewStyle?.id === style.id) setPreviewStyle(null);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-pixel text-xl text-neon-cyan">Style Catalogue</h1>
          <p className="text-sm text-muted mt-1">{total.toLocaleString()} styles available</p>
        </div>
        <div className="flex gap-2">
          <NeonButton onClick={() => setShowUpload(true)}>
            <Upload size={16} /> Upload
          </NeonButton>
          <NeonButton variant="secondary" onClick={handleImport} disabled={importing}>
            {importing ? 'Importing...' : 'Re-import iScored'}
          </NeonButton>
        </div>
      </div>

      {/* Search */}
      <NeonCard>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search by game name or author..."
            className="w-full pl-10 pr-4 py-2 bg-raised border border-border rounded text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
          />
        </div>
      </NeonCard>

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {loading ? (
          Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-lg h-48 animate-pulse" />
          ))
        ) : styles.length === 0 ? (
          <div className="col-span-full text-center text-muted py-12">
            {query ? 'No styles match your search.' : 'No styles in catalogue. Click "Re-import iScored" to populate.'}
          </div>
        ) : (
          styles.map(style => (
            <StyleCard
              key={style.id}
              style={style}
              onClick={() => setPreviewStyle(style)}
              onDelete={() => handleDelete(style)}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4">
          <NeonButton
            variant="ghost"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft size={16} /> Prev
          </NeonButton>
          <span className="text-sm text-muted">
            Page {currentPage} of {totalPages}
          </span>
          <NeonButton
            variant="ghost"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next <ChevronRight size={16} />
          </NeonButton>
        </div>
      )}

      {/* Preview Modal */}
      {previewStyle && (
        <StylePreviewModal style={previewStyle} onClose={() => setPreviewStyle(null)} />
      )}

      {/* Upload Modal */}
      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => {
            setShowUpload(false);
            fetchStyles(query, offset);
          }}
        />
      )}
    </div>
  );
}

// ─── Style Card ────────────────────────────────────────────────────────────────

function StyleCard({ style, onClick, onDelete }: { style: Style; onClick: () => void; onDelete: () => void }) {
  const bgUrl = style.has_background ? `/api/styles/images/backgrounds/${style.id}.png` : null;
  const headerUrl = style.has_header ? `/api/styles/images/headers/${style.id}.png` : null;

  return (
    <div
      className="bg-surface border border-border rounded-lg overflow-hidden cursor-pointer hover:border-neon-cyan/50 transition-colors group relative"
      onClick={onClick}
    >
      {/* Image preview */}
      <div
        className="h-32 bg-raised bg-cover bg-center relative"
        style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : undefined}
      >
        {headerUrl && (
          <img src={headerUrl} alt="" className="absolute inset-0 w-full h-full object-contain" />
        )}
        {!bgUrl && !headerUrl && (
          <div className="flex items-center justify-center h-full text-faint">
            <Image size={24} />
          </div>
        )}
        {/* Delete button */}
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          className="absolute top-1 right-1 p-1 bg-black/60 rounded text-muted hover:text-neon-magenta opacity-0 group-hover:opacity-100 transition-opacity border-0 cursor-pointer"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {/* Info */}
      <div className="p-2">
        <div className="text-xs font-medium text-primary truncate">{style.name}</div>
        <div className="text-xs text-faint truncate">by {style.author}</div>
      </div>
    </div>
  );
}

// ─── Preview Modal ─────────────────────────────────────────────────────────────

function StylePreviewModal({ style, onClose }: { style: Style; onClose: () => void }) {
  const bgUrl = style.has_background ? `/api/styles/images/backgrounds/${style.id}.png` : null;
  const headerUrl = style.has_header ? `/api/styles/images/headers/${style.id}.png` : null;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-display text-sm font-bold text-primary">{style.name}</h3>
          <button onClick={onClose} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {/* Full preview */}
        <div
          className="mx-4 mt-4 rounded-lg overflow-hidden bg-black bg-cover bg-center relative"
          style={{
            minHeight: 280,
            ...(bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}),
          }}
        >
          {headerUrl && (
            <img src={headerUrl} alt="" className="w-full object-contain" />
          )}
          {/* Sample scoreboard overlay */}
          <div className="absolute bottom-0 left-0 right-0 bg-black/60 p-3">
            <div className="text-xs text-yellow-400 font-bold">Player1</div>
            <div className="text-xs text-red-400">123,456,789</div>
          </div>
        </div>

        {/* Metadata */}
        <div className="p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Author</span>
            <span className="text-primary">{style.author}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Source</span>
            <span className="text-primary">{style.source === 'iscored' ? 'iScored Community' : 'Custom Upload'}</span>
          </div>
          {style.iscored_style_id && (
            <div className="flex justify-between">
              <span className="text-muted">iScored Style ID</span>
              <span className="text-primary">{style.iscored_style_id}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted">Background</span>
            <span className="text-primary">{style.has_background ? 'Yes' : 'No'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Header Image</span>
            <span className="text-primary">{style.has_header ? 'Yes' : 'No'}</span>
          </div>
          {style.notes && (
            <div>
              <span className="text-muted">Notes</span>
              <p className="text-primary mt-1">{style.notes}</p>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted">Catalogue ID</span>
            <span className="text-faint text-xs font-mono">{style.id}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Upload Modal ──────────────────────────────────────────────────────────────

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [notes, setNotes] = useState('');
  const [bgFile, setBgFile] = useState<File | null>(null);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [bgPreview, setBgPreview] = useState<string | null>(null);
  const [headerPreview, setHeaderPreview] = useState<string | null>(null);

  const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

  const handleBgChange = (file: File | null) => {
    if (file && file.size > MAX_SIZE) {
      toast('Background image must be under 2 MB', 'error');
      return;
    }
    setBgFile(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setBgPreview(url);
    } else {
      setBgPreview(null);
    }
  };

  const handleHeaderChange = (file: File | null) => {
    if (file && file.size > MAX_SIZE) {
      toast('Header image must be under 2 MB', 'error');
      return;
    }
    setHeaderFile(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setHeaderPreview(url);
    } else {
      setHeaderPreview(null);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim() || !author.trim() || !bgFile) {
      toast('Name, author, and background image are required', 'error');
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('author', author.trim());
      formData.append('notes', notes.trim());
      formData.append('background', bgFile);
      if (headerFile) formData.append('header', headerFile);

      await api.upload('/admin/styles/upload', formData);
      toast('Style uploaded successfully', 'success');
      onUploaded();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-display text-sm font-bold text-primary">Upload Custom Style</h3>
          <button onClick={onClose} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
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

          {/* Notes */}
          <div>
            <label className="text-xs text-muted block mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional description"
              className="w-full px-3 py-2 bg-raised border border-border rounded text-sm text-primary focus:outline-none focus:border-neon-cyan/50"
            />
          </div>

          {/* Background image */}
          <div>
            <label className="text-xs text-muted block mb-1">Background Image * (max 2 MB)</label>
            {bgPreview ? (
              <div className="relative rounded overflow-hidden">
                <img src={bgPreview} alt="Background preview" className="w-full h-32 object-cover" />
                <button
                  onClick={() => handleBgChange(null)}
                  className="absolute top-1 right-1 p-1 bg-black/60 rounded text-muted hover:text-neon-magenta border-0 cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <label className="flex items-center justify-center h-24 border border-dashed border-border rounded cursor-pointer hover:border-neon-cyan/50 transition-colors">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={e => handleBgChange(e.target.files?.[0] || null)}
                />
                <span className="text-sm text-faint">Click to select background image</span>
              </label>
            )}
          </div>

          {/* Header image */}
          <div>
            <label className="text-xs text-muted block mb-1">Header Image (optional, max 2 MB)</label>
            {headerPreview ? (
              <div className="relative rounded overflow-hidden">
                <img src={headerPreview} alt="Header preview" className="w-full h-24 object-contain bg-raised" />
                <button
                  onClick={() => handleHeaderChange(null)}
                  className="absolute top-1 right-1 p-1 bg-black/60 rounded text-muted hover:text-neon-magenta border-0 cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <label className="flex items-center justify-center h-20 border border-dashed border-border rounded cursor-pointer hover:border-neon-cyan/50 transition-colors">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={e => handleHeaderChange(e.target.files?.[0] || null)}
                />
                <span className="text-sm text-faint">Click to select header image</span>
              </label>
            )}
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-2">
            <NeonButton variant="ghost" onClick={onClose}>Cancel</NeonButton>
            <NeonButton onClick={handleSubmit} disabled={uploading || !name.trim() || !author.trim() || !bgFile}>
              {uploading ? 'Uploading...' : 'Upload Style'}
            </NeonButton>
          </div>
        </div>
      </div>
    </div>
  );
}
