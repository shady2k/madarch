/**
 * How a link inside a page's Markdown behaves (requirement `pages`): a link to
 * another page of the wiki opens that page; a link to anything that is not a
 * page of the wiki — an outside address included — is shown as its text.
 */

export type ResolvedLink = { kind: 'wiki'; path: string } | { kind: 'plain' };

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
 * target that is not a page of the wiki: it resolves into the product but
 * names no page the wiki holds, or it points outside the wiki altogether.
 * The reader sees the link's text instead.
 */
export function classifyTarget(pagePath: string, href: string): ResolvedLink {
  const target = href.replace(/[#?].*$/, '');
  if (target === '') return { kind: 'plain' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { kind: 'plain' };
  if (target.startsWith('//')) return { kind: 'plain' };
  // Percent escapes are decoded before resolving, wherever the target is
  // rooted: `a%20b.md` and `/docs/a%20b.md` name the files they escape
  // (finding 2.10). An escape the wiki cannot read names no page.
  // A rooted address names the page at that path within the product —
  // `/docs/vision.md` and `/p/docs/vision.md` reach the same page, the
  // second being the wiki's own address shape (finding 5).
  let destination: string;
  try {
    destination = decodeURIComponent(target);
  } catch {
    return { kind: 'plain' };
  }
  let resolved: string;
  if (destination.startsWith('/p/')) {
    resolved = resolveRelative('', destination.slice('/p/'.length));
  } else if (destination.startsWith('/')) {
    // A rooted address names the page at that path within the product, so
    // it resolves against the product root with the same rules as a
    // relative one: `/docs/./vision.md` and `/docs/deep/../vision.md`
    // name the page their path reaches (finding 2.11).
    resolved = resolveRelative('', destination.slice(1));
  } else {
    resolved = resolveRelative(pagePath, destination);
  }
  if (resolved === '') return { kind: 'plain' };
  return { kind: 'wiki', path: resolved };
}

/** A link is shown as written only when the wiki holds the page it names. */
export function resolveLink(pagePath: string, href: string, heldPaths: ReadonlySet<string>): ResolvedLink {
  const classified = classifyTarget(pagePath, href);
  if (classified.kind === 'wiki' && !heldPaths.has(classified.path)) return { kind: 'plain' };
  return classified;
}
