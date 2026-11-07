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
import { FACT_ID_PATTERN } from '../src/fill/facts.js';
import { createGraphStore } from '../src/graph/index.js';
import { createStagesFill, declaredStagesDigest, type StagesFill } from '../src/product/fill-stages.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

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

/** The graph kinds the three static stages publish, counted as the fact kinds they used to be, so one assertion reads both stores. */
async function countGraphKinds(owner: DatabaseOwner): Promise<Record<string, number>> {
  return await owner.run(async (tx) => {
    const counts: Record<string, number> = {};
    const nodes = await tx.query<{ kind: string; n: string }>(
      `SELECT k.key AS kind, count(*)::text AS n FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE v.recorded_to = 'infinity' AND v.valid_to = 'infinity' AND k.key IN ('code.file', 'code.directory', 'code.symbol', 'code.coverage', 'code.commit', 'code.repository')
       GROUP BY k.key`,
    );
    const nodeName: Record<string, string> = { 'code.file': 'file', 'code.directory': 'directory', 'code.symbol': 'symbol', 'code.coverage': 'coverage', 'code.commit': 'snapshot', 'code.repository': 'repository' };
    for (const row of nodes.rows) counts[nodeName[row.kind] ?? row.kind] = Number(row.n);
    const edges = await tx.query<{ relation: string; fact: string | null; n: string }>(
      `SELECT r.key AS relation, e.properties->>'factKind' AS fact, count(*)::text AS n FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
       WHERE e.recorded_to = 'infinity' AND e.valid_to = 'infinity' AND r.key IN ('code.occurrence', 'code.imports', 'code.contains')
       GROUP BY r.key, e.properties->>'factKind'`,
    );
    for (const row of edges.rows) {
      const kind = row.relation === 'code.occurrence' ? 'occurrence' : row.relation === 'code.imports' ? 'import' : row.fact === 'defines' ? 'defines' : 'contains';
      counts[kind] = (counts[kind] ?? 0) + Number(row.n);
    }
    return counts;
  });
}

/** The node kinds one snapshot unit published, read from the graph: the unit's own scope and producer. */
async function unitNodes(owner: DatabaseOwner, unitId: string): Promise<readonly { readonly fact: { readonly kind: string; readonly value: Record<string, unknown> } }[]> {
  return await owner.run(async (tx) => {
    // A unit publishes under its plan's scope: the table's own key for most stages, and a
    // stage's scope where its unit id names what it read (the history stage's range).
    const plan = await tx.query<{ scope: string }>(
      'SELECT scope FROM fill_unit_plan WHERE unit_id = $1 ORDER BY generation DESC LIMIT 1',
      [unitId],
    );
    const scopeKey = plan.rows[0]?.scope ?? unitId;
    const scope = await tx.query<{ node_id: string }>(
      "SELECT s.node_id::text AS node_id FROM publication_scope s WHERE s.producer = 'fill.' || split_part($1, '/', 1) AND s.scope_key = $2",
      [unitId, scopeKey],
    );
    const nodeId = scope.rows[0]?.node_id;
    if (nodeId === undefined) return [];
    const rows = await tx.query<{ kind: string; properties: Record<string, unknown> }>(
      `SELECT k.key AS kind, v.properties FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE v.scope_id = $1::bigint AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity' ORDER BY v.node_id`,
      [nodeId],
    );
    const name: Record<string, string> = { 'code.repository': 'repository', 'code.commit': 'snapshot' };
    return rows.rows.map((row) => ({ fact: { kind: name[row.kind] ?? row.kind, value: row.properties } }));
  });
}

/** Opens one product for runs: its wiring, its host over an owner this test closes. */
async function openProduct(folder: string): Promise<OpenProduct> {
  const owner: DatabaseOwner = createPGliteDatabaseOwner({ btreeGist: true });
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
    counts: async () => ({ ...await countPublishedFactsByKind(owner), ...await countGraphKinds(owner) }),
    unitFacts: async (unitId) => await unitNodes(owner, unitId),
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
  writeFirstFillWorkflow(product);
  writeFileSync(join(product, 'package.json'), '{\n  "name": "shop",\n  "version": "1.0.0"\n}\n');
  writeFileSync(join(product, 'src', 'order.ts'), "import { total } from './total.js';\n\nexport function checkout(): number {\n  return total();\n}\n");
  writeFileSync(join(product, 'src', 'total.ts'), 'export function total(): number {\n  return 42;\n}\n');
  writeFileSync(join(product, 'docs', 'readme.md'), '# Shop\n\nThe shop adds up an order.\n');
  git(product, 'init', '-q');
  commitAll(product, 'one\n\nTask: fixture-a.1');
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

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
        'build-configuration', 'code-facts', 'codegraph', 'data-model', 'data-model-aggregate', 'document-index', 'history', 'inventory', 'modules', 'operations', 'operations-links', 'snapshot', 'state-machines', 'syntax',
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
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
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
    const owner = createPGliteDatabaseOwner({ btreeGist: true });
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
  /** The commit the first run stood on: the one the history unit it published names. */
  let firstHistoryCommit = '';
  let afterSecond: Readonly<Record<string, number>> = {};

  beforeAll(async () => {
    // One wiring and one host for both runs, which is what decision 0027's
    // "a second run of the same product reuses what the first opened" means: the
    // second run's pins are read again when it plans, and stand on the commit the
    // one-file commit made (the wiring's own doc says so).
    opened = await openProduct(product);
    first = await opened.run('run-one');
    firstHistoryCommit = git(product, 'rev-parse', 'HEAD');
    afterFirst = await opened.counts();
    // The one-file commit: the second run stands on a new commit of the same tree.
    writeFileSync(join(product, 'src', 'total.ts'), 'export function total(): number {\n  return 43;\n}\n');
    commitAll(product, 'two');
    second = await opened.run('run-two');
    afterSecond = await opened.counts();
  }, 900_000);

  afterAll(async () => {
    await opened?.close();
  }, 300_000);

  test('the first run publishes what the stages read from the pinned tree', async () => {
    expect(first?.state).toBe('succeeded');
    expect(first?.settled).toBe(true);
    expect(first?.units.length).toBeGreaterThan(0);
    expect(first?.units.every((unit) => unit.state === 'published')).toBe(true);
    expect(first?.reused).toEqual([]);
    // The three static stages publish into the 0028 graph: the pinned snapshot, the tree's files and
    // folders, the tree's containment, and the syntax stage's symbols, definitions, mentions and
    // imports. The stages after them still read the fill's fact store (tasks 2.2 to 2.4), so their
    // kinds — package, module, document, commit — are the next tasks' assertions.
    for (const kind of ['coverage', 'contains', 'defines', 'directory', 'file', 'import', 'occurrence', 'snapshot', 'symbol']) {
      expect(afterFirst[kind] ?? 0).toBeGreaterThan(0);
    }
    // The product's files: its four sources, its workspace.yaml, and the workflows manifest the fill runs.
    expect(afterFirst['file']).toBe(6);
    // The code pass runs after the file pass whose symbols it joins: one unit per repository's tree,
    // and the call `checkout` makes to `total` stands in the graph as its edge.
    expect(first?.units.map((unit) => unit.unitId)).toContain('codegraph/tree:shop');
    const calls = await opened!.owner.run(async (tx) => (await tx.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id WHERE r.key = 'code.calls' AND e.producer = 'fill.codegraph' AND e.recorded_to = 'infinity' AND e.valid_to = 'infinity'",
    )).rows[0]!);
    expect(Number(calls.n)).toBe(1);
    expect(afterFirst['directory']).toBe(3);
    // The snapshot stage's commit node and the history stage's commit node of the same commit:
    // two producers, two nodes, each with its own key (decision 0033's fenced publication).
    expect(afterFirst['snapshot']).toBe(2);
  }, 900_000);

  test('a second run after a one-file commit plans that file\'s units and its dependants\' and no others', async () => {
    const planned = new Set((second?.units ?? []).map((unit) => unit.unitId));
    // The file whose bytes moved, in the stages that read its bytes.
    for (const unitId of [
      // The file whose bytes moved is the snapshot's unit, and the syntax stage reads it again. The code
      // pass stands on the repository's commit, which moved with it: its one unit plans again.
      'snapshot/file:shop:src/total.ts',
      'syntax/file:shop:src/total.ts',
      'codegraph/tree:shop',
    ]) {
      expect(planned.has(unitId)).toBe(true);
    }
    // The commit's propagation plans the inventory's unit too, because the inventory consumes the snapshot's
    // `file` kind; its draft is the same containment edge, so the graph opens no new edge version.
    expect(planned.has('inventory/file:shop:src/total.ts')).toBe(true);
    // The files the commit did not touch are not computed again: their bytes and
    // their resolutions stand as the first run published them.
    expect(['snapshot/file:shop:src/order.ts', 'inventory/file:shop:src/order.ts', 'syntax/file:shop:src/order.ts'].filter((unitId) => planned.has(unitId))).toEqual([]);
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
    expect([...(second?.reused ?? [])].sort()).toEqual(['build-configuration/manifest:shop:package.json', 'document-index/document:shop:docs/readme.md'].sort());
    // The history stage names one unit per repository the run pins, at the
    // commit it pins (its plan reads the run's pins and no graph: a plan that
    // read the graph's snapshot facts would name the previous run's commit, and
    // on a first run nothing at all). Its first publication moves the read it
    // records of what the graph holds, so the run replaces the unit once and
    // publishes it again: the replacement is bounded, and the run settles instead
    // of looping (a stage that wrote only what changed made it loop; the history
    // stage writes its whole set, `src/fill/stages/history.ts`).
    // A history unit's scope names the commit it read, so the second run plans one at the new pin and the run's
    // sweep replaces the one the first run left at the old one: the facts of a commit the graph no longer stands
    // on are retracted, which is what madarch-tzte.26.1's propagation adds to this task's own incrementality.
    // Both units stand published after the run, and each is its own unit of the run's list.
    const historyUnits = (second?.units ?? []).filter((unit) => unit.stageId === 'history');
    expect(historyUnits.map((unit) => unit.unitId).sort()).toEqual([
      `history/shop@${git(product, 'rev-parse', 'HEAD')}`,
      `history/shop@${firstHistoryCommit}`,
    ].sort());
    const historyUnit = historyUnits.find((unit) => unit.unitId === `history/shop@${git(product, 'rev-parse', 'HEAD')}`);
    const plan = historyUnit === undefined ? null : await readUnitPlan(opened!.owner, historyUnit.unitId, historyUnit.generation);
    const transitions = historyUnit === undefined ? [] : (await opened!.owner.transaction('snapshot', async (executor) => (
      await executor.query<{ event: string }>('SELECT event FROM fill_transition WHERE subject_id = $1 ORDER BY seq', [historyUnit.unitId])
    ).rows)).map((row) => row.event);
    expect(plan?.runId).toBe('run-two');
    expect(historyUnit?.state).toBe('published');
    expect(transitions.filter((event) => event === 'invalidate')).toHaveLength(1);
  }, 900_000);

  test('the second run republished the snapshot of the commit it stood on, replacing the first run\'s', async () => {
    // 0027: a unit's publication replaces that unit's own facts. One unit is one
    // repository at one commit (0026, stage 0), so the graph holds one snapshot
    // of it after two runs — the second run's — and the shape is what says the
    // wiring read the pins again instead of standing on the first run's commit.
    const facts = await opened!.unitFacts('snapshot/repository:shop');
    // One unit per repository at one commit writes two graph nodes (decision 0033, stage 0):
    // the repository node and the commit it pinned.
    expect(facts.map((entry) => entry.fact.kind).sort()).toEqual(['repository', 'snapshot']);
    const snapshot = facts.find((entry) => entry.fact.kind === 'snapshot')!;
    expect((snapshot.fact.value as { commit: string; repository: string }).commit).toBe(git(product, 'rev-parse', 'HEAD'));
    expect((snapshot.fact.value as { repository: string }).repository).toBe('shop');
    // The snapshot stage's own commit node, and the history stage's copies of the range it read:
    // `code.commit` is one kind and two producers write it (decision 0033's fenced publication).
    expect(afterSecond['snapshot']).toBeGreaterThanOrEqual(1);
    // A file is its repository and its path, so the file facts of both runs are
    // the same rows: one row per file of the tree, whatever the commit.
    expect(afterSecond['file']).toBe(6);
    expect(afterSecond['directory']).toBe(3);
  }, 900_000);
});

describe('a tree holding a file no grammar of ours reads', () => {
  /**
   * The defect this case holds (madarch-8bdc.2.8): the code pass writes a symbol for a declaration it reads
   * in a file no per-file pass of ours can read, and its own read of the repository's symbols then answers
   * the symbol it just wrote. The run went stale once on every repository where it wrote a symbol, and the
   * replacement generation raised on the node it had written itself. The fixture holds a Terraform resource
   * beside a TypeScript function: the library reads both, one grammar of ours reads the TypeScript alone.
   */
  test('the code pass writes the resource and settles in its first generation, and the run succeeds', async () => {
    const folder = join(root, 'shop-terraform');
    mkdirSync(join(folder, 'src'), { recursive: true });
    mkdirSync(join(folder, 'terraform'), { recursive: true });
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: 2f6d1e8a-3b4c-4d5e-8f90-1a2b3c4d5e6f\nname: shop-terraform\n');
    writeFirstFillWorkflow(folder);
    writeFileSync(join(folder, 'src', 'total.ts'), 'export function total(): number {\n  return 42;\n}\n');
    writeFileSync(join(folder, 'terraform', 'images.tf'), [
      'resource "registry_repository" "images" {',
      '  location      = "europe-west1"',
      '  repository_id = "images"',
      '  format        = "DOCKER"',
      '}',
      '',
    ].join('\n'));
    git(folder, 'init', '-q');
    commitAll(folder, 'one');
    const opened = await openProduct(folder);
    try {
      const run = await opened.run('run-terraform');
      // One generation, not two: the code pass's read of the symbols answers no symbol it wrote itself.
      expect({ state: run.state, settled: run.settled }).toEqual({ state: 'succeeded', settled: true });
      // The code pass publishes in its first generation: its read of the file pass's declarations
      // answers what it answered before it wrote its symbol. The modules stage reads the repository's
      // symbols, and the code pass plans no unit in the run's first wave (it waits for the file pass), so
      // nothing holds the modules unit back: it reads the symbols before the code pass published one,
      // goes stale once by that publication, and stands published in the generation that replaces it.
      const codegraph = run.units.find((unit) => unit.unitId === 'codegraph/tree:shop-terraform');
      const modules = run.units.find((unit) => unit.unitId === 'modules/modules:shop-terraform');
      expect({ codegraph: [codegraph?.state, codegraph?.generation], modules: modules?.state }).toEqual({
        codegraph: ['published', 1],
        modules: 'published',
      });
      // The resource is a record of ours, readable where every reader of a symbol reads it, with its key.
      const store = createGraphStore(opened.owner);
      const symbols = (await store.byProperty('code.symbol', 'repository', 'shop-terraform', { limit: 1000 })).rows;
      const held = (node: (typeof symbols)[number]): Record<string, unknown> => node.properties as Record<string, unknown>;
      const resource = symbols.find((node) => held(node)['globalName'] === 'shop-terraform:terraform/images.tf#registry_repository.images');
      if (resource === undefined) throw new Error(`the graph holds no symbol for the Terraform resource: it answered ${symbols.map((node) => String(held(node)['globalName'])).sort().join(', ')}`);
      // The node carries a symbol fact's id — a kind, a colon and the digest of what the symbol is about —
      // and the graph answers it by that key: a reader names it as it names every other symbol.
      const key = String(held(resource)['recordKey']);
      expect(FACT_ID_PATTERN.test(key) && key.startsWith('symbol:')).toBe(true);
      expect((await store.byKey(key, { limit: 2 })).rows.map((node) => node.nodeId)).toEqual([resource.nodeId]);
      expect(held(resource)['qualifiedName']).toBe('registry_repository.images');
      expect(resource.producer).toBe('fill.codegraph');
      expect((held(resource)['provenance'] as { place?: { file?: string } }).place?.file).toBe('terraform/images.tf');
    } finally {
      await opened.close();
    }
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
