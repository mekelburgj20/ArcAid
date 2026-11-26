import type { ReactNode } from 'react';

/**
 * G23 - an empty state says what goes here and what to do next (owner's pick,
 * 2026-11-25): the unlit double-line triangle (the toast's emblem), a title, one
 * sentence in muted ink, and the action (normally a `Button`). The triangle
 * strikes on, like a neon tube (the toast's flicker), and stays lit while the
 * action is hovered or keyboard-focused, in cyan or, with `tone="pink"`, pink.
 * With reduced motion it simply lights, with no flicker. Site tokens only.
 */
export default function EmptyState({ title, children, action, tone = 'cyan', className = '' }: {
    title: ReactNode;
    /** The one sentence: what goes here, or what to do. */
    children?: ReactNode;
    action?: ReactNode;
    tone?: 'cyan' | 'pink';
    /** Layout only. */
    className?: string;
}) {
    return (
        <div className={`part-empty${tone === 'pink' ? ' part-empty--pink' : ''} ${className}`.trim()}>
            <svg className="part-empty__sign" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
                <polygon className="part-empty__outer" points="13.1,3.3 29.3,21.3 5.6,26.4" />
                <polygon className="part-empty__inner" points="14.1,8 24.8,19.9 9.1,23.2" />
            </svg>
            <p className="part-empty__title">{title}</p>
            {children && <div className="part-empty__text">{children}</div>}
            {action && <div className="part-empty__action">{action}</div>}
        </div>
    );
}
