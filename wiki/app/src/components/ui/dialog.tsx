/** shadcn/ui dialog with Radix focus management and wiki surfaces. */
import { forwardRef, type ComponentProps, type HTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';

const dialogSurface = 'grid gap-4 rounded-[var(--radius-panel)] border border-line bg-[var(--surface-menu)] p-6 text-ink shadow-[var(--shadow-high)]';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Overlay>>(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay ref={ref} className={cn('fixed inset-0 wiki-modal-layer bg-ink/40', className)} {...props} />;
});

export const DialogContent = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Content> & { closeLabel?: string; showCloseButton?: boolean }>(function DialogContent({ className, children, closeLabel = 'Close', showCloseButton = true, ...props }, ref) {
  return <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className={cn(dialogSurface, 'fixed left-1/2 top-1/2 wiki-modal-layer max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto outline-none', className)} {...props}>
      {children}
      {showCloseButton && <DialogPrimitive.Close className="absolute right-3 top-3 rounded-[var(--radius-control)] p-1 text-secondary outline-none hover:bg-[var(--surface-hover)] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink disabled:pointer-events-none">
        <XIcon aria-hidden="true" size={16} /><span className="sr-only">{closeLabel}</span>
      </DialogPrimitive.Close>}
    </DialogPrimitive.Content>
  </DialogPortal>;
});

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-2 pr-6', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap justify-end gap-2', className)} {...props} />;
}

export const DialogTitle = forwardRef<HTMLHeadingElement, ComponentProps<typeof DialogPrimitive.Title>>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn('m-0 text-body font-semibold leading-tight text-ink', className)} {...props} />;
});

export const DialogDescription = forwardRef<HTMLParagraphElement, ComponentProps<typeof DialogPrimitive.Description>>(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn('m-0 text-small text-secondary', className)} {...props} />;
});

/** The dialog surface in document flow, without modal behavior or a focus trap. */
export function DialogPreview({ title, description, children, className, ...props }: HTMLAttributes<HTMLDivElement> & { title: string; description?: string }) {
  return <div className={cn(dialogSurface, 'relative w-full max-w-lg', className)} {...props}>
    <DialogHeader><h3 className="m-0 text-body font-semibold leading-tight">{title}</h3>{description && <p className="m-0 text-small text-secondary">{description}</p>}</DialogHeader>
    {children}
  </div>;
}
