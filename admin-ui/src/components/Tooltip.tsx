import { useState, useRef, useEffect } from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  className?: string;
}

export default function Tooltip({ text, children, className = '' }: TooltipProps) {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState<'top' | 'bottom'>('top');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (show && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPosition(rect.top < 80 ? 'bottom' : 'top');
    }
  }, [show]);

  return (
    <div
      ref={ref}
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div className={`absolute z-50 px-2.5 py-1.5 text-xs text-primary bg-raised border border-border rounded shadow-lg whitespace-normal max-w-56 left-1/2 -translate-x-1/2 pointer-events-none ${
          position === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
        }`}>
          {text}
        </div>
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
