/**
 * The packet one agent unit is told before it reads (madarch-tzte.22.3; decision
 * 0026, "Agent input"): a fixed part — the role, the rules, the limits, the answer
 * shape with an example, and the tools — and a per-unit part assembled from the
 * graph without an agent: the scope and its place, its members ranked and without
 * bodies, the edges that reach it, its data and entry points, the product's history,
 * the intent so far, the open questions, the coverage earlier stages recorded and the
 * drafts other units hold. At most 0026's 20K tokens, and no file content pasted.
 *
 * Every expectation is taken from the task and the decision: 0026's numbers (272000,
 * 70%, 80%, ~30 turns, ~10 minutes, 16000 output tokens, 20K packet, ~200-line spans,
 * an 8K tool answer), the ten tool names of 0026's "Agents and tools", the code point
 * orders, and the answer contract the decision asks for. The graph is one this test
 * publishes through the store's own sink, and the file's bytes are ones this test
 * writes to disk — so "no file content pasted" is a claim this test can falsify.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFactStoreSchema, applyPublishedFacts } from '../src/fill/fact-store.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { createFactGraphReader } from '../src/fill/graph-reads.js';
import {
  buildUnitPacket,
  unitFixedPart,
  MEMBER_ESTIMATE_TOKENS,
  PACKET_SECTIONS,
  PACKET_TOKENS,
  pathOfNode,
  placeText,
  plannedTokens,
  PLANNED_FRACTION,
} from '../src/fill/agent-packet.js';
import { createOrchestratorSchema } from '../src/fill/orchestrator-store.js';
import { createGitSnapshotSource, type RepositoryPin, type SnapshotSource } from '../src/fill/snapshot.js';
import { createFillStateSchema, createUnit, readUnit } from '../src/fill/state-store.js';
import { DEFAULT_STAGE_LIMITS, type StageGraphReader } from '../src/fill/stage.js';
import { UNIT_TOOL_NAMES } from '../src/fill/unit-tools.js';

const NOW = 1_700_000_000_000;
const REPOSITORY = 'acme-shop';
const FOLDER = 'src';
const FILES = ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'];
/** The string that stands in the file's bytes and must never reach the prompt: 0026 says no file content is pasted. */
const SECRET_BODY = 'const secretBodyOfAlpha = "the-order-total-comes-from-the-cart";';
const BIG_REPOSITORY = 'big-repo';
const BIG_FILES = 400;

let root: string | undefined;
let COMMIT = 'a'.repeat(40);
let world: World | undefined;

/** One provenance: a fact read out of a file of the fixture repository at the pinned commit. */
function provenance(file: string, line: number): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: REPOSITORY, commit: COMMIT },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

function fileFact(repository: string, path: string, line = 1): Fact {
  return makeNodeFact({
    kind: 'file',
    value: { repository, path: repositoryPath(path), roles: ['source'], language: 'typescript', bytes: 40, blob: 'b'.repeat(40) },
    provenance: repository === REPOSITORY ? provenance(path, line) : factProvenance(repository, path, line),
    layer: 'extracted',
  });
}

function factProvenance(repository: string, path: string, line: number, commit = COMMIT): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: repository, commit },
    place: { file: repositoryPath(path), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 10 } },
  };
}

/** The graph the packet is built over: a repository, a folder of three files with their entry points, symbols, claims, coverage, questions and commits. */
interface Fixture {
  readonly repository: Fact;
  readonly folder: Fact;
  readonly files: readonly Fact[];
  readonly symbols: readonly Fact[];
  readonly entry: Fact;
  readonly claim: Fact;
  readonly question: Fact;
  readonly coverage: Fact;
  readonly commits: readonly Fact[];
  readonly bigRepository: Fact;
  readonly bigFolder: Fact;
  readonly bigFiles: readonly Fact[];
  facts(): readonly Fact[];
}

function fixture(): Fixture {
  const repository = makeNodeFact({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: provenance('README.md', 1), layer: 'extracted' });
  const folder = makeNodeFact({ kind: 'directory', value: { repository: REPOSITORY, path: repositoryPath(FOLDER) }, provenance: provenance('README.md', 1), layer: 'extracted' });
  const files = FILES.map((path, index) => fileFact(REPOSITORY, path, index + 1));
  const symbols = files.map((file, index) => makeNodeFact({
    kind: 'symbol',
    value: { repository: REPOSITORY, file: repositoryPath(FILES[index]!), qualifiedName: `OrderService.${FILES[index]!.split('/')[1]!.replace('.ts', '')}`, symbolKind: 'function' },
    provenance: provenance(FILES[index]!, 3),
    layer: 'extracted',
  }));
  const entry = makeNodeFact({ kind: 'entry-point', value: { repository: REPOSITORY, file: repositoryPath(FILES[0]!), name: 'madarch serve', form: 'cli-command' }, provenance: provenance(FILES[0]!, 5), layer: 'extracted' });
  const claim = makeNodeFact({
    kind: 'claim',
    value: { subject: { form: 'node', id: folder.id }, predicate: 'holds-the-checkout', object: { form: 'literal', text: 'the checkout' }, text: 'The checkout lives in src' },
    provenance: provenance(FILES[0]!, 6),
    layer: 'inferred',
  });
  const question = makeNodeFact({
    kind: 'question',
    value: { repository: REPOSITORY, type: 'assumption-check', about: folder.id, prompt: 'Does the checkout own the tax rule?' },
    provenance: provenance(FILES[0]!, 7),
    layer: 'inferred',
  });
  const coverage = makeNodeFact({
    kind: 'coverage',
    value: { repository: REPOSITORY, scope: folder.id, complete: false, read: ['src/alpha.ts'], unread: [{ what: 'src/beta.ts', reason: 'too-large' }] },
    provenance: provenance(FILES[0]!, 1),
    layer: 'extracted',
  });
  const commits = [
    makeNodeFact({ kind: 'commit', value: { repository: REPOSITORY, commit: COMMIT, committedAt: '2026-10-01T10:00:00Z', authoredAt: '2026-10-01T09:00:00Z', subject: 'Add the checkout total', parents: [], files: [repositoryPath('src/alpha.ts')] }, provenance: provenance(FILES[0]!, 1), layer: 'extracted' }),
    // A commit fact is read at the commit it is about, which the schema checks exactly: this one cites its own.
    makeNodeFact({ kind: 'commit', value: { repository: REPOSITORY, commit: 'c'.repeat(40), committedAt: '2026-10-02T10:00:00Z', authoredAt: '2026-10-02T09:00:00Z', subject: 'Split the cart from the order', parents: [COMMIT], files: [repositoryPath('src/beta.ts')] }, provenance: factProvenance(REPOSITORY, FILES[1]!, 1, 'c'.repeat(40)), layer: 'extracted' }),
  ];
  const bigRepository = makeNodeFact({ kind: 'repository', value: { repository: BIG_REPOSITORY, form: 'code' }, provenance: { source: { system: 'tree-sitter', version: '1.0.0' }, repository: { id: BIG_REPOSITORY, commit: COMMIT } }, layer: 'extracted' });
  const bigFolder = makeNodeFact({ kind: 'directory', value: { repository: BIG_REPOSITORY, path: repositoryPath(FOLDER) }, provenance: { source: { system: 'tree-sitter', version: '1.0.0' }, repository: { id: BIG_REPOSITORY, commit: COMMIT } }, layer: 'extracted' });
  const bigFiles = Array.from({ length: BIG_FILES }, (_unused, index) => fileFact(BIG_REPOSITORY, `src/file${String(index).padStart(4, '0')}.ts`));
  const graph: Fixture = {
    repository, folder, files, symbols, entry, claim, question, coverage, commits, bigRepository, bigFolder, bigFiles,
    facts: () => [
      repository, folder, ...files, ...symbols, entry, claim, question, coverage, ...commits,
      bigRepository, bigFolder, ...bigFiles,
      ...files.map((file) => makeEdgeFact({ kind: 'contains', value: { from: folder.id, to: file.id }, provenance: provenance(FOLDER, 1), layer: 'extracted' })),
      ...symbols.map((symbol, index) => makeEdgeFact({ kind: 'defines', value: { from: files[index]!.id, to: symbol.id }, provenance: provenance(FILES[index]!, 3), layer: 'extracted' })),
      makeEdgeFact({ kind: 'contains', value: { from: repository.id, to: folder.id }, provenance: provenance('README.md', 1), layer: 'extracted' }),
      makeEdgeFact({ kind: 'call', value: { from: symbols[1]!.id, to: symbols[0]!.id, count: 2, precision: 'syntactic' }, provenance: provenance(FILES[1]!, 4), layer: 'extracted' }),
      makeEdgeFact({ kind: 'defines', value: { from: folder.id, to: entry.id }, provenance: provenance(FILES[0]!, 5), layer: 'extracted' }),
      makeEdgeFact({ kind: 'contains', value: { from: bigRepository.id, to: bigFolder.id }, provenance: { source: { system: 'tree-sitter', version: '1.0.0' }, repository: { id: BIG_REPOSITORY, commit: COMMIT } }, layer: 'extracted' }),
      ...bigFiles.map((file) => makeEdgeFact({ kind: 'contains', value: { from: bigFolder.id, to: file.id }, provenance: { source: { system: 'tree-sitter', version: '1.0.0' }, repository: { id: BIG_REPOSITORY, commit: COMMIT } }, layer: 'extracted' })),
    ],
  };
  return graph;
}

/** One world: the process's owner with the fill's tables, the fixture graph published, and a reader over it. */
interface World {
  readonly owner: DatabaseOwner;
  readonly graph: Fixture;
  readonly snapshot: SnapshotSource;
  /** The reader the packet reads through, with every read it makes recorded in the list this returns. */
  reader(recorded: string[]): StageGraphReader;
  close(): Promise<void>;
}

async function openWorld(): Promise<World> {
  const owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
  const graph = fixture();
  await createUnit(owner, { unitId: 'graph/all', product: 'fixture-product', runId: 'run-seed', stageId: 'graph', scopeKey: 'all', inputsDigest: 'graph-inputs', retries: 0, at: NOW });
  const record = await readUnit(owner, 'graph/all');
  if (record === null) throw new Error('the fixture unit was not created');
  await owner.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: record,
    plan: { unitId: 'graph/all', generation: record.generation, runId: 'run-seed', stageId: 'graph', stageUnitId: 'all', scope: 'all', stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: 'graph-publication-1',
    writes: graph.facts().map((fact) => ({ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMIT}`, value: fact })),
  }));
  const pins: readonly RepositoryPin[] = [{ id: REPOSITORY, form: 'code', root: join(root!, 'acme-shop'), commit: COMMIT }];
  const snapshot = createGitSnapshotSource(() => pins);
  return {
    owner,
    graph,
    snapshot,
    reader: (recorded) => ({
      async query(text: string) {
        recorded.push(text);
        return await createFactGraphReader({ database: owner, snapshot }).query(text);
      },
    }),
    close: async () => { await owner.close(); },
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-agent-packet-'));
  const checkout = join(root, 'acme-shop');
  mkdirSync(join(checkout, FOLDER), { recursive: true });
  writeFileSync(join(checkout, FILES[0]!), `${SECRET_BODY}\n`);
  writeFileSync(join(checkout, FILES[1]!), 'export const beta = 2;\n');
  writeFileSync(join(checkout, FILES[2]!), 'export const gamma = 3;\n');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'one');
  COMMIT = git('rev-parse', 'HEAD').trim();
  world = await openWorld();
}, 120_000);

afterAll(async () => {
  await world?.close();
  world = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function opened(): World {
  if (world === undefined) throw new Error('the suite\'s world was not opened');
  return world;
}

/** One packet over the fixture's folder, with its reads recorded. */
async function build(overrides: Partial<Parameters<typeof buildUnitPacket>[0]> = {}): Promise<{ packet: Awaited<ReturnType<typeof buildUnitPacket>>; recorded: string[] }> {
  const observed = opened();
  const recorded: string[] = [];
  const packet = await buildUnitPacket({
    unit: { id: observed.graph.folder.id, scope: placeText(REPOSITORY, FOLDER) },
    scopeId: observed.graph.folder.id,
    repository: REPOSITORY,
    path: FOLDER,
    commit: COMMIT,
    graph: observed.reader(recorded),
    limits: DEFAULT_STAGE_LIMITS,
    kinds: ['claim', 'coverage', 'question', 'rule'],
    task: 'Understand the checkout folder and write what you establish.',
    ...overrides,
  });
  return { packet, recorded };
}

describe('the fixed part every unit is told', () => {
  test('names the role, 0026\'s limits with their numbers, the answer shape with its example and the ten tools', () => {
    const fixed = unitFixedPart({ limits: DEFAULT_STAGE_LIMITS, kinds: ['claim', 'coverage', 'question', 'rule'] });
    expect(fixed).toContain('You are one unit of madarch\'s fill');
    // 0026's numbers, as the task and the decision state them.
    expect(fixed).toContain('a 272000-token context window');
    expect(fixed).toContain('a wrap-up message at 70% (190400 tokens)');
    expect(fixed).toContain('a hard stop at 80% (217600 tokens)');
    expect(fixed).toContain('at 30 turns');
    expect(fixed).toContain('at 600 seconds');
    expect(fixed).toContain('at 16000 output tokens');
    expect(fixed).toContain('about 200 lines at a time');
    expect(fixed).toContain('at most 8000 tokens');
    // The answer contract, with the example 0026 asks for.
    expect(fixed).toContain('{"status":"done"|"partial","covered":["<path inside your scope>"],"remaining":["<path inside your scope>"],"summary":"<one sentence>"}');
    expect(fixed).toContain('Example: {"status":"done","covered":["src/order.ts","src/cart.ts"],"remaining":[],"summary":"The checkout total is the cart total plus tax"}');
    // Every tool of 0026's catalogue, by name, and the kinds this unit may write.
    for (const name of UNIT_TOOL_NAMES) expect(fixed).toContain(`- ${name}: `);
    expect(fixed).toContain('Facts this unit may write: claim, coverage, question, rule.');
    // 0026: "The agent's own file tools are off".
    expect(fixed).toContain('You have no file, shell, network or terminal tools');
    // A narrower window a product configured is told to the unit as it stands.
    const narrow = unitFixedPart({ limits: { ...DEFAULT_STAGE_LIMITS, contextTokens: 100_000, maxTurns: 5 }, kinds: ['claim'] });
    expect(narrow).toContain('a 100000-token context window');
    expect(narrow).toContain('a wrap-up message at 70% (70000 tokens)');
    expect(narrow).toContain('a hard stop at 80% (80000 tokens)');
    expect(narrow).toContain('at 5 turns');
  });
});

describe('the per-unit packet, assembled from the graph', () => {
  test('holds the scope and its place, its members ranked without bodies, and every section it reads', async () => {
    const { packet } = await build();
    expect(packet.sections).toEqual([...PACKET_SECTIONS]);
    const parsed = JSON.parse(packet.packet) as Record<string, unknown>;
    function section<T>(name: string): T { return parsed[name] as T; }
    // The unit, its scope and the place the run pinned: 0026's "scope, place … the task".
    expect(section<Record<string, unknown>>('unit')).toEqual({ id: opened().graph.folder.id, scope: 'acme-shop:src', task: 'Understand the checkout folder and write what you establish.' });
    expect(section<Record<string, unknown>>('place')).toEqual({ repository: REPOSITORY, path: 'src', commit: COMMIT, scope: 'acme-shop:src' });
    // The scope's own node, what it holds by kind, and the edges that touch it by kind and direction.
    expect(section<Record<string, unknown>>('scope')).toMatchObject({ kind: 'directory', label: `${REPOSITORY}:src/`, id: opened().graph.folder.id });
    expect(section<Record<string, unknown>>('scope')).toMatchObject({ holds: [{ kind: 'entry-point', count: 1 }, { kind: 'file', count: 3 }] });
    // Every edge that names the scope: the repository contains it, it contains its three files, and it defines the
    // entry point — counted by kind and direction, in code point order of the kind then the direction.
    expect(section<Record<string, unknown>>('scope')).toMatchObject({ edges: [
      { kind: 'contains', direction: 'in', count: 1 },
      { kind: 'contains', direction: 'out', count: 3 },
      { kind: 'defines', direction: 'out', count: 1 },
    ] });
    // The members, ranked and without bodies: 0026's "ranked symbols without bodies, entry points" — the entry point
    // the folder defines first, then the three files it contains, each with the path it stands at.
    const members = section<{ kind: string; label: string; file?: string; line?: number; place?: string }[]>('members');
    expect(members.map((member) => member.kind)).toEqual(['entry-point', 'file', 'file', 'file']);
    expect(members.map((member) => member.file)).toEqual(['src/alpha.ts', 'src/alpha.ts', 'src/beta.ts', 'src/gamma.ts']);
    expect(members.map((member) => member.place)).toEqual(['acme-shop:src/alpha.ts', 'acme-shop:src/alpha.ts', 'acme-shop:src/beta.ts', 'acme-shop:src/gamma.ts']);
    // No body of any member is in it: a member is its kind, its label, its id and where it stands, never its code.
    expect(JSON.stringify(members)).not.toContain('secretBodyOfAlpha');
    // The entry points and tests the scope holds, and the data nodes it holds, as the members' own kinds name them.
    expect(section<{ label: string }[]>('entryPoints').map((row) => row.label)).toEqual(['madarch serve']);
    expect(section<unknown[]>('data')).toEqual([]);
    // The relation kinds reaching the scope: a placement edge (`contains`, `defines`) is no relation, which is what
    // the scope's own edge counts above hold instead.
    expect(section<unknown[]>('relations')).toEqual([]);
    // 0026's "history": the product's commits, newest first, from the graph's own facts.
    expect(section<{ subject: string }[]>('history').map((row) => row.subject)).toEqual(['Split the cart from the order', 'Add the checkout total']);
    // The kinds this unit may write, in code point order.
    expect(section<Record<string, unknown>>('writes')).toMatchObject({ kinds: ['claim', 'coverage', 'question', 'rule'] });
    // Nothing was cut and nothing is missing: a packet whose lists were cut says so in its own marker.
    expect(packet.marker).toBeNull();
    expect(packet.tokens).toBeLessThanOrEqual(PACKET_TOKENS);
  });

  test('reads no kind an agent unit itself writes: a unit\'s own publication never moves its own packet\'s reads', async () => {
    const { recorded } = await build();
    const requests = recorded.map((text) => JSON.parse(text) as Record<string, unknown>);
    // 0027 rechecks every recorded read after the unit publishes, so the packet reads only what the deterministic
    // stages publish: the scope's node, what it holds, the edges that touch it, its members, its relations and the
    // product's history — never a claim, a coverage, a question, a rule, a state or an entity.
    const agentKinds = ['claim', 'coverage', 'question', 'rule', 'state', 'entity-proposal'];
    for (const request of requests) {
      if (request['read'] === 'facts-with') expect(agentKinds).not.toContain(request['kind']);
      // The reads that name edge kinds are the members read (`contains`, `defines`) and the relations read (the
      // schema's relation kinds): every one of them an edge kind this unit does not write, since its declared kinds
      // are node kinds. A read that named none of them would be the scope's own edge counts.
    }
    expect(requests.filter((request) => request['read'] === 'facts-with').map((request) => request['kind'])).toEqual(['commit']);
    expect([...new Set(requests.map((request) => String(request['read'])))].sort()).toEqual(['adjacent', 'fact', 'facts', 'facts-with', 'held']);
  });

  test('no file content is pasted: the bytes of a member never reach the prompt', async () => {
    const { packet } = await build();
    // 0026: "No file content is pasted." The bytes stand in the checkout and in no read this packet makes.
    expect(packet.prompt).not.toContain(SECRET_BODY);
    expect(packet.prompt).not.toContain('the-order-total-comes-from-the-cart');
    // The reads the packet makes are the graph's own: no span read carries a line of any file.
    const readKinds = (await build()).recorded.map((text) => (JSON.parse(text) as { read: string }).read);
    expect(readKinds).not.toContain('span');
    expect([...new Set(readKinds)].sort()).toEqual(['adjacent', 'fact', 'facts', 'facts-with', 'held']);
  });

  test('every read the packet makes is recorded as the unit\'s dependency', async () => {
    const { recorded } = await build();
    // Four reads of the scope's own shape, two of its members and neighbourhood, two of what the graph already says,
    // and two of the product's history and questions: each text is the reader's own, so the orchestrator records it.
    expect(recorded.length).toBeGreaterThanOrEqual(7);
    const requests = recorded.map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(requests.every((request) => typeof request['read'] === 'string')).toBe(true);
    // The packet reads one kind of fact by a value field: the product's commits. The intent, the open questions and
    // the coverage about the scope are the unit's own to read through its tools, and its publication never moves
    // this packet's reads.
    expect(requests.filter((request) => request['read'] === 'facts-with').map((request) => request['kind'])).toEqual(['commit']);
  });

  test('the same graph gives the same prompt, twice', async () => {
    const first = await build();
    const second = await build();
    expect(second.packet.prompt).toBe(first.packet.prompt);
    expect(second.packet.tokens).toBe(first.packet.tokens);
  });

  test('0026\'s 20K cap holds a big scope, and every list it cut is named', async () => {
    const observed = opened();
    const recorded: string[] = [];
    const packet = await buildUnitPacket({
      unit: { id: observed.graph.bigFolder.id, scope: placeText(BIG_REPOSITORY, FOLDER) },
      scopeId: observed.graph.bigFolder.id,
      repository: BIG_REPOSITORY,
      path: FOLDER,
      commit: COMMIT,
      graph: observed.reader(recorded),
      limits: DEFAULT_STAGE_LIMITS,
      kinds: ['claim', 'coverage'],
      task: 'Understand the big folder.',
    });
    expect(packet.tokens).toBeLessThanOrEqual(PACKET_TOKENS);
    expect(packet.marker).not.toBeNull();
    // The cut is named, with what was cut and by which cap: 0026's 20000-token starting packet.
    // The cut is named wherever it happened: 0026's 8K-token answer cap cuts the members read itself, and the
    // packet's own 20000-token cap cuts a list that does not fit — both say what they cut and by which cap.
    expect(String(packet.marker)).toContain(`${BIG_FILES} rows`);
    expect(String(packet.marker)).toMatch(/the (packet's 20000-token cap|answer's 8000-token cap)/);
    expect(String(packet.marker)).toMatch(/rows were cut|row was cut/);
    const parsed = JSON.parse(packet.packet) as { members: unknown[] };
    expect(parsed.members.length).toBeLessThan(BIG_FILES);
    expect(parsed.members.length).toBeGreaterThan(0);
  });

  test('the plan\'s numbers are 0026\'s: ~50% of the window, and about one bounded span a member', () => {
    expect(PLANNED_FRACTION).toBe(0.5);
    expect(plannedTokens(DEFAULT_STAGE_LIMITS)).toBe(136_000);
    // 0026 bounds an evidence span at about 200 lines, which is the estimate one member costs.
    expect(MEMBER_ESTIMATE_TOKENS).toBe(2_000);
  });
});

describe('the places a member stands at', () => {
  test('a folder\'s label spells its path with a slash, a file\'s without one, and a module names none', () => {
    expect(pathOfNode({ kind: 'directory', label: 'acme-shop:src/' })).toBe('src');
    expect(pathOfNode({ kind: 'file', label: 'acme-shop:src/alpha.ts' })).toBe('src/alpha.ts');
    // A place kind's label is where it stands; its provenance is where its fact was read, which for a folder is a
    // file inside it — so the label wins and the provenance is the fallback.
    expect(pathOfNode({ kind: 'file', label: 'acme-shop:src/alpha.ts', file: 'src/other.ts' })).toBe('src/alpha.ts');
    expect(pathOfNode({ kind: 'file', label: 'alpha.ts', file: 'src/other.ts' })).toBe('src/other.ts');
    // A module's label is its own name (0026's clustering names it inside its parent), and a path a reader reads
    // off it would be a path the node does not stand at.
    expect(pathOfNode({ kind: 'module', label: 'checkout-payment' })).toBeUndefined();
    expect(placeText('acme-shop')).toBe('acme-shop');
    expect(placeText('acme-shop', 'src')).toBe('acme-shop:src');
  });
});
