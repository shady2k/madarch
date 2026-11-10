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
 * line, never treated as no lock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
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

/** The lock as the product folder holds it: its entries, a refusal, or absent when the product holds none. */
export function readPluginLock(productFolder: string): PluginLockRead {
  const file = PLUGINS_LOCK_FILE;
  let text: string;
  try {
    text = readFileSync(join(productFolder, file), 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { ok: true, file, entries: [], text: '', absent: true };
    return { ok: false, file, line: 1, message: `the plugin lock ${file} cannot be read: ${(error as Error).message}` };
  }
  const lines = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const at = (path: (string | number)[]): number => {
    try {
      return lineForPath(parsed, lines, path);
    } catch {
      return 1;
    }
  };
  if (parsed.errors.length > 0) return { ok: false, file, line: at([]), message: `the plugin lock ${file} cannot be read as YAML: ${parsed.errors[0]!.message.split('\n')[0] ?? parsed.errors[0]!.message}` };
  const root: unknown = parsed.toJS();
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return { ok: false, file, line: 1, message: `the plugin lock ${file} is a mapping with a "plugins" sequence in it` };
  const top = root as Record<string, unknown>;
  for (const key of Object.keys(top)) if (key !== 'plugins') return { ok: false, file, line: at([key]), message: `the plugin lock ${file} holds "plugins" and nothing else, and holds "${key}"` };
  const raw = top['plugins'];
  if (raw === undefined) return { ok: true, file, entries: [], text };
  if (!Array.isArray(raw)) return { ok: false, file, line: at(['plugins']), message: `"plugins" in ${file} is a list of { id, version, closure, path }` };
  const entries: PluginLockEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    const line = at(['plugins', index]);
    const body = entry as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, file, line, message: `a plugin lock entry of ${file} is { id, version, closure, path }` };
    const extra = Object.keys(body).filter((key) => key !== 'id' && key !== 'version' && key !== 'closure' && key !== 'path');
    if (extra.length > 0) return { ok: false, file, line, message: `"${extra[0]}" is not a field of a plugin lock entry in ${file}: the fields are id, version, closure and path` };
    const id = body['id'];
    const version = body['version'];
    const closure = body['closure'];
    const path = body['path'];
    if (typeof id !== 'string' || !NAME.test(id)) return { ok: false, file, line, message: `a plugin lock entry of ${file} names its plugin by id: lower-case letters, digits and dashes` };
    if (typeof version !== 'string' || !VERSION.test(version)) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} is locked at ${JSON.stringify(version)} in ${file}: the lock records the exact semantic version (1.0.0)` };
    if (typeof closure !== 'string' || !HASH.test(closure)) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} is locked with the closure ${JSON.stringify(closure)} in ${file}: the lock records the closure's sha256, 64 lower-case hex digits` };
    if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.split('/').some((leg) => leg === '' || leg === '.' || leg === '..')) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} is locked at the folder ${JSON.stringify(path)} in ${file}: the path is relative to the product repository` };
    if (entries.some((held) => held.id === id)) return { ok: false, file, line, message: `the plugin ${JSON.stringify(id)} stands twice in ${file}: a plugin is locked once` };
    entries.push({ id, version, closure, path, line });
  }
  entries.sort((left, right) => byCodePoint(left.id, right.id));
  return { ok: true, file, entries, text };
}
