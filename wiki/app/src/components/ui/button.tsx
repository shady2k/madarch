/**
 * The shadcn/ui Button, copied in the new-york shape and re-themed from the
 * wiki's own design tokens: no shadcn theme colours, the graphite pairs stand
 * in (the tokens remain the single colour source). Radix underneath is not
 * needed for the button itself.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactElement } from 'react';
import { cn } from '@/lib/utils.js';

export type ButtonVariant = 'default' | 'ghost';
export type ButtonSize = 'default' | 'icon' | 'icon-sm';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const variantClasses: Record<ButtonVariant, string> = {
  default: 'bg-chrome text-ink border border-line shadow-none hover:bg-pill',
  ghost: 'text-secondary hover:enabled:bg-pill hover:enabled:text-ink',
};

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-9 px-3 text-small',
  icon: 'size-9',
  'icon-sm': 'size-6',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'ghost', size = 'icon', ...props },
  ref,
): ReactElement {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-[5px] outline-none',
        'focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        'disabled:pointer-events-none disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
});
