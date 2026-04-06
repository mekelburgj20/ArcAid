import { useState, useRef, useEffect } from 'react';
import { Info, ExternalLink } from 'lucide-react';

interface GameInfoPopupProps {
  externalUrl?: string | null;
  notes?: string | null;
  size?: number;
  className?: string;
}

export default function GameInfoPopup({ externalUrl, notes, size = 14, className = '' }: GameInfoPopupProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!externalUrl && !notes) return null;

  return (
    <div ref={ref} className={`relative inline-flex ${className}`}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="text-muted hover:text-primary transition-colors cursor-pointer"
        title="Game info"
      >
        <Info size={size} />
      </button>
      {open && (
        <div
          className="absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 bg-surface border border-border rounded-lg shadow-lg p-3 min-w-[200px] max-w-[300px]"
          onClick={(e) => e.stopPropagation()}
        >
          {notes && (
            <p className="text-xs text-muted mb-2 whitespace-pre-wrap">{notes}</p>
          )}
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-neon-cyan hover:underline break-all"
            >
              <ExternalLink size={12} className="flex-shrink-0" />
              {externalUrl}
            </a>
          )}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <div className="w-2 h-2 bg-surface border-r border-b border-border rotate-45 -translate-y-1" />
          </div>
        </div>
      )}
    </div>
  );
}
