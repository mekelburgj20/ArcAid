import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  className?: string;
}

export default function Tooltip({ text, children, className = '' }: TooltipProps) {
  const [coords, setCoords] = useState<{ top: number; left: number; placement: 'top' | 'bottom' } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const handleEnter = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;

    // Clamp horizontal so tooltip stays on screen (w-64 = 256px)
    const tooltipW = 256;
    const half = tooltipW / 2;
    let left = centerX;
    if (centerX - half < 8) left = 8 + half;
    else if (centerX + half > window.innerWidth - 8) left = window.innerWidth - 8 - half;

    const placement = rect.top < 100 ? 'bottom' : 'top';
    const top = placement === 'top' ? rect.top - 6 : rect.bottom + 6;

    setCoords({ top, left, placement });
  }, []);

  const handleLeave = useCallback(() => setCoords(null), []);

  return (
    <div
      ref={ref}
      className={`relative inline-flex ${className}`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {children}
      {coords && createPortal(
        <div
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            transform: coords.placement === 'top'
              ? 'translate(-50%, -100%)'
              : 'translate(-50%, 0)',
            zIndex: 9999,
          }}
          className="px-2.5 py-1.5 text-xs text-primary bg-raised border border-border rounded shadow-lg whitespace-normal w-64 pointer-events-none"
        >
          {text}
        </div>,
        document.body
      )}
    </div>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-muted text-muted text-[10px] leading-none cursor-help ml-1 hover:border-neon-cyan hover:text-neon-cyan transition-colors">?</span>
    </Tooltip>
  );
}
