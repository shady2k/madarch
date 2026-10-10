/**
 * The shadcn/ui Sheet, copied in the new-york shape and re-themed from the
 * wiki's own design tokens. This is the phone navigation's drawer: Radix's
 * dialog primitive underneath, the nav-shadow token on the panel, the chrome
 * ground, and the document column standing at its own width behind it.
 */
import { forwardRef, type ReactElement } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils.js';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;

export type SheetSide = 'left' | 'right';

const sideClasses: Record<SheetSide, string> = {
  left: 'inset-y-0 left-0 border-r border-line',
  right: 'inset-y-0 right-0 border-l border-line',
};

export const SheetContent = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Content> & { side?: SheetSide }
>(function SheetContent({ className, children, side = 'left', ...props }, ref): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/40" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex w-[min(280px,_82vw)] flex-col bg-chrome shadow-[var(--nav-shadow)] outline-none',
          sideClasses[side],
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="sr-only">Document navigation</DialogPrimitive.Title>
        <DialogPrimitive.Close className="absolute right-2 top-2 rounded-[5px] p-1 text-secondary hover:bg-pill hover:text-ink">
          <XIcon aria-hidden="true" size={16} />
          <span className="sr-only">Close navigation</span>
        </DialogPrimitive.Close>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
