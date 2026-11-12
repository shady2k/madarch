import type { CSSProperties, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

/** Theme-paired colors supplied by a syntax highlighter, isolated from page layout. */
export function SyntaxToken({ colors, fontStyle = 0, className, ...props }: HTMLAttributes<HTMLSpanElement> & { colors: Record<string, string>; fontStyle?: number }) {
  return <span className={cn('shiki-token', Boolean(fontStyle & 1) && 'italic', Boolean(fontStyle & 2) && 'font-semibold', className)} style={colors as CSSProperties} {...props} />;
}
