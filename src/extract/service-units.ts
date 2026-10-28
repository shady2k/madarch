/**
 * The units a repository declares: one per module or package manifest, named by
 * what that manifest says it is, plus the units a compose build context or a
 * Dockerfile declares where no manifest does.
 *
 * A service is not a folder called `services/` (madarch-mwhd.3): a repository
 * declares its own units, and the extractors read the declaration — `go.mod`'s
 * module path through the go.mod reader, `package.json`'s name, a compose
 * service's build context — never a path shape of one product. Which folders
 * hold someone else's manifest is registry data (repository-conventions.ts).
 */
import { parseDocument } from 'yaml';
import type { TreeReader } from './records.js';
import { byCodePoint } from '../model/order.js';
import { readGoMod } from '../fill/stages/manifest-format.js';
import { repositoryConventions } from './library-models/repository-conventions.js';

export interface ServiceUnit {
  /** What the declaration says it is, last path segment of it: `training.example/orders` is `orders`, `@acme/web` is `web`. */
  readonly name: string;
  /** The folder the declaration governs, `''` for the repository root. */
  readonly root: string;
  /** The file that declares it, or null for a unit a compose build context names. */
  readonly manifestPath: string | null;
  readonly ecosystem: 'go' | 'node' | 'declared';
  /** The whole declared identity, kept for the proofs that need it (a Go module path, say). */
  readonly declared: string;
  /** What declared it: a manifest, a compose build context, or a Dockerfile in the folder. */
  readonly source: 'manifest' | 'compose' | 'dockerfile';
}

const lastSegment = (value: string): string => {
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  return parts[parts.length - 1] ?? '';
};

const folderOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
};

const segmentsOf = (path: string): string[] => (path === '' || path === '.' ? [] : path.split('/').filter((part) => part !== '' && part !== '.'));

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', {fatal: false}).decode(bytes);

/** A path relative to a folder, resolved: `.` and `..` segments are folded, never guessed. */
function resolveUnder(folder: string, relative: string): string {
  const parts = segmentsOf(folder);
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { parts.pop(); continue; }
    parts.push(segment);
  }
  return parts.join('/');
}

/** The names the registry says hold another project's manifest. */
const FOREIGN = new Set(repositoryConventions.foreignManifestFolders.map((entry) => entry.folder));

interface Declarations {
  readonly manifests: readonly ServiceUnit[];
  readonly others: readonly ServiceUnit[];
}

/** The name a `package.json` declares; a manifest that names nothing is known by its folder. */
function packageNameOf(text: string, folder: string): string | undefined {
  try {
    const manifest = JSON.parse(text) as {name?: unknown};
    if (typeof manifest.name === 'string' && manifest.name.trim() !== '') return manifest.name.trim();
  } catch {
    // A manifest whose bytes are not JSON declares no name here; the syntax
    // extractor reports the unreadable file itself, and the folder names the unit.
  }
  return lastSegment(folder) === '' ? undefined : lastSegment(folder);
}

/** One compose file's build contexts: the service name and the folder it builds. */
function composeBuilds(folder: string, text: string): {name: string; root: string}[] {
  const document = parseDocument(text);
  if (document.errors.length > 0 || document.contents === null) return [];
  type Node = {get?: (key: string, keepScalar?: boolean) => unknown; items?: readonly unknown[]};
  const services = (document.contents as Node).get?.('services') as Node | undefined;
  const builds: {name: string; root: string}[] = [];
  for (const pair of (services?.items ?? []) as readonly {key?: {value?: unknown}; value?: Node}[]) {
    const name = pair.key?.value;
    if (typeof name !== 'string') continue;
    // The declared build context, as a plain string or as the map's `context` key.
    let context = pair.value?.get?.('build');
    if (context !== null && typeof context === 'object') context = (context as Node).get?.('context');
    if (typeof context !== 'string' || context.trim() === '') continue;
    builds.push({name, root: resolveUnder(folder, context.trim())});
  }
  return builds;
}

/**
 * Every unit the tree declares: manifests first, then the declarations that name
 * a folder where no manifest does. Sorted by root, then by name, so the walk of a
 * tree answers the same units in the same order every time.
 */
export function serviceUnits(tree: TreeReader): readonly ServiceUnit[] {
  const manifests: ServiceUnit[] = [];
  const compose: ServiceUnit[] = [];
  const dockerfiles: ServiceUnit[] = [];
  const manifestRoots = new Set<string>();
  const composeTexts: {path: string; text: string}[] = [];
  for (const path of tree.paths) {
    const segments = segmentsOf(path);
    if (segments.some((segment) => FOREIGN.has(segment))) continue;
    const file = segments[segments.length - 1] ?? '';
    const root = folderOf(path);
    let text: string;
    try {
      text = decode(tree.read(path));
    } catch {
      continue;
    }
    if (file === 'go.mod' || file === 'package.json') {
      const declared = file === 'go.mod' ? goModuleOf(text) : packageNameOf(text, root);
      const name = declared === undefined ? '' : lastSegment(declared);
      if (name === '') continue;
      manifests.push({name, root, manifestPath: path, ecosystem: file === 'go.mod' ? 'go' : 'node', declared: declared!, source: 'manifest'});
      manifestRoots.add(root);
      continue;
    }
    if (file === 'Dockerfile' || file.startsWith('Dockerfile.')) {
      // A Dockerfile at the repository root declares no unit: the root is the repository, and every
      // file under it would become that one service's.
      const name = nameOfFolder(root);
      if (name !== undefined) dockerfiles.push({name, root, manifestPath: path, ecosystem: 'declared', declared: name, source: 'dockerfile'});
      continue;
    }
    if (COMPOSE_NAMES.has(file)) composeTexts.push({path, text});
  }
  for (const entry of composeTexts) for (const build of composeBuilds(folderOf(entry.path), entry.text)) {
    // A build context that resolves to the repository root declares no unit, for the same reason.
    if (build.root === '' || manifestRoots.has(build.root) || build.name === '') continue;
    compose.push({name: build.name, root: build.root, manifestPath: null, ecosystem: 'declared', declared: build.name, source: 'compose'});
  }
  const declaredRoots = new Set([...manifests.map((unit) => unit.root), ...compose.map((unit) => unit.root)]);
  const others = [...compose, ...dockerfiles.filter((unit) => !declaredRoots.has(unit.root))];
  return [...manifests, ...others].sort((left, right) => byCodePoint(left.root, right.root) || byCodePoint(left.name, right.name));
}

/** The compose file names the registry declares, compared exactly: no pattern over a path. */
const COMPOSE_NAMES = new Set(['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);

const nameOfFolder = (root: string): string | undefined => {
  if (root === '') return undefined;
  const name = lastSegment(root);
  return name === '' ? undefined : name;
};

/** The module path one `go.mod` declares, read by the go.mod reader; a comment never joins it. */
function goModuleOf(text: string): string | undefined {
  const read = readGoMod(text);
  return read.ok ? read.value.module : undefined;
}

export interface UnitIndex {
  /** The units a manifest declares, by the folder they govern. */
  readonly manifests: ReadonlyMap<string, ServiceUnit>;
  /** The units a compose build context or a Dockerfile declares, by folder. */
  readonly others: ReadonlyMap<string, ServiceUnit>;
}

/** An index of the units by the folder they govern: one lookup per ancestor of a path. */
export function unitIndex(units: readonly ServiceUnit[]): UnitIndex {
  const manifests = new Map<string, ServiceUnit>();
  const others = new Map<string, ServiceUnit>();
  for (const unit of units) {
    const held = unit.source === 'manifest' ? manifests : others;
    if (!held.has(unit.root)) held.set(unit.root, unit);
  }
  return {manifests, others};
}

/**
 * The unit a repository path belongs to: the deepest ancestor folder that declares
 * one. A manifest is the stronger declaration, so it answers first; a compose or
 * Dockerfile declaration answers only where no manifest governs the path.
 */
export function unitOfPath(units: UnitIndex, path: string): ServiceUnit | undefined {
  const declared = deepest(units.manifests, path);
  return declared ?? deepest(units.others, path);
}

function deepest(index: ReadonlyMap<string, ServiceUnit>, path: string): ServiceUnit | undefined {
  let folder = folderOf(path);
  for (;;) {
    const held = index.get(folder);
    if (held !== undefined) return held;
    if (folder === '') return undefined;
    folder = folderOf(folder);
  }
}

/** The name of the unit a path belongs to, or undefined outside every unit. */
export function serviceOfPath(units: UnitIndex, path: string): string | undefined {
  return unitOfPath(units, path)?.name;
}

/** The files one unit governs, in the tree's own order. */
export function filesOfUnit(tree: TreeReader, unit: ServiceUnit): string[] {
  const prefix = unit.root === '' ? '' : `${unit.root}/`;
  return tree.paths.filter((path) => prefix === '' || path.startsWith(prefix));
}
