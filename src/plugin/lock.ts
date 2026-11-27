/**
 * The plugin lock (decision 0035, item 20): `madarch/plugins.lock` of a product
 * repository records each plugin's exact version and the hash of its closure,
 * so a fill runs exactly what the lock names, on any machine. The manifest binds
 * a major version; the lock names the minor and patch, and a fill that finds a
 * closure whose hash is not the locked one refuses the plugin by name instead of
 * running other bytes.
 *
 * The file is YAML: a top-level `plugins:` sequence of `{ id, version, closure,
 * path }` items. A lock that cannot be read is refused with the file and the
 * line, never treated as no lock; the reason says what is wrong and never
 * repeats the file, so a reader places the location beside it once
 * (madarch-64o5.197).
 */
import { LineCounter, parseDocument, visit } from 'yaml';
import { lineForPath } from '../model/yaml-position.js';
import { byCodePoint } from '../model/order.js';

/** The lock's place in the product repository. */
export const PLUGINS_LOCK_FILE = 'madarch/plugins.lock';

/** One plugin the product locks: its exact version, its closure's hash and its folder. */
export interface PluginLockEntry {
  readonly id: string;
  /** The exact semantic version the fill runs. */
  readonly version: string;
  /** The sha256 of the closure the fill executes (`src/plugin/closure.ts`). */
  readonly closure: string;
  /** The plugin's folder in the product repository, `/`-separated. */
  readonly path: string;
  readonly line: number;
}

/** A lock that could not be read: the file, the line and what to fix. */
export type PluginLockRefusal = { readonly ok: false; readonly file: string; readonly line: number; readonly message: string };

/** The lock as the product folder holds it: its entries, a refusal, or absent when the product holds none. */
export type PluginLockRead =
  | { readonly ok: true; readonly file: string; readonly entries: readonly PluginLockEntry[]; readonly text: string; readonly absent?: true }
  | PluginLockRefusal;

const NAME = /^[a-z][a-z0-9-]*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HASH = /^[0-9a-f]{64}$/u;

/** The major version a semantic version names. */
export function majorOf(version: string): string {
  const cut = version.indexOf('.');
  return cut < 0 ? version : version.slice(0, cut);
}


/** The first alias of the document whose anchor is not there, with the line it stands on. */
function firstUnresolvedAlias(document: ReturnType<typeof parseDocument>, lines: LineCounter): { readonly anchor: string; readonly line: number } | undefined {
  let found: { readonly anchor: string; readonly line: number } | undefined;
  visit(document, {
    Alias(_key, node) {
      if (found !== undefined) return visit.BREAK;
      if (node.resolve(document) !== undefined) return;
      found = { anchor: node.source, line: node.range === null || node.range === undefined ? 1 : lines.linePos(node.range[0]).line };
      return visit.BREAK;
    },
  });
  return found;
}

/**
 * Parses a plugin lock's text, as the working tree or the graph's stored files hold it: `text` undefined is a product
 * that holds no lock.
 */
export function parsePluginLock(text: string | undefined, file: string = PLUGINS_LOCK_FILE): PluginLockRead {
  if (text === undefined) return { ok: true, file, entries: [], text: '', absent: true };
  const lines = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const at = (path: (string | number)[]): number => {
    try {
      return lineForPath(parsed, lines, path);
    } catch {
      return 1;
    }
  };
  if (parsed.errors.length > 0) return { ok: false, file, line: at([]), message: `the plugin lock cannot be read as YAML: ${parsed.errors[0]!.message.split('\n')[0] ?? parsed.errors[0]!.message}` };
  let root: unknown;
  try {
    root = parsed.toJS();
  } catch (error) {
    // An alias whose anchor is not there is no error the document reports: the conversion throws instead, which the
    // command's own diagnostic answers with its file and line rather than the runtime's stack (madarch-64o5.197).
    const alias = firstUnresolvedAlias(parsed, lines);
    if (alias === undefined) throw error;
    return { ok: false, file, line: alias.line, message: `the alias *${alias.anchor} names no anchor of the document: an anchor is set before the alias that uses it` };
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return { ok: false, file, line: 1, message: 'the plugin lock is a mapping with a "plugins" sequence in it' };
  const top = root as Record<string, unknown>;
  for (const key of Object.keys(top)) if (key !== 'plugins') return { ok: false, file, line: at([key]), message: `the plugin lock holds "plugins" and nothing else, and holds "${key}"` };
  const raw = top['plugins'];
  if (raw === undefined) return { ok: true, file, entries: [], text };
  if (!Array.isArray(raw)) return { ok: false, file, line: at(['plugins']), message: '"plugins" is a list of { id, version, closure, path }' };
  const entries: PluginLockEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    const line = at(['plugins', index]);
    const body = entry as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, file, line, message: 'a plugin lock entry is { id, version, closure, path }' };
    const extra = Object.keys(body).filter((key) => key !== 'id' && key !== 'version' && key !== 'closure' && key !== 'path');
    if (extra.length > 0) return { ok: false, file, line, message: `"${extra[0]}" is not a field of a plugin lock entry: the fields are id, version, closure and path` };
    const id = body['id'];
    const version = body['version'];
    const closure = body['closure'];
    const path = body['path'];
    if (typeof id !== 'string' || !NAME.test(id)) return { ok: false, file, line, message: 'a plugin lock entry names its plugin by id: lower-case letters, digits and dashes' };
    if (typeof version !== 'string' || !VERSION.test(version)) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} is locked at ${JSON.stringify(version)}: the lock records the exact semantic version (1.0.0)` };
    if (typeof closure !== 'string' || !HASH.test(closure)) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} is locked with the closure ${JSON.stringify(closure)}: the lock records the closure's sha256, 64 lower-case hex digits` };
    if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.split('/').some((leg) => leg === '' || leg === '.' || leg === '..')) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} is locked at the folder ${JSON.stringify(path)}: the path is relative to the product repository` };
    if (entries.some((held) => held.id === id)) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} stands twice: a plugin is locked once` };
    entries.push({ id, version, closure, path, line });
  }
  entries.sort((left, right) => byCodePoint(left.id, right.id));
  return { ok: true, file, entries, text };
}
