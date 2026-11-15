import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export function InlineCode({ className, ...props }: HTMLAttributes<HTMLElement>) {
  // A path, a key or a command can be longer than the column: it wraps anywhere rather than widening the page.
  return <code className={cn('font-mono text-small [overflow-wrap:anywhere]', className)} {...props} />;
}
export function Strong({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <b className={cn('font-semibold', className)} {...props} />;
}
