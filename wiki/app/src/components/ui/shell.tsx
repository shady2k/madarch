/** Viewport shell: fixed chrome, independently scrolling navigation and page. */
import { forwardRef, type HTMLAttributes, type AnchorHTMLAttributes } from 'react';
import { cn } from '@/lib/utils.js';
import { SheetContent } from './sheet.js';
import { Skeleton } from './skeleton.js';
import { DropdownMenuContent } from './dropdown-menu.js';
import type { ComponentProps } from 'react';

export function ShellSidebar({ loading, ...props }: HTMLAttributes<HTMLElement> & { loading?: boolean }) { return <aside className={cn('app-nav hidden w-[240px] wide:w-[260px] shrink-0 border-r border-line bg-chrome md:flex', loading && 'flex-col gap-3 px-[14px] py-[18px] wide:px-[18px]')} {...props} />; }
export function ShellMain(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-main flex min-h-0 min-w-0 flex-1 flex-col" {...props} />; }
export function ShellFixed(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-fixed z-30 shrink-0" {...props} />; }
export function ShellRow(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-row flex min-h-0 flex-1 overflow-hidden" {...props} />; }
export const ShellScroll = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ShellScroll(props, ref) { return <div ref={ref} className="shell-scroll min-h-0 min-w-0 flex-1 overflow-auto" {...props} />; });
export function ShellDocument(props: HTMLAttributes<HTMLDivElement>) { return <div className="shell-document w-full" {...props} />; }
export function ShellToolbar(props: HTMLAttributes<HTMLElement>) { return <header className="shell-toolbar flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-line bg-page px-4 wide:px-[35px]" {...props} />; }
export function ShellActions(props: HTMLAttributes<HTMLSpanElement>) { return <span className="flex shrink-0 items-center gap-1" {...props} />; }
/** A top-bar control that stands only where the sidebar is gone: a phone's width needs the menu, a wide screen never. */
export function ShellPhoneOnly(props: HTMLAttributes<HTMLSpanElement>) { return <span className="md:hidden" {...props} />; }
export function ShellRoleLabel(props: HTMLAttributes<HTMLSpanElement>) { return <span className="hidden text-small sm:inline" {...props} />; }
export function ShellError(props: HTMLAttributes<HTMLDivElement>) { return <div className="grid h-full min-h-full place-items-center bg-page p-6 text-ink [font-family:var(--font-sans)]" {...props} />; }


export function ShellBrandMark() { return <svg aria-hidden="true" className="size-10 shrink-0 text-ink" viewBox="0 0 50 32"><text x="0" y="25" fill="currentColor" fontFamily="Inter, sans-serif" fontSize="31" fontWeight="750" letterSpacing="-4">m<tspan fill="var(--text)">·</tspan></text></svg>; }

export function ShellProductMenu(props: ComponentProps<typeof DropdownMenuContent>) { return <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]" {...props} />; }
export function ShellProductLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a className="flex items-center gap-2 no-underline" {...props} />; }
export function ShellNavigationLoading() { return <><Skeleton className="h-7 w-32" /><Skeleton className="h-9 w-full" />{[70, 55, 62, 48].map((width, index) => <Skeleton key={index} className="h-5" style={{ width: `${width}%` }} />)}</>; }
export function ShellToolbarLoading() { return <header className="shell-toolbar min-h-[58px] border-b border-line" />; }
export function ShellNavigationSheet(props: ComponentProps<typeof SheetContent>) { return <SheetContent className="app-nav w-[min(280px,_82vw)] px-[14px] py-3" {...props} />; }
