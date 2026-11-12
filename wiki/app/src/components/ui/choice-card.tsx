/** Choice cards used by first-open and preference dialogs. */
import type { HTMLAttributes, LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';
export function ChoiceCard({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) { return <label className={cn('flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-card)] border border-line px-3 py-2 has-[:checked]:border-ink', className)} {...props} />; }
export function DialogBody(props: HTMLAttributes<HTMLDivElement>) { return <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto text-small text-secondary" {...props} />; }
export function ChoiceDescription(props: HTMLAttributes<HTMLSpanElement>) { return <span className="text-small text-secondary" {...props} />; }
