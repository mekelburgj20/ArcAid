import { useState } from 'react';
import { Share2, Check } from 'lucide-react';

/**
 * S16 — Web Share button with clipboard fallback.
 *
 * Uses the native share sheet where available (mobile, some desktop browsers);
 * otherwise copies "text url" to the clipboard and flips the label to
 * "Copied!" for 2s (the Settings.tsx copy-link pattern — inline state, no
 * ToastProvider dependency so the button works on any page).
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

export default function ShareButton({ title, text, path, className, showLabel = true }: ShareButtonProps) {
    const [copied, setCopied] = useState(false);

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
        try {
            await navigator.clipboard.writeText(`${text} ${url}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable (very old browser / non-secure context) — no-op.
        }
    };

    return (
        <button
            onClick={handleShare}
            className={className ?? DEFAULT_CLASS}
            aria-label={copied ? 'Link copied' : 'Share'}
            title="Share"
        >
            {copied ? <Check size={14} /> : <Share2 size={14} />}
            {showLabel && (copied ? 'Copied!' : 'Share')}
        </button>
    );
}
