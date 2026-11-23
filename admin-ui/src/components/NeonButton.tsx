import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'danger' | 'ghost' | 'secondary';
  children: ReactNode;
}

const variants = {
  primary: 'bg-lead/10 ink-lead border-lead/40 hover:bg-lead/20 hover:border-lead/60',
  danger: 'bg-neon-coral/10 ink-danger border-neon-coral/40 hover:bg-neon-coral/20 hover:border-neon-coral/60',
  ghost: 'bg-transparent text-muted border-border hover:text-primary hover:border-border-glow',
  secondary: 'bg-raised text-muted border-border hover:text-primary hover:border-border-glow',
};

// s20: forwardRef so callers (e.g. ConfirmModal) can programmatically focus
// the underlying <button> — was a plain function component, so a `ref` prop
// silently no-op'd (React warns and leaves ref.current null).
const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(function NeonButton(
  { variant = 'primary', children, className = '', disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`
        inline-flex items-center justify-center gap-2 px-4 py-2 rounded border text-sm font-medium
        transition-all duration-200 cursor-pointer
        disabled:opacity-40 disabled:cursor-not-allowed
        ${variants[variant]}
        ${className}
      `}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
});

export default NeonButton;
