import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

/** Compact markdown in tables and metadata, without reading-page paragraph margins. */
export function ReadingContent({ compact = false, className, ...props }: HTMLAttributes<HTMLDivElement> & { compact?: boolean }) {
  return <div className={cn('[&_.reading_p]:my-0', compact && 'text-small leading-snug [&_.reading]:text-small [&_.reading_ul]:my-1 [&_.reading_ol]:my-1', className)} {...props} />;
}
