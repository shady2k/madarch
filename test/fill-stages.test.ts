/**
 * The product wiring of the eight deterministic stages (madarch-tzte.21.8): a
 * product's manifest read into pins, the eight stages registered over them, and
 * real runs through the orchestrator host on a database the test opens. The
 * fixture is a product repository the test makes — decision 0021's manifest and
 * a handful of files — because AGENTS.md keeps a committed test to fixtures the
 * project holds or creates: no outside checkout is read here.
 *
 * What these tests hold, in the task's own words: on a product the eight
 * deterministic stages run through the orchestrator without an agent and publish
 * their facts, and a second run after a one-file commit recomputes only what
 * that file affects — its units are the changed file's own and those of its
 * dependants, and the files the commit did not touch are not planned.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { countPublishedFactsByKind, readUnitFacts } from '../src/fill/fact-store.js';
import { readUnitPlan } from '../src/fill/orchestrator-store.js';
import { createFillOrchestratorService, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createStagesFill, declaredStagesDigest, type StagesFill } from '../src/product/fill-stages.js';

/** One product open for a run: the database it fills, its host, and the wiring over the product. */
interface OpenProduct {
  readonly fill: StagesFill;
  readonly owner: DatabaseOwner;
  readonly service: FillOrchestratorService;
  run(runId: string): Promise<FillRunResult>;
  /** The facts the graph holds, by kind, as the store reads them. */
  counts(): Promise<Readonly<Record<string, number>>>;
  /** The facts one unit published, as the store holds them. */
  unitFacts(unitId: string): Promise<readonly { readonly fact: { readonly kind: string; readonly value: unknown } }[]>;
  close(): Promise<void>;
}

let root = '';
/** The product the two runs fill: a repository this test makes. */
let product = '';

/** One git call in a fixture checkout. */
function git(folder: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: folder, encoding: 'utf8' }).trim();
}

/** Commits everything a fixture folder holds, under the fixture's own identity. */
function commitAll(folder: string, message: string): string {
  git(folder, 'add', '-A');
  git(folder, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
  return git(folder, 'rev-parse', 'HEAD');
}

/** Opens one product for runs: its wiring, its host over an owner this test closes. */
async function openProduct(folder: string): Promise<OpenProduct> {
  const owner: DatabaseOwner = createPGliteDatabaseOwner();
  const fill = await createStagesFill({ product: folder, database: owner });
  const home = mkdtempSync(join(tmpdir(), 'madarch-stages-home-'));
  const service = createFillOrchestratorService({ home, owner, registry: fill.registry, wiring: () => fill.wiring });
  return {
    fill,
    owner,
    service,
    run: async (runId) => {
      const result = await service.run({ product: fill.product, runId });
      if (!result.ok) throw new Error(`the run ${runId} was refused: ${result.code}: ${result.reason}`);
      return result;
    },
    counts: async () => await countPublishedFactsByKind(owner),
    unitFacts: async (unitId) => await readUnitFacts(owner, unitId),
    close: async () => {
      await service.stop();
      await owner.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The pins one product's wiring reads, refused where it wires no source at all. */
async function pinsOf(fill: StagesFill): Promise<readonly { id: string; form: string; root: string; commit: string }[]> {
  const source = fill.wiring.source;
  if (source === undefined) throw new Error('the stages wiring wires no snapshot source, and every stage reads its bytes through one');
  return await (await source()).pins();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-stages-'));
  product = join(root, 'shop');
  mkdirSync(join(product, 'src'), { recursive: true });
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f\nname: shop\n');
  writeFileSync(join(product, 'package.json'), '{\n  "name": "shop",\n  "version": "1.0.0"\n}\n');
  writeFileSync(join(product, 'src', 'order.ts'), "import { total } from './total.js';\n\nexport function checkout(): number {\n  return total();\n}\n");
  writeFileSync(join(product, 'src', 'total.ts'), 'export function total(): number {\n  return 42;\n}\n');
  writeFileSync(join(product, 'docs', 'readme.md'), '# Shop\n\nThe shop adds up an order.\n');
  git(product, 'init', '-q');
  commitAll(product, 'one\n\nTask: fixture-a.1');
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the wiring of one product', () => {
  test('the product repository is pinned at its HEAD, and the eight stages are declared over it', async () => {
    const opened = await openProduct(product);
    try {
      expect(opened.fill.product).toEqual({ name: 'shop', folder: product });
      expect((await pinsOf(opened.fill)).map((pin) => [pin.id, pin.form, pin.root, pin.commit])).toEqual([
        ['shop', 'product', product, git(product, 'rev-parse', 'HEAD')],
      ]);
      const snapshot = await opened.fill.wiring.snapshot();
      expect(snapshot.repository).toBe(product);
      expect(snapshot.commit).toBe(git(product, 'rev-parse', 'HEAD'));
      expect(opened.fill.registry.all().map((stage) => stage.id)).toEqual([
        'build-configuration', 'document-index', 'history', 'inventory', 'modules', 'semantic-resolution', 'snapshot', 'syntax',
      ]);
      expect(snapshot.registryHash).toBe(declaredStagesDigest(opened.fill.registry));
      expect(snapshot.registryHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await opened.close();
    }
  }, 300_000);

  test('a manifest that does not read, and a product name that is no repository name, are refused with the file', async () => {
    const broken = join(root, 'broken');
    mkdirSync(broken, { recursive: true });
    const owner = createPGliteDatabaseOwner();
    try {
      writeFileSync(join(broken, 'workspace.yaml'), 'schemaVersion: 1\nid: 6d9f9c2a-1b7c-4e0e-9a92-27f1d1a2b3c4\nname: [\n');
      await expect(createStagesFill({ product: broken, database: owner })).rejects.toThrow(
        new RegExp(`${join(broken, 'workspace.yaml')}:\\d+:`),
      );
      writeFileSync(join(broken, 'workspace.yaml'), 'schemaVersion: 1\nid: 6d9f9c2a-1b7c-4e0e-9a92-27f1d1a2b3c4\nname: broken shop\n');
      await expect(createStagesFill({ product: broken, database: owner })).rejects.toThrow(/which is no repository name/);
    } finally {
      await owner.close();
    }
  }, 300_000);

  test('a declared repository is pinned when it is connected — a link included — and refused by its folder when it is not', async () => {
    const declared = join(root, 'declared');
    const api = join(declared, 'repos', 'api');
    mkdirSync(join(declared, 'repos'), { recursive: true });
    writeFileSync(join(declared, 'workspace.yaml'), [
      'schemaVersion: 1',
      'id: 8f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      'name: declared',
      'repos:',
      '  - name: api',
      '    url: https://example.invalid/leftover-listings-api.git',
      '',
    ].join('\n'));
    git(declared, 'init', '-q');
    commitAll(declared, 'one');
    // A checkout connected the way `madarch init` and `madarch repo add` connect
    // one by default: a link at repos/<name>, whose physical folder is elsewhere.
    const checkout = join(root, 'api-checkout');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'main.go'), 'package main\n');
    git(checkout, 'init', '-q');
    commitAll(checkout, 'one');
    symlinkSync(checkout, api, 'dir');
    const opened = await openProduct(declared);
    try {
      expect((await pinsOf(opened.fill)).map((pin) => [pin.id, pin.form, pin.root, pin.commit])).toEqual([
        ['api', 'code', api, git(checkout, 'rev-parse', 'HEAD')],
        ['declared', 'product', declared, git(declared, 'rev-parse', 'HEAD')],
      ]);
    } finally {
      await opened.close();
    }
    // A declared repository whose folder holds no checkout is refused by name:
    // the wiring never guesses a commit for a repository that is not there.
    unlinkSync(api);
    const owner = createPGliteDatabaseOwner();
    try {
      const fill = await createStagesFill({ product: declared, database: owner });
      await expect(pinsOf(fill)).rejects.toThrow(new RegExp(`${api} is no Git checkout of its own`));
    } finally {
      await owner.close();
    }
  }, 300_000);
});

describe('two runs over one product', () => {
  let opened: OpenProduct | undefined;
  let first: FillRunResult | undefined;
  let second: FillRunResult | undefined;
  let afterFirst: Readonly<Record<string, number>> = {};
  let afterSecond: Readonly<Record<string, number>> = {};

  beforeAll(async () => {
    // One wiring and one host for both runs, which is what decision 0027's
    // "a second run of the same product reuses what the first opened" means: the
    // second run's pins are read again when it plans, and stand on the commit the
    // one-file commit made (the wiring's own doc says so).
    opened = await openProduct(product);
    first = await opened.run('run-one');
    afterFirst = await opened.counts();
    // The one-file commit: the second run stands on a new commit of the same tree.
    writeFileSync(join(product, 'src', 'total.ts'), 'export function total(): number {\n  return 43;\n}\n');
    commitAll(product, 'two');
    second = await opened.run('run-two');
    afterSecond = await opened.counts();
  }, 900_000);

  afterAll(async () => {
    await opened?.close();
  });

  test('the first run publishes what the stages read from the pinned tree', () => {
    expect(first?.state).toBe('succeeded');
    expect(first?.settled).toBe(true);
    expect(first?.units.length).toBeGreaterThan(0);
    expect(first?.units.every((unit) => unit.state === 'published')).toBe(true);
    expect(first?.reused).toEqual([]);
    // The kinds the stages that read the tree publish: the pinned snapshot, the
    // inventory's files and folders, the packages a manifest declares, the
    // symbols and imports the syntax stage finds, the documents and their
    // sections, and the modules a repository's graph clusters into.
    for (const kind of ['coverage', 'contains', 'directory', 'file', 'module', 'package', 'symbol', 'defines', 'import', 'occurrence', 'document', 'section', 'commit', 'task-key']) {
      expect(afterFirst[kind] ?? 0).toBeGreaterThan(0);
    }
    expect(afterFirst['file']).toBe(5);
    expect(afterFirst['directory']).toBe(2);
    expect(afterFirst['snapshot']).toBe(1);
  }, 900_000);

  test('a second run after a one-file commit plans that file\'s units and its dependants\' and no others', async () => {
    const planned = new Set((second?.units ?? []).map((unit) => unit.unitId));
    // The file whose bytes moved, in the stages that read its bytes.
    for (const unitId of [
      'inventory/file:shop:src/total.ts',
      'syntax/file:shop:src/total.ts',
      'semantic-resolution/file:shop:src/total.ts',
      // The folder it stands in holds a file this run writes.
      'inventory/directory:shop:src',
    ]) {
      expect(planned.has(unitId)).toBe(true);
    }
    // Its dependant: src/order.ts imports ./total.js, so the resolution stage
    // re-resolves it although its own bytes did not move (21.6's own rule).
    expect(planned.has('semantic-resolution/file:shop:src/order.ts')).toBe(true);
    // The files the commit did not touch are not computed again: their bytes and
    // their resolutions stand as the first run published them.
    for (const unitId of [
      'inventory/file:shop:src/order.ts',
      'syntax/file:shop:src/order.ts',
      'inventory/file:shop:docs/readme.md',
      'document-index/document:shop:docs/readme.md',
    ]) {
      expect(planned.has(unitId)).toBe(false);
    }
    // Every unit the second run planned is executed but the inherited ones. The
    // expectation is written as the list itself, so a unit that ended in another
    // state is named by the failure and not counted away.
    const states = (second?.units ?? []).map((unit) => `${unit.unitId}: ${unit.state}`).sort();
    expect({ states, state: second?.state, settled: second?.settled, stopped: second?.stoppedBecause }).toEqual({
      states: (second?.units ?? []).map((unit) => `${unit.unitId}: published`).sort(),
      state: 'succeeded', settled: true, stopped: undefined,
    });
    // The one unit the commit did not affect and its stage still plans — stage 2
    // names a unit for every manifest in the tree, comparing no blob itself — is
    // inherited rather than computed again: its own bytes did not move.
    expect(second?.reused).toEqual(['build-configuration/manifest:shop:package.json']);
    // The history stage names one unit per repository the run pins, at the
    // commit it pins (its plan reads the run's pins and no graph: a plan that
    // read the graph's snapshot facts would name the previous run's commit, and
    // on a first run nothing at all). Its first publication moves the read it
    // records of what the graph holds, so the run replaces the unit once and
    // publishes it again: the replacement is bounded, and the run settles instead
    // of looping (a stage that wrote only what changed made it loop; the history
    // stage writes its whole set, `src/fill/stages/history.ts`).
    const historyUnit = (second?.units ?? []).find((unit) => unit.stageId === 'history');
    const plan = historyUnit === undefined ? null : await readUnitPlan(opened!.owner, historyUnit.unitId, historyUnit.generation);
    const transitions = historyUnit === undefined ? [] : (await opened!.owner.transaction('snapshot', async (executor) => (
      await executor.query<{ event: string }>('SELECT event FROM fill_transition WHERE subject_id = $1 ORDER BY seq', [historyUnit.unitId])
    ).rows)).map((row) => row.event);
    expect(plan?.runId).toBe('run-two');
    expect(historyUnit?.unitId).toBe(`history/shop@${git(product, 'rev-parse', 'HEAD')}`);
    expect(historyUnit?.state).toBe('published');
    expect(transitions.filter((event) => event === 'invalidate')).toHaveLength(1);
  }, 900_000);

  test('the second run republished the snapshot of the commit it stood on, replacing the first run\'s', async () => {
    // 0027: a unit's publication replaces that unit's own facts. One unit is one
    // repository at one commit (0026, stage 0), so the graph holds one snapshot
    // of it after two runs — the second run's — and the shape is what says the
    // wiring read the pins again instead of standing on the first run's commit.
    const facts = await opened!.unitFacts('snapshot/shop');
    // One unit per repository at one commit writes three facts (0026, stage 0):
    // the snapshot, the repository node and the coverage of the reading.
    expect(facts.map((entry) => entry.fact.kind).sort()).toEqual(['coverage', 'repository', 'snapshot']);
    const snapshot = facts.find((entry) => entry.fact.kind === 'snapshot')!;
    expect((snapshot.fact.value as { commit: string; repository: string }).commit).toBe(git(product, 'rev-parse', 'HEAD'));
    expect((snapshot.fact.value as { repository: string }).repository).toBe('shop');
    expect(afterSecond['snapshot']).toBe(1);
    // A file is its repository and its path, so the file facts of both runs are
    // the same rows: one row per file of the tree, whatever the commit.
    expect(afterSecond['file']).toBe(5);
    expect(afterSecond['directory']).toBe(2);
  }, 900_000);
});

describe('the fill-stages command surface', () => {
  const cli = fileURLToPath(new URL('../scripts/madarch.ts', import.meta.url));

  /** Runs the command as a person does, with a scratch products home. */
  function runCommand(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const home = mkdtempSync(join(tmpdir(), 'madarch-stages-cli-'));
    try {
      const run = spawnSync('bun', [cli, ...args], { encoding: 'utf8', env: { ...process.env, MADARCH_HOME: home }, timeout: 120_000 });
      return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('its help names the usage, the options it takes and an example', () => {
    const help = runCommand(['fill-stages', '--help']);
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('usage: madarch fill-stages');
    for (const flag of ['--product <folder>', '--home <folder>', '--run <id>', '--json']) expect(help.stdout).toContain(flag);
    expect(help.stdout).toContain('Example:');
    expect(help.stdout).toContain('--run <id>');
    expect(help.stdout).toContain('The run to plan');
  }, 120_000);

  test('a folder that is no product is refused with exit 1, naming what is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'madarch-stages-empty-'));
    try {
      const home = mkdtempSync(join(tmpdir(), 'madarch-stages-home-'));
      try {
        const run = spawnSync('bun', [cli, 'fill-stages', '--product', empty, '--home', home], {
          encoding: 'utf8', env: { ...process.env, MADARCH_HOME: home }, timeout: 120_000,
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(join(empty, 'workspace.yaml'));
        expect(run.stderr).toContain('holds no workspace.yaml');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 120_000);

  test('an unknown option and a value the run flag does not have are refused with exit 2', () => {
    const unknown = runCommand(['fill-stages', '--stages']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option "--stages"');
    expect(unknown.stderr).toContain('--run');
    const bare = runCommand(['fill-stages', '--run']);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain('--run needs a value');
  }, 120_000);
});
