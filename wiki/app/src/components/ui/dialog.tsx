/** shadcn/ui dialog with Radix focus management and wiki surfaces. */
import { createContext, useContext, forwardRef, type ComponentProps, type ReactNode, type HTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { Button } from './button.js';
import { cn } from '@/lib/utils.js';

const dialogSurface = 'flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-[var(--surface-menu)] text-ink shadow-[var(--shadow-high)]';

const CloseContext = createContext<{ label: string; show: boolean; disabled: boolean } | null>(null);

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Overlay>>(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay ref={ref} className={cn('fixed inset-0 wiki-modal-layer bg-ink/40', className)} {...props} />;
});

export const DialogContent = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Content> & { closeLabel?: string; showCloseButton?: boolean; closeDisabled?: boolean }>(function DialogContent({ className, children, closeLabel = 'Close', showCloseButton = true, closeDisabled = false, ...props }, ref) {
  return <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className={cn(dialogSurface, 'fixed left-1/2 top-1/2 wiki-modal-layer max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 outline-none', className)} {...props}>
      <CloseContext.Provider value={{ label: closeLabel, show: showCloseButton, disabled: closeDisabled }}>{children}</CloseContext.Provider>
    </DialogPrimitive.Content>
  </DialogPortal>;
});

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const close = useContext(CloseContext);
  return <div data-slot="dialog-header" className={cn('relative shrink-0 flex flex-col gap-2 border-b border-line p-6 pr-14', className)} {...props}>
    {props.children}
    {close?.show && <DialogPrimitive.Close asChild><Button size="icon" disabled={close.disabled} aria-label={close.label} className="absolute right-3 top-3"><XIcon aria-hidden="true" size={16} /></Button></DialogPrimitive.Close>}
  </div>;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="dialog-footer" className={cn('shrink-0 flex flex-wrap items-center justify-end gap-2 border-t border-line p-6', className)} {...props} />;
}

export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="dialog-body" className={cn('grid min-h-0 flex-1 gap-3 overflow-y-auto overscroll-contain p-6 text-small text-secondary', className)} {...props} />;
}

export const DialogTitle = forwardRef<HTMLHeadingElement, ComponentProps<typeof DialogPrimitive.Title>>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn('m-0 text-body font-semibold leading-tight text-ink', className)} {...props} />;
});

export const DialogDescription = forwardRef<HTMLParagraphElement, ComponentProps<typeof DialogPrimitive.Description>>(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn('m-0 text-small text-secondary', className)} {...props} />;
});

/** The dialog surface in document flow, without modal behavior or a focus trap. */
export function DialogPreview({ title, description, children, footer, className, ...props }: HTMLAttributes<HTMLDivElement> & { title: string; description?: string; footer?: ReactNode }) {
  return <div className={cn(dialogSurface, 'relative max-h-[min(36rem,calc(100dvh-2rem))] w-full max-w-lg', className)} {...props}>
    <DialogHeader><h3 className="m-0 text-body font-semibold leading-tight">{title}</h3>{description && <p className="m-0 text-small text-secondary">{description}</p>}</DialogHeader>
    <DialogBody>{children}</DialogBody>
    <DialogFooter>{footer}</DialogFooter>
  </div>;
}
