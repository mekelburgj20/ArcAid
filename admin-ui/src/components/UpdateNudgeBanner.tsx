import { RefreshCw, X } from 'lucide-react';
import { useUpdateNudge } from '../hooks/useUpdateNudge';

/**
 * Stale-PWA nudge (field report 2026-08-06): installed PWAs can run a stale
 * bundle for a while — the service worker is cache-first for static assets,
 * and only index.html/sw.js are no-cache, so a reload picks up a new build
 * but nothing tells the user to reload. This polls `GET /api/version`
 * (via `useUpdateNudge`) and offers a one-tap full reload once the server
 * reports a version different from the one this session booted with.
 *
 * Mounted once per top-level layout (PublicLayout, RoomAdminLayout,
 * SuperAdminLayout) rather than globally in App.tsx: kiosk mode is an
 * unattended display with no one to tap "refresh" and already opts out of
 * shared layout chrome (App.tsx routes it with no layout wrapper), and the
 * bare login/landing/OAuth-callback screens are transient enough that the
 * nudge isn't useful there either. Three call sites, one component/hook —
 * same idiom as `NotificationNudgeBanner`.
 */
export default function UpdateNudgeBanner() {
  const { show, dismiss, refresh } = useUpdateNudge();
  if (!show) return null;

  // v2.133.1 — OPAQUE surface. The original `bg-neon-cyan/10` was a 10% tint
  // over whatever sat behind the toast, so over a busy admin page the text was
  // barely readable (owner, 2026-08-23). `bg-surface` is the theme's solid
  // card colour, so it reads in every theme.
  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-xs px-4 py-3 rounded border border-neon-cyan/60 bg-surface shadow-xl shadow-black/40 flex items-start gap-2">
      <RefreshCw size={14} className="mt-0.5 shrink-0 text-neon-cyan" />
      <button
        type="button"
        onClick={refresh}
        className="flex-1 text-left bg-transparent border-none p-0 cursor-pointer text-neon-cyan text-sm font-medium"
      >
        A new version of Arcaid is available — tap to refresh
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss update notice"
        className="shrink-0 text-neon-cyan/70 hover:text-neon-cyan cursor-pointer bg-transparent border-none"
      >
        <X size={14} />
      </button>
    </div>
  );
}
