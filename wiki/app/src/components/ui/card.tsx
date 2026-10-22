/**
 * The shadcn/ui Card, copied in the new-york shape and re-themed from the
 * wiki's own design tokens: the card surface, the card radius, the low shadow.
 */
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card({ className, ...props }, ref) {
  return <div ref={ref} className={cn('ui-card rounded-[var(--radius-card)] border border-line bg-[var(--surface-card)] text-ink shadow-[var(--shadow-low)]', className)} {...props} />;
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardHeader({ className, ...props }, ref) {
  return <div ref={ref} className={cn('flex flex-col gap-1 px-4 pt-4', className)} {...props} />;
});

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(function CardTitle({ className, ...props }, ref) {
  return <h3 ref={ref} className={cn('!m-0 text-body font-[550] leading-snug', className)} {...props} />;
});

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(function CardDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn('m-0 text-small text-secondary', className)} {...props} />;
});

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn('px-4 pb-4 pt-3', className)} {...props} />;
});

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardFooter({ className, ...props }, ref) {
  return <div ref={ref} className={cn('flex items-center gap-2 border-t border-line px-4 py-3', className)} {...props} />;
});
