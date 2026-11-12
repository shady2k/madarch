/** Viewport shell: fixed chrome, independently scrolling navigation and page. */
import { forwardRef, type HTMLAttributes, type ButtonHTMLAttributes, type AnchorHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';
import { SheetContent } from './sheet.js';
import { Skeleton } from './skeleton.js';
import { CardContent } from './card.js';
import { DropdownMenuContent } from './dropdown-menu.js';
import type { ComponentProps } from 'react';
import { Button, type ButtonProps } from './button.js';

export function ShellSidebar({ loading, ...props }: HTMLAttributes<HTMLElement> & { loading?: boolean }) { return <aside className={cn('app-nav hidden w-[240px] wide:w-[260px] shrink-0 border-r border-line bg-chrome md:flex', loading && 'flex-col gap-3 px-[14px] py-[18px] wide:px-[18px]')} {...props} />; }
export function ShellMain(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-main flex min-h-0 min-w-0 flex-1 flex-col" {...props} />; }
export function ShellFixed(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-fixed z-30 shrink-0" {...props} />; }
export function ShellRow(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-row flex min-h-0 flex-1 overflow-hidden" {...props} />; }
export const ShellScroll = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ShellScroll(props, ref) { return <div ref={ref} className="shell-scroll min-h-0 min-w-0 flex-1 overflow-auto" {...props} />; });
export function ShellDocument(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-document w-full" {...props} />; }
export function ShellToolbar(props: HTMLAttributes<HTMLElement>) { return <header className="shell-toolbar flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-line bg-page px-4 wide:px-[35px]" {...props} />; }
export function ShellActions(props: HTMLAttributes<HTMLSpanElement>) { return <span className="flex shrink-0 items-center gap-1" {...props} />; }
export function ShellBreadcrumb(props: HTMLAttributes<HTMLSpanElement>) { return <span className="shell-breadcrumb min-w-0 truncate text-small text-secondary" {...props} />; }
export function ShellBreadcrumbSeparator() { return <span aria-hidden="true" className="px-2 text-muted">/</span>; }
export function ShellTabs(props: HTMLAttributes<HTMLDivElement>) { return <div role="tablist" className="tab-bar flex min-h-[38px] shrink-0 items-end gap-1 overflow-x-auto border-b border-line bg-chrome px-3 pt-1.5 wide:px-[27px]" {...props} />; }
export function ShellTab({ active, ...props }: HTMLAttributes<HTMLDivElement> & { active: boolean }) { return <div className={cn('tab group flex min-w-28 items-center rounded-t-md border border-b-0', active ? 'border-line bg-page text-ink' : 'border-transparent text-secondary hover:bg-chrome')} {...props} />; }
export function ShellTabTrigger(props: ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" role="tab" className="min-w-0 flex-1 cursor-pointer truncate bg-transparent px-3 py-1.5 text-left text-small text-inherit focus-visible:ring-2 focus-visible:ring-ink" {...props} />; }
export function ShellTabClose(props: ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className="mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-row)] bg-transparent text-muted hover:bg-[var(--surface-active)] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink" {...props} />; }
export function ShellMenuButton(props: ButtonProps) { return <Button className="shell-menu md:!hidden" {...props} />; }
export function ShellIconLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a className="inline-flex size-9 items-center justify-center rounded-[var(--radius-control)] text-secondary no-underline hover:bg-[var(--surface-hover)] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink" {...props} />; }
export function ShellRoleButton(props: ButtonProps) { return <Button variant="ghost" size="content" className="h-9 gap-1.5 px-2" {...props} />; }
export function ShellRoleLabel(props: HTMLAttributes<HTMLSpanElement>) { return <span className="hidden text-small sm:inline" {...props} />; }
export function ShellError(props: HTMLAttributes<HTMLDivElement>) { return <div className="grid min-h-dvh place-items-center bg-page p-6 text-ink [font-family:var(--font-sans)]" {...props} />; }

export const ShellStatusButton = forwardRef<HTMLButtonElement, ButtonProps & { compact?: boolean }>(function ShellStatusButton({ compact, ...props }, ref) { return <Button ref={ref} size="content" className={cn('fill-chip rounded-[var(--radius-row)] focus-visible:ring-2 focus-visible:ring-ink', compact && 'fill-chip-writing')} {...props} />; });
export const ShellStatusWrap = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ShellStatusWrap(props, ref) { return <div ref={ref} className="relative" {...props} />; });
export function ShellStatusLabel(props: HTMLAttributes<HTMLSpanElement>) { return <span className="fill-chip-label" {...props} />; }
export function ShellStatusWords(props: HTMLAttributes<HTMLSpanElement>) { return <span className="fill-chip-words" {...props} />; }
export function ShellStatusCount({ narrow, ...props }: HTMLAttributes<HTMLSpanElement> & { narrow?: boolean }) { return <span className={cn('fill-chip-count', narrow && 'fill-chip-count-narrow')} {...props} />; }
export function ShellStatusBody(props: HTMLAttributes<HTMLDivElement>) { return <div className="px-2 pb-2 text-small" {...props} />; }
export function ShellStatusLine({ inset, ...props }: HTMLAttributes<HTMLParagraphElement> & { inset?: boolean }) { return <p className={cn('m-0 mt-1 break-words text-small', inset && 'px-2 pb-2')} {...props} />; }
export function ShellStatusMessage(props: HTMLAttributes<HTMLDivElement>) { return <div className="m-0 px-2 pb-2 text-small" {...props} />; }
export function ShellStatusDot({ state, ...props }: HTMLAttributes<HTMLSpanElement> & { state: 'up-to-date' | 'stale' | 'running' | 'failed' }) { return <span className="fill-dot mr-1.5 inline-block size-2 shrink-0 rounded-full align-middle" {...props}><span aria-hidden="true" className={cn('block size-full rounded-full', state === 'up-to-date' || state === 'running' ? 'bg-current' : 'border border-current', state === 'running' && 'animate-pulse motion-reduce:animate-none')} /></span>; }

export function ShellBrandMark() { return <svg aria-hidden="true" className="size-10 shrink-0 text-ink" viewBox="0 0 50 32"><text x="0" y="25" fill="currentColor" fontFamily="Inter, sans-serif" fontSize="31" fontWeight="750" letterSpacing="-4">m<tspan fill="var(--text)">·</tspan></text></svg>; }

export function ShellProductMenu(props: ComponentProps<typeof DropdownMenuContent>) { return <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]" {...props} />; }
export function ShellProductLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a className="flex items-center gap-2 no-underline" {...props} />; }
export function ShellLanguageButton(props: ButtonProps) { return <Button variant="ghost" size="icon" className="shell-language size-9" {...props} />; }
export function ShellFillContent(props: ComponentProps<typeof CardContent>) { return <CardContent className="grid gap-2 p-3" {...props} />; }
export function ShellFillChoice(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a className="rounded px-2 py-2 text-small text-ink hover:bg-chrome" {...props} />; }
export function ShellHomeLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a className="text-muted no-underline hover:text-ink" {...props} />; }
export function ShellAnswersLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a className="answers-waiting no-underline" {...props} />; }
export function ShellAnswersWords(props: HTMLAttributes<HTMLSpanElement>) { return <span className="answers-waiting-words" {...props} />; }
export function ShellAnswersCount(props: HTMLAttributes<HTMLSpanElement>) { return <span className="answers-waiting-count" {...props} />; }
export function ShellNavigationLoading() { return <><Skeleton className="h-7 w-32" /><Skeleton className="h-9 w-full" />{[70, 55, 62, 48].map((width, index) => <Skeleton key={index} className="h-5" style={{ width: `${width}%` }} />)}</>; }
export function ShellToolbarLoading() { return <header className="shell-toolbar min-h-[58px] border-b border-line" />; }
export function ShellNavigationSheet(props: ComponentProps<typeof SheetContent>) { return <SheetContent className="app-nav w-[min(280px,_82vw)] px-[14px] py-3" {...props} />; }
