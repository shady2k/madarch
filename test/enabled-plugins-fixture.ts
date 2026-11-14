import { readFolderManifestText, starterManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { seedStarterSet, STARTER_FILES } from '../src/knowledge/seed.js';

/** Keeps only exercised plugins; excluded bindings become passive provenance, with every field retained. */
export function useFixturePlugins(folder: string, ids: readonly string[], keepKinds: readonly string[] = []): void {
  const file = join(folder, 'madarch', 'catalog.yaml');
  const manifest = parseDocument(readFolderManifestText(folder));
  const body = manifest.toJS();
  const plugins = (body.plugins ?? []) as { id: string }[];
  for (const id of ids) {
    if (!plugins.some(plugin => plugin.id === id)) throw new Error(`${file}:1: fixture requests undeclared plugin ${id}`);
  }
  const removed = new Set(plugins.filter(plugin => !ids.includes(plugin.id)).map(plugin => plugin.id));
  const kinds = body.kinds ?? {};
  for (const [name, kind] of Object.entries(kinds) as [string, { source?: string; terms?: string[]; fields?: { binding?: unknown }[] }][]) {
    let converted = false;
    for (const [index, field] of (kind.fields ?? []).entries()) {
      if (typeof field.binding !== 'string') continue;
      const producer = field.binding.split('@')[0]!;
      if (!removed.has(producer)) continue;
      converted = true;
      manifest.deleteIn(['kinds', name, 'fields', index, 'binding']);
      manifest.setIn(['kinds', name, 'fields', index, 'producers'], [producer]);
    }
    const hasBinding = (kind.fields ?? []).some(field => field.binding !== undefined && (typeof field.binding !== 'string' || !removed.has(field.binding.split('@')[0]!)));
    if (converted && kind.source === 'graph' && kind.terms !== undefined && !hasBinding) {
      manifest.deleteIn(['kinds', name, 'terms']);
    }
  }
  const kept = plugins.filter(plugin => ids.includes(plugin.id)) as { id: string; outputs?: string[]; inputs?: string[] }[];
  manifest.set('plugins', kept);
  // A kind whose only producers are gone leaves the manifest with them: a product declares the kinds its plugins fill,
  // and a kind left with no producer is an abnormal state the fill reports as an error (madarch-64o5.60). A kind whose
  // fields people author stays: the manifest names a person as its producer.
  let filled = new Set<string>();
  for (const plugin of kept) {
    for (const kind of plugin.outputs ?? []) filled.add(kind);
    const contract = join(folder, 'plugins', plugin.id, 'contract.json');
    if (!existsSync(contract)) continue;
    const held = JSON.parse(readFileSync(contract, 'utf8')) as { outputs?: { vertices?: { kind: string }[] } };
    for (const vertex of held.outputs?.vertices ?? []) filled.add(vertex.kind);
  }
  const gone = new Set<string>();
  const dropped = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, kind] of Object.entries(kinds) as [string, { fields?: { producers?: string[] }[]; 'derives-from'?: string[] }][]) {
      if (gone.has(name)) continue;
      const declared = kind.fields ?? [];
      if (declared.length === 0 || filled.has(name)) continue;
      if (declared.every((field) => field.producers?.includes('person') === true)) continue;
      gone.add(name);
      changed = true;
    }
    // A plugin whose declared input kind left cannot run: it leaves with the kind, and its outputs leave after it.
    for (const plugin of kept) {
      if (dropped.has(plugin.id)) continue;
      if (!(plugin.inputs ?? []).every((kind) => !gone.has(kind))) { dropped.add(plugin.id); changed = true; }
    }
    for (const id of dropped) for (const plugin of kept) if (plugin.id === id) for (const kind of plugin.outputs ?? []) if (!gone.has(kind)) { gone.add(kind); changed = true; }
  }
  filled.clear();
  for (const plugin of kept) {
    if (dropped.has(plugin.id)) continue;
    for (const kind of plugin.outputs ?? []) filled.add(kind);
    const contract = join(folder, 'plugins', plugin.id, 'contract.json');
    if (!existsSync(contract)) continue;
    const held = JSON.parse(readFileSync(contract, 'utf8')) as { outputs?: { vertices?: { kind: string }[] } };
    for (const vertex of held.outputs?.vertices ?? []) filled.add(vertex.kind);
  }
  manifest.set('plugins', kept.filter((plugin) => !dropped.has(plugin.id)));
  // Kinds the caller keeps stand even when no plugin fills them: a fixture may write their vertices itself, which is a
  // person's authored write and no plugin's producer.
  for (const name of keepKinds) {
    gone.delete(name);
    const declared = ((body.kinds ?? {}) as Record<string, { fields?: { name: string }[] }>)[name]?.fields ?? [];
    for (const [index] of declared.entries()) {
      manifest.deleteIn(['kinds', name, 'fields', index, 'binding']);
      manifest.setIn(['kinds', name, 'fields', index, 'producers'], ['person']);
    }
  }
  for (const name of gone) manifest.deleteIn(['kinds', name]);
  // An edge whose end left with its kinds leaves too: a relation names kinds the manifest declares.
  const edges = (body.edges ?? []) as { from: string[]; to: string[] }[];
  manifest.set('edges', edges.filter((edge) => [...edge.from, ...edge.to].every((name) => name === 'any' || !gone.has(name))));
  writeFolderManifest(folder, manifest.toString());
}

/** Seeds a fresh repository-only fixture with both complete closures, not the everything starter's other plugins. */
export function seedRepositoryPlugins(folder: string): void {
  const ids = ['disk', 'git'];
  for (const file of STARTER_FILES) {
    if (file.path.startsWith('plugins/') && !ids.includes(file.path.split('/')[1]!)) continue;
    const target = join(folder, file.path);
    mkdirSync(dirname(target), { recursive: true });
    if (file.path === 'madarch/plugins.lock') {
      const lock = parseDocument(file.content);
      lock.set('plugins', lock.toJS().plugins.filter((plugin: { id: string }) => ids.includes(plugin.id)));
      writeFileSync(target, lock.toString(), { flag: 'wx' });
    } else {
      writeFileSync(target, file.bytes ?? file.content, { flag: 'wx' });
    }
  }
  useFixturePlugins(folder, ids);
}

/** Declares repository fact inputs for fixtures that previously relied on native stages. */
export function useRepositoryPlugins(folder: string): void {
  const hadManifest = existsSync(join(folder, 'madarch', 'catalog.yaml'));
  const previous = hadManifest ? readFolderManifestText(folder) : undefined;
  seedStarterSet(folder);
  const manifest = parseDocument(previous ?? readFolderManifestText(folder));
  const starter = parseDocument(starterManifestText()).toJS();
  for (const key of ['purposes', 'roles']) {
    manifest.set(key, { ...starter[key], ...(manifest.toJS()[key] ?? {}) });
  }
  const body = manifest.toJS();
  const repositoryKinds = ['code.repository', 'code.directory', 'code.file', 'code.gitlink', 'code.commit', 'code.author'];
  for (const name of repositoryKinds) {
    const existing = body.kinds?.[name];
    if (existing === undefined || existing.fields === undefined) {
      manifest.setIn(['kinds', name], { ...starter.kinds[name], ...existing });
    }
  }
  const plugins = body.plugins ?? [];
  for (const id of ['disk', 'git']) {
    if (!plugins.some((plugin: { id: string }) => plugin.id === id)) plugins.push(starter.plugins.find((plugin: { id: string }) => plugin.id === id));
  }
  manifest.set('plugins', plugins);
  const edges = body.edges ?? [];
  for (const edge of starter.edges ?? []) {
    if (!edge.name.startsWith('code.') || !['disk', 'git'].includes(edge.capability)) continue;
    const existing = edges.findIndex((candidate: { name: string }) => candidate.name === edge.name);
    if (existing < 0) edges.push(edge);
    else edges[existing] = { ...edges[existing], ...edge };
  }
  manifest.set('edges', edges);
  writeFolderManifest(folder, manifest.toString());
  const lockFile = join(folder, 'madarch', 'plugins.lock');
  const lock = parseDocument(readFileSync(lockFile, 'utf8'));
  const starterLock = parseDocument(STARTER_FILES.find(file => file.path === 'madarch/plugins.lock')!.content).toJS();
  const locked = lock.toJS().plugins ?? [];
  for (const id of ['disk', 'git']) {
    if (!locked.some((plugin: { id: string }) => plugin.id === id)) locked.push(starterLock.plugins.find((plugin: { id: string }) => plugin.id === id));
  }
  lock.set('plugins', locked);
  writeFileSync(lockFile, lock.toString());
  if (!hadManifest) useFixturePlugins(folder, ['disk', 'git']);
}
