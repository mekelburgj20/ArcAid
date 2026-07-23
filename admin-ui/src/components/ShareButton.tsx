import { useEffect, useRef, useState } from 'react';
import { Share2, Check, X } from 'lucide-react';

/**
 * S16 — Web Share button with clipboard fallback.
 *
 * Uses the native share sheet where available (mobile, some desktop browsers);
 * otherwise copies "text url" to the clipboard and flips the label to
 * "Copied!" for 2s (the Settings.tsx copy-link pattern — inline state, no
 * ToastProvider dependency so the button works on any page). Non-secure
 * contexts (plain-HTTP LAN deploys) have no navigator.clipboard — fall back to
 * the legacy execCommand copy; if even that fails, show "Copy failed" rather
 * than a silent no-op.
 */
interface ShareButtonProps {
    /** Share-sheet title (some targets display it, most use text+url). */
    title: string;
    /** Message body, e.g. `I'm #1 on Medieval Madness!`. */
    text: string;
    /** App-relative path (e.g. `/rtx_pinball/games/Foo`); made absolute at click time. */
    path: string;
    className?: string;
    /** Icon-only compact variant when false. Default true. */
    showLabel?: boolean;
}

const DEFAULT_CLASS =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-medium transition-colors cursor-pointer ' +
    'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20';

function legacyCopy(value: string): boolean {
    try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

export default function ShareButton({ title, text, path, className, showLabel = true }: ShareButtonProps) {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const flash = (next: 'copied' | 'failed') => {
        setState(next);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setState('idle'), 2000);
    };

    const handleShare = async () => {
        const url = `${window.location.origin}${path}`;
        if (typeof navigator.share === 'function') {
            try {
                await navigator.share({ title, text, url });
                return;
            } catch (err) {
                // AbortError = user dismissed the sheet — done, not a failure.
                if (err instanceof DOMException && err.name === 'AbortError') return;
                // Anything else (e.g. NotAllowedError) → clipboard fallback below.
            }
        }
        const payload = `${text} ${url}`;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
                flash('copied');
                return;
            }
        } catch {
            // fall through to legacy copy
        }
        flash(legacyCopy(payload) ? 'copied' : 'failed');
    };

    return (
        <button
            onClick={handleShare}
            // s20: icon-only variant (showLabel=false) had no text to pad its hit
            // area out to 44px — the labeled variant's text does that already.
            className={`${className ?? DEFAULT_CLASS}${!showLabel ? ' min-h-11 min-w-11 justify-center' : ''}`}
            aria-label={state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy failed' : 'Share'}
            title="Share"
        >
            {state === 'copied' ? <Check size={14} /> : state === 'failed' ? <X size={14} /> : <Share2 size={14} />}
            {showLabel && (state === 'copied' ? 'Copied!' : state === 'failed' ? 'Copy failed' : 'Share')}
        </button>
    );
}
