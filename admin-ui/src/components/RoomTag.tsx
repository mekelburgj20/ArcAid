import { Link } from 'react-router-dom';

export type RoomTagSize = 16 | 24 | 32;

export interface RoomTagProps {
    shortTag: string;
    size?: RoomTagSize;
    logoUrl?: string | null;
    slug?: string | null;
    href?: string | null;
    title?: string;
    className?: string;
}

const SIZE_TO_STYLE: Record<RoomTagSize, { font: number; pad: string }> = {
    16: { font: 9, pad: '1px 4px' },
    24: { font: 11, pad: '2px 6px' },
    32: { font: 13, pad: '3px 8px' },
};

function normalizeShortTag(input: string): string {
    return (input || '').trim().slice(0, 6).toUpperCase();
}

export default function RoomTag({
    shortTag,
    size = 24,
    logoUrl,
    slug,
    href,
    title,
    className,
}: RoomTagProps) {
    const label = normalizeShortTag(shortTag);
    if (!label) return null;

    const { font, pad } = SIZE_TO_STYLE[size];
    const box = size;

    const content = logoUrl ? (
        <img
            src={logoUrl}
            alt={label}
            width={box}
            height={box}
            style={{
                width: box,
                height: box,
                objectFit: 'cover',
                borderRadius: 4,
                display: 'block',
            }}
        />
    ) : (
        <span
            aria-label={label}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: box,
                height: box,
                padding: pad,
                fontSize: font,
                fontWeight: 700,
                letterSpacing: '0.08em',
                lineHeight: 1,
                borderRadius: 4,
                background: 'rgba(0, 220, 220, 0.12)',
                color: 'var(--color-neon-cyan, #00dcdc)',
                border: '1px solid rgba(0, 220, 220, 0.35)',
                fontFamily: 'var(--font-mono, "Courier New", monospace)',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
            }}
        >
            {label}
        </span>
    );

    const target = href ?? (slug ? `/${slug}` : null);

    if (target) {
        return (
            <Link
                to={target}
                title={title ?? label}
                className={className}
                style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
            >
                {content}
            </Link>
        );
    }

    return (
        <span title={title ?? label} className={className} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {content}
        </span>
    );
}
