import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';
export function TechnicalText({ className, ...props }: HTMLAttributes<HTMLPreElement>) {
  return <pre className={cn('whitespace-pre-wrap break-words text-[0.8125rem]', className)} {...props} />;
}
