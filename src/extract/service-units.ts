/**
 * The units a repository declares: one per module or package manifest, named by
 * what that manifest says it is and rooted at the folder the manifest governs.
 *
 * A service is not a folder called `services/` (madarch-mwhd.3): a repository
 * declares its own units, and the extractors read the declaration — `go.mod`'s
 * module path, `package.json`'s name — never a path shape of one product.
 */
import type { TreeReader } from './records.js';
import { byCodePoint } from '../model/order.js';

export interface ServiceUnit {
  /** What the manifest declares, last path segment of it: `training.example/orders` is `orders`, `@acme/web` is `web`. */
  readonly name: string;
  /** The folder the manifest governs, `''` for the repository root. */
  readonly root: string;
  readonly manifestPath: string;
  readonly ecosystem: 'go' | 'node';
  /** The declared identity itself, kept for the proofs that need the whole of it. */
  readonly declared: string;
}

/** Folders whose manifests declare someone else's unit, never this repository's. */
const FOREIGN = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage']);

const lastSegment = (value: string): string => {
  const parts = value.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
};

const folderOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
};

const segmentsOf = (path: string): string[] => (path === '' ? [] : path.split('/'));

/** The module path one `go.mod` declares, or undefined when it declares none. */
function goModuleOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('module')) continue;
    const rest = trimmed.slice('module'.length).trim();
    return rest === '' ? undefined : rest;
  }
  return undefined;
}

/** The name one `package.json` declares; a manifest that names nothing is known by its folder. */
function packageNameOf(text: string, folder: string): string | undefined {
  try {
    const manifest = JSON.parse(text) as { name?: unknown };
    if (typeof manifest.name === 'string' && manifest.name.trim() !== '') return manifest.name.trim();
  } catch {
    // A manifest whose bytes are not JSON declares no name here; the syntax
    // extractor reports the unreadable file itself, and the folder names the unit.
  }
  const folderName = lastSegment(folder);
  return folderName === '' ? undefined : folderName;
}

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/** Every unit the tree declares, in root order. */
export function serviceUnits(tree: TreeReader): readonly ServiceUnit[] {
  const units: ServiceUnit[] = [];
  for (const path of tree.paths) {
    const segments = segmentsOf(path);
    if (segments.some((segment) => FOREIGN.has(segment))) continue;
    const file = segments[segments.length - 1];
    if (file !== 'go.mod' && file !== 'package.json') continue;
    const root = folderOf(path);
    let text: string;
    try {
      text = decode(tree.read(path));
    } catch {
      continue;
    }
    const declared = file === 'go.mod' ? goModuleOf(text) : packageNameOf(text, root);
    if (declared === undefined) continue;
    const name = lastSegment(declared);
    if (name === '') continue;
    units.push({ name, root, manifestPath: path, ecosystem: file === 'go.mod' ? 'go' : 'node', declared });
  }
  return units.sort((left, right) => byCodePoint(left.root, right.root) || byCodePoint(left.name, right.name));
}

/** An index of the units by the folder they govern: one lookup per ancestor of a path. */
export function unitIndex(units: readonly ServiceUnit[]): ReadonlyMap<string, ServiceUnit> {
  const index = new Map<string, ServiceUnit>();
  for (const unit of units) if (!index.has(unit.root)) index.set(unit.root, unit);
  return index;
}

/**
 * The unit a repository path belongs to: the deepest ancestor folder that
 * declares one, so a package inside a module answers with the package.
 */
export function unitOfPath(units: ReadonlyMap<string, ServiceUnit>, path: string): ServiceUnit | undefined {
  let folder = folderOf(path);
  for (;;) {
    const held = units.get(folder);
    if (held !== undefined) return held;
    if (folder === '') return undefined;
    folder = folderOf(folder);
  }
}

/** The name of the unit a path belongs to, or undefined outside every unit. */
export function serviceOfPath(units: ReadonlyMap<string, ServiceUnit>, path: string): string | undefined {
  return unitOfPath(units, path)?.name;
}

/** The files one unit governs, in the tree's own order. */
export function filesOfUnit(tree: TreeReader, unit: ServiceUnit): string[] {
  const prefix = unit.root === '' ? '' : `${unit.root}/`;
  return tree.paths.filter((path) => prefix === '' || path.startsWith(prefix));
}
