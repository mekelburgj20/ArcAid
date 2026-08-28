import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  toast: (message: string, type?: Toast['type']) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const typeStyles = {
    success: 'border-neon-green/50 text-neon-green',
    error: 'border-neon-magenta/50 text-neon-magenta',
    info: 'border-neon-cyan/50 text-neon-cyan',
  };

  // OPAQUE surface — same fix UpdateNudgeBanner got in v2.133.1. The original
  // `bg-neon-*/10` was a 10% tint over whatever the page had behind the toast,
  // so over busy content ("Game queued…" fires right above the picker grid)
  // the text clashed with the objects underneath (owner, 2026-08-27). Mixing
  // the accent into the theme's solid card colour keeps the tinted look while
  // fully covering the page in every theme.
  const typeBackgrounds: Record<Toast['type'], string> = {
    success: 'color-mix(in oklab, var(--color-neon-green) 12%, var(--color-surface))',
    error: 'color-mix(in oklab, var(--color-neon-magenta) 12%, var(--color-surface))',
    info: 'color-mix(in oklab, var(--color-neon-cyan) 12%, var(--color-surface))',
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded border text-sm font-medium shadow-xl shadow-black/40 transition-all animate-[fadeIn_0.2s_ease-out] ${typeStyles[t.type]}`}
            style={{ background: typeBackgrounds[t.type] }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
