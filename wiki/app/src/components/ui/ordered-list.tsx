import type { OlHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export function OrderedList({ className, ...props }: OlHTMLAttributes<HTMLOListElement>) {
  return <ol className={cn('m-0 list-none p-0', className)} {...props} />;
}
