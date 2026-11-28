import { join } from 'node:path';
import { releaseRoot } from '../product-wiki/release-assets.js';

const engineLocationRoots = [
  join(releaseRoot(), 'src').replaceAll('\\', '/') + '/',
  join(releaseRoot(), 'scripts').replaceAll('\\', '/') + '/',
  '/$bunfs/',
  'B:/~BUN/',
];

/**
 * Strip the leading engine location from a client message while preserving product locations
 * (madarch-64o5.203). `product` is the folder of the product the client asked about: a location
 * under it belongs to the product, even where the product sits inside the checkout's own `src/`
 * or `scripts/`, which are engine folders to a location that names an engine module.
 */
export function stripEngineLocation(message: string, product?: string): string {
  const start = errorNameLength(message);
  const end = leadingLocationEnd(message, start);
  if (end < 0) return message;
  const location = message.slice(start, end).replaceAll('\\', '/');
  if (product !== undefined && underProduct(location, product)) return message;
  return engineLocationRoots.some((root) => location.startsWith(root)) ? message.slice(end + 2) : message;
}

/** The `TypeError: ` a message carries when it was made from an error's own text. */
function errorNameLength(message: string): number {
  const first = message.indexOf(': ');
  return first > 0 && message.slice(0, first).endsWith('Error') ? first + 2 : 0;
}

/**
 * Where the message's leading location ends, when it has one: after its line number — `path:12:`,
 * or `path:12:4:` — because a checkout folder may itself hold a colon and a space, so the first
 * `: ` does not end the location. A location with no line number (an engine module's own) ends at
 * its first `: `.
 */
function leadingLocationEnd(message: string, start: number): number {
  const first = message.indexOf(': ', start);
  if (first < 0) return -1;
  for (let at = first; at >= 0; at = message.indexOf(': ', at + 2)) {
    if (endsWithLineNumber(message.slice(start, at))) return at;
  }
  return engineLocationRoots.some((root) => message.slice(start, first).replaceAll('\\', '/').startsWith(root)) ? first : -1;
}

/** True when the text ends with a line number, `:<digits>`, or the column after it, `:<digits>:<digits>`. */
function endsWithLineNumber(text: string): boolean {
  const colon = text.lastIndexOf(':');
  if (colon <= 0 || colon === text.length - 1) return false;
  for (let at = colon + 1; at < text.length; at += 1) if (!'0123456789'.includes(text[at]!)) return false;
  return true;
}

/** True when the location names the product's own folder or a file below it. */
function underProduct(location: string, product: string): boolean {
  let end = product.length;
  while (end > 0 && (product[end - 1] === '/' || product[end - 1] === '\\')) end -= 1;
  const root = product.slice(0, end).replaceAll('\\', '/');
  return location === root || location.startsWith(`${root}/`);
}
