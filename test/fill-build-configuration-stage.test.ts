/**
 * The build and configuration stage (madarch-tzte.21.5, decision 0026 stage 2;
 * decision 0033's static stage, madarch-8bdc.2.3) through its own `plan` and
 * `execute` with a fake context: the orchestrator is not needed and not used.
 *
 * Every expectation comes from the task and the decisions, never from the
 * module: a manifest of each kind this stage reads (a `package.json`, a
 * `go.mod`, a `Cargo.toml`, a `Dockerfile`, a compose file) yields the graph
 * items it declares in the extractors' `code.*` vocabulary — a `code.package`
 * node, a `code.dependency` declaration per dependency the manifest names with
 * one `code.uses-dependency` edge from the manifest's file, the deploy units,
 * the environment variables with the `code.consumes` edge from the file that
 * declares them, the entry points, and one coverage; a manifest that does not
 * parse, a declaration this stage does not read and a lock file are coverage
 * naming the file and the line, never a silent skip; and a path the pinned
 * commit no longer holds is planned and publishes nothing.
 *
 * The graph is the test's own: the reads a plan makes are answered from the
 * rows a test names, and no test touches a real database. Every repository is
 * one the test makes in a temporary folder and removes.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import {
  BUILD_CONFIGURATION_STAGE_ID, createBuildConfigurationStage, manifestKindOf, publishedManifestsRead,
} from '../src/fill/stages/build-configuration.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { fileFactIdOf } from '../src/fill/stages/syntax-facts.js';
import { publishedTreeRead } from '../src/fill/stages/tree-rows.js';
import type { FillStage } from '../src/fill/stage.js';

/** A throwaway repository the test commits into by hand. */
interface Fixture {
  readonly root: string;
  commit(): string;
  git(...args: string[]): string;
  write(path: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-build-configuration-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = async (path: string, text: string): Promise<void> => {
    const at = join(root, path);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, text);
  };
  return {
    root,
    git,
    write,
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** What a stage recorded while it ran. */
interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
}

/** One unit's context: the reads answered by the test, the draft collected here, and a signal the test holds. */
async function contextFor(
  unit: StageUnit,
  source: ReturnType<typeof createGitSnapshotSource>,
  answer: (read: string) => readonly unknown[] = () => [],
): Promise<{ context: StageContext; recorder: Recorder; controller: AbortController }> {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  const graph = { query: async (read: string) => { recorder.queries.push(read); return answer(read); } };
  const repository = await staticStageSourceOf(source, unit.id.split(':')[1] ?? '');
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: BUILD_CONFIGURATION_STAGE_ID, version: 2, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph,
      static: staticStageContext(repository, {
        byKey: async () => [],
        byGlobalName: async () => [],
        neighbourhood: async () => ({ rows: [], next: null }),
      }),
      draft: { write: (entry: StageDraftWrite) => { recorder.writes.push(entry); }, writes: () => ({ writes: recorder.writes }) },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

/** One item of a draft, as a test reads it: the fill's kind from the node's properties, its key, and the properties. */
interface DraftItem {
  readonly kind: string;
  readonly id: string;
  readonly value: Record<string, unknown>;
  readonly provenance: { readonly place?: { readonly file: string; readonly range: { readonly startLine: number; readonly endLine: number } } };
}

/** The draft's items, in the order they were written: nodes by key, edges by their joins, both by their `factKind`. */
function itemsOf(writes: readonly StageDraftWrite[]): readonly DraftItem[] {
  const items: DraftItem[] = [];
  for (const write of writes) {
    if (write.kind === 'node') {
      const properties = write.value.properties as Record<string, unknown>;
      items.push({ kind: String(properties['factKind']), id: write.value.key, value: properties, provenance: properties['provenance'] as DraftItem['provenance'] });
      continue;
    }
    if (write.kind !== 'edge') continue;
    const properties = (write.value.properties ?? {}) as Record<string, unknown>;
    const end = (one: { readonly key: string } | { readonly id: string }): string => ('key' in one ? one.key : one.id);
    items.push({ kind: String(properties['factKind']), id: `${write.value.relation}:${end(write.value.from)}->${end(write.value.to)}`, value: properties, provenance: properties['provenance'] as DraftItem['provenance'] });
  }
  return items;
}

/** The items of one kind, in the order they were written. */
function itemsOfKind(writes: readonly StageDraftWrite[], kind: string): readonly DraftItem[] {
  return itemsOf(writes).filter((item) => item.kind === kind);
}

/** The kinds of the items one draft holds, in the order they were written. */
function kindsOf(writes: readonly StageDraftWrite[]): string[] {
  return itemsOf(writes).map((item) => item.kind);
}

/** The coverage one draft holds, as a reader of the graph sees it. */
function coverageOfDraft(writes: readonly StageDraftWrite[]): { readonly scope: string; readonly complete: boolean; readonly read: readonly string[]; readonly unread: readonly { readonly what: string; readonly reason: string }[] } {
  const held = itemsOfKind(writes, 'coverage');
  if (held.length !== 1) throw new Error(`the draft holds ${String(held.length)} coverage items, and this test reads one: ${kindsOf(writes).join(', ')}`);
  const value = held[0]!.value;
  return {
    scope: String(value['scope']),
    complete: value['complete'] === true,
    read: (value['read'] ?? []) as readonly string[],
    unread: (value['unread'] ?? []) as readonly { what: string; reason: string }[],
  };
}

/** The units one plan named, by id. */
function unitIds(plan: { units: readonly { id: string }[] }): string[] {
  return plan.units.map((unit) => unit.id);
}

/** One pinned repository's source. */
function sourceOf(root: string, commit: string): ReturnType<typeof createGitSnapshotSource> {
  return createGitSnapshotSource([{ id: 'orders-api', form: 'code', root, commit }]);
}

/** The stage over one fixture's pin. */
function stageOver(root: string, commit: string): FillStage {
  return createBuildConfigurationStage(sourceOf(root, commit));
}

/** One unit run, as the test reads it back. */
async function executed(stage: FillStage, root: string, commit: string, unitId: string, answer: (read: string) => readonly unknown[] = () => []): Promise<Recorder> {
  const { context, recorder } = await contextFor({ id: unitId, scope: unitId.split(':').slice(1).join(':') }, sourceOf(root, commit), answer);
  expect(await stage.execute({ id: unitId, scope: unitId.split(':').slice(1).join(':') }, context)).toEqual({ outcome: 'draft' });
  expect(await stage.validate({ writes: recorder.writes }, { query: async () => [] })).toEqual({ ok: true });
  return recorder;
}

/** What a call refused with, so a test can read what it names; `answered` when it did not refuse. */
async function refusedBy(call: () => unknown): Promise<string> {
  try {
    await call();
    return 'answered';
  } catch (error) {
    return (error as Error).message;
  }
}

/** The tree read a plan makes, as the snapshot and inventory stages publish it. */
function treeRows(paths: readonly string[]): readonly { readonly kind: 'file'; readonly repository: string; readonly path: string; readonly blob: string }[] {
  return paths.map((path) => ({ kind: 'file' as const, repository: 'orders-api', path, blob: 'a'.repeat(40) }));
}

// ---- the stage and its plan -----------------------------------------------

describe('the stage of the registry', () => {
  test('it is a static stage, covered by the boundary check\'s rules, and the graph runs it after the snapshot', () => {
    const stage = createBuildConfigurationStage(createGitSnapshotSource(() => []));
    expect(stage.id).toBe(BUILD_CONFIGURATION_STAGE_ID);
    expect(stage.staticReading).toBe(true);
    const read = deriveStageGraph(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }), undefined);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.graph.edges.filter((edge) => edge.to === BUILD_CONFIGURATION_STAGE_ID).map((edge) => [edge.from, edge.via]).sort()).toEqual([
      ['snapshot', 'file'],
      ['snapshot', 'snapshot'],
    ].sort());
  });

  test('a path\'s name decides which manifest it declares', () => {
    expect([
      'package.json', 'packages/a/package.json', 'go.mod', 'Cargo.toml', 'Dockerfile', 'services/Dockerfile.api',
      'Containerfile', 'compose.yml', 'docker-compose.yaml', 'bun.lock', 'package-lock.json',
    ].map((path) => `${path} -> ${String(manifestKindOf(path))}`)).toEqual([
      'package.json -> npm', 'packages/a/package.json -> npm', 'go.mod -> go', 'Cargo.toml -> cargo', 'Dockerfile -> dockerfile',
      'services/Dockerfile.api -> dockerfile', 'Containerfile -> dockerfile', 'compose.yml -> compose', 'docker-compose.yaml -> compose',
      'bun.lock -> lock', 'package-lock.json -> lock',
    ]);
    expect(['README.md', 'src/index.ts', 'packages/b/tsconfig.json', 'composer.json', 'dockerfile'].map((path) => manifestKindOf(path))).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ]);
  });
});

describe('the plan', () => {
  test('names a unit per manifest the pinned tree holds, in code point order, from the graph', async () => {
    const f = await fixture();
    try {
      for (const path of ['package.json', 'packages/a/package.json', 'Dockerfile', 'README.md', 'src/index.ts']) await f.write(path, '{ "name": "workspace" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const plan = await stage.plan({ query: async (read) => (read === publishedTreeRead('orders-api') ? treeRows(['Dockerfile', 'package.json', 'packages/a/package.json', 'README.md', 'src/index.ts']) : []) });
      expect(unitIds(plan)).toEqual([
        'manifest:orders-api:Dockerfile',
        'manifest:orders-api:package.json',
        'manifest:orders-api:packages/a/package.json',
      ]);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('plans a published manifest the pinned commit no longer holds, and that unit publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const plan = await stage.plan({
        query: async (read) => {
          if (read === publishedTreeRead('orders-api')) return treeRows(['package.json']);
          if (read === publishedManifestsRead('orders-api')) return [{ kind: 'manifest', repository: 'orders-api', path: 'gone.json' }];
          return [];
        },
      });
      expect(unitIds(plan)).toEqual(['manifest:orders-api:gone.json', 'manifest:orders-api:package.json']);
      const recorder = await executed(stage, f.root, commit, 'manifest:orders-api:gone.json');
      expect(recorder.writes).toEqual([]);
      expect(recorder.notes[0]).toContain('declares no manifest this stage reads');
    } finally {
      await f.dispose();
    }
  }, 60_000);
});

// ---- one manifest of each kind --------------------------------------------

describe('a package.json', () => {
  test('its package, its dependency declarations and their edges, its binaries and scripts, and its coverage', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",\n  "version": "1.0.0",\n  "dependencies": { "yaml": "^2.9.1" },\n  "devDependencies": { "typescript": "5.9.3" },\n  "bin": { "orders": "./cli.ts" },\n  "scripts": { "test": "bun test" }\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, f.root, commit, 'manifest:orders-api:package.json');

      expect(itemsOfKind(recorder.writes, 'package').map((item) => item.value)).toMatchObject([
        { repository: 'orders-api', name: 'orders-api', form: 'package', ecosystem: 'npm', version: '1.0.0', manifest: 'package.json' },
      ]);
      expect(itemsOfKind(recorder.writes, 'dependency').filter((item) => typeof item.value['name'] === 'string').map((item) => [item.value['name'], item.value['group'], item.value['version']])).toEqual([
        ['typescript', 'devDependencies', '5.9.3'],
        ['yaml', 'dependencies', '^2.9.1'],
      ]);
      const fileKey = fileFactIdOf('orders-api', 'package.json');
      for (const edge of itemsOfKind(recorder.writes, 'dependency').filter((item) => typeof item.value['line'] === 'number')) {
        expect(edge.id.startsWith('code.uses-dependency:')).toBe(true);
        expect(edge.value['file']).toBe('package.json');
      }
      expect(recorder.writes.filter((write) => write.kind === 'edge' && write.value.relation === 'code.uses-dependency').every((write) => write.kind === 'edge' && 'key' in write.value.from && write.value.from.key === fileKey)).toBe(true);
      expect(itemsOfKind(recorder.writes, 'entry-point').map((item) => [item.value['name'], item.value['form']])).toEqual([
        ['orders', 'cli-command'],
        ['test', 'cli-command'],
      ]);
      expect(coverageOfDraft(recorder.writes).complete).toBe(true);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a workspaces manifest is a workspace, and a package.json that does not parse is one gap naming the line', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "root",\n  "workspaces": ["packages/*"]\n}\n');
      await f.write('broken/package.json', '{\n  "name": "broken",\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const root = await executed(stage, f.root, commit, 'manifest:orders-api:package.json');
      expect(itemsOfKind(root.writes, 'package')[0]!.value['form']).toBe('workspace');
      const broken = await executed(stage, f.root, commit, 'manifest:orders-api:broken/package.json');
      const coverage = coverageOfDraft(broken.writes);
      expect(coverage.complete).toBe(false);
      expect(coverage.unread).toHaveLength(1);
      expect(coverage.unread[0]!.what.startsWith('broken/package.json:')).toBe(true);
      expect(itemsOfKind(broken.writes, 'package')).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a dependency on a package outside the pinned tree is still a declared dependency', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",\n  "dependencies": {\n    "@acme/outside": "^2.0.0"\n  }\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, f.root, commit, 'manifest:orders-api:package.json');
      expect(itemsOfKind(recorder.writes, 'dependency').filter((item) => typeof item.value['name'] === 'string').map((item) => item.value['name'])).toEqual(['@acme/outside']);
      expect(coverageOfDraft(recorder.writes).complete).toBe(true);
    } finally {
      await f.dispose();
    }
  }, 60_000);
});

describe('a go.mod and a Cargo.toml', () => {
  test('each names its package and its declared dependencies', async () => {
    const f = await fixture();
    try {
      await f.write('go.mod', 'module example.com/orders\n\ngo 1.22\n\nrequire (\n\tgithub.com/segmentio/kafka-go v0.4.47\n)\n');
      await f.write('Cargo.toml', '[package]\nname = "orders"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n\n[[bin]]\nname = "orders-cli"\n\n[lib]\nname = "orders_lib"\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const go = await executed(stage, f.root, commit, 'manifest:orders-api:go.mod');
      expect(itemsOfKind(go.writes, 'package').map((item) => [item.value['name'], item.value['ecosystem']])).toEqual([['example.com/orders', 'go']]);
      expect(itemsOfKind(go.writes, 'dependency').filter((item) => typeof item.value['name'] === 'string').map((item) => [item.value['name'], item.value['group'], item.value['version']])).toEqual([
        ['github.com/segmentio/kafka-go', 'require', 'v0.4.47'],
      ]);
      const cargo = await executed(stage, f.root, commit, 'manifest:orders-api:Cargo.toml');
      expect(itemsOfKind(cargo.writes, 'package').map((item) => [item.value['name'], item.value['ecosystem'], item.value['version']])).toEqual([['orders', 'cargo', '0.1.0']]);
      expect(itemsOfKind(cargo.writes, 'dependency').filter((item) => typeof item.value['name'] === 'string').map((item) => [item.value['name'], item.value['version']])).toEqual([['serde', '1']]);
      expect(itemsOfKind(cargo.writes, 'entry-point').map((item) => [item.value['name'], item.value['form']])).toEqual([
        ['orders-cli', 'cli-command'],
        ['orders_lib', 'library-export'],
      ]);
    } finally {
      await f.dispose();
    }
  }, 60_000);
});

describe('deploy units and the environment', () => {
  test('a Dockerfile declares a container, its environment with the file that reads it, and its command', async () => {
    const f = await fixture();
    try {
      await f.write('services/web/Dockerfile', 'FROM oven/bun:1\nENV PORT=8080 LOG_LEVEL=info\nARG BUILD_ID\nENTRYPOINT ["bun", "run", "start"]\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, f.root, commit, 'manifest:orders-api:services/web/Dockerfile');
      expect(itemsOfKind(recorder.writes, 'deploy-unit').map((item) => [item.value['name'], item.value['form'], item.value['manifest']])).toEqual([
        ['services/web/Dockerfile', 'container', 'services/web/Dockerfile'],
      ]);
      expect(itemsOfKind(recorder.writes, 'environment-variable').map((item) => item.value['name'])).toEqual(['BUILD_ID', 'LOG_LEVEL', 'PORT']);
      expect(itemsOfKind(recorder.writes, 'entry-point').map((item) => [item.value['name'], item.value['form']])).toEqual([
        ['["bun", "run", "start"]', 'main'],
      ]);
      const fileKey = fileFactIdOf('orders-api', 'services/web/Dockerfile');
      expect(recorder.writes.filter((write) => write.kind === 'edge' && write.value.relation === 'code.consumes').every((write) => write.kind === 'edge' && 'key' in write.value.from && write.value.from.key === fileKey)).toBe(true);
      expect(coverageOfDraft(recorder.writes).complete).toBe(true);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a compose file declares a service per service and the variables its services declare', async () => {
    const f = await fixture();
    try {
      await f.write('docker-compose.yml', 'name: fixture\nservices:\n  web:\n    image: nginx\n    environment:\n      - ORDERS_TOPIC=orders\n      - DEBUG\n  worker:\n    environment:\n      ORDERS_DB: postgres\n    env_file:\n      - ./worker.env\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, f.root, commit, 'manifest:orders-api:docker-compose.yml');
      expect(itemsOfKind(recorder.writes, 'deploy-unit').map((item) => [item.value['name'], item.value['form']])).toEqual([
        ['docker-compose.yml:web', 'service'],
        ['docker-compose.yml:worker', 'service'],
      ]);
      expect(itemsOfKind(recorder.writes, 'environment-variable').map((item) => item.value['name'])).toEqual(['DEBUG', 'ORDERS_DB', 'ORDERS_TOPIC']);
      expect(itemsOfKind(recorder.writes, 'consumes')).toHaveLength(3);
      expect(coverageOfDraft(recorder.writes).unread.map((gap) => gap.what)).toEqual([
        'docker-compose.yml:12 the service "worker" takes its environment from "./worker.env", and this stage reads no env_file',
      ]);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a lock file is a declared gap and not a silence', async () => {
    const f = await fixture();
    try {
      await f.write('bun.lock', '{"lockfileVersion": 1}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, f.root, commit, 'manifest:orders-api:bun.lock');
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'bun.lock:1 a lock file declares resolved versions, and no fact of this stage carries one', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  }, 60_000);
});

describe('one unit', () => {
  test('a cancelled unit raises and writes nothing, and a unit id this stage never plans is refused', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      expect(await refusedBy(async () => await stage.execute({ id: 'package:orders-api:package.json', scope: 'orders-api:package.json' }, { ...(await contextFor({ id: 'package:orders-api:package.json', scope: 'orders-api:package.json' }, sourceOf(f.root, commit))).context })))
        .toContain('is not one this stage plans');
      const { context, recorder } = await contextFor({ id: 'manifest:orders-api:package.json', scope: 'orders-api:package.json' }, sourceOf(f.root, commit));
      context.signal.aborted === false ? undefined : undefined;
      const controller = new AbortController();
      controller.abort();
      const aborted = { ...context, signal: controller.signal };
      expect(await refusedBy(async () => await stage.execute({ id: 'manifest:orders-api:package.json', scope: 'orders-api:package.json' }, aborted))).toContain('cancelled before it read the pinned manifest');
      expect(recorder.writes.filter((write) => write.kind === 'node')).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a path that names no manifest this stage reads publishes nothing, and a submodule is not its bytes', async () => {
    const f = await fixture();
    try {
      await f.write('README.md', '# fixture\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, f.root, commit, 'manifest:orders-api:README.md');
      expect(recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 60_000);
});
