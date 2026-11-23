import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AnimationEvent, CSSProperties, ReactNode } from 'react';
import { Toaster, toast as sonner } from 'sonner';

/**
 * Toasts (G23, v2.260.0): the Arcaid toast on Sonner.
 *
 * Sonner carries the behaviour only (the live region, stacking, swipe away,
 * Alt+T to reach them); the look is Arcaid's own and lives in `index.css`
 * ("The Arcaid toast"). The owner picked it from the G23 mockup because
 * library-default toasts "look pretty similar to a lot of other current AI
 * generated website artifacts" (2026-11-22, style plan decision 6). Never
 * switch Sonner's default look back on.
 *
 * The rules from before stay: an ERROR stays until tapped (a long refusal
 * vanished after 4 s before a phone user could read it, owner 2026-11-08);
 * success and info clear themselves after 4 s; at most three are on screen,
 * so a burst of errors cannot bury the page. The clock is the pinball rail:
 * its CSS animation ending is what dismisses the toast, so it stops with it
 * (pointer over the toasts, focus inside them, or the tab hidden).
 *
 * A caller may name the heading and lengthen the clock (`ToastOptions`): the
 * room page's "Arcaid Witness" toast says where the player's devices send
 * their scores, one sentence per line, and stays 2 s longer per extra line.
 */

type ToastType = 'success' | 'error' | 'info';

export interface ToastOptions {
  /**
   * The heading, in place of the type's own (Done / Heads up / Didn't work):
   * for a toast that reports a standing fact, not the result of something the
   * person just did. Drawn exactly like the default headings.
   */
  label?: string;
  /**
   * How long a success or info toast stays (4 s when left out); a message of
   * several lines needs longer to read. An error has no clock, so this does
   * nothing there.
   */
  durationMs?: number;
}

interface ToastContextValue {
  /** A line break in `message` starts a new line in the toast. */
  toast: (message: string, type?: ToastType, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const MAX_ON_SCREEN = 3;
const CLEARS_AFTER_MS = 4000;

const LOOK: Record<ToastType, { tone: 'cyan' | 'ice' | 'pink'; label: string }> = {
  success: { tone: 'cyan', label: 'Done' },
  info: { tone: 'ice', label: 'Heads up' },
  error: { tone: 'pink', label: "Didn't work" },
};

/** The Arcaid triangle, double-lined like the logo's and tilted like the ones on the Witness background. */
function Emblem() {
  return (
    <svg className="arc-toast__emblem" viewBox="0 0 32 32" aria-hidden="true">
      <polygon className="arc-toast__emblem-outer" points="13.1,3.3 29.3,21.3 5.6,26.4" />
      <polygon className="arc-toast__emblem-inner" points="14.1,8 24.8,19.9 9.1,23.2" />
    </svg>
  );
}

function ArcaidToast({ id, message, type, options }: { id: string | number; message: string; type: ToastType; options?: ToastOptions }) {
  const { tone } = LOOK[type];
  const label = options?.label ?? LOOK[type].label;
  const clearsAfterMs = options?.durationMs ?? CLEARS_AFTER_MS;
  const stays = type === 'error';
  const dismiss = () => sonner.dismiss(id);
  // Only the rail's own animation is the clock (a child's animationend bubbles here too).
  const railEnded = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) dismiss();
  };
  return (
    <div className={`arc-toast arc-toast--${tone}`} role={stays ? 'alert' : 'status'}>
      <Emblem />
      <div className="arc-toast__body">
        <p className="arc-toast__label">{label}</p>
        <p className="arc-toast__msg">{message}</p>
        {stays && (
          <button type="button" className="arc-toast__chip" onClick={dismiss}>Dismiss</button>
        )}
      </div>
      {!stays && (
        <>
          <button type="button" className="arc-toast__x" aria-label="Dismiss" onClick={dismiss}>×</button>
          <div className="arc-toast__rail" aria-hidden="true">
            <div
              className="arc-toast__run"
              style={{ '--arc-toast-ms': `${clearsAfterMs}ms` } as CSSProperties}
              onAnimationEnd={railEnded}
            >
              <span className="arc-toast__ball" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Phones get the toasts at the TOP (owner, 2026-11-22). At the bottom, stacked Arcaid toasts
 * covered a centred dialog's buttons and the bottom sheets' (toasts sit above dialogs so a
 * dialog's own errors show). 600 px is Sonner's own phone breakpoint, where it also goes full
 * width, so the two switch together. Bottom-right when `matchMedia` is missing (jsdom).
 */
const PHONE_QUERY = '(max-width: 600px)';

function usePhoneViewport(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return phone;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const toast = useCallback((message: string, type: ToastType = 'info', options?: ToastOptions) => {
    // Make room first, oldest out, so a fourth never waits hidden behind three errors.
    const active = sonner.getToasts();
    active.slice(0, Math.max(0, active.length - (MAX_ON_SCREEN - 1))).forEach(t => sonner.dismiss(t.id));
    sonner.custom(id => <ArcaidToast id={id} message={message} type={type} options={options} />, { duration: Infinity });
  }, []);

  // The rail's CSS clock would keep running in a hidden tab and the toast would be gone
  // before anyone saw it; this class stops it until the tab is back.
  useEffect(() => {
    const sync = () => document.documentElement.classList.toggle('tab-hidden', document.hidden);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      document.documentElement.classList.remove('tab-hidden');
    };
  }, []);

  const phone = usePhoneViewport();

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <Toaster
        theme="dark"
        position={phone ? 'top-center' : 'bottom-right'}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
        expand
        visibleToasts={MAX_ON_SCREEN}
        gap={10}
        duration={Infinity}
        style={{ '--width': '392px' } as CSSProperties}
        toastOptions={{ className: 'arc-toast-li' }}
      />
    </ToastContext.Provider>
  );
}
