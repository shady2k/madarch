import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export function InlineCode({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <code className={cn('font-mono text-small', className)} {...props} />;
}
export function Strong({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <b className={cn('font-semibold', className)} {...props} />;
}
