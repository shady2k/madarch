/**
 * The shadcn/ui Button, copied in the new-york shape and re-themed from the
 * wiki's own design tokens: no shadcn theme colours, the graphite pairs stand
 * in (the tokens remain the single colour source). Radix underneath is not
 * needed for the button itself.
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactElement } from 'react';
import { cn } from '@/lib/utils.js';

type ButtonVariant = 'default' | 'ghost' | 'link' | 'outline';
type ButtonSize = keyof typeof sizeClasses;

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
} & (
  | { disabled?: false; disabledReason?: string }
  | { disabled: boolean | undefined; disabledReason: string }
);

const variantClasses: Record<ButtonVariant, string> = {
  default: 'bg-chrome text-ink border border-line shadow-none hover:bg-[var(--surface-hover)]',
  ghost: 'text-secondary hover:enabled:bg-[var(--surface-hover)] hover:enabled:text-ink',
  link: 'text-secondary underline underline-offset-2 hover:enabled:text-ink',
  outline: 'border border-line bg-transparent text-ink hover:enabled:bg-[var(--surface-hover)]',
};

const sizeClasses = {
  default: 'h-9 px-3 text-small',
  sm: 'h-7 px-2 text-small',
  content: 'h-auto p-0 text-left text-small',
  icon: 'size-9',
  'icon-sm': 'size-6',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'ghost', size = 'icon', disabled, disabledReason, 'aria-describedby': describedBy, ...props },
  ref,
): ReactElement {
  const reasonId = useId();
  return (
    <>
      <button
        ref={ref}
        className={cn(
          'ui-button inline-flex select-none items-center justify-center gap-2 rounded-[var(--radius-control)] outline-none transition-colors duration-150 motion-reduce:transition-none',
          'focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page',
          'disabled:pointer-events-none disabled:opacity-50',
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...props}
        disabled={disabled}
        aria-describedby={disabled ? [describedBy, reasonId].filter(Boolean).join(' ') : describedBy}
      />
      {disabled ? <span id={reasonId} className="text-small text-muted">{disabledReason}</span> : null}
    </>
  );
});
