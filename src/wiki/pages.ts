







/**
 * One link or image of a document, resolved to what it names in the
 * repository: another document's page, an image the build copies into the
 * site, something left as written — an external scheme, a `#anchor` of
 * the same page, a protocol-relative link — that the built-site link
 * check judges like every other link, the full address of the path it
 * names on the repository's host at the built commit (`host`), or a link
 * shown as text — a refused scheme, or one with nowhere on the host to
 * lead: no origin, a host the wiki does not link to, a path that climbs
 * out of the repository. The build warns about every link shown as text
 * and about every host link the repository does not hold; it never fails
 * on a document link.
 */



/**
 * Orders two strings by Unicode code point. Several sorts below must agree
 * with each other and stay off the machine's locale, so they share this one
 * comparator; the link checker sorts its report by it too.
 */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
