/**
 * The shadcn/ui Dialog in the wiki's tokens: a centered panel over a dimmed
 * page, Radix's dialog primitive underneath (focus is trapped, Escape closes).
 * It asks a question that needs an answer before anything is changed.
 */
import { forwardRef, type ReactElement } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils.js';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = forwardRef<HTMLHeadingElement, React.ComponentProps<typeof DialogPrimitive.Title>>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn('m-0 text-h3 font-semibold text-ink', className)} {...props} />;
});
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = forwardRef<HTMLDivElement, React.ComponentProps<typeof DialogPrimitive.Content>>(function DialogContent({ className, children, ...props }, ref): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/40" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('fixed left-1/2 top-1/2 z-50 grid max-h-[85dvh] w-[min(34rem,_92vw)] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-[var(--surface-menu)] p-5 text-ink shadow-[var(--shadow-high)] outline-none', className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
