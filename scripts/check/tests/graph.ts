/**
 * The import graph of values from the layer folders: what a `test/unit/` or
 * `test/integration/` file reaches when type-only imports are not followed.
 *
 * dependency-cruiser reads the graph with the repository's own committed setup
 * (`.dependency-cruiser.mjs`: swc parses, `tsPreCompilationDeps` keeps the type
 * information), and this module keeps the edges that are values. A dependency that
 * is only `import type` — or every specifier written `type` — is not a value the
 * running test can reach, and the unit rule is about what runs.
 *
 * dependency-cruiser reports which module imports which, not the line the import is
 * written on. The line comes from the importing module's own syntax tree
 * (`scripts/check/architecture/imports.ts`, the one parse an architecture rule
 * already uses), matched by the specifier as written.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cruise, type ICruiseOptions } from 'dependency-cruiser';
import { importStatementsOf } from '../architecture/imports.js';
import { repositoryRoot } from '../architecture/sources.js';
import { byCodePoint } from '../../../src/model/order.js';

/** One value a module reaches: a path from the root, or the specifier of a module the repository does not hold. */
export interface ImportEdge {
  /** The target: a module's path from the root, or a package or core module's specifier (`pg`, `child_process`). */
  readonly to: string;
  /** The specifier exactly as the importing module writes it. */
  readonly specifier: string;
  /** The 1-based line the import is written on. */
  readonly line: number;
}

/** The value imports of every module the layer folders reach. */
export interface ImportGraph {
  readonly root: string;
  /** The edges of each module under the root, in code point order of the target and then by line. */
  readonly edges: ReadonlyMap<string, readonly ImportEdge[]>;
  /** The modules under the root the cruise read: the nodes a chain may pass through. */
  readonly modules: ReadonlySet<string>;
}

/** An empty graph: a tree with no layer folder has nothing to read. */
export function emptyImportGraph(root: string): ImportGraph {
  return { root, edges: new Map(), modules: new Set() };
}

interface DependencyConfiguration {
  readonly options: ICruiseOptions;
}

/** The committed dependency-cruiser setup, read once: the same parser and exclusions `check:architecture` runs. */
let committed: Promise<ICruiseOptions> | undefined;

async function committedOptions(): Promise<ICruiseOptions> {
  committed ??= (async () => {
    const file = resolve(repositoryRoot(), '.dependency-cruiser.mjs');
    const loaded = (await import(pathToFileURL(file).href)) as { readonly default?: DependencyConfiguration };
    const options = loaded.default?.options;
    if (options === undefined) {
      throw new Error(`${file}:1: the dependency rules have no options export, and the test check reads its parser and exclusions from them`);
    }
    return options;
  })();
  return await committed;
}

/**
 * The value import graph of the folders named. A folder that does not exist is left
 * out; when none exists — today's tree, before the layers are laid out — the graph is
 * empty and no cruise runs.
 */
export async function valueImportGraph(root: string, folders: readonly string[]): Promise<ImportGraph> {
  const present = folders.filter((folder) => existsSync(join(root, ...folder.split('/'))));
  if (present.length === 0) return emptyImportGraph(root);
  const options = await committedOptions();
  const result = await cruise(present, { ...options, baseDir: root, validate: false });
  const output = result.output;
  if (typeof output === 'string') {
    throw new Error(`${root}:1: dependency-cruiser answered ${JSON.stringify(output.slice(0, 80))} rather than a report; the test check reads its report as data`);
  }
  const edges = new Map<string, ImportEdge[]>();
  const modules = new Set<string>();
  const statements = new Map<string, ReturnType<typeof importStatementsOf>>();
  for (const module of output.modules) {
    const source = toRepositoryPath(root, module.source);
    if (source === null) continue;
    modules.add(source);
    const found: ImportEdge[] = [];
    for (const dependency of module.dependencies) {
      if (dependency.typeOnly === true || dependency.dependencyTypes.includes('type-only')) continue;
      const local = repositoryPathOf(root, dependency.resolved);
      const to = local ?? dependency.module;
      let written = statements.get(source);
      if (written === undefined) {
        written = importStatementsOf(root, source);
        statements.set(source, written);
      }
      const matches = written.filter((statement) => statement.specifier === dependency.module);
      const statement = matches.find((candidate) => !candidate.typeOnly) ?? matches[0];
      found.push({ to, specifier: dependency.module, line: statement?.line ?? 1 });
    }
    found.sort((left, right) => byCodePoint(left.to, right.to) || left.line - right.line);
    edges.set(source, found);
  }
  return { root, edges, modules };
}

/** A path dependency-cruiser reports, as a path from the root; `null` when it is no module this repository holds. */
function toRepositoryPath(root: string, path: string): string | null {
  const absoluteRoot = resolve(root);
  const normalized = path.split('\\').join('/');
  const relative = normalized === absoluteRoot
    ? ''
    : normalized.startsWith(`${absoluteRoot}/`)
      ? normalized.slice(absoluteRoot.length + 1)
      : normalized;
  if (relative.length === 0 || relative.startsWith('/') || relative.includes('node_modules/')) return null;
  if (!existsSync(resolve(root, ...relative.split('/')))) return null;
  return relative;
}

/** The resolved path of a dependency when it is a module under the root, and `null` when it is a package or core module. */
function repositoryPathOf(root: string, resolved: string | undefined): string | null {
  if (resolved === undefined || resolved.length === 0) return null;
  return toRepositoryPath(root, resolved);
}

/** The module a value edge names, or `null` when the edge leaves the repository. */
export function reachedModule(graph: ImportGraph, edge: ImportEdge): string | null {
  return graph.modules.has(edge.to) ? edge.to : null;
}
