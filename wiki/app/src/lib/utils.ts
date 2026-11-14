/**
 * The shadcn/ui class helper, as the copied components expect it. The app adds
 * no extra class-merge dependency: a truthy-value join keeps the shadcn shape
 * without clsx/tailwind-merge, and the app's classes never conflict enough to
 * need a real merge (the acceptance walk checks the rendered result).
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
