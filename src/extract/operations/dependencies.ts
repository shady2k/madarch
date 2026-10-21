/**
 * The dependencies: what each package.json and go.mod declares (direct, dev,
 * indirect, with the exact versions the manifests pin), what each lock file
 * resolves (the package counts with their dev-only split, the module sums),
 * and which source files use which dependency.
 */
import type { PropertyValue } from '../records.js';
import type { Records } from './accumulate.js';
import { readGoMod, readJson } from '../../fill/stages/manifest-format.js';
import { serviceOf, TreeText } from './source.js';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

/** The npm manifests of the tree, with their declared dependencies. */
function npmManifests(t: TreeText, records: Records): void {
  for (const path of t.pathsNamed(/^package\.json$/)) {
    if (path.includes('node_modules')) continue;
    const service = serviceOf(path);
    const read = readJson(t.text(path));
    if (!read.ok) {
      records.gap(path, `line ${read.gap.line}: ${read.gap.detail}`);
      continue;
    }
    const manifest = read.value.value as { name?: unknown; private?: unknown; version?: unknown; scripts?: unknown; dependencies?: unknown; devDependencies?: unknown };
    const properties: { [key: string]: PropertyValue } = { ecosystem: 'npm' };
    if (typeof manifest.name === 'string') properties.name = manifest.name;
    if (typeof manifest.private === 'boolean') properties.private = manifest.private;
    if (typeof manifest.version === 'string') properties.version = manifest.version;
    if (manifest.scripts !== undefined && manifest.scripts !== null && typeof manifest.scripts === 'object') {
      properties.scripts = Object.fromEntries(
        Object.entries(manifest.scripts as Record<string, unknown>).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]),
      );
    }
    const manifestKey = `code.manifest:${path}`;
    records.add({ key: manifestKey, kind: 'code.manifest', label: path, properties, span: t.spanOfFile(path) });

    const scopes: [string, unknown][] = [['direct', manifest.dependencies], ['dev', manifest.devDependencies]];
    const names: { name: string; scope: string }[] = [];
    for (const [scope, block] of scopes) {
      if (block === undefined || block === null || typeof block !== 'object') continue;
      for (const [dependency, version] of Object.entries(block as Record<string, unknown>)) {
        if (typeof version !== 'string') continue;
        const key = `code.dependency:${path}#${dependency}`;
        records.add({
          key,
          kind: 'code.dependency',
          label: dependency,
          properties: { name: dependency, version, scope, exact: EXACT_VERSION.test(version) } satisfies { [key: string]: PropertyValue },
          span: t.spanOfLine(path, read.value.lineAt([scope === 'direct' ? 'dependencies' : 'devDependencies', dependency])),
        });
        records.edge('code.declares-dependency', manifestKey, key, { scope }, t.spanOfLine(path, read.value.lineAt([scope === 'direct' ? 'dependencies' : 'devDependencies', dependency])));
        names.push({ name: dependency, scope });
      }
    }
    if (service !== undefined) markUses(t, records, service, path, names.map((entry) => entry.name), 'ts');

    // The lock file the manifest resolves through: the counts the key plants.
    const lockPath = `${path.slice(0, path.lastIndexOf('/'))}/package-lock.json`;
    if (t.has(lockPath)) readNpmLock(t, records, path, manifestKey, lockPath);
  }
}

/** One package-lock.json: its format version, its packages, the dev-only split. */
function readNpmLock(t: TreeText, records: Records, manifestPath: string, manifestKey: string, lockPath: string): void {
  const read = readJson(t.text(lockPath));
  if (!read.ok) {
    records.gap(lockPath, `line ${read.gap.line}: ${read.gap.detail}`);
    return;
  }
  const lock = read.value.value as { lockfileVersion?: unknown; packages?: unknown };
  const packages = lock.packages;
  let total = 0;
  let devOnly = 0;
  if (packages !== undefined && packages !== null && typeof packages === 'object') {
    for (const [name, entry] of Object.entries(packages as Record<string, unknown>)) {
      if (name === '') continue;
      total += 1;
      if (entry !== null && typeof entry === 'object' && (entry as { dev?: unknown }).dev === true) devOnly += 1;
    }
  }
  const key = `code.lockfile:${lockPath}`;
  records.add({
    key,
    kind: 'code.lockfile',
    label: lockPath,
    properties: {
      format: 'npm',
      lockfileVersion: typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : null,
      packages: total,
      devOnlyPackages: devOnly,
    } satisfies { [key: string]: PropertyValue },
    span: t.spanOfFile(lockPath),
  });
  records.edge('code.resolves', manifestKey, key);
}

/** One go.mod: the module, its requirements with versions and the indirect marker. */
function goManifests(t: TreeText, records: Records): void {
  for (const path of t.pathsNamed(/^go\.mod$/)) {
    const service = serviceOf(path);
    const read = readGoMod(t.text(path));
    if (!read.ok) {
      records.gap(path, `line ${read.gap.line}: ${read.gap.detail}`);
      continue;
    }
    const lines = t.lines(path);
    const goVersion = lines.map((line) => /^go\s+(\S+)/.exec(line)?.[1]).find((value) => value !== undefined) ?? null;
    const manifestKey = `code.manifest:${path}`;
    records.add({
      key: manifestKey,
      kind: 'code.manifest',
      label: path,
      properties: { ecosystem: 'go', module: read.value.module, goVersion } satisfies { [key: string]: PropertyValue },
      span: t.spanOfFile(path),
    });
    const direct: string[] = [];
    for (const require of read.value.requires) {
      const raw = lines[require.line - 1]?.trim() ?? '';
      const indirect = raw.includes('// indirect');
      const tokens = raw.split(/\s+/u).filter((token) => token !== '//');
      const version = tokens.find((token) => /^v\d/.test(token)) ?? null;
      const key = `code.dependency:${path}#${require.path}`;
      records.add({
        key,
        kind: 'code.dependency',
        label: require.path,
        properties: { name: require.path, version, scope: indirect ? 'indirect' : 'direct' } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLine(path, require.line),
      });
      records.edge(
        'code.declares-dependency',
        manifestKey,
        key,
        { scope: indirect ? 'indirect' : 'direct' },
        t.spanOfLine(path, require.line),
      );
      if (!indirect) direct.push(require.path);
    }
    if (service !== undefined) markUses(t, records, service, path, direct, 'go');
    const sumPath = `${path.slice(0, path.lastIndexOf('/'))}/go.sum`;
    if (t.has(sumPath)) readGoSum(t, records, manifestKey, sumPath);
  }
}

/** One go.sum: the distinct module-version pairs it carries sums for. */
function readGoSum(t: TreeText, records: Records, manifestKey: string, sumPath: string): void {
  const pairs = new Set<string>();
  for (const line of t.lines(sumPath)) {
    const declared = /^(\S+)\s+(\S+)\s+/.exec(line);
    if (declared !== null) pairs.add(`${declared[1] ?? ''} ${declared[2] ?? ''}`);
  }
  const key = `code.lockfile:${sumPath}`;
  records.add({
    key,
    kind: 'code.lockfile',
    label: sumPath,
    properties: { format: 'go-sum', modules: pairs.size } satisfies { [key: string]: PropertyValue },
    span: t.spanOfFile(sumPath),
  });
  records.edge('code.resolves', manifestKey, key);
}

/** The source files of one service that import a dependency of its manifest. */
function markUses(t: TreeText, records: Records, service: string, manifestPath: string, names: readonly string[], kind: 'ts' | 'go'): void {
  if (names.length === 0) return;
  const prefix = `services/${service}/`;
  const wanted = new Set(names);
  for (const path of t.tree.paths) {
    if (!path.startsWith(prefix) || path === manifestPath) continue;
    if (kind === 'ts' ? !/\.(ts|mts|cts|js|mjs)$/.test(path) : !path.endsWith('.go')) continue;
    let text: string;
    try {
      text = t.text(path);
    } catch {
      continue;
    }
    for (const name of wanted) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = kind === 'ts' ? new RegExp(`(?:from\\s*|require\\(\\s*|import\\s*)['"]${escaped}['"]`) : new RegExp(`"${escaped}"`);
      const match = pattern.exec(text);
      if (match === null || match.index === undefined) continue;
      const line = text.slice(0, match.index).split('\n').length;
      records.edge('code.uses-dependency', records.file(path), `code.dependency:${manifestPath}#${name}`, {}, t.spanOfLine(path, line));
    }
  }
}

/** The dependencies area: npm first, then Go. */
export function extractDependencies(t: TreeText, records: Records): void {
  npmManifests(t, records);
  goManifests(t, records);
}
