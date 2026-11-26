/**
 * The plugin-free store walk keeps a reduced catalogue: the kinds the engine's own
 * reads name, without any plugin.
 *
 * A store acceptance walk fills a product on a machine that cannot isolate a plugin
 * (Windows has no plugin sandbox), so the walk removes every plugin from the product's
 * catalogue. An engine read — the fill's own repository pins, the workbook's file
 * inventory (0039) — still names its kinds through `semantic-bindings`: dropping the
 * declarations that carry them made the fill refuse with "semantic-bindings.repository
 * is required by this read". The reduced catalogue therefore keeps the code structure
 * and history kinds (repository, directory, file, commit, author) with the kinds they
 * derive from, the edges those kinds relate by and the semantic bindings over them,
 * and drops every other kind, edge and plugin. The catalogue's own metadata — its
 * purposes among them — stays: a purpose names no kind of its own and an engine read
 * still asks for it.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

/** The kinds a plugin-free fill reads: the store's repositories, their trees and their history. */
const STORE_KINDS = ['code.repository', 'code.directory', 'code.file', 'code.commit', 'code.author'] as const;

interface Catalog {
  readonly groups?: Record<string, { readonly parent?: string }>;
  readonly roles?: Record<string, { readonly lead?: readonly string[]; readonly open?: readonly string[] }>;
  readonly documents?: { readonly expect?: readonly string[] };
  readonly edges?: readonly { readonly name: string; readonly from: readonly string[]; readonly to: readonly string[] }[];
  readonly 'semantic-bindings'?: Record<string, { readonly kind: string; readonly edges?: Record<string, { readonly kind: string; readonly direction: 'from' | 'to' }> }>;
  readonly plugins?: readonly unknown[];
  readonly problems?: unknown;
  readonly [key: string]: unknown;
}

/** The metadata a reduced catalogue keeps: everything but the plugins, the problems and the kinds the filter below drops. */
const KEPT_METADATA = ['value-types', 'purposes', 'properties', 'catalog', 'groups', 'roles', 'values', 'language'] as const;

/** Every kind file the template wrote, by the kind name its file name gives it. */
function kindFiles(kinds: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (folder: string): void => {
    let names: string[];
    try { names = readdirSync(folder); } catch { return; }
    for (const name of names) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (name.endsWith('.yaml') && name !== '.yaml') found.set(name.slice(0, -'.yaml'.length), path);
    }
  };
  walk(kinds);
  return found;
}

export function prepareStoreAcceptanceFixture(folder: string): void {
  const manifestFolder = join(folder, 'madarch');
  const kinds = join(manifestFolder, 'kinds');
  const catalog = parse(readFileSync(join(manifestFolder, 'catalog.yaml'), 'utf8')) as Catalog;
  const files = kindFiles(kinds);
  const declarations = new Map([...files].map(([name, path]) => [name, parse(readFileSync(path, 'utf8')) as { readonly 'derives-from'?: readonly string[] }]));

  // The kept kinds rest on the kinds they derive from, which the manifest requires too.
  const kept = new Set<string>();
  const keep = (name: string): void => {
    if (kept.has(name) || !declarations.has(name)) return;
    kept.add(name);
    for (const parent of declarations.get(name)!['derives-from'] ?? []) keep(parent);
  };
  for (const name of STORE_KINDS) keep(name);
  if (!kept.has('code.file')) throw new Error(`${join(manifestFolder, 'catalog.yaml')}:1: the product's catalogue declares no code.file, so the store acceptance fixture has nothing to keep`);

  // A kind is its file: the catalogue holds the metadata around those files.
  for (const [name, path] of files) {
    if (!kept.has(name)) rmSync(path);
  }
  const prune = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) { prune(path); if (readdirSync(path).length === 0) rmSync(path, { recursive: true }); }
    }
  };
  prune(kinds);

  // A protected kind (`system.*`) is declared by the engine, never by the product, so an edge that names one stands.
  const endpoints = (names: readonly string[]): string[] => names.filter(name => name === 'any' || name.startsWith('system.') || kept.has(name));
  const edges = (catalog.edges ?? []).map(edge => ({ ...edge, from: endpoints(edge.from), to: endpoints(edge.to) }))
    .filter(edge => edge.from.length > 0 && edge.to.length > 0);
  // A semantic role is kept when its kind stands and every edge it names relates that kind.
  const bindings = Object.fromEntries(Object.entries(catalog['semantic-bindings'] ?? {})
    .filter(([, binding]) => kept.has(binding.kind) && Object.values(binding.edges ?? {}).every(role =>
      edges.some(edge => edge.name === role.kind && edge[role.direction].some(name => name === 'any' || name === binding.kind)))));
  const reduced: Catalog = {
    ...Object.fromEntries(KEPT_METADATA.filter(key => catalog[key] !== undefined).map(key => [key, catalog[key]])),
    documents: { ...catalog.documents, expect: (catalog.documents?.expect ?? []).filter(name => kept.has(name)) },
    edges,
    'semantic-bindings': bindings,
  };
  mkdirSync(kinds, { recursive: true });
  writeFileSync(join(manifestFolder, 'catalog.yaml'), stringify(reduced, { lineWidth: 0 }));
  // A plugin-free product installs no plugin: the folder's contracts name the kinds of the full catalogue and are
  // refused once the catalogue is reduced, so the installation goes with the declarations that listed it.
  rmSync(join(folder, 'plugins'), { recursive: true, force: true });
  rmSync(join(manifestFolder, 'plugins.lock'), { force: true });
}
