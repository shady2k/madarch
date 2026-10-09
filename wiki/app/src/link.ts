/**
 * How a link inside a page's Markdown behaves (requirement `pages`): a link to
 * another page of the wiki opens that page; a link whose target the wiki does
 * not hold is shown as its text; an external link opens as it is written.
 */

export type ResolvedLink =
  | { kind: 'wiki'; path: string }
  | { kind: 'external'; href: string }
  | { kind: 'plain' };

/** Joins a relative target against the page it was written on, without a URL object. */
function resolveRelative(pagePath: string, target: string): string {
  const directory = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/') + 1) : '';
  const parts = (directory + target).split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' && stack.length > 0) continue;
    if (part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/**
 * Classifies one Markdown link target by its shape alone. `plain` marks a
 * target that resolves into the product but names no page the wiki holds and
 * no outside address; the reader sees the link's text instead.
 */
export function classifyTarget(pagePath: string, href: string): ResolvedLink {
  const target = href.replace(/[#?].*$/, '');
  if (target === '') return { kind: 'plain' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    if (/^https?:/i.test(target)) return { kind: 'external', href };
    return { kind: 'plain' };
  }
  if (target.startsWith('//')) return { kind: 'external', href };
  const resolved = target.startsWith('/') ? target.slice(1) : resolveRelative(pagePath, target);
  if (resolved === '') return { kind: 'plain' };
  return { kind: 'wiki', path: resolved };
}

/** A link is shown as written only when the wiki holds the page it names. */
export function resolveLink(pagePath: string, href: string, heldPaths: ReadonlySet<string>): ResolvedLink {
  const classified = classifyTarget(pagePath, href);
  if (classified.kind === 'wiki' && !heldPaths.has(classified.path)) return { kind: 'plain' };
  return classified;
}
