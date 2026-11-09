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

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // v2.233.0: an ERROR stays until tapped. A long refusal ("… is not in the
  // game catalogue …") vanished after 4 s before a phone user could read it
  // (owner, 2026-11-08). Success and info still clear themselves. At most
  // three stay on screen, so a burst of errors cannot bury the page.
  const toast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, message, type }].slice(-3));
    if (type !== 'error') setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);

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
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:max-w-md z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded border text-sm font-medium shadow-xl shadow-black/40 transition-all animate-[fadeIn_0.2s_ease-out] ${typeStyles[t.type]}`}
            style={{ background: typeBackgrounds[t.type] }}
            role={t.type === 'error' ? 'alert' : 'status'}
          >
            <span className="flex items-start gap-3">
              <span className="min-w-0 break-words">{t.message}</span>
              <button
                type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}
                className="shrink-0 -mr-1 -mt-0.5 px-1 opacity-70 hover:opacity-100"
              >×</button>
            </span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
