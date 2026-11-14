import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils.js';

/** A labelled line of metadata, with linked or plain values. */
export function MetadataLine({ label, children, className, ...props }: HTMLAttributes<HTMLDivElement> & { label?: ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-1 text-small leading-snug [&_.reading_p]:my-0', className)} {...props}>
      {label !== undefined && <span className="text-muted">{label}</span>}
      {children}
    </div>
  );
}
