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

/**
 * A text the engine wrote, as the reader's page shows it (madarch-64o5.200): every engine location is
 * taken out, wherever it stands — after the source path that opens a message, inside a sentence the
 * engine composed, in a context field — and a stack frame that names only the engine's own bundle goes
 * with it. A bundle frame carries no source map: its line and column are an offset in the shipped
 * binary, not a line a reader can open. A frame at the checkout's own source keeps its line and column
 * and loses only the folder this machine keeps the checkout in; a product's location stands as written.
 *
 * The record stays as the engine wrote it on disk: this reads it for a person, and the evidence a
 * developer needs is still in the file beside the store.
 */
export function stripEngineLocations(text: string, product?: string, engineRoot: string = releaseRoot()): string {
  const shown: string[] = [];
  for (const line of text.split('\n')) {
    const frame = frameOf(line);
    if (frame === null) { shown.push(stripFieldsOf(line, product, engineRoot)); continue; }
    const location = readerLocationOf(frame.location, engineRoot);
    if (location !== null) shown.push(line.slice(0, frame.start) + location + line.slice(frame.end));
  }
  return shown.join('\n');
}

/** A stack frame's location in its line, with the positions it holds: the text inside the last parentheses, or the last word. */
function frameOf(line: string): { readonly start: number; readonly end: number; readonly location: string } | null {
  const start = firstWordStart(line);
  if (start === 0 || line.slice(start, start + 2) !== 'at' || line[start + 2]?.trim() !== '') return null;
  if (line.endsWith(')')) {
    const open = line.lastIndexOf('(');
    if (open >= 0) return { start: open + 1, end: line.length - 1, location: line.slice(open + 1, -1) };
  }
  const last = line.lastIndexOf(' ');
  const location = line.slice(last + 1);
  return location === '' ? null : { start: last + 1, end: line.length, location };
}

/**
 * A location as the reader's page shows it: null for the engine's own bundle, which names a byte in the
 * shipped binary rather than a line; the source path for a file of the checkout the engine was built
 * from (`src/x.ts:12:3`); and the location as written for anything else — a product's file, a plugin's,
 * a frame native to the runtime.
 */
function readerLocationOf(location: string, engineRoot: string): string | null {
  const normalized = location.replaceAll('\\', '/');
  for (const root of bundleRoots) if (normalized.startsWith(root)) return null;
  for (const root of engineSourceRoots(engineRoot)) {
    if (!normalized.startsWith(root)) continue;
    const folder = root.slice(0, -1);
    const checkout = folder.slice(0, folder.lastIndexOf('/') + 1);
    return checkout === '' ? null : normalized.slice(checkout.length);
  }
  return location;
}

/** A line with every engine location a field of its own taken out: the one at its head first, then any later one. */
function stripFieldsOf(line: string, product: string | undefined, engineRoot: string): string {
  let text = stripEngineLocation(line, product, engineRoot);
  for (;;) {
    const found = nextEngineField(text, engineRoot);
    if (found === null) break;
    text = text.slice(0, found.start) + text.slice(found.end);
  }
  // A field whose whole value is one engine location has nothing left a reader can use: the bundle's own
  // offset names no source, and the checkout's path names the machine more than it names the file.
  const whole = text.trim();
  if (whole === '' || holdsWhitespace(whole)) return text;
  return readerLocationOf(whole, engineRoot) ?? '';
}

/** Where a line's first word starts, after the indentation a stack line carries. */
function firstWordStart(line: string): number {
  let start = 0;
  while (start < line.length && line[start]!.trim() === '') start += 1;
  return start;
}

/** True when a text holds a space, a tab or another character that is no part of a word. */
function holdsWhitespace(text: string): boolean {
  for (const character of text) if (character.trim() === '') return true;
  return false;
}

/** The next engine location a line holds as a field: where it starts, and where the text it opens stops. */
function nextEngineField(text: string, engineRoot: string): { readonly start: number; readonly end: number } | null {
  const normalized = text.replaceAll('\\', '/');
  for (let at = 0; at < normalized.length; at += 1) {
    // A field stands where a phrase ends: at the line's head, after a space, or inside an opening parenthesis.
    if (at !== 0 && normalized[at - 1] !== ' ' && normalized[at - 1] !== '(') continue;
    const end = engineFieldEnd(normalized, at, engineRoot);
    if (end !== null) return { start: at, end: end + 2 };
  }
  return null;
}

/** Where the engine location that starts at `at` stops, at the `: ` that follows it; null when no engine location starts there. */
function engineFieldEnd(normalized: string, at: number, engineRoot: string): number | null {
  for (const root of bundleRoots) {
    if (!normalized.startsWith(root, at)) continue;
    const end = normalized.indexOf(': ', at + root.length);
    return end < 0 ? null : end;
  }
  for (const root of engineSourceRoots(engineRoot)) {
    if (!normalized.startsWith(root, at)) continue;
    const end = sourceLocationEnd(normalized, at + root.length);
    return end < 0 ? null : end;
  }
  return null;
}
