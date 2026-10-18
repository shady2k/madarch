/**
 * The build and configuration stage (madarch-tzte.21.5, decision 0026 stage 2)
 * through its own `plan` and `execute` with a fake context: the orchestrator
 * (madarch-tzte.19.5) is not needed and not used.
 *
 * Every expectation comes from the task and the decisions, never from the
 * module: a fixture workspace with two packages, one depending on the other,
 * yields two `package` facts and one `dependency` edge; a `package.json`, a
 * `go.mod` and a `Cargo.toml` each yield a package with its ecosystem; a
 * Dockerfile and a compose file yield deploy units, environment variables with
 * the file that reads them and declared entry points; a manifest that does not
 * parse, a declaration this stage does not read and a dependency on a package
 * outside the pinned repositories are coverage naming the file and the line,
 * never a silent skip; and a manifest the pinned commit no longer holds is
 * planned and publishes nothing.
 *
 * The graph is the test's own: the reads a plan makes are answered from the
 * rows a test names, and no test touches a real database. Every repository is
 * one the test makes in a temporary folder and removes.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFact, makeNodeFact, repositoryPath } from '../src/fill/facts.js';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import {
  BUILD_CONFIGURATION_STAGE_ID, createBuildConfigurationStage, manifestKindOf, publishedManifestsRead,
  type PublishedManifestRow,
} from '../src/fill/stages/build-configuration.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { createInventoryStage } from '../src/fill/stages/inventory.js';
import type { FillStage } from '../src/fill/stage.js';

// ---- the test's own repository, context and graph ---------------------------

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
function contextFor(unit: StageUnit, answer: (read: string) => readonly unknown[] = () => []): { context: StageContext; recorder: Recorder; controller: AbortController } {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: 'test', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph: {
        query: async (read: string) => {
          recorder.queries.push(read);
          return answer(read);
        },
      },
      draft: {
        write: (entry: StageDraftWrite) => { recorder.writes.push(entry); },
        writes: () => ({ writes: recorder.writes }),
      },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

/** One fact of a draft set, as the fact store would hold it. */
interface DraftFact {
  readonly kind: string;
  readonly id: string;
  readonly value: Record<string, unknown>;
  readonly provenance: {
    readonly repository: { readonly id: string; readonly commit: string };
    readonly place?: { readonly file: string; readonly range: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number } };
  };
}

/** The facts one draft set holds, in the order they were written; a write that is no fact is left out. */
function factsOf(writes: readonly StageDraftWrite[]): readonly DraftFact[] {
  const facts: DraftFact[] = [];
  for (const write of writes) {
    if (write.kind !== 'fact') continue;
    facts.push(write.value as DraftFact);
  }
  return facts;
}

/** One write's fact envelope, for a test that reads a draft back. */
function factOf(write: StageDraftWrite): unknown {
  if (write.kind !== 'fact') throw new Error(`the stage wrote a ${write.kind}, and this test reads facts`);
  return write.value;
}

/** The kinds of the facts one draft set holds, in the order they were written. */
function kindsOf(writes: readonly StageDraftWrite[]): string[] {
  return factsOf(writes).map((fact) => fact.kind);
}

/** The one fact of a kind a draft holds; a test that expects exactly one reads it here. */
function oneFact(writes: readonly StageDraftWrite[], kind: string): DraftFact {
  const held = factsOf(writes).filter((fact) => fact.kind === kind);
  if (held.length !== 1) throw new Error(`the draft holds ${held.length} ${kind} facts, and this test reads one: ${kindsOf(writes).join(', ')}`);
  return held[0]!;
}

/** The coverage one draft holds, read as what a reader of the graph sees. */
function coverageOfDraft(writes: readonly StageDraftWrite[]): { readonly scope: string; readonly complete: boolean; readonly read: readonly string[]; readonly unread: readonly { readonly what: string; readonly reason: string }[] } {
  const fact = oneFact(writes, 'coverage');
  return {
    scope: String(fact.value['scope']),
    complete: fact.value['complete'] === true,
    read: (fact.value['read'] ?? []) as readonly string[],
    unread: (fact.value['unread'] ?? []) as readonly { what: string; reason: string }[],
  };
}

/** The units one plan named, by id. */
function unitIds(plan: { units: readonly { id: string }[] }): string[] {
  return plan.units.map((unit) => unit.id);
}

/** The stage over one fixture's pin. */
function stageOver(root: string, commit: string, id = 'orders-api'): FillStage {
  return createBuildConfigurationStage(createGitSnapshotSource([{ id, form: 'code', root, commit }]));
}

/** One unit run, as the test reads it back. */
async function executed(stage: FillStage, unitId: string, answer: (read: string) => readonly unknown[] = () => []): Promise<Recorder> {
  const { context, recorder } = contextFor({ id: unitId, scope: unitId }, answer);
  const outcome = await stage.execute({ id: unitId, scope: unitId }, context);
  expect(outcome).toEqual({ outcome: 'draft' });
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

// ---- the registry ----------------------------------------------------------

describe('the stage is registered', () => {
  test('the build and configuration stage registers, after the snapshot and the inventory', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]) });
      const read = deriveStageGraph(registry);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // Stage 2 reads stage 0's pinned tree and stage 1's file node: both
      // producers run before it, and nothing else does.
      expect(read.graph.order).toEqual(['snapshot', 'inventory', 'build-configuration']);
      expect(read.graph.edges).toEqual([
        { from: 'inventory', to: 'build-configuration', via: 'file' },
        { from: 'snapshot', to: 'build-configuration', via: 'snapshot' },
        { from: 'snapshot', to: 'inventory', via: 'repository' },
        { from: 'snapshot', to: 'inventory', via: 'snapshot' },
      ]);
      expect(registry.get(BUILD_CONFIGURATION_STAGE_ID)?.produces.map((produced) => produced.kind)).toEqual([
        'consumes', 'coverage', 'dependency', 'deploy-unit', 'entry-point', 'environment-variable', 'package',
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a path’s name decides which manifest it declares', () => {
    // The DONE WHEN's own formats, and the names beside them this stage reads
    // none of: a name that declares nothing is no unit at all.
    expect([
      'package.json', 'packages/a/package.json', 'go.mod', 'Cargo.toml', 'Dockerfile', 'services/Dockerfile.api',
      'Containerfile', 'compose.yml', 'docker-compose.yaml', 'docker-compose.prod.yml', 'bun.lock', 'package-lock.json',
    ].map((path) => `${path} -> ${String(manifestKindOf(path))}`)).toEqual([
      'package.json -> npm',
      'packages/a/package.json -> npm',
      'go.mod -> go',
      'Cargo.toml -> cargo',
      'Dockerfile -> dockerfile',
      'services/Dockerfile.api -> dockerfile',
      'Containerfile -> dockerfile',
      'compose.yml -> compose',
      'docker-compose.yaml -> compose',
      'docker-compose.prod.yml -> compose',
      'bun.lock -> lock',
      'package-lock.json -> lock',
    ]);
    expect(['README.md', 'src/index.ts', 'packages/b/tsconfig.json', 'composer.json', 'dockerfile'].map((path) => manifestKindOf(path))).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ]);
  });
});

// ---- planning --------------------------------------------------------------

describe('the plan', () => {
  test('names a unit per manifest the pinned tree holds, in code point order', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "workspace" }\n');
      await f.write('packages/a/package.json', '{ "name": "@fixture/a" }\n');
      await f.write('Dockerfile', 'FROM oven/bun:1\n');
      await f.write('README.md', '# fixture\n');
      await f.write('src/index.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const plan = await stage.plan({ query: async (read) => { expect(read).toBe(publishedManifestsRead('orders-api')); return []; } });
      expect(unitIds(plan)).toEqual([
        'manifest:orders-api:Dockerfile',
        'manifest:orders-api:package.json',
        'manifest:orders-api:packages/a/package.json',
      ]);
      expect(plan.units.map((unit) => unit.scope)).toEqual([
        'orders-api:Dockerfile', 'orders-api:package.json', 'orders-api:packages/a/package.json',
      ]);
      expect(plan.coverage).toBe('planned');
    } finally {
      await f.dispose();
    }
  });

  test('plans nothing, and says so, for a tree that declares no manifest', async () => {
    const f = await fixture();
    try {
      await f.write('src/index.ts', 'export const a = 1;\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      expect(await stage.plan({ query: async () => [] })).toEqual({ units: [], coverage: 'nothing-found' });
    } finally {
      await f.dispose();
    }
  });

  test('plans a published manifest the pinned commit no longer holds, and that unit publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const published: PublishedManifestRow[] = [
        { kind: 'manifest', repository: 'orders-api', path: 'package.json' },
        { kind: 'manifest', repository: 'orders-api', path: 'packages/gone/package.json' },
      ];
      const plan = await stage.plan({ query: async () => published });
      expect(unitIds(plan)).toEqual(['manifest:orders-api:package.json', 'manifest:orders-api:packages/gone/package.json']);
      const recorder = await executed(stage, 'manifest:orders-api:packages/gone/package.json');
      // A unit that writes nothing is how this stage asks for what an earlier
      // run wrote at a vanished path to be retracted.
      expect(recorder.writes).toEqual([]);
      expect(recorder.notes).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  test('refuses a published row that names another repository, another kind, no path or a field the read does not name', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const read = async (rows: readonly unknown[]): Promise<string> => await refusedBy(() => stage.plan({ query: async () => rows }));
      expect(await read([{ kind: 'manifest', repository: 'other', path: 'package.json' }])).toContain('its repository is "other"');
      expect(await read([{ kind: 'file', repository: 'orders-api', path: 'package.json' }])).toContain('its kind is "file"');
      expect(await read([{ kind: 'manifest', repository: 'orders-api', path: '../package.json' }])).toContain('is no repository path');
      expect(await read([{ kind: 'manifest', repository: 'orders-api', path: 'package.json', run: 'run-1' }])).toContain('a run, a unit, an attempt or a session is none of them');
    } finally {
      await f.dispose();
    }
  });
});

// ---- a package.json --------------------------------------------------------

describe('a package.json', () => {
  test('two packages of one workspace, one depending on the other, yield two package facts and one dependency edge', async () => {
    const f = await fixture();
    try {
      // The task's own fixture: a workspace with two packages, one depending
      // on the other.
      await f.write('packages/a/package.json', '{\n  "name": "@fixture/a",\n  "version": "1.0.0",\n  "dependencies": {\n    "@fixture/b": "workspace:*"\n  }\n}\n');
      await f.write('packages/b/package.json', '{\n  "name": "@fixture/b",\n  "version": "1.0.0"\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const plan = await stage.plan({ query: async () => [] });
      expect(unitIds(plan)).toEqual(['manifest:orders-api:packages/a/package.json', 'manifest:orders-api:packages/b/package.json']);

      const a = await executed(stage, 'manifest:orders-api:packages/a/package.json');
      const b = await executed(stage, 'manifest:orders-api:packages/b/package.json');
      for (const write of [...a.writes, ...b.writes]) expect(checkFact(factOf(write))).toEqual([]);
      expect(kindsOf(a.writes)).toEqual(['package', 'dependency', 'coverage']);
      expect(kindsOf(b.writes)).toEqual(['package', 'coverage']);

      const packageA = oneFact(a.writes, 'package');
      const packageB = oneFact(b.writes, 'package');
      expect(packageA.value).toEqual({
        repository: 'orders-api', name: '@fixture/a', form: 'package', ecosystem: 'npm', version: '1.0.0', manifest: 'packages/a/package.json',
      });
      expect(packageB.value).toEqual({
        repository: 'orders-api', name: '@fixture/b', form: 'package', ecosystem: 'npm', version: '1.0.0', manifest: 'packages/b/package.json',
      });

      const edge = oneFact(a.writes, 'dependency');
      // The edge's ends are the two package nodes the run published, and it
      // stands at the line that declares the dependency.
      expect(edge.value).toEqual({ from: packageA.id, to: packageB.id, basis: 'manifest' });
      expect(edge.provenance.place).toEqual({ file: 'packages/a/package.json', range: { startLine: 5, startColumn: 0, endLine: 5, endColumn: 31 } });

      // Both units' facts add up to exactly the two packages and the one edge.
      expect(factsOf([...a.writes, ...b.writes]).filter((fact) => fact.kind === 'package')).toHaveLength(2);
      expect(factsOf([...a.writes, ...b.writes]).filter((fact) => fact.kind === 'dependency')).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  test('a dependency on a package the pinned repositories do not declare is coverage, never an edge', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",\n  "dependencies": {\n    "@acme/outside": "^2.0.0"\n  }\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(kindsOf(recorder.writes)).toEqual(['package', 'coverage']);
      const coverage = coverageOfDraft(recorder.writes);
      // The file and the line the dependency stands at, and nothing invented.
      expect(coverage.complete).toBe(false);
      expect(coverage.unread).toEqual([
        { what: 'package.json:4 the dependency "@acme/outside" names no package this repository\'s manifests declare', reason: 'unsupported' },
      ]);
      expect(coverage.read).toEqual(['dependencies', 'name']);
    } finally {
      await f.dispose();
    }
  });

  test('a file:/link: specifier resolves by the path it names, and a workspaces manifest is a workspace', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "fixture-root",\n  "workspaces": ["packages/*"]\n}\n');
      await f.write('packages/billing/package.json', '{\n  "name": "@fixture/billing"\n}\n');
      await f.write('packages/web/package.json', '{\n  "name": "@fixture/web",\n  "dependencies": {\n    "@fixture/billing": "file:../billing"\n  }\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const root = await executed(stage, 'manifest:orders-api:package.json');
      expect(oneFact(root.writes, 'package').value['form']).toBe('workspace');
      const web = await executed(stage, 'manifest:orders-api:packages/web/package.json');
      const billing = await executed(stage, 'manifest:orders-api:packages/billing/package.json');
      const edge = oneFact(web.writes, 'dependency');
      expect(edge.value['to']).toBe(oneFact(billing.writes, 'package').id);
      expect(coverageOfDraft(web.writes).complete).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('declared binaries and scripts are entry points, and the package is read once', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "madarch",\n  "bin": { "madarch": "./scripts/madarch.ts" },\n  "scripts": {\n    "test": "bun test",\n    "views": "bun scripts/render-views.ts"\n  }\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(kindsOf(recorder.writes)).toEqual(['package', 'entry-point', 'entry-point', 'entry-point', 'coverage']);
      const entries = factsOf(recorder.writes).filter((fact) => fact.kind === 'entry-point').map((fact) => fact.value);
      expect(entries).toEqual([
        { repository: 'orders-api', file: 'package.json', name: 'madarch', form: 'cli-command' },
        { repository: 'orders-api', file: 'package.json', name: 'test', form: 'cli-command' },
        { repository: 'orders-api', file: 'package.json', name: 'views', form: 'cli-command' },
      ]);
      expect(coverageOfDraft(recorder.writes).complete).toBe(true);
    } finally {
      await f.dispose();
    }
  });
});

// ---- a go.mod and a Cargo.toml --------------------------------------------

describe('a Go module and a Cargo manifest', () => {
  test('a go.mod names its module and depends on another module of the repository only', async () => {
    const f = await fixture();
    try {
      await f.write('go.mod', 'module example.com/orders\n\ngo 1.22\n\nrequire (\n\texample.com/shared v1.0.0\n\texample.com/acme/gift v1.0.0 // indirect\n)\n');
      await f.write('shared/go.mod', 'module example.com/shared\n\ngo 1.22\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const orders = await executed(stage, 'manifest:orders-api:go.mod');
      const shared = await executed(stage, 'manifest:orders-api:shared/go.mod');
      expect(checkFact(factOf(orders.writes[0]!))).toEqual([]);
      expect(kindsOf(orders.writes)).toEqual(['package', 'dependency', 'coverage']);
      expect(oneFact(orders.writes, 'package').value).toEqual({
        repository: 'orders-api', name: 'example.com/orders', form: 'package', ecosystem: 'go', manifest: 'go.mod',
      });
      const edge = oneFact(orders.writes, 'dependency');
      expect(edge.value).toEqual({ from: oneFact(orders.writes, 'package').id, to: oneFact(shared.writes, 'package').id, basis: 'manifest' });
      expect(edge.provenance.place?.range.startLine).toBe(6);
      const coverage = coverageOfDraft(orders.writes);
      expect(coverage.read).toEqual(['go', 'module', 'require']);
      expect(coverage.unread).toEqual([
        { what: 'go.mod:7 the requirement "example.com/acme/gift" names no package this repository\'s manifests declare', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a Cargo.toml names its package, a path dependency, its binary and its library', async () => {
    const f = await fixture();
    try {
      await f.write('orders/Cargo.toml', '[package]\nname = "orders"\nversion = "0.1.0"\n\n[dependencies]\nbilling = { path = "../billing" }\nserde = "1"\n\n[[bin]]\nname = "orders-cli"\n\n[lib]\nname = "orders_lib"\n');
      await f.write('billing/Cargo.toml', '[package]\nname = "billing"\nversion = "0.1.0"\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const orders = await executed(stage, 'manifest:orders-api:orders/Cargo.toml');
      const billing = await executed(stage, 'manifest:orders-api:billing/Cargo.toml');
      for (const write of orders.writes) expect(checkFact(factOf(write))).toEqual([]);
      expect(oneFact(orders.writes, 'package').value).toEqual({
        repository: 'orders-api', name: 'orders', form: 'package', ecosystem: 'cargo', version: '0.1.0', manifest: 'orders/Cargo.toml',
      });
      const edge = oneFact(orders.writes, 'dependency');
      expect(edge.value).toEqual({ from: oneFact(orders.writes, 'package').id, to: oneFact(billing.writes, 'package').id, basis: 'manifest' });
      expect(factsOf(orders.writes).filter((fact) => fact.kind === 'entry-point').map((fact) => fact.value)).toEqual([
        { repository: 'orders-api', file: 'orders/Cargo.toml', name: 'orders-cli', form: 'cli-command' },
        { repository: 'orders-api', file: 'orders/Cargo.toml', name: 'orders_lib', form: 'library-export' },
      ]);
      expect(coverageOfDraft(orders.writes).unread).toEqual([
        { what: 'orders/Cargo.toml:7 the dependency "serde" names no package this repository\'s manifests declare', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- a Dockerfile and a compose file --------------------------------------

describe('deploy units and the environment', () => {
  test('a Dockerfile declares a container, its environment with the file that reads it, and its command', async () => {
    const f = await fixture();
    try {
      await f.write('services/billing/Dockerfile', 'FROM oven/bun:1\nENV ORDERS_TOPIC=orders \\\n    ORDERS_DB=postgres\nARG PORT\nENTRYPOINT ["bun", "run", "start"]\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:services/billing/Dockerfile');
      for (const write of recorder.writes) expect(checkFact(factOf(write))).toEqual([]);
      expect(kindsOf(recorder.writes)).toEqual([
        'deploy-unit',
        'environment-variable', 'consumes', 'environment-variable', 'consumes', 'environment-variable', 'consumes',
        'entry-point', 'coverage',
      ]);
      expect(oneFact(recorder.writes, 'deploy-unit').value).toEqual({
        repository: 'orders-api', name: 'services/billing/Dockerfile', form: 'container', manifest: 'services/billing/Dockerfile',
      });
      const variables = factsOf(recorder.writes).filter((fact) => fact.kind === 'environment-variable').map((fact) => fact.value['name']);
      // `ENV` declares the container's own environment and `ARG` a variable
      // the build reads: both are variables the configuration names here.
      expect(variables).toEqual(['ORDERS_DB', 'ORDERS_TOPIC', 'PORT']);
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'entry-point').map((fact) => fact.value)).toEqual([
        { repository: 'orders-api', file: 'services/billing/Dockerfile', name: '["bun", "run", "start"]', form: 'main' },
      ]);

      // The `consumes` edge stands on the file node stage 1 published for the
      // Dockerfile: one node for one file, whoever reads it.
      const inventory = createInventoryStage(createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]));
      const fileUnit = await executed(inventory, 'file:orders-api:services/billing/Dockerfile');
      const fileId = oneFact(fileUnit.writes, 'file').id;
      for (const edge of factsOf(recorder.writes).filter((fact) => fact.kind === 'consumes')) {
        expect(edge.value['from']).toBe(fileId);
      }
      const coverage = coverageOfDraft(recorder.writes);
      expect(coverage.complete).toBe(true);
      expect(coverage.read).toEqual(['arg', 'entrypoint', 'env', 'environment', 'from']);
    } finally {
      await f.dispose();
    }
  });

  test('a compose file declares a service per service and the variables its services declare', async () => {
    const f = await fixture();
    try {
      await f.write('docker-compose.yml', 'name: fixture\nservices:\n  web:\n    image: nginx\n    environment:\n      - ORDERS_TOPIC=orders\n      - DEBUG\n  worker:\n    environment:\n      ORDERS_DB: postgres\n    env_file:\n      - ./worker.env\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:docker-compose.yml');
      for (const write of recorder.writes) expect(checkFact(factOf(write))).toEqual([]);
      // A service's name is qualified by the compose file that declares it.
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'deploy-unit').map((fact) => fact.value)).toEqual([
        { repository: 'orders-api', name: 'docker-compose.yml:web', form: 'service', manifest: 'docker-compose.yml' },
        { repository: 'orders-api', name: 'docker-compose.yml:worker', form: 'service', manifest: 'docker-compose.yml' },
      ]);
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'environment-variable').map((fact) => fact.value['name'])).toEqual(['DEBUG', 'ORDERS_DB', 'ORDERS_TOPIC']);
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'consumes')).toHaveLength(3);
      // An env_file is a file this stage does not read, and it says so.
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'docker-compose.yml:12 the service "worker" takes its environment from "./worker.env", and this stage reads no env_file', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- what a manifest cannot say ------------------------------------------

describe('what this stage cannot read is coverage', () => {
  test('a package.json that does not parse is one coverage naming the file and the line, and no package', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",,\n  "version": "1.0.0"\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(kindsOf(recorder.writes)).toEqual(['coverage']);
      const coverage = coverageOfDraft(recorder.writes);
      expect(coverage.complete).toBe(false);
      expect(coverage.read).toEqual([]);
      expect(coverage.unread).toHaveLength(1);
      expect(coverage.unread[0]?.what.startsWith('package.json:2 ')).toBe(true);
      // The fact stands at the line the reader stopped at, so a reader of the
      // graph opens the file where it stopped.
      expect(oneFact(recorder.writes, 'coverage').provenance.place?.range.startLine).toBe(2);
    } finally {
      await f.dispose();
    }
  });

  test('every manifest this stage cannot read names its file and its line', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": }\n');
      await f.write('Cargo.toml', '[package]\nname = "orders"\n[dependencies]\nserde = { features = [\n  "derive",\n] }\n');
      await f.write('go.mod', 'module example.com/orders\nfrobnicate 1\n');
      await f.write('Dockerfile', 'FROM oven/bun:1\nFROBNICATE the build\n');
      await f.write('compose.yml', 'services:\n  web:\n    environment:\n      - [not a variable]\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const cases: readonly (readonly [string, string, number])[] = [
        ['package.json', 'manifest:orders-api:package.json', 1],
        ['Cargo.toml', 'manifest:orders-api:Cargo.toml', 4],
        ['go.mod', 'manifest:orders-api:go.mod', 2],
        ['Dockerfile', 'manifest:orders-api:Dockerfile', 2],
        ['compose.yml', 'manifest:orders-api:compose.yml', 4],
      ];
      for (const [path, unit, line] of cases) {
        const recorder = await executed(stage, unit);
        const coverage = coverageOfDraft(recorder.writes);
        expect(coverage.complete).toBe(false);
        expect(coverage.unread).toHaveLength(1);
        // The path, the 1-based line, and what stood there: the whole of it in
        // the one string a reader acts on.
        expect(coverage.unread[0]?.what.startsWith(`${path}:${line} `)).toBe(true);
        expect((coverage.unread[0]?.what ?? '').length).toBeGreaterThan(`${path}:${line} `.length);
        expect(recorder.writes).toHaveLength(1);
      }
    } finally {
      await f.dispose();
    }
  });

  test('a manifest that is a symbolic link is a named gap, never the link’s own text', async () => {
    const f = await fixture();
    try {
      await f.write('packages/real/package.json', '{ "name": "@fixture/real" }\n');
      await symlink('packages/real/package.json', join(f.root, 'package.json'));
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(kindsOf(recorder.writes)).toEqual(['coverage']);
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'package.json:1 a symbolic link stands here, and this stage reads a manifest\'s own bytes and does not follow a link', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a lock file is a declared gap and not a silence', async () => {
    const f = await fixture();
    try {
      await f.write('bun.lock', '{\n  "lockfileVersion": 1,\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:bun.lock');
      expect(kindsOf(recorder.writes)).toEqual(['coverage']);
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'bun.lock:1 a lock file declares resolved versions, and no fact of this stage carries one', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a duplicate key is a named gap, and the first declaration stands', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",\n  "name": "another"\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(oneFact(recorder.writes, 'package').value['name']).toBe('orders-api');
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'package.json:3 the member "name" is declared twice: the first declaration stands, and the second is not read', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- what the readers note -------------------------------------------------

describe('a declaration read twice, and a dependency that is no edge', () => {
  test('a Cargo key declared twice is named, and the first declaration stands', async () => {
    const f = await fixture();
    try {
      await f.write('Cargo.toml', '[package]\nname = "orders"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\nserde = "2"\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:Cargo.toml');
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'Cargo.toml:6 the dependency "serde" names no package this repository\'s manifests declare', reason: 'unsupported' },
        { what: 'Cargo.toml:7 the key "dependencies.serde" is declared twice: the first declaration stands, and the second is not read', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a compose service declared twice is one deploy unit, and the repeat is named', async () => {
    const f = await fixture();
    try {
      await f.write('compose.yml', 'services:\n  web:\n    image: nginx\n  web:\n    image: other\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:compose.yml');
      expect(kindsOf(recorder.writes)).toEqual(['deploy-unit', 'coverage']);
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'compose.yml:4 the key "web" is declared twice: the first declaration stands, and the second is not read', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a dependency resolves in the ecosystem of the manifest that declares it', async () => {
    const f = await fixture();
    try {
      // One name, two ecosystems: the crate `yaml` is not the npm package.
      await f.write('package.json', '{\n  "name": "yaml"\n}\n');
      await f.write('Cargo.toml', '[package]\nname = "orders"\n\n[dependencies]\nyaml = "0.9"\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const cargo = await executed(stage, 'manifest:orders-api:Cargo.toml');
      expect(kindsOf(cargo.writes)).toEqual(['package', 'coverage']);
      expect(coverageOfDraft(cargo.writes).unread).toEqual([
        { what: 'Cargo.toml:5 the dependency "yaml" names no cargo package this repository\'s manifests declare', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a package that depends on itself is a gap, never a self-loop', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",\n  "dependencies": {\n    "orders-api": "workspace:*"\n  }\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(kindsOf(recorder.writes)).toEqual(['package', 'coverage']);
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'package.json:4 the dependency "orders-api" is the package of this manifest: a package does not depend on itself', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a Dockerfile that mixes the two ENV forms is named, and the pairs it holds stand', async () => {
    const f = await fixture();
    try {
      await f.write('Dockerfile', 'FROM oven/bun:1\nENV A=1 B\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:Dockerfile');
      expect(kindsOf(recorder.writes)).toEqual(['deploy-unit', 'environment-variable', 'consumes', 'coverage']);
      expect(oneFact(recorder.writes, 'environment-variable').value['name']).toBe('A');
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'Dockerfile:2 ENV mixes "KEY=value" pairs with a lone name, and which form a token takes is Docker\'s own rule', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a target that declares no name takes its package’s, and stands at its own table', async () => {
    const f = await fixture();
    try {
      await f.write('Cargo.toml', '[package]\nname = "orders"\nversion = "0.1.0"\n\n[[bin]]\npath = "src/main.rs"\n\n[lib]\npath = "src/lib.rs"\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:Cargo.toml');
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'entry-point').map((fact) => fact.value)).toEqual([
        { repository: 'orders-api', file: 'Cargo.toml', name: 'orders', form: 'cli-command' },
        { repository: 'orders-api', file: 'Cargo.toml', name: 'orders', form: 'library-export' },
      ]);
      // The place is the table the target declares, not the name key it does
      // not carry.
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'entry-point').map((fact) => fact.provenance.place?.range.startLine)).toEqual([5, 8]);
    } finally {
      await f.dispose();
    }
  });

  test('a JSON member stands at the line of its key, not of its value', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name":\n    "orders-api"\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(oneFact(recorder.writes, 'package').provenance.place?.range.startLine).toBe(2);
      expect(coverageOfDraft(recorder.writes).complete).toBe(true);
    } finally {
      await f.dispose();
    }
  });
});

// ---- what the second review round found ------------------------------------

describe('a manifest read strictly, and one name per declarer', () => {
  test('a trailing comma is refused, as the ecosystem’s own reader refuses it', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(kindsOf(recorder.writes)).toEqual(['coverage']);
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'package.json:3 a "," before "}" stands where a member belongs: JSON has no trailing comma', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a trailing comma in an array is refused too', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{\n  "name": "orders-api",\n  "workspaces": ["packages/*",]\n}\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(kindsOf(recorder.writes)).toEqual(['coverage']);
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'package.json:3 a "," before "]" stands where an element belongs: JSON has no trailing comma', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a quoted Dockerfile value is one word, and a line that really mixes forms is a gap', async () => {
    const f = await fixture();
    try {
      // Both examples are the Dockerfile reference's own.
      await f.write('Dockerfile', 'FROM oven/bun:1\nENV MY_NAME="John Doe" MY_DOG=Rex\\ The\\ Dog\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:Dockerfile');
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'environment-variable').map((fact) => fact.value['name'])).toEqual(['MY_DOG', 'MY_NAME']);
      expect(coverageOfDraft(recorder.writes).complete).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('a repeated compose service is read once, and its body is not read at all', async () => {
    const f = await fixture();
    try {
      await f.write('compose.yml', 'services:\n  web:\n    environment:\n      - A=1\n  web:\n    environment:\n      - B=2\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:compose.yml');
      // A fact standing at a line the unit's own coverage calls unread is what
      // this refuses: the second declaration's variables are not read.
      expect(factsOf(recorder.writes).filter((fact) => fact.kind === 'environment-variable').map((fact) => fact.value['name'])).toEqual(['A']);
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'compose.yml:5 the key "web" is declared twice: the first declaration stands, and the second is not read', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('two Dockerfiles in one folder are two deploy units, each named by its own manifest', async () => {
    const f = await fixture();
    try {
      await f.write('services/billing/Dockerfile', 'FROM oven/bun:1\n');
      await f.write('services/billing/Dockerfile.prod', 'FROM oven/bun:1\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const plain = await executed(stage, 'manifest:orders-api:services/billing/Dockerfile');
      const production = await executed(stage, 'manifest:orders-api:services/billing/Dockerfile.prod');
      const one = oneFact(plain.writes, 'deploy-unit');
      const other = oneFact(production.writes, 'deploy-unit');
      expect(one.value).toEqual({ repository: 'orders-api', name: 'services/billing/Dockerfile', form: 'container', manifest: 'services/billing/Dockerfile' });
      expect(other.value).toEqual({ repository: 'orders-api', name: 'services/billing/Dockerfile.prod', form: 'container', manifest: 'services/billing/Dockerfile.prod' });
      expect(one.id).not.toBe(other.id);
    } finally {
      await f.dispose();
    }
  });

  test('a YAML merge key is named, since this reader resolves no merge', async () => {
    const f = await fixture();
    try {
      await f.write('compose.yml', 'x-base: &base\n  image: nginx\nservices:\n  web:\n    <<: *base\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:compose.yml');
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'compose.yml:5 the key "<<" merges another mapping, and this reader resolves no merge: what the merged mapping declares is not read here', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a workspace’s shared dependencies are read, not dropped', async () => {
    const f = await fixture();
    try {
      await f.write('Cargo.toml', '[package]\nname = "orders"\n\n[workspace.dependencies]\nserde = "1"\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:Cargo.toml');
      expect(coverageOfDraft(recorder.writes).unread).toEqual([
        { what: 'Cargo.toml:5 the dependency "serde" names no package this repository\'s manifests declare', reason: 'unsupported' },
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- the unit's own rules -------------------------------------------------

describe('one unit', () => {
  test('a cancelled unit raises and writes nothing, since an empty draft retracts', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const { context, recorder, controller } = contextFor({ id: 'manifest:orders-api:package.json', scope: 'orders-api:package.json' });
      controller.abort();
      await expect(stage.execute({ id: 'manifest:orders-api:package.json', scope: 'orders-api:package.json' }, context)).rejects.toThrow('was cancelled');
      expect(recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('the same manifest read twice is the same facts, and a submodule path writes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api", "dependencies": { "yaml": "^2.9.1" } }\n');
      const first = f.commit();
      f.git('update-index', '--add', '--cacheinfo', `160000,${first},packages/sub/package.json`);
      f.git('commit', '-qm', 'submodule');
      const commit = f.git('rev-parse', 'HEAD').trim();
      const stage = stageOver(f.root, commit);
      const once = await executed(stage, 'manifest:orders-api:package.json');
      const twice = await executed(stage, 'manifest:orders-api:package.json');
      expect(factsOf(twice.writes).map((fact) => fact.id)).toEqual(factsOf(once.writes).map((fact) => fact.id));
      // A path that holds a submodule's commit is not this repository's file.
      const recorder = await executed(stage, 'manifest:orders-api:packages/sub/package.json');
      expect(recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a unit id this stage never plans is refused, naming the id', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      for (const id of ['file:orders-api:package.json', 'manifest:orders-api:', 'manifest:bad repo:package.json']) {
        const message = await refusedBy(() => executed(stage, id));
        expect(message).toContain(JSON.stringify(id));
        expect(message).toContain('a unit id is "manifest:<repository>:<path>"');
      }
    } finally {
      await f.dispose();
    }
  });

  test('validate reads every write back, and refuses a kind this stage does not produce', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const stage = stageOver(f.root, commit);
      const recorder = await executed(stage, 'manifest:orders-api:package.json');
      expect(await stage.validate({ writes: recorder.writes }, { query: async () => [] })).toEqual({ ok: true });
      const foreign: StageDraftWrite = {
        kind: 'fact',
        evidence: 'orders-api@0:package.json',
        value: makeNodeFact({
          kind: 'file',
          value: { repository: 'orders-api', path: repositoryPath('package.json'), roles: ['config'] },
          provenance: {
            source: { system: 'git', version: '2.43.0' },
            repository: { id: 'orders-api', commit },
            place: { file: repositoryPath('package.json'), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 } },
          },
          layer: 'extracted',
        }),
      };
      const refused = await stage.validate({ writes: [foreign] }, { query: async () => [] });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.errors.join('\n')).toContain('the build-configuration stage does not produce a "file" fact');
    } finally {
      await f.dispose();
    }
  });
});
