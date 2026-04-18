import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
    size?: number;
    title?: string;
};

function baseProps(size = 16, title?: string): SVGProps<SVGSVGElement> {
    return {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        role: title ? 'img' : 'presentation',
        'aria-label': title,
        'aria-hidden': title ? undefined : true,
    };
}

export function TrophyIcon({ size = 14, title, ...rest }: IconProps) {
    return (
        <svg {...baseProps(size, title)} {...rest}>
            <path
                d="M7 4h10v2h3a1 1 0 0 1 1 1v2a4 4 0 0 1-4 4h-.2a6 6 0 0 1-3.8 3.9V19h3v2H8v-2h3v-2.1A6 6 0 0 1 7.2 13H7a4 4 0 0 1-4-4V7a1 1 0 0 1 1-1h3V4Zm10 4v3a2 2 0 0 0 2-2V8h-2ZM7 8H5v1a2 2 0 0 0 2 2V8Z"
                fill="currentColor"
            />
        </svg>
    );
}

export function SubmitScoreIcon({ size = 16, title, ...rest }: IconProps) {
    // Themed "score slip" — dashed ticket with an upload arrow. Distinct from generic Upload.
    return (
        <svg {...baseProps(size, title)} {...rest}>
            <path
                d="M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 4 4 4h-3v5h-2v-5H8l4-4Z"
                fill="currentColor"
            />
        </svg>
    );
}

export function MysteryAwardIcon({ size = 16, title, ...rest }: IconProps) {
    // Themed: prize token — diamond with spark rays.
    return (
        <svg {...baseProps(size, title)} {...rest}>
            <path
                d="M12 2 8 8l4 6 4-6-4-6Zm-7 9 2 4 2-4H5Zm12 0-2 4 4 0-2-4Zm-5 6-4 5h8l-4-5Z"
                fill="currentColor"
            />
        </svg>
    );
}

export function RoomBadgeIcon({ size = 16, title, ...rest }: IconProps) {
    // Placeholder hex shield for rooms without a logo_url.
    return (
        <svg {...baseProps(size, title)} {...rest}>
            <path
                d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4Z"
                stroke="currentColor"
                strokeWidth="1.6"
                fill="none"
            />
        </svg>
    );
}

export function AnonymousAvatarIcon({ size = 16, title, ...rest }: IconProps) {
    // Themed placeholder avatar for anonymous (§15 "no Discord avatar") rows on leaderboards.
    // Round silhouette with a question-mark mask — distinct from Discord's default mystery wampus.
    return (
        <svg {...baseProps(size, title)} {...rest}>
            <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.18" />
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path
                d="M9.2 9.4a3 3 0 0 1 5.8 1.1c0 1.4-1.1 2-1.9 2.5-.6.4-1.1.7-1.1 1.4v.3m0 2.5v.1"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                fill="none"
            />
        </svg>
    );
}

export function CooldownLockIcon({ size = 14, title, ...rest }: IconProps) {
    return (
        <svg {...baseProps(size, title)} {...rest}>
            <path
                d="M8 10V7a4 4 0 1 1 8 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h4V7a2 2 0 1 0-4 0v3Z"
                fill="currentColor"
            />
        </svg>
    );
}

/**
 * Canvas helper — draws a 5-point star of radius `r` at (cx, cy).
 * Used by MysteryAward.tsx in place of the U+2605 character so the canvas
 * never depends on a system emoji/glyph font.
 */
export function drawCanvasStar(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
): void {
    const spikes = 5;
    const outer = r;
    const inner = r * 0.42;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = (Math.PI / spikes) * i - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
}
