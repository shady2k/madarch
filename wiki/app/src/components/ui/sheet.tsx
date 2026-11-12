/**
 * The shadcn/ui Sheet, copied in the new-york shape and re-themed from the
 * wiki's own design tokens. This is the phone navigation's drawer: Radix's
 * dialog primitive underneath, the nav-shadow token on the panel, the chrome
 * ground, and the document column standing at its own width behind it.
 */
import { forwardRef, type ReactElement } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { Button } from './button.js';
import { DialogBody, DialogHeader } from './dialog.js';
import { cn } from '@/lib/utils.js';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export type SheetSide = 'left' | 'right';

const sideClasses: Record<SheetSide, string> = {
  left: 'inset-y-0 left-0 border-r border-line',
  right: 'inset-y-0 right-0 border-l border-line',
};

export const SheetContent = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Content> & { side?: SheetSide; title?: string; closeLabel?: string }
>(function SheetContent({ className, children, side = 'left', title = 'Navigation', closeLabel = 'Close', ...props }, ref): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 wiki-modal-layer bg-ink/40" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'sheet-drawer fixed wiki-modal-layer flex min-h-0 overflow-hidden w-[min(280px,_82vw)] flex-col rounded-r-[var(--radius-panel)] border border-line bg-[var(--surface-menu)] shadow-[var(--nav-shadow)] outline-none',
          sideClasses[side],
          className,
        )}
        {...props}
      >
        <DialogHeader>
          <DialogPrimitive.Title className="m-0 text-body font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild><Button size="icon" className="absolute right-2 top-2" aria-label={closeLabel}><XIcon aria-hidden="true" size={16} /></Button></DialogPrimitive.Close>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
