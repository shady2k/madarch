/**
 * The build and configuration stage against the answer key, on the training
 * repository the knowledge tests and `scripts/knowledge-shots.ts` generate
 * (madarch-8bdc.2.3): the manifest items the key names — the dependencies a
 * manifest declares, with the version it pins, and the deploy units a Dockerfile
 * and a compose file declare — are what the stage publishes into the 0028 graph,
 * read back through `src/graph`'s own reads. A second fill of the same commit
 * writes nothing.
 *
 * The repository is `examples/training-repository/generate.mjs`'s own (the
 * generator AGENTS.md allows a test to run); nothing comes from outside it. The
 * key is `examples/training-repository/answer-key.json`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';

const GENERATOR = fileURLToPath(new URL('../examples/training-repository/generate.mjs', import.meta.url));
const KEY = fileURLToPath(new URL('../examples/training-repository/answer-key.json', import.meta.url));
const REPOSITORY = 'training';
const PRODUCT = 'training-shop';

/** One item of the answer key: its id and the places it names, each a path, a symbol and an anchor. */
interface KeyItem {
  readonly id: string;
  readonly location?: { readonly path?: string; readonly symbol?: string; readonly anchor?: string };
  readonly locations?: readonly { readonly path?: string; readonly symbol?: string; readonly anchor?: string }[];
}

/** The key's places as one list, its singular `location` included. */
function placesOf(item: KeyItem): readonly { readonly path?: string; readonly symbol?: string; readonly anchor?: string }[] {
  return [...(item.location === undefined ? [] : [item.location]), ...(item.locations ?? [])];
}

/** One dependency a manifest declares, as the graph holds it: the file, the name and the version. */
interface ReadDependency {
  readonly file: string;
  readonly name: string;
  readonly version?: string;
  readonly group?: string;
}

let root = '';
let owner: DatabaseOwner | undefined;
let service: ReturnType<typeof createFillOrchestratorService> | undefined;
let fill: StagesFill | undefined;
let store: GraphStore | undefined;
let first: FillRunResult | undefined;
let second: FillRunResult | undefined;
let dependencies: readonly ReadDependency[] = [];
let documents: readonly { readonly path: string; readonly title: string; readonly anchors: readonly string[] }[] = [];
let modules: readonly { readonly key: string; readonly name: string; readonly members: readonly string[] }[] = [];
let commits: readonly { readonly commit: string; readonly subject: string; readonly parents: readonly string[] }[] = [];
let tasks: readonly string[] = [];
let deployUnits: readonly { readonly path: string; readonly name: string; readonly form: string; readonly kind: string }[] = [];
let versions = { nodes: 0, edges: 0 };

/** The node properties a read answered, as a record. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** Every node of one kind the graph holds for the repository, read one page after another. */
async function nodesOfKind(kind: string): Promise<readonly { readonly nodeId: string; readonly properties: unknown }[]> {
  const rows: { nodeId: string; properties: unknown }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store!.byProperty(kind, 'repository', REPOSITORY, { limit: 1000, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows.map((row) => ({ nodeId: row.nodeId, properties: row.properties })));
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** The node version and edge version counts of the graph: what a fill that writes nothing leaves as it found them. */
async function counts(): Promise<{ readonly nodes: number; readonly edges: number }> {
  return await owner!.transaction('snapshot', async (executor) => {
    const nodes = await executor.query<{ n: string }>('SELECT count(*)::text AS n FROM node_version');
    const edges = await executor.query<{ n: string }>('SELECT count(*)::text AS n FROM edge_version');
    return { nodes: Number(nodes.rows[0]?.n ?? 0), edges: Number(edges.rows[0]?.n ?? 0) };
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-build-configuration-training-'));
  const repository = join(root, 'training');
  execFileSync(process.execPath, [GENERATOR, repository], { stdio: ['ignore', 'pipe', 'pipe'] });
  const product = join(root, 'product');
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', REPOSITORY), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 5c2e8a52-9c3e-4f7a-8b21-6d2e9c0a5b41',
    `name: ${PRODUCT}`,
    'repos:',
    `  - name: ${REPOSITORY}`,
    '    url: file:///training',
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] }); };
  writeFirstFillWorkflow(product);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the product of the training repository');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    owner, registry: fill.registry, wiring: () => fill!.wiring,
    clock: () => (at += 1_000), limits: { leaseMs: 86_400_000 }, maxPasses: 100_000,
  });
  store = createGraphStore(owner);
  const run = await service.run({ product: fill.product, runId: 'training-one' });
  if (!run.ok) throw new Error(`the first fill was refused: ${run.code}: ${run.reason}`);
  first = run;
  const dependencyNodes = await nodesOfKind('code.dependency');
  dependencies = dependencyNodes.map((node) => {
    const held = propertiesOf(node);
    return { file: String(held['file']), name: String(held['name']), ...(typeof held['version'] === 'string' ? { version: held['version'] } : {}), ...(typeof held['group'] === 'string' ? { group: held['group'] } : {}) };
  });
  const units = [...await nodesOfKind('code.dockerfile'), ...await nodesOfKind('code.compose-service'), ...await nodesOfKind('code.deploy-unit')];
  deployUnits = units.map((node) => {
    const held = propertiesOf(node);
    return { path: String(held['manifest']), name: String(held['name']), form: String(held['form']), kind: String(held['factKind']) };
  });
  // The document index's documents and sections, the modules stage's modules and their
  // members, and the history stage's commits and task keys, as the graph holds them.
  const documentNodes = await nodesOfKind('code.document');
  const sectionNodes = await nodesOfKind('code.document-section');
  documents = documentNodes.map((node) => {
    const held = propertiesOf(node);
    const path = String(held['path']);
    const anchors = sectionNodes.map(propertiesOf).filter((section) => section['document'] === path).map((section) => String(section['anchor'])).sort();
    return { path, title: String(held['title'] ?? ''), anchors };
  });
  const moduleNodes = await nodesOfKind('code.module');
  const containsEdges = await store!.edgesByProperty('code.contains', 'repository', REPOSITORY, { limit: 10_000 });
  const pathByKey = new Map<string, string>();
  for (const node of await nodesOfKind('code.file')) pathByKey.set(String(propertiesOf(node)['recordKey']), String(propertiesOf(node)['path']));
  modules = moduleNodes.map((node) => {
    const held = propertiesOf(node);
    const key = String(held['recordKey']);
    const members = containsEdges.rows
      .filter((edge) => edge.edge.src === node.nodeId)
      .map((edge) => String((edge.dst.properties as Record<string, unknown>)['recordKey']))
      .map((each) => pathByKey.get(each) ?? '')
      .filter((path) => path !== '');
    return { key, name: String(held['name']), members };
  });
  commits = (await nodesOfKind('code.commit'))
    // The product repository is pinned too, and its own commit node is the snapshot's: the
    // history items are about the code repository's ancestry.
    .filter((node) => propertiesOf(node)['repository'] === REPOSITORY && propertiesOf(node)['subject'] !== undefined)
    .map((node) => {
      const held = propertiesOf(node);
      return { commit: String(held['commit']), subject: String(held['subject'] ?? ''), parents: (held['parents'] ?? []) as readonly string[] };
    });
  tasks = (await nodesOfKind('code.task')).map((node) => String(propertiesOf(node)['key']));
  versions = await counts();
  const again = await service.run({ product: fill.product, runId: 'training-two' });
  if (!again.ok) throw new Error(`the second fill was refused: ${again.code}: ${again.reason}`);
  second = again;
}, 900_000);

afterAll(async () => {
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the answer key\'s manifest items, read from the graph', () => {
  test('every dependency a manifest declares stands with the name and version the manifest wrote', async () => {
    expect({ state: first?.state, settled: first?.settled }).toEqual({ state: 'succeeded', settled: true });
    const key = JSON.parse(readFileSync(KEY, 'utf8')) as { readonly items: readonly KeyItem[] };
    // The items whose evidence is a manifest's own declaration: one dependency name with
    // the version pinned beside it, or a dependency group, in a `go.mod`, a `package.json`
    // or a `Cargo.toml`.
    const wanted = key.items.filter((item) => ['dependencies', 'stack'].includes(item.id.split('.')[0]!));
    expect(wanted.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const item of wanted) {
      for (const place of placesOf(item)) {
        const path = place.path;
        if (path === undefined) continue;
        // A lock file's content is no declaration of this stage's: it is the stage's
        // named gap, and the key's lock-file places are the shape of the file, not a
        // dependency any manifest declares.
        if (path.endsWith('package-lock.json') || path.endsWith('bun.lock') || path.endsWith('go.sum') || path.endsWith('yarn.lock') || path.endsWith('pnpm-lock.yaml') || path.endsWith('Cargo.lock')) continue;
        // The anchor names the declaration the key points at: `"lodash": "4.17.15"`, or
        // `github.com/lib/pq v1.10.9`. The dependency's own name is the first token of it.
        const anchor = place.anchor ?? place.symbol ?? '';
        const name = (/"([^"]+)"/u.exec(anchor)?.[1] ?? /^([^\s"]+)/u.exec(anchor)?.[1] ?? '').trim();
        if (name === '') continue;
        const held = dependencies.find((one) => one.file === path && one.name === name);
        if (held === undefined) missing.push(`${item.id}: ${path} declares no ${name}`);
      }
    }
    expect(missing).toEqual([]);
    // The versions the key names are the versions the graph holds.
    expect(dependencies.filter((one) => one.file === 'services/payments/package.json' && one.name === 'lodash').map((one) => one.version)).toEqual(['4.17.15']);
    expect(dependencies.filter((one) => one.file === 'services/orders/go.mod' && one.name === 'github.com/lib/pq').map((one) => one.version)).toEqual(['v1.10.9']);
  }, 900_000);

  test('the deploy units the key names stand: every compose service and every Dockerfile the repository holds', async () => {
    const key = JSON.parse(readFileSync(KEY, 'utf8')) as { readonly items: readonly KeyItem[] };
    const compose = key.items.find((item) => item.id === 'deploy.compose');
    expect(compose).toBeDefined();
    const services = placesOf(compose!)
      .map((place) => (place.anchor ?? '').trim().replace(/:$/u, '').trim())
      .filter((name) => name !== '');
    expect(services.length).toBeGreaterThan(0);
    const held = deployUnits.filter((unit) => unit.path === 'docker-compose.yml').map((unit) => unit.name.split(':').at(-1) ?? '');
    for (const service of services) expect(held).toContain(service);
    // And every Dockerfile the tree holds is a deploy unit of its own path.
    const dockerfiles = key.items.find((item) => item.id === 'deploy.dockerfiles');
    expect(dockerfiles).toBeDefined();
    for (const place of placesOf(dockerfiles!)) {
      if (place.path === undefined) continue;
      expect(deployUnits.filter((unit) => unit.path === place.path).length).toBeGreaterThan(0);
    }
  }, 900_000);


describe('the answer key\'s document, module and history items, read from the graph', () => {
  test('every document the key names stands with its sections, and the anchors it names are section anchors', async () => {
    const key = JSON.parse(readFileSync(KEY, 'utf8')) as { readonly items: readonly KeyItem[] };
    const wanted = key.items.filter((item) => item.id.startsWith('doc.') || item.id.startsWith('docs.'));
    expect(wanted.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const item of wanted) {
      for (const place of placesOf(item)) {
        const path = place.path;
        if (path === undefined || !path.endsWith('.md')) continue;
        const document = documents.find((one) => one.path === path);
        if (document === undefined) { missing.push(`${item.id}: no document at ${path}`); continue; }
        if (document.title.trim() === '') missing.push(`${item.id}: the document at ${path} carries no title`);
      }
    }
    expect(missing).toEqual([]);
    // Every document the key names opens at least one section, and its title is a heading a
    // reader of the page sees.
    for (const path of ['docs/vision.md', 'docs/requirements.md', 'docs/glossary.md', 'docs/adr/0001-broker.md', 'docs/adr/0002-outbox.md']) {
      const document = documents.find((one) => one.path === path)!;
      expect(document.anchors.length).toBeGreaterThan(0);
    }
  }, 900_000);

  test('every file the module items group stands in one module, and the modules cover the repository', async () => {
    const key = JSON.parse(readFileSync(KEY, 'utf8')) as { readonly items: readonly KeyItem[] };
    const wanted = key.items.filter((item) => item.id.startsWith('modules.'));
    expect(wanted.length).toBeGreaterThan(0);
    expect(modules.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const item of wanted) {
      for (const place of placesOf(item)) {
        const path = place.path;
        if (path === undefined) continue;
        if (!modules.some((module) => module.members.includes(path))) missing.push(`${item.id}: ${path} stands in no module`);
      }
    }
    expect(missing).toEqual([]);
  }, 900_000);

  test('the repository\'s commits stand with their parents and the task keys their messages name', async () => {
    const key = JSON.parse(readFileSync(KEY, 'utf8')) as { readonly plantedCounts: { readonly commits: number; readonly mergeCommits: number } };
    expect(commits).toHaveLength(key.plantedCounts.commits);
    expect(commits.filter((commit) => commit.parents.length === 2)).toHaveLength(key.plantedCounts.mergeCommits);
    // The training repository's messages name their tracker keys in their subjects (`ORD-12 add
    // order lifecycle`) and carry no `Task:` line, so the history stage writes no `code.task`
    // node for it — and the keys the messages do name are in the subjects it read.
    expect(tasks).toEqual([]);
    expect(commits.filter((commit) => /^[A-Z]+-\d+ /u.test(commit.subject)).length).toBeGreaterThan(0);
  }, 900_000);
});

  test('a second fill of the same commit writes nothing', async () => {
    expect({ state: second?.state, settled: second?.settled }).toEqual({ state: 'succeeded', settled: true });
    const units = second?.units ?? [];
    const reused = second?.reused ?? [];
    expect(units.filter((unit) => !reused.includes(unit.unitId)).map((unit) => unit.unitId)).toEqual([]);
    expect(await counts()).toEqual(versions);
  }, 900_000);
});
