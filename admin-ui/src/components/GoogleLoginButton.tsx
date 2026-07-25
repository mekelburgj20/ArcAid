/**
 * Shared Google login button — sibling of DiscordLoginButton.tsx (v2.35.0).
 * Standard Google branding: white/dark neutral button, "Sign in with Google"
 * wordmark, inline SVG "G" mark (no external assets, no new deps).
 */
interface Props {
    onClick: () => void;
    /** Optional compact label, defaults to "Login". */
    label?: string;
    className?: string;
}

export default function GoogleLoginButton({ onClick, label = 'Login', className }: Props) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded border border-border bg-surface text-primary text-xs font-medium hover:bg-raised hover:border-border/80 transition-colors cursor-pointer ${className ?? ''}`}
        >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3.02h3.87c2.27-2.09 3.58-5.17 3.58-8.84z" />
                <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.87-3.02c-1.08.72-2.46 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.11A12 12 0 0 0 12 24z" />
                <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.39l4-3.11z" />
                <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.59 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.27 6.61l4 3.11C6.22 6.88 8.87 4.77 12 4.77z" />
            </svg>
            <span className="hidden sm:inline">{label}</span>
        </button>
    );
}
