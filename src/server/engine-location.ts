import { join } from 'node:path';
import { releaseRoot } from '../product-wiki/release-assets.js';

/** The roots a compiled binary's own code is mounted under, on every platform. */
const bundleRoots = ['/$bunfs/', 'B:/~BUN/'];

/** The extensions an engine module carries: only such a path names the engine's own code in a checkout. */
const engineModuleExtensions = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'];

/**
 * Strip the leading engine location from a client message while preserving product locations
 * (madarch-64o5.203). `product` is the folder of the product the client asked about: a location
 * under it belongs to the product, even where the product sits inside the checkout's own `src/`
 * or `scripts/`, which are engine folders to a location that names an engine module.
 *
 * The known root decides where a location ends, not the shape of what follows it: a bundle mount
 * holds no colon and no space, so its location ends at its first `: `, and a checkout's source
 * folder is consumed whole — its own path may hold a colon and a space — up to the module the
 * engine raised in.
 */
export function stripEngineLocation(message: string, product?: string, engineRoot: string = releaseRoot()): string {
  const rest = message.slice(errorNameLength(message));
  const normalized = rest.replaceAll('\\', '/');
  if (product !== undefined && underProduct(normalized, product)) return message;
  for (const root of bundleRoots) {
    if (!normalized.startsWith(root)) continue;
    const end = normalized.indexOf(': ', root.length);
    return end < 0 ? message : rest.slice(end + 2);
  }
  for (const root of engineSourceRoots(engineRoot)) {
    if (!normalized.startsWith(root)) continue;
    const end = sourceLocationEnd(normalized, root.length);
    return end < 0 ? message : rest.slice(end + 2);
  }
  return message;
}

/**
 * The `TypeError: ` a message carries when it was made from an error's own text. The name is a bare
 * identifier, never a path: a checkout folder named `ScratchError` ends in `Error` too, and the
 * colon and space that follow it are part of the path.
 */
function errorNameLength(message: string): number {
  const first = message.indexOf(': ');
  if (first <= 0 || !message.slice(0, first).endsWith('Error')) return 0;
  return isErrorName(message.slice(0, first)) ? first + 2 : 0;
}

/** True for a name like `TypeError`: letters, digits, `_` and `$` only, never a path separator. */
function isErrorName(name: string): boolean {
  for (const character of name) {
    const letter = (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
    if (!letter && !(character >= '0' && character <= '9') && character !== '_' && character !== '$') return false;
  }
  return name.length > 0;
}

/** The checkout's own source folders. The prefix ends in a separator, so it is matched whole. */
function engineSourceRoots(engineRoot: string): string[] {
  let root = engineRoot.replaceAll('\\', '/');
  while (root.endsWith('/')) root = root.slice(0, -1);
  return [join(root, 'src'), join(root, 'scripts')].map((folder) => `${folder.replaceAll('\\', '/')}/`);
}

/**
 * Where the leading location of a message under the checkout's source folder ends: after the module
 * the engine raised in. Only a module extension makes a segment the engine's; a numbered file that
 * is no module is a product's, and an unnumbered segment is a phrase only while the text after it
 * names no absolute path.
 */
function sourceLocationEnd(normalized: string, from: number): number {
  let search = from;
  for (;;) {
    const end = normalized.indexOf(': ', search);
    if (end < 0) return -1;
    const held = withoutLineNumbers(normalized.slice(from, end));
    if (held.module) return end;
    if (held.numbered) return -1;
    const after = end + 2;
    const next = normalized.indexOf(': ', after);
    const segment = next < 0 ? normalized.slice(after) : normalized.slice(after, next);
    if (namesAbsolutePath(segment) || segment.includes(' /')) return -1;
    search = after;
  }
}

/** A segment without its line number and column, `:<digits>` up to twice, and whether it carried one. */
function withoutLineNumbers(segment: string): { readonly module: boolean; readonly numbered: boolean } {
  let path = segment;
  let numbered = false;
  for (let taken = 0; taken < 2; taken += 1) {
    const colon = path.lastIndexOf(':');
    if (colon <= 0 || colon === path.length - 1) break;
    let digits = true;
    for (let at = colon + 1; at < path.length; at += 1) if (!'0123456789'.includes(path[at]!)) { digits = false; break; }
    if (!digits) break;
    path = path.slice(0, colon);
    numbered = true;
  }
  return { module: engineModuleExtensions.some((extension) => path.endsWith(extension)), numbered };
}

/** True when the text starts with an absolute path, `/…` on Unix or `C:/…` on Windows. */
function namesAbsolutePath(text: string): boolean {
  if (text.startsWith('/')) return true;
  if (text.length < 3 || text[1] !== ':' || text[2] !== '/') return false;
  const drive = text[0]!;
  return (drive >= 'a' && drive <= 'z') || (drive >= 'A' && drive <= 'Z');
}

/** True when the location names the product's own folder, a file below it, or a line of it. */
function underProduct(location: string, product: string): boolean {
  let end = product.length;
  while (end > 0 && (product[end - 1] === '/' || product[end - 1] === '\\')) end -= 1;
  const root = product.slice(0, end).replaceAll('\\', '/');
  if (root === '') return false;
  return location === root || location.startsWith(`${root}/`) || location.startsWith(`${root}:`);
}
