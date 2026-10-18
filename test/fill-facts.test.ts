import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseContractText } from '../src/product/contract.js';
import { byCodePoint } from '../src/model/order.js';
import { StorageForm } from '../src/product/schema.js';
import {
  AGENT_STAGES,
  FACT_EDGE_KINDS,
  FACT_ID_PATTERN,
  FACT_KINDS,
  FACT_KINDS_IN_ORDER,
  FACT_KIND_NAME_PATTERN,
  FACT_NODE_KINDS,
  FACT_STAGES,
  EDGE_END_KINDS,
  FACTS_SCHEMA_VERSION,
  FactSchemaError,
  REGISTRY_KIND_MAPPINGS,
  REGISTRY_STORAGE_FORMS,
  checkFact,
  factId,
  factKindsForRegistryForm,
  isFactKind,
  isRepositoryPath,
  makeEdgeFact,
  makeNodeFact,
  repositoryPath,
  repositoryPathIn,
  statusesOfLayer,
} from '../src/fill/facts.js';
import type { Fact, FactKind, FactLayer, FactProvenance, FactStatus, FactValueOf, RepositoryPath } from '../src/fill/facts.js';

/**
 * The code-fact schema's own conformance tests. Every expected value here is
 * taken from the decisions the schema grounds — 0004's atoms, 0005's layers
 * and statuses, 0026's stages and bounded units, 0027's kind versions, 0021's
 * registry storage forms — and none is copied from the module under test: the
 * kinds the DONE WHEN of madarch-tzte.20.1 names are written out here as the
 * task names them, so a kind dropped from the schema fails a test that never
 * read the schema's own list.
 */

/** The commit every sample fact was read at: 40 lower-case hexadecimal digits. */
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** A second commit, for the tests that move the commit and expect no id to move. */
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

/** Two checkouts of one repository, on two machines: only what lies between the paths may reach an id. */
const CHECKOUT_HERE = '/opt/madarch-checkout';
const CHECKOUT_ELSEWHERE = '/srv/ci/workspace/checkout';

/** The repository every sample is about, by the product's own name for it (0021). */
const REPOSITORY = 'orders-api';

/** A well-formed fact id of a node the samples point at, when the node itself is not what is under test. */
function anyId(kind: 'file' | 'symbol' | 'state' | 'commit' | 'document' | 'api-endpoint' | 'deploy-unit'): string {
  return `${kind}:${'0123456789abcdef'.repeat(4)}`;
}

/** The field of a kind's value that names the file the fact itself stands at, where the kind stands at its own file. */
const SELF_PLACE_FIELD: Readonly<Record<string, string>> = { 'deploy-unit': 'manifest', 'document': 'path', 'entry-point': 'file', 'file': 'path', 'package': 'manifest', 'section': 'document', 'symbol': 'file', 'test': 'file' };

/** The place a sample of the kind stands at: its own file where the kind has one, `src/order.ts` otherwise. */
function placePathOf(kind: FactKind): RepositoryPath {
  const field = SELF_PLACE_FIELD[kind];
  if (field === undefined) return repositoryPath('src/order.ts');
  return (SAMPLES[kind] as unknown as Record<string, unknown>)[field] as RepositoryPath;
}

/** The provenance every sample carries: a place at the fact's own file, lines 3 to 7. */
function provenanceOf(file: RepositoryPath = repositoryPath('src/order.ts'), commit = COMMIT): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '0.25.10' },
    repository: { id: REPOSITORY, commit },
    place: { file, range: { startLine: 3, startColumn: 0, endLine: 7, endColumn: 1 } },
  };
}

/**
 * One sample value per kind: the smallest value each kind's own reader would
 * write. A literal union is not checkable here (a member may be left out of a
 * `Record<FactKind, …>` and the table still type-checks only through the
 * schema's own map), so `SAMPLES` is keyed by the schema's kind list and a
 * test below asserts every kind of that list has one.
 */
const SAMPLES: { readonly [K in FactKind]: FactValueOf<K> } = {
  'snapshot': { repository: REPOSITORY, commit: COMMIT, tree: 'abcdef0123456789abcdef0123456789abcdef01', fileCount: 128, byteCount: 40960 },
  'repository': { repository: REPOSITORY, form: 'code', defaultBranch: 'main' },
  'directory': { repository: REPOSITORY, path: repositoryPath('src') },
  'file': { repository: REPOSITORY, path: repositoryPath('src/order.ts'), roles: ['source'], language: 'typescript', bytes: 512 },
  'package': { repository: REPOSITORY, name: '@acme/orders', form: 'package', ecosystem: 'npm', version: '1.4.0', manifest: repositoryPath('package.json') },
  'deploy-unit': { repository: REPOSITORY, name: 'orders-api', form: 'container', manifest: repositoryPath('deploy/Dockerfile') },
  'api-endpoint': { contract: 'http::GET::/api/orders/{}', framework: 'express' },
  'table': { repository: REPOSITORY, name: 'public.orders', engine: 'postgres' },
  'column': { repository: REPOSITORY, table: 'public.orders', name: 'total', dataType: 'numeric(12,2)' },
  'environment-variable': { name: 'ORDERS_TOPIC' },
  'symbol': { repository: REPOSITORY, file: repositoryPath('src/order.ts'), qualifiedName: 'OrderService.create', symbolKind: 'method', scipKind: 'StaticMethod', displayName: 'create', signature: 'create(order: Order): Promise<void>' },
  'occurrence': { symbol: anyId('symbol'), roles: ['definition', 'write-access'] },
  'entry-point': { repository: REPOSITORY, file: repositoryPath('src/main.ts'), name: 'GET /api/orders', form: 'http-route' },
  'comment': { text: 'An order is placed once the card is authorized.', form: 'block' },
  'test': { repository: REPOSITORY, file: repositoryPath('test/order.test.ts'), name: 'places an order', framework: 'bun', covers: [anyId('symbol')] },
  'module': { repository: REPOSITORY, name: 'checkout-payment', seed: 'cluster', members: 12, importance: 0.42 },
  'document': { repository: REPOSITORY, path: repositoryPath('docs/requirements/orders.md'), mediaType: 'text/markdown', title: 'Orders' },
  'section': { repository: REPOSITORY, document: repositoryPath('docs/requirements/orders.md'), anchor: 'placing-an-order', heading: 'Placing an order', level: 2 },
  'commit': { repository: REPOSITORY, commit: COMMIT, committedAt: '2026-10-18T09:15:00Z', authoredAt: '2026-10-18T08:40:00Z', subject: 'Place an order', author: 'Example Author', parents: [OTHER_COMMIT], files: [repositoryPath('src/order.ts'), repositoryPath('test/order.test.ts')] },
  'claim': { subject: { form: 'node', id: anyId('symbol') }, predicate: 'is-implemented-by', object: { form: 'literal', text: 'the order service' }, text: 'Orders are placed by the order service.', confidence: 0.7 },
  'entity-proposal': { repository: REPOSITORY, proposed: 'concept', name: 'Order', summary: 'What a customer buys.', aliases: ['purchase'] },
  'rule': { statement: 'An order is placed once its card is authorized.', subject: anyId('symbol'), form: 'invariant' },
  'state': { repository: REPOSITORY, machine: 'OrderStatus', name: 'placed', initial: true },
  'coverage': { repository: REPOSITORY, scope: 'module:checkout-payment', complete: false, read: ['src/order.ts', 'src/payment.ts'], unread: [{ what: 'src/legacy.js', reason: 'unsupported' }] },
  'question': { repository: REPOSITORY, type: 'assumption-check', about: anyId('symbol'), prompt: 'Is an order placed at authorization or at capture?' },
  'contains': { from: anyId('file'), to: anyId('symbol') },
  'defines': { from: anyId('file'), to: anyId('symbol') },
  'import': { from: anyId('file'), to: anyId('file'), specifier: '../model/order.js' },
  'dependency': { from: anyId('file'), to: anyId('file'), basis: 'manifest' },
  'call': { from: anyId('symbol'), to: anyId('symbol'), count: 3 },
  'reference': { from: anyId('symbol'), to: anyId('symbol'), count: 2 },
  'inherits': { from: anyId('symbol'), to: anyId('symbol'), form: 'implements' },
  'provides': { from: anyId('deploy-unit'), contract: 'topic::order-placed' },
  'consumes': { from: anyId('symbol'), variable: 'environment-variable:' + '0'.repeat(64) },
  'binds': { variable: 'environment-variable:' + '0'.repeat(64), environment: 'production', value: { form: 'digest', sha256: 'a'.repeat(64) } },
  'resolves': { from: anyId('api-endpoint'), to: anyId('deploy-unit') },
  'document-link': { from: anyId('document'), to: { form: 'external', url: 'https://example.com/orders' } },
  'task-key': { from: anyId('commit'), key: 'madarch-tzte.20.1' },
  'transition': { from: 'state:' + '1'.repeat(64), to: 'state:' + '2'.repeat(64), event: 'payment-authorized' },
  'interaction': { caller: anyId('symbol'), callee: anyId('deploy-unit'), form: 'http', via: 'POST /api/orders' },
};

/**
 * The layers each kind is written in, taken from decisions 0026 and 0005: a
 * deterministic stage (0 to 7) writes what a tool extracted, an agent stage
 * (8 to 13) what an agent inferred, a person's own words are `declared`, and
 * `module` and `coverage` are the two kinds both halves write. Read off the
 * decisions, never from the schema's own table.
 */
const EXPECTED_LAYERS: Readonly<Record<FactKind, readonly FactLayer[]>> = {

  // stages 0 to 7 write these, and only those stages
  'snapshot': ['extracted'],
  'repository': ['extracted'],
  'directory': ['extracted'],
  'file': ['extracted'],
  'package': ['extracted'],
  'deploy-unit': ['extracted'],
  'api-endpoint': ['extracted'],
  'table': ['extracted'],
  'column': ['extracted'],
  'environment-variable': ['extracted'],
  'symbol': ['extracted'],
  'occurrence': ['extracted'],
  'entry-point': ['extracted'],
  'comment': ['extracted'],
  'test': ['extracted'],
  'document': ['extracted'],
  'section': ['extracted'],
  'commit': ['extracted'],
  // stage 5 clusters them deterministically, stage 9 refines the boundaries
  'module': ['extracted', 'inferred'],
  // agent stages read these, and only agent stages
  'entity-proposal': ['inferred'],
  'rule': ['inferred'],
  'state': ['inferred'],
  'question': ['inferred'],
  'transition': ['inferred'],
  'interaction': ['inferred'],
  // a claim is an agent's reading, or the product's own words when a
  // person declares it (the "person's declaration" scenario of this change)
  'claim': ['declared', 'inferred'],
  // every stage reports what it read
  'coverage': ['extracted', 'inferred'],
  // the edges of stages 0 to 7
  'contains': ['extracted'],
  'defines': ['extracted'],
  'import': ['extracted'],
  'dependency': ['extracted'],
  'call': ['extracted'],
  'reference': ['extracted'],
  'inherits': ['extracted'],
  'provides': ['extracted'],
  'consumes': ['extracted'],
  'binds': ['extracted'],
  'resolves': ['extracted'],
  'document-link': ['extracted'],
  'task-key': ['extracted'],
};

/** A sample value with the counts a rerun may count another way: the same fact, counted differently. */
function withOtherCounts(kind: FactKind, value: FactValueOf<FactKind>): FactValueOf<FactKind> {
  const varied: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>) };
  for (const field of ['bytes', 'count', 'fileCount', 'members'] as const) {
    if (typeof varied[field] === 'number') varied[field] = (varied[field] as number) + 1;
  }
  expect(Object.keys(varied).length).toBe(Object.keys(value as unknown as Record<string, unknown>).length);
  return varied as unknown as FactValueOf<FactKind>;
}

/** The layer each sample is written in: extracted for the deterministic stages, inferred for the agent ones. */
function layerOf(kind: FactKind): FactLayer {
  const layers = EXPECTED_LAYERS[kind];
  return layers.includes('extracted') ? 'extracted' : (layers[0] as FactLayer);
}

/** The provenance of one sample fact of the kind, at the place the kind stands at. */
function provenanceFor(kind: FactKind, commit = COMMIT): FactProvenance {
  return provenanceOf(placePathOf(kind), commit);
}

/** One sample fact of the kind, through the schema's own constructor. */
function sampleFact(kind: FactKind): Fact {
  const provenance = provenanceFor(kind);
  return FACT_KINDS[kind].shape === 'node'
    ? makeNodeFact({ kind: kind as never, value: SAMPLES[kind] as never, provenance, layer: layerOf(kind) })
    : makeEdgeFact({ kind: kind as never, value: SAMPLES[kind] as never, provenance, layer: layerOf(kind) });
}

/** The identity parts of the sample, as the schema computes them: its value's, then its place's where the place is identity. */
function identityOf(kind: FactKind, provenance: FactProvenance = provenanceFor(kind)): readonly (readonly [string, unknown])[] {
  const definition = FACT_KINDS[kind];
  const parts = [...(definition.identityValue as (value: unknown, read: FactProvenance) => readonly (readonly [string, unknown])[])(SAMPLES[kind], provenance)];
  if (definition.place === 'identity') {
    const place = provenance.place;
    if (place === undefined) throw new Error('the test read the identity of a place-identity kind without a place');
    parts.push(['repository', provenance.repository.id], ['file', place.file], ['range', `${place.range.startLine}:${place.range.startColumn}-${place.range.endLine}:${place.range.endColumn}`]);
  }
  return parts;
}

describe('the kinds the fill writes', () => {
  test('every kind the task names is declared, in the schema own namespace', () => {
    // The kinds madarch-tzte.20.1's DONE WHEN names, in its own words: stages
    // 0–7 first, then the agent stages' kinds. A kind the schema stops
    // declaring fails here even if the module's own list agrees with itself.
    const named: readonly FactKind[] = [
      'snapshot', 'repository', 'directory', 'file', 'package', 'dependency', 'deploy-unit', 'api-endpoint',
      'table', 'column', 'environment-variable', 'symbol', 'occurrence', 'import', 'call', 'reference',
      'entry-point', 'comment', 'test', 'module', 'document', 'section', 'document-link', 'commit', 'task-key',
      'claim', 'entity-proposal', 'rule', 'state', 'transition', 'interaction', 'coverage', 'question',
    ];
    const declared = new Set<string>(FACT_KINDS_IN_ORDER);
    const missing = named.filter((kind) => !declared.has(kind));
    expect(missing).toEqual([]);
  });

  test('the two kind lists are disjoint, the ordered list is each list sorted, and every name is one kebab token', () => {
    expect(FACT_NODE_KINDS.filter((kind) => (FACT_EDGE_KINDS as readonly string[]).includes(kind))).toEqual([]);
    // The schema's one ordered list: the node kinds in code point order, then
    // the edge kinds in code point order (each declared list is grouped by the
    // stages that write it, which is the stages' order and not the alphabet's).
    expect(FACT_KINDS_IN_ORDER).toEqual([...[...FACT_NODE_KINDS].sort(byCodePoint), ...[...FACT_EDGE_KINDS].sort(byCodePoint)]);
    for (const kind of FACT_KINDS_IN_ORDER) {
      expect(FACT_KIND_NAME_PATTERN.test(kind)).toBe(true);
      expect(kind).not.toContain(' ');
      expect(kind).not.toMatch(/[A-Z]/);
    }
    expect(new Set(FACT_KINDS_IN_ORDER).size).toBe(FACT_NODE_KINDS.length + FACT_EDGE_KINDS.length);
  });

  test('a fact kind never takes a registry kind name: the two vocabularies are kept apart', () => {
    // The registry's own reading of a real product registry (0021): its kind
    // names are the product's words ("work item", "capability"), and a fact
    // kind is never one of them.
    const text = readFileSync(join(import.meta.dir, '..', 'examples', 'contract', 'registry-product', 'docs', 'kinds.yaml'), 'utf8');
    const read = parseContractText('docs/kinds.yaml', text);
    if (!read.ok) throw new Error(read.errors.map((error) => `${error.file}:${error.line}: ${error.message}`).join('\n'));
    expect(read.kinds.length).toBeGreaterThan(0);
    const registryNames = new Set(read.kinds.map((kind) => kind.name));
    for (const kind of FACT_KINDS_IN_ORDER) expect(registryNames.has(kind)).toBe(false);
    // And the other way: no registry document id can be read as a fact id,
    // whose shape is the kind, a colon, and 64 lowercase hex digits.
    for (const kind of read.kinds) expect(FACT_ID_PATTERN.test(`${kind.prefix}-1`)).toBe(false);
  });

  test('every kind is declared once in the table, with the shape its own list gave it', () => {
    expect(Object.keys(FACT_KINDS).sort()).toEqual([...FACT_KINDS_IN_ORDER].sort());
    for (const kind of FACT_NODE_KINDS) expect(FACT_KINDS[kind].shape).toBe('node');
    for (const kind of FACT_EDGE_KINDS) expect(FACT_KINDS[kind].shape).toBe('edge');
    for (const kind of FACT_KINDS_IN_ORDER) expect(FACT_KINDS[kind].kind).toBe(kind);
  });

  test('every kind names the stages that write it, in 0026 order, and every stage writes something', () => {
    for (const kind of FACT_KINDS_IN_ORDER) {
      const stages = FACT_KINDS[kind].stages;
      expect(stages.length).toBeGreaterThan(0);
      const indexes = stages.map((stage) => FACT_STAGES.indexOf(stage));
      expect(indexes.every((index) => index >= 0)).toBe(true);
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    }
    // Every stage of 0026 writes at least one kind — no stage is a name with
    // nothing behind it.
    expect(FACT_STAGES.filter((stage) => !FACT_KINDS_IN_ORDER.some((kind) => FACT_KINDS[kind].stages.includes(stage)))).toEqual([]);
  });

  test('the agent kinds are written by agent stages only, and every agent stage is 8 to 13', () => {
    const agentKinds: readonly FactKind[] = ['claim', 'entity-proposal', 'question', 'rule', 'state', 'transition', 'interaction'];
    for (const kind of agentKinds) {
      for (const stage of FACT_KINDS[kind].stages) expect(AGENT_STAGES).toContain(stage);
    }
    expect([...AGENT_STAGES]).toEqual([...FACT_STAGES].filter((stage) => Number(stage.split('-')[0]) >= 8));
    // A coverage is what every stage reports about what it read (0004's
    // coverage, 0026's "a unit at a limit returns what it has with its coverage").
    expect(FACT_KINDS['coverage'].stages).toEqual(FACT_STAGES);
  });

  test('every kind declares the layers a fact of it may be written in, from 0005 four', () => {
    const layers: readonly FactLayer[] = ['declared', 'extracted', 'inferred', 'observed'];
    for (const kind of FACT_KINDS_IN_ORDER) {
      const declared = FACT_KINDS[kind].layers;
      expect(declared.length).toBeGreaterThan(0);
      for (const layer of declared) expect(layers).toContain(layer);
      expect(new Set(declared).size).toBe(declared.length);
      // The fill watches no running system today: nothing it writes is observed.
      expect(declared).not.toContain('observed');
    }
    // The deterministic stages' facts are extracted, never inferred.
    expect(FACT_KINDS['file'].layers).toEqual(['extracted']);
    expect(FACT_KINDS['symbol'].layers).toEqual(['extracted']);
  });

  test('a kind declares the layers its stages obtain it in, and no layer its stages cannot obtain', () => {
    // Decision 0026: stages 0 to 7 are deterministic readers, 8 to 13 are
    // agent stages. Decision 0005: an extracted fact is what a tool found, an
    // inferred one is an agent's interpretation, a declared one is a person's
    // own words. So a kind's layers are read off the stages that write it; the
    // expected list below is taken from the two decisions and never from the
    // schema's own table.
    expect(Object.keys(EXPECTED_LAYERS).sort()).toEqual([...FACT_KINDS_IN_ORDER].sort());
    for (const kind of FACT_KINDS_IN_ORDER) {
      const definition: { readonly stages: readonly string[]; readonly layers: readonly FactLayer[] } = FACT_KINDS[kind];
      const layers: FactLayer[] = [...definition.layers];
      expect(layers.sort()).toEqual([...EXPECTED_LAYERS[kind]]);
      // And the same rule read the other way: a kind that no deterministic
      // stage writes never claims the extracted layer, and a kind that no
      // agent stage writes never claims the inferred one.
      const writtenBy = (stages: readonly string[], agent: boolean): boolean =>
        stages.some((stage) => AGENT_STAGES.includes(stage as never) === agent);
      const deterministic = writtenBy(definition.stages, false);
      const agent = writtenBy(definition.stages, true);
      if (!deterministic) expect(definition.layers).not.toContain('extracted');
      if (!agent) expect(definition.layers).not.toContain('inferred');
      if (deterministic) expect(definition.layers).toContain('extracted');
      if (agent) expect(definition.layers).toContain('inferred');
    }
    // module is the one kind the two decisions place in both halves of the fill.
    expect(FACT_KINDS['module'].stages).toEqual(['5-modules', '9-boundaries']);
    expect(FACT_KINDS['coverage'].stages).toEqual(FACT_STAGES);
    // The one layer no stage of this registry writes: a declared claim is a
    // person's own words (0005), recorded by the acceptance path beside the
    // stages, and it is the sole exception to "a kind's layers are what its
    // stages obtain it in".
    expect(EXPECTED_LAYERS['claim']).toEqual(['declared', 'inferred']);
    expect(FACT_KINDS['claim'].stages.every((stage) => AGENT_STAGES.includes(stage))).toBe(true);
  });

  test('every kind carries its value shape version, and only a moved kind stands past the schema version', () => {
    expect(Number.isInteger(FACTS_SCHEMA_VERSION)).toBe(true);
    // A kind whose value shape changes moves alone: `file` moved to 2 when the
    // blob its bytes stand under was added to it (madarch-tzte.21.1, stage 1),
    // and `document` and `section` to 2 when their byte spans were added to them
    // (madarch-tzte.21.4, stage 6).
    const moved: Readonly<Record<string, number>> = { 'document': 2, 'file': 2, 'section': 2 };
    for (const kind of FACT_KINDS_IN_ORDER) {
      expect(Number.isInteger(FACT_KINDS[kind].version)).toBe(true);
      // 0027: a stage declares the fact kind's version for what it produces,
      // and every kind starts at the schema's own version.
      expect(FACT_KINDS[kind].version).toBe(moved[kind] ?? FACTS_SCHEMA_VERSION);
    }
  });
});

describe('one sample of every kind', () => {
  for (const kind of FACT_KINDS_IN_ORDER) {
    test(`the ${kind} kind is one the schema reads: its own sample passes the check`, () => {
      const fact = sampleFact(kind);
      expect(checkFact(fact)).toEqual([]);
      expect(fact.kind).toBe(kind);
      expect(fact.schemaVersion).toBe(FACT_KINDS[kind].version);
      expect(FACT_ID_PATTERN.test(fact.id)).toBe(true);
      expect(fact.id.startsWith(`${kind}:`)).toBe(true);
      expect(fact.status).toBe('proposed');
    });
  }

  test('every kind has a sample, so no kind is left untested', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...FACT_KINDS_IN_ORDER].sort());
    for (const kind of FACT_KINDS_IN_ORDER) expect(SAMPLES[kind]).toBeDefined();
  });
});

describe('the ancestry one commit fact carries', () => {
  /** The sample commit with the fields a merge gives it: two parents and the paths it changed. */
  const merge = { ...SAMPLES['commit'], parents: [OTHER_COMMIT, COMMIT], files: [repositoryPath('src/order.ts'), repositoryPath('test/order.test.ts')] };

  /** The paths a fact's own check refuses it at, in the order the check names them. */
  function pathsOf(fact: unknown): string[] {
    return checkFact(fact).map((problem) => problem.path);
  }

  /** One commit fact of the value, built with the id its own identity digests to. */
  function commitOf(value: FactValueOf<'commit'>): unknown {
    const provenance = provenanceFor('commit');
    return { ...makeNodeFact({ kind: 'commit', value: merge, provenance, layer: 'extracted' }), value, id: factId({ kind: 'commit', value, provenance }) };
  }

  test('a commit carries its parents in git own order and its changed files in code point order', () => {
    // Decision 0026's stage 7 and the task's DONE WHEN: a commit fact carries
    // the parents of the ancestry and the paths the commit changed. A parent
    // list is git's own order — the first parent first, which is what says
    // which line of history a merge continues — so it is kept as it was read
    // even where code point order would sort it the other way; the changed
    // paths are a set and stand in code point order, each once.
    expect(byCodePoint(COMMIT, OTHER_COMMIT)).toBeLessThan(0);
    const fact = makeNodeFact({ kind: 'commit', value: merge, provenance: provenanceFor('commit'), layer: 'extracted' });
    expect(checkFact(fact)).toEqual([]);
    expect(fact.value.parents).toEqual([OTHER_COMMIT, COMMIT]);
    expect(fact.value.files).toEqual([repositoryPath('src/order.ts'), repositoryPath('test/order.test.ts')]);
  });

  test('a changed path out of code point order, a path named twice and a repeated parent are each refused where they stand', () => {
    const disordered = { ...merge, files: [repositoryPath('test/order.test.ts'), repositoryPath('src/order.ts')] };
    expect(pathsOf(commitOf(disordered))).toEqual(['value.files[1]']);
    const twice = { ...merge, files: [repositoryPath('src/order.ts'), repositoryPath('src/order.ts')] };
    expect(pathsOf(commitOf(twice))).toEqual(['value.files[1]']);
    const repeatedParent = { ...merge, parents: [COMMIT, COMMIT] };
    expect(pathsOf(commitOf(repeatedParent))).toEqual(['value.parents[1]']);
    // And a repeat that does not stand next to its twin is a repeat too: an
    // own-order list still names each entry once, whatever order it is in.
    const apart = { ...merge, parents: [OTHER_COMMIT, COMMIT, OTHER_COMMIT] };
    expect(pathsOf(commitOf(apart))).toEqual(['value.parents[2]']);
  });

  test("the check does not read a value field's own type: a time is the writer's business", () => {
    // The capability's value-types-are-the-writers scenario: the schema reads a
    // value's keys, its paths, its closed forms, its lists and its identity
    // parts, and never the type of a field that is none of those, so a time
    // written as anything at all is left to the write path.
    expect(pathsOf(commitOf({ ...merge, committedAt: 12345 as never, authoredAt: 'yesterday' }))).toEqual([]);
    expect(pathsOf(commitOf({ ...merge, subject: 7 as never }))).toEqual([]);
  });

  test('a machine path and a name that is no commit are each refused where they stand in the list', () => {
    // The schema's own rule 3, for a list: a path is a repository path, and a
    // parent is a commit, whoever wrote the fact.
    expect(pathsOf(commitOf({ ...merge, files: ['/opt/madarch-checkout/src/order.ts'] as never }))).toEqual(['value.files[0]']);
    expect(pathsOf(commitOf({ ...merge, files: ['../src/order.ts'] as never }))).toEqual(['value.files[0]']);
    expect(pathsOf(commitOf({ ...merge, parents: ['HEAD'] }))).toEqual(['value.parents[0]']);
    expect(checkFact(makeNodeFact({ kind: 'commit', value: merge, provenance: provenanceFor('commit'), layer: 'extracted' }))).toEqual([]);
  });

  test('a commit fact is the same fact whatever it changed: the ancestry is its value, never its identity', () => {
    const other = { ...merge, files: [repositoryPath('c.md')], parents: [] };
    expect(factId({ kind: 'commit', value: merge, provenance: provenanceFor('commit') })).toBe(factId({ kind: 'commit', value: other, provenance: provenanceFor('commit') }));
  });
});

describe('ids: content-addressed, stable, and never a run', () => {
  test('the same fact gives the same id twice: nothing in the schema reads a clock or a random source', () => {
    for (const kind of FACT_KINDS_IN_ORDER) {
      const first = sampleFact(kind).id;
      const second = sampleFact(kind).id;
      expect(second).toBe(first);
      expect(factId({ kind, value: SAMPLES[kind], provenance: provenanceFor(kind) } as never)).toBe(first);
    }
  });

  test('an id is the kind and the SHA-256 digest of the identity alone: 64 lower-case hex digits', () => {
    for (const kind of FACT_KINDS_IN_ORDER) {
      const id = sampleFact(kind).id;
      const match = id.match(FACT_ID_PATTERN);
      expect(match).not.toBeNull();
      expect(id.slice(kind.length + 1)).toMatch(/^[0-9a-f]{64}$/);
      // Nothing of the fact's words can appear in an id: a run id, a path, a
      // predicate have nowhere to stand in a hex digest.
      expect(id).not.toContain('src/order.ts');
      expect(id).not.toContain(COMMIT);
    }
  });

  test('the same file read in two checkouts on two machines is one fact and one id', () => {
    const here = provenanceOf(repositoryPathIn(CHECKOUT_HERE, `${CHECKOUT_HERE}/src/order.ts`));
    const elsewhere = provenanceOf(repositoryPathIn(CHECKOUT_ELSEWHERE, `${CHECKOUT_ELSEWHERE}/src/order.ts`));
    const factHere = makeNodeFact({ kind: 'file', value: SAMPLES['file'], provenance: here, layer: 'extracted' });
    const factElsewhere = makeNodeFact({ kind: 'file', value: SAMPLES['file'], provenance: elsewhere, layer: 'extracted' });
    expect(factElsewhere.id).toBe(factHere.id);
    // And nothing of either machine's directory reached the provenance.
    expect(JSON.stringify(factHere)).not.toContain(CHECKOUT_HERE);
    expect(JSON.stringify(factElsewhere)).not.toContain(CHECKOUT_ELSEWHERE);
  });

  test('a rerun at another commit, with another reader version and other counts, is the same fact', () => {
    for (const kind of FACT_KINDS_IN_ORDER) {
      // Every part of the provenance a rerun may vary, and no part of the
      // identity: another commit and another source version. The reader's
      // name is varied too, except where the fact *is* one reader's reading:
      // a coverage says what one reader read of one scope, so its reader is
      // identity (the test below).
      const moved: FactProvenance = {
        source: { system: kind === 'coverage' ? 'tree-sitter' : 'scip-typescript', version: '0.4.1' },
        repository: { id: REPOSITORY, commit: OTHER_COMMIT },
        place: provenanceFor(kind).place,
      };
      expect(factId({ kind, value: SAMPLES[kind], provenance: moved } as never)).toBe(sampleFact(kind).id);
      // A rerun may also count a different number of the same things — a call's
      // sites, a file's bytes, a module's members, a snapshot's files — and the
      // fact is the same fact.
      const recounted = withOtherCounts(kind, SAMPLES[kind]);
      expect(factId({ kind, value: recounted, provenance: provenanceFor(kind) } as never)).toBe(sampleFact(kind).id);
      // The layer and the status are not identity either: how a fact was
      // obtained and whether anyone accepted it never changes what it is. Each
      // layer the kind admits is built through the constructor, with the last
      // status that layer allows, and the id does not move.
      for (const layer of EXPECTED_LAYERS[kind]) {
        const status = statusesOfLayer(layer).at(-1) as FactStatus;
        const again = FACT_KINDS[kind].shape === 'node'
          ? makeNodeFact({ kind: kind as never, value: SAMPLES[kind] as never, provenance: provenanceFor(kind), layer, status })
          : makeEdgeFact({ kind: kind as never, value: SAMPLES[kind] as never, provenance: provenanceFor(kind), layer, status });
        expect(again.id).toBe(sampleFact(kind).id);
        expect(again.layer).toBe(layer);
        expect(again.status).toBe(status);
      }
    }
  });

  test('a coverage is one reader reading one scope: another reader of it is another fact', () => {
    // 0004's coverage and 0005's "not enough data": two readers of one scope
    // keep their own gaps, so neither publisher overwrites the other's.
    const read = (system: string): string => factId({
      kind: 'coverage',
      value: SAMPLES['coverage'],
      provenance: { ...provenanceFor('coverage'), source: { system, version: '1' } },
    } as never);
    expect(read('scip-typescript')).not.toBe(read('tree-sitter'));
    expect(read('tree-sitter')).toBe(read('tree-sitter'));
  });

  test('a state is one machine of one repository: the same name in another repository is another state', () => {
    const here = makeNodeFact({ kind: 'state', value: SAMPLES['state'], provenance: provenanceFor('state'), layer: 'inferred' });
    const elsewhere = makeNodeFact({ kind: 'state', value: { ...SAMPLES['state'], repository: 'checkout-web' }, provenance: { ...provenanceFor('state'), repository: { id: 'checkout-web', commit: COMMIT } }, layer: 'inferred' });
    expect(elsewhere.id).not.toBe(here.id);
  });

  test('no identity of any kind names a run, a unit, an attempt, a generation, a session or a time', () => {
    const forbidden = ['run', 'runid', 'unit', 'unitid', 'attempt', 'generation', 'session', 'clock', 'now', 'time', 'timestamp', 'at'];
    for (const kind of FACT_KINDS_IN_ORDER) {
      const fields = identityOf(kind).map(([field]) => field);
      expect(new Set(fields).size).toBe(fields.length);
      for (const field of fields) expect(forbidden).not.toContain(field.toLowerCase());
    }
    const provenanceKeys = Object.keys(provenanceOf());
    expect(provenanceKeys.sort()).toEqual(['place', 'repository', 'source']);
  });

  test('no identity of any kind is the source version, the layer or the status, and the commit is identity only where the fact is the commit', () => {
    // A snapshot is one repository pinned at one commit and a commit fact is
    // that commit (0004's "repository@ref", 0026's stage 0): those two are
    // the facts whose identity the commit is. Everything else is read *at* a
    // commit, so the commit is provenance and never identity.
    const aboutTheCommit: readonly FactKind[] = ['commit', 'snapshot'];
    for (const kind of FACT_KINDS_IN_ORDER) {
      const values = identityOf(kind).map(([, value]) => JSON.stringify(value));
      expect(values).not.toContain(JSON.stringify('0.25.10'));
      expect(values).not.toContain(JSON.stringify('extracted'));
      expect(values).not.toContain(JSON.stringify('proposed'));
      if (!aboutTheCommit.includes(kind)) expect(values).not.toContain(JSON.stringify(COMMIT));
    }
    expect(identityOf('snapshot').map(([field]) => field)).toContain('commit');
    expect(identityOf('file').map(([field]) => field)).not.toContain('commit');
  });

  test('a value that changes without changing what the fact is about keeps the id; an identity that changes moves it', () => {
    const base = makeNodeFact({ kind: 'file', value: SAMPLES['file'], provenance: provenanceFor('file'), layer: 'extracted' });
    const renamed = makeNodeFact({ kind: 'file', value: { ...SAMPLES['file'], roles: ['source', 'test'], bytes: 4096 }, provenance: provenanceFor('file'), layer: 'extracted' });
    expect(renamed.id).toBe(base.id);
    const moved = makeNodeFact({ kind: 'file', value: { ...SAMPLES['file'], path: repositoryPath('src/order/index.ts') }, provenance: provenanceOf(repositoryPath('src/order/index.ts')), layer: 'extracted' });
    expect(moved.id).not.toBe(base.id);
    // Two repositories' files at one relative path are never one fact.
    const otherRepository = makeNodeFact({ kind: 'file', value: { ...SAMPLES['file'], repository: 'catalog-api' }, provenance: { ...provenanceFor('file'), repository: { id: 'catalog-api', commit: COMMIT } }, layer: 'extracted' });
    expect(otherRepository.id).not.toBe(base.id);
  });

  test('the endpoint, the variable and the contract are one node across repositories (0003 and 0006)', () => {
    const here = makeNodeFact({ kind: 'api-endpoint', value: SAMPLES['api-endpoint'], provenance: provenanceFor('api-endpoint'), layer: 'extracted' });
    const elsewhere = makeNodeFact({ kind: 'api-endpoint', value: SAMPLES['api-endpoint'], provenance: { ...provenanceFor('api-endpoint'), repository: { id: 'checkout-web', commit: COMMIT } }, layer: 'extracted' });
    expect(elsewhere.id).toBe(here.id);
    const variable = makeNodeFact({ kind: 'environment-variable', value: SAMPLES['environment-variable'], provenance: { ...provenanceFor('environment-variable'), repository: { id: 'checkout-web', commit: COMMIT } }, layer: 'extracted' });
    const variableHere = makeNodeFact({ kind: 'environment-variable', value: SAMPLES['environment-variable'], provenance: provenanceFor('environment-variable'), layer: 'extracted' });
    expect(variable.id).toBe(variableHere.id);
  });

  test('a claim is one assertion at one place: the same words at another span are another claim', () => {
    const atThree = makeNodeFact({ kind: 'claim', value: SAMPLES['claim'], provenance: provenanceFor('claim'), layer: 'inferred' });
    const atThirty = makeNodeFact({
      kind: 'claim',
      value: SAMPLES['claim'],
      provenance: { ...provenanceFor('claim'), place: { file: repositoryPath('src/order.ts'), range: { startLine: 30, startColumn: 0, endLine: 31, endColumn: 1 } } },
      layer: 'inferred',
    });
    expect(atThirty.id).not.toBe(atThree.id);
    const otherObject = makeNodeFact({ kind: 'claim', value: { ...SAMPLES['claim'], object: { form: 'literal', text: 'the checkout service' } }, provenance: provenanceFor('claim'), layer: 'inferred' });
    expect(otherObject.id).not.toBe(atThree.id);
  });
});

describe('repository paths: the machine checkout never reaches a fact', () => {
  test('a relative path reads as itself, with a machine separator folded and a leading ./ dropped', () => {
    // `String(...)` because a repository path's type is branded: the brand is
    // the point (a plain string is not one), and the bytes are what is read.
    expect(String(repositoryPath('src/order.ts'))).toBe('src/order.ts');
    expect(String(repositoryPath('src\\order.ts'))).toBe('src/order.ts');
    expect(String(repositoryPath('./src/order.ts'))).toBe('src/order.ts');
    expect(isRepositoryPath('src/order.ts')).toBe(true);
  });

  test('an absolute path, a climbed path, a drive path, a trailing separator, an empty leg and a dotted leg are refused', () => {
    const refused = ['/opt/madarch-checkout/src/order.ts', '../secret.ts', 'C:\\checkout\\src\\order.ts', 'src/', 'src//order.ts', 'src/./order.ts', ''];
    for (const value of refused) {
      expect(isRepositoryPath(value)).toBe(false);
      expect(() => repositoryPath(value)).toThrow(FactSchemaError);
    }
  });

  test("a sibling folder whose name starts with the root name is outside it, and a name's bytes are never folded", () => {
    // A prefix comparison would read `/srv/checkout2` as inside `/srv/checkout`.
    expect(() => repositoryPathIn('/srv/checkout', '/srv/checkout2/src/order.ts')).toThrow(/not inside the repository root/);
    // Unicode is the repository's own: an NFC name and its NFD spelling are
    // two paths, and neither is folded into the other.
    const nfc = 'docs/\u00DCber.md';
    const nfd = 'docs/U\u0308ber.md';
    expect(nfc).not.toBe(nfd);
    expect(String(repositoryPath(nfc))).toBe(nfc);
    expect(String(repositoryPath(nfd))).toBe(nfd);
    expect(repositoryPath(nfd)).not.toBe(repositoryPath(nfc));
    expect(String(repositoryPath('Docs/Readme.md'))).toBe('Docs/Readme.md');
  });

  test('a path inside the root reads relative to it, and a path outside names both paths', () => {
    expect(String(repositoryPathIn('/opt/madarch-checkout', '/opt/madarch-checkout/src/order.ts'))).toBe('src/order.ts');
    expect(String(repositoryPathIn('/opt/madarch-checkout/', '/opt/madarch-checkout/src/order.ts'))).toBe('src/order.ts');
    expect(() => repositoryPathIn('/opt/madarch-checkout', '/tmp/other/src/order.ts')).toThrow(/\/tmp\/other\/src\/order\.ts.*\/opt\/madarch-checkout/);
    expect(() => repositoryPathIn('/opt/madarch-checkout', '/opt/madarch-checkout')).toThrow(/the repository root itself/);
  });
});

describe('the check that names every reason a fact is not one the schema reads', () => {
  /** The sample file fact, and the problems the check names for a variant of it. */
  function problemsOf(variant: unknown): { paths: string[]; messages: string[] } {
    const problems = checkFact(variant);
    return { paths: problems.map((problem) => problem.path), messages: problems.map((problem) => problem.message) };
  }

  const file = sampleFact('file');

  test('a value that is no fact at all, and a kind the schema does not declare', () => {
    expect(problemsOf(null).messages[0]).toContain('a fact is an object');
    expect(problemsOf({ ...file, kind: 'service' }).paths).toEqual(['kind']);
    expect(problemsOf({ ...file, kind: 'service' }).messages[0]).toContain('is not a fact kind');
    expect(isFactKind('service')).toBe(false);
    expect(isFactKind('file')).toBe(true);
  });

  test('a schema version, an id, a layer and a status each at their own path', () => {
    // `file` has moved past the schema's own version (madarch-tzte.21.1 added
    // the blob its bytes stand under), so the version it does not carry is the
    // one after its own.
    expect(problemsOf({ ...file, schemaVersion: FACT_KINDS['file'].version + 1 }).paths).toEqual(['schemaVersion']);
    expect(problemsOf({ ...file, id: 'file:not-hex' }).paths).toEqual(['id']);
    expect(problemsOf({ ...file, id: 'f' + file.id }).paths).toEqual(['id']);
    expect(problemsOf({ ...file, layer: 'guessed' }).paths).toEqual(['layer']);
    // A file is extracted by the inventory: never inferred, never declared.
    expect(problemsOf({ ...file, layer: 'inferred' }).messages[0]).toContain('a file fact is extracted, not inferred');
    expect(problemsOf({ ...file, status: 'accepted' }).messages[0]).toContain('an extracted fact is proposed, not accepted');
    // A person's declaration may stand accepted; an agent's reading may not.
    const claim = sampleFact('claim');
    expect(checkFact({ ...claim, layer: 'declared', status: 'accepted' })).toEqual([]);
    expect(problemsOf({ ...claim, layer: 'inferred', status: 'accepted' }).paths).toEqual(['status']);
  });

  test('the provenance: a source and its version, a repository and its commit', () => {
    expect(problemsOf({ ...file, provenance: undefined }).paths).toEqual(['provenance']);
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), source: { system: 'tree-sitter', version: ' ' } } }).paths).toEqual(['provenance.source.version']);
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), repository: { id: '/opt/madarch-checkout', commit: COMMIT } } }).paths).toEqual(['provenance.repository.id']);
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), repository: { id: REPOSITORY, commit: 'HEAD' } } }).paths).toEqual(['provenance.repository.commit']);
  });

  test('every problem of a fact that cites a place names the file and the line', () => {
    const problems = checkFact({ ...file, status: 'accepted' });
    expect(problems[0]?.file).toBe('src/order.ts');
    expect(problems[0]?.line).toBe(3);
    // And a fact with no place carries none.
    const noPlace = checkFact({ ...file, provenance: { ...provenanceFor('file'), place: undefined } });
    expect(noPlace[0]?.path).toBe('provenance.place');
    expect(noPlace[0]?.file).toBeUndefined();
  });

  test('a place the kind stands at is required, and a place read as a repository path with an ascending range', () => {
    const occurrence = sampleFact('occurrence');
    // The design's scenario says the place is the only reason named: a fact
    // that stands at no place has no other defect.
    expect(problemsOf({ ...occurrence, provenance: { ...provenanceFor('occurrence'), place: undefined } }).paths).toEqual(['provenance.place']);
    expect(problemsOf({ ...occurrence, provenance: { ...provenanceFor('occurrence'), place: { file: '/opt/madarch-checkout/src/order.ts', range: provenanceFor('occurrence').place?.range } } }).paths).toEqual(['provenance.place.file']);
    expect(problemsOf({ ...occurrence, provenance: { ...provenanceFor('occurrence'), place: { file: repositoryPath('src/order.ts'), range: { startLine: 0, startColumn: 0, endLine: 1, endColumn: 0 } } } }).paths).toEqual(['provenance.place.range.startLine']);
    expect(problemsOf({ ...occurrence, provenance: { ...provenanceFor('occurrence'), place: { file: repositoryPath('src/order.ts'), range: { startLine: 9, startColumn: 0, endLine: 3, endColumn: 0 } } } }).paths).toEqual(['provenance.place.range.endLine']);
    expect(problemsOf({ ...occurrence, provenance: { ...provenanceFor('occurrence'), place: { file: repositoryPath('src/order.ts'), range: { startLine: 3, startColumn: 5, endLine: 3, endColumn: 2 } } } }).paths).toEqual(['provenance.place.range.endColumn']);
    expect(problemsOf({ ...occurrence, provenance: { ...provenanceFor('occurrence'), place: { file: repositoryPath('src/order.ts'), range: { startLine: 3, startColumn: 0, endLine: 7 } } } }).paths).toEqual(['provenance.place.range.endColumn']);
    // An optional place is allowed to be absent: a repository fact need not cite one.
    const repository = sampleFact('repository');
    expect(checkFact({ ...repository, provenance: { source: provenanceFor('repository').source, repository: provenanceFor('repository').repository } })).toEqual([]);
  });

  test('the value: a repository path, a list of names in code point order, a token that is one word', () => {
    expect(problemsOf({ ...file, value: { ...file.value, path: '/opt/madarch-checkout/src/order.ts' } }).paths).toEqual(['value.path']);
    expect(problemsOf({ ...file, value: { ...file.value, roles: ['test', 'source'] } }).paths).toEqual(['value.roles[1]']);
    expect(problemsOf({ ...file, value: { ...file.value, roles: ['source', 'source'] } }).paths).toEqual(['value.roles[1]']);
    const claim = sampleFact('claim');
    expect(problemsOf({ ...claim, value: { ...claim.value, predicate: 'is implemented by' } }).paths).toEqual(['value.predicate']);
    expect(problemsOf({ ...file, value: 'src/order.ts' }).paths).toEqual(['value']);
  });

  test('a record listed twice in one list is refused, and a value missing an identity field names the field', () => {
    const coverage = sampleFact('coverage');
    // 0004's coverage: a scope's gaps are in code point order of what was not
    // read, each once, so the refusal names the field the repeat and the order
    // stand in.
    expect(problemsOf({ ...coverage, value: { ...coverage.value, unread: [{ what: 'src/a.js', reason: 'error' }, { what: 'src/a.js', reason: 'error' }] } }).paths).toEqual(['value.unread[1].what']);
    expect(problemsOf({ ...coverage, value: { ...coverage.value, unread: [{ what: 'src/b.js', reason: 'error' }, { what: 'src/a.js', reason: 'error' }] } }).paths).toEqual(['value.unread[1].what']);
    // A gap's reason is one the schema names (0005: a coverage says why).
    expect(problemsOf({ ...coverage, value: { ...coverage.value, unread: [{ what: 'src/a.js', reason: 'guessed' }] } }).paths).toEqual(['value.unread[0].reason']);
    const { repository: _dropped, ...withoutRepository } = SAMPLES['table'];
    expect(problemsOf({ ...sampleFact('table'), value: withoutRepository }).paths).toEqual(['value.repository']);
  });

  test('a kind that stands at its own file: a place naming another file is refused', () => {
    const document = sampleFact('document');
    expect(problemsOf({ ...document, provenance: provenanceOf() }).paths).toEqual(['provenance.place.file']);
    expect(problemsOf({ ...document, provenance: provenanceOf() }).messages[0]).toContain('docs/requirements/orders.md');
    // A path the value itself is wrong about is reported there, once.
    expect(problemsOf({ ...document, value: { ...document.value, path: '/tmp/out.md' } }).paths).toEqual(['value.path']);
  });

  test('the ends of an assertion and the value of a binding carry a closed form inside the value', () => {
    const claim = sampleFact('claim');
    expect(problemsOf({ ...claim, value: { ...claim.value, subject: { form: 'node', id: 'not-an-id' } } }).paths).toEqual(['value.subject']);
    expect(problemsOf({ ...claim, value: { ...claim.value, object: { form: 'guess', text: 'x' } } }).messages[0]).toContain('is no form');
    expect(problemsOf({ ...claim, value: { ...claim.value, object: { form: 'external', url: '  ' } } }).paths).toEqual(['value.object']);
    const binds = sampleFact('binds');
    expect(problemsOf({ ...binds, value: { ...binds.value, value: { form: 'digest', sha256: 'xyz' } } }).paths).toEqual(['value.value']);
    expect(problemsOf({ ...binds, value: { ...binds.value, value: { form: 'secret', text: 'x' } } }).messages[0]).toContain('is no form');
  });

  test('an identity part reads as its own form: a repository name, a commit, a fact id, a token', () => {
    // 0004's repository@ref and 0026's "referenced nodes exist": an identity is
    // the digest of parts the graph can join, so a machine path where a
    // repository's name belongs, `HEAD` where a commit belongs or a word where
    // a fact id belongs is named at the field it stands in, before any id is
    // computed from it.
    expect(problemsOf({ ...file, value: { ...file.value, repository: CHECKOUT_HERE } }).paths).toEqual(['value.repository']);
    expect(problemsOf({ ...file, value: { ...file.value, repository: 'orders api' } }).paths).toEqual(['value.repository']);
    const snapshot = sampleFact('snapshot');
    expect(problemsOf({ ...snapshot, value: { ...snapshot.value, commit: 'HEAD' } }).paths).toEqual(['value.commit']);
    const commit = sampleFact('commit');
    expect(problemsOf({ ...commit, value: { ...commit.value, commit: OTHER_COMMIT.toUpperCase() } }).paths).toEqual(['value.commit']);
    const dependency = sampleFact('dependency');
    expect(problemsOf({ ...dependency, value: { ...dependency.value, to: 'orders-service' } }).paths).toEqual(['value.to']);
    const occurrence = sampleFact('occurrence');
    expect(problemsOf({ ...occurrence, value: { ...occurrence.value, symbol: 'OrderService.create' } }).paths).toEqual(['value.symbol']);
    const claim = sampleFact('claim');
    expect(problemsOf({ ...claim, value: { ...claim.value, predicate: 42 } }).paths).toEqual(['value.predicate']);
    const coverage = sampleFact('coverage');
    expect(problemsOf({ ...coverage, value: { ...coverage.value, scope: 7 } }).paths).toEqual(['value.scope']);
    // A part a fact may leave out is no defect when it is absent, and is read
    // as its own form when it is there.
    const moduleWithoutParent = makeNodeFact({ kind: 'module', value: { ...SAMPLES['module'], parent: undefined }, provenance: provenanceFor('module'), layer: 'extracted' });
    expect(checkFact(moduleWithoutParent)).toEqual([]);
    const module = sampleFact('module');
    expect(problemsOf({ ...module, value: { ...module.value, parent: 'checkout' } }).paths).toEqual(['value.parent']);
    const questionWithoutAbout = makeNodeFact({ kind: 'question', value: { ...SAMPLES['question'], about: undefined }, provenance: provenanceFor('question'), layer: 'inferred' });
    expect(checkFact(questionWithoutAbout)).toEqual([]);
  });

  test('a fact handed to the check with no value at all is refused, never thrown out of', () => {
    // An agent's write or a damaged stored row may carry nothing where a value
    // belongs: the check names every reason and never throws. A missing field
    // is named when it is one of the kind's identity parts, which is why the
    // comment — whose identity is its place alone — is the one kind an empty
    // value leaves passing; a field that is neither identity nor a closed form
    // is the write path's to check, since only it has the kind's type.
    const placeOnly: readonly FactKind[] = ['comment'];
    for (const kind of FACT_KINDS_IN_ORDER) {
      const broken = { ...sampleFact(kind), value: {} };
      let problems: readonly { path: string }[] = [];
      expect(() => {
        problems = checkFact(broken);
      }).not.toThrow();
      if (placeOnly.includes(kind)) {
        expect(problems).toEqual([]);
        continue;
      }
      expect(problems.length).toBeGreaterThan(0);
      for (const problem of problems) expect(problem.path.startsWith('value')).toBe(true);
    }
  });

  test('every reason at once: an absolute place, a range that ends before it starts, and roles out of order', () => {
    // The design's own `check` scenario: one fact, three defects, three
    // problems, each at its own path and each carrying the place's file and
    // line.
    const problems = checkFact({
      ...file,
      provenance: { ...provenanceFor('file'), place: { file: '/opt/madarch-checkout/src/order.ts', range: { startLine: 9, startColumn: 0, endLine: 3, endColumn: 0 } } },
      value: { ...file.value, roles: ['test', 'source'] },
    });
    expect(problems.map((problem) => problem.path)).toEqual(['provenance.place.file', 'provenance.place.range.endLine', 'value.roles[1]']);
    for (const problem of problems) {
      expect(problem.file).toBe('/opt/madarch-checkout/src/order.ts');
      expect(problem.line).toBe(9);
    }
  });

  test('an identity part the kind closes to a list of forms is refused outside it', () => {
    // 0026's "referenced nodes exist" and the design's `check` requirement: a
    // part the graph cannot join is refused before any id is computed from it,
    // and the constructor refuses the same write.
    const cases: readonly (readonly [FactKind, string, unknown])[] = [
      ['package', 'form', 'library'],
      ['deploy-unit', 'form', 'pod'],
      ['symbol', 'symbolKind', 'getter'],
      ['entry-point', 'form', 'cron'],
      ['entity-proposal', 'proposed', 'module'],
      ['dependency', 'basis', 'guess'],
      ['inherits', 'form', 'mixes-in'],
      ['interaction', 'form', 'telepathy'],
    ];
    for (const [kind, field, wrong] of cases) {
      const fact = sampleFact(kind);
      const value = { ...(fact.value as unknown as Record<string, unknown>), [field]: wrong };
      expect(problemsOf({ ...fact, value }).paths).toEqual([`value.${field}`]);
      expect(() => factId({ kind, value, provenance: provenanceFor(kind) } as never)).toThrow(/this reads as one of/);
    }
  });

  test('a closed form inside the value is refused outside the list the schema names', () => {
    const fileFact = sampleFact('file');
    expect(problemsOf({ ...fileFact, value: { ...fileFact.value, roles: ['zebra'] } }).paths).toEqual(['value.roles[0]']);
    const occurrence = sampleFact('occurrence');
    expect(problemsOf({ ...occurrence, value: { ...occurrence.value, roles: ['definition', 'nope'] } }).paths).toEqual(['value.roles[1]']);
    const comment = sampleFact('comment');
    expect(problemsOf({ ...comment, value: { ...comment.value, form: 'poem' } }).paths).toEqual(['value.form']);
    const module = sampleFact('module');
    expect(problemsOf({ ...module, value: { ...module.value, seed: 'guess' } }).paths).toEqual(['value.seed']);
    const rule = sampleFact('rule');
    expect(problemsOf({ ...rule, value: { ...rule.value, form: 'slogan' } }).paths).toEqual(['value.form']);
    const repository = sampleFact('repository');
    expect(problemsOf({ ...repository, value: { ...repository.value, form: 'mirror' } }).paths).toEqual(['value.form']);
  });

  test('a run id cannot ride inside a term, a binding, a gap or the provenance', () => {
    // 0026: "ids are stable and never contain a run id". A nested record is a
    // record too: an unnamed key is refused wherever it stands.
    const claim = sampleFact('claim');
    const runIdTerm = { ...(claim.value as unknown as Record<string, unknown>), subject: { form: 'node', id: anyId('symbol'), runId: 'run-7' } };
    // Two reasons, both true: the key is no part of a term, and the row's id is
    // no longer the digest of what the row now says.
    expect(problemsOf({ ...claim, value: runIdTerm }).paths).toEqual(['value.subject', 'id']);
    const binds = sampleFact('binds');
    const runIdBinding = { ...(binds.value as unknown as Record<string, unknown>), value: { form: 'literal', text: 'x', runId: 'run-7' } };
    expect(problemsOf({ ...binds, value: runIdBinding }).paths).toEqual(['value.value']);
    const coverage = sampleFact('coverage');
    const runIdGap = { ...(coverage.value as unknown as Record<string, unknown>), unread: [{ what: 'src/a.js', reason: 'error', runId: 'run-7' }] };
    expect(problemsOf({ ...coverage, value: runIdGap }).paths).toEqual(['value.unread[0]']);
    // And the provenance, its source, the repository, the place and the range.
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), runId: 'run-7' } }).paths).toEqual(['provenance']);
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), source: { system: 'tree-sitter', version: '0.25.10', runId: 'run-7' } } }).paths).toEqual(['provenance.source']);
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), repository: { id: REPOSITORY, commit: COMMIT, runId: 'run-7' } } }).paths).toEqual(['provenance.repository']);
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), place: { file: repositoryPath('src/order.ts'), range: provenanceFor('file').place!.range, runId: 'run-7' } } }).paths).toEqual(['provenance.place']);
    expect(problemsOf({ ...file, provenance: { ...provenanceFor('file'), place: { file: repositoryPath('src/order.ts'), range: { ...provenanceFor('file').place!.range, runId: 'run-7' } } } }).paths).toEqual(['provenance.place.range']);
  });

  test('a value that did not read does not stop the identity parts from being read, and neither does a provenance that did not', () => {
    // The design's `check` requirement: every reason. A broken place or
    // provenance costs its own reasons, never the value's.
    const across = { ...sampleFact('package') };
    const value = { ...(across.value as unknown as Record<string, unknown>), form: 'library' };
    expect(problemsOf({ ...across, value, provenance: undefined }).paths).toEqual(['provenance', 'value.form']);
    expect(problemsOf({ ...across, value, provenance: { ...provenanceFor('package'), repository: { id: 'orders api', commit: COMMIT } } }).paths).toEqual(['provenance.repository.id', 'value.form']);
    const rule = sampleFact('rule');
    const blank = { ...(rule.value as unknown as Record<string, unknown>), statement: '   ' };
    expect(problemsOf({ ...rule, value: blank, provenance: { ...provenanceFor('rule'), place: { file: '/opt/madarch-checkout/src/order.ts', range: provenanceFor('rule').place!.range } } }).paths).toEqual(['provenance.place.file', 'value.statement']);
  });

  test('a provenance the check refused is not digested into an id complaint', () => {
    // A name that is not a repository's is one defect, not two: the id was
    // computed from the fact as written, so the check says nothing about it.
    const claim = sampleFact('claim');
    const problems = problemsOf({ ...claim, provenance: { ...provenanceFor('claim'), repository: { id: 'orders api', commit: COMMIT } } });
    expect(problems.paths).toEqual(['provenance.repository.id']);
  });

  test('the digest waits for the provenance records the identity reads, and no others', () => {
    // A fact's commit and source version are what it was read at, not what it
    // is (0004): a file's identity is its repository and its path, so a tampered
    // id is a real reason beside a broken commit. A place-identity kind's id
    // does name the repository and the place, so a broken one there says nothing
    // about the digest.
    const tampered = { ...file, id: `file:${'a'.repeat(64)}` };
    expect(problemsOf({ ...tampered, provenance: { ...provenanceFor('file'), repository: { id: REPOSITORY, commit: 'HEAD' } } }).paths).toEqual(['provenance.repository.commit', 'id']);
    expect(problemsOf({ ...tampered, provenance: { ...provenanceFor('file'), source: { system: 'tree-sitter', version: ' ' } } }).paths).toEqual(['provenance.source.version', 'id']);
    const claim = sampleFact('claim');
    expect(problemsOf({ ...claim, provenance: { ...provenanceFor('claim'), repository: { id: 'orders api', commit: COMMIT } } }).paths).toEqual(['provenance.repository.id']);
  });

  test('a value that is not JSON is named at the fact, never thrown out of', () => {
    // An agent's write may carry anything: a BigInt, a circular record, an
    // `undefined` inside a record the identity digests. The check names it.
    expect(problemsOf({ ...file, status: 10n as never }).paths).toEqual(['status']);
    expect(problemsOf({ ...file, kind: 10n as never }).paths).toEqual(['kind']);
    const circular: Record<string, unknown> = { what: 'src/a.js', reason: 'error' };
    circular['self'] = circular;
    const coverage = sampleFact('coverage');
    expect(problemsOf({ ...coverage, value: { ...coverage.value, unread: [circular] } }).paths).toEqual(['value.unread[0]']);
    const claim = sampleFact('claim');
    const notJson = { ...claim.value, subject: { form: 'node', id: anyId('symbol'), url: undefined } };
    const paths = problemsOf({ ...claim, value: notJson }).paths;
    expect(paths).toContain('value.subject');
    expect(paths).toContain('value');
    // And the constructor refuses the same write rather than throwing a JSON error.
    expect(() => makeNodeFact({ kind: 'claim', value: notJson as never, provenance: provenanceFor('claim'), layer: 'inferred' })).toThrow(FactSchemaError);
  });

  test('a field the kind holds as a list is refused when it is not one, and an empty list of roles is refused too', () => {
    const coverage = sampleFact('coverage');
    expect(problemsOf({ ...coverage, value: { ...coverage.value, read: 5 } }).paths).toEqual(['value.read']);
    expect(problemsOf({ ...coverage, value: { ...coverage.value, unread: {} } }).paths).toEqual(['value.unread']);
    const testFact = sampleFact('test');
    expect(problemsOf({ ...testFact, value: { ...testFact.value, covers: anyId('symbol') } }).paths).toEqual(['value.covers']);
    const proposal = sampleFact('entity-proposal');
    expect(problemsOf({ ...proposal, value: { ...proposal.value, aliases: 'purchase' } }).paths).toEqual(['value.aliases']);
    // A file's roles are one or more (its own doc), and a list one entry wrong
    // names that entry and no other.
    const fileFact = sampleFact('file');
    expect(problemsOf({ ...fileFact, value: { ...fileFact.value, roles: [] } }).paths).toEqual(['value.roles']);
    expect(problemsOf({ ...fileFact, value: { ...fileFact.value, roles: ['source', 5 as never] } }).paths).toEqual(['value.roles[1]']);
  });

  test('a value and its provenance name one repository and one commit', () => {
    // The fact log files a fact by its provenance and the graph joins it by its
    // id; one fact in two repositories would be two.
    expect(problemsOf({ ...file, value: { ...file.value, repository: 'catalog-api' } }).paths).toEqual(['value.repository', 'id']);
    const snapshot = sampleFact('snapshot');
    expect(problemsOf({ ...snapshot, value: { ...snapshot.value, commit: OTHER_COMMIT } }).paths).toEqual(['value.commit', 'id']);
  });

  test('a name part is one name however it was spelled', () => {
    // The design's "A name is one name": trimmed, inner whitespace collapsed.
    const spaced = (kind: FactKind, field: string, spelled: string): void => {
      const fact = sampleFact(kind);
      const value = { ...(fact.value as unknown as Record<string, unknown>), [field]: spelled };
      const built = factId({ kind, value, provenance: provenanceFor(kind) } as never);
      expect(built).toBe(sampleFact(kind).id);
    };
    spaced('environment-variable', 'name', ' ORDERS_TOPIC ');
    spaced('section', 'anchor', ' placing-an-order ');
    spaced('symbol', 'qualifiedName', 'OrderService.create ');
    spaced('state', 'machine', ' OrderStatus ');
  });

  test('a key the schema does not name is refused: a run, a unit or a time never rides on a fact', () => {
    // 0026: "ids are stable and never contain a run id". A row that carries one
    // is refused at the key rather than published whole.
    expect(problemsOf({ ...file, runId: 'run-7' }).paths).toEqual(['runId']);
    expect(problemsOf({ ...file, value: { ...file.value, runId: 'run-7' } }).paths).toEqual(['value.runId']);
    expect(problemsOf({ ...file, unitId: 'u1', attempt: 2 }).paths).toEqual(['attempt', 'unitId']);
  });

  test('a place is required of the kinds read from bytes, and optional only where the fact has no site', () => {
    // 0004 ("every fact carries its source, repository@ref, file and line") and
    // the item's DONE WHEN. A fact about the tree itself — the repository, its
    // snapshot, a commit, a directory, a `contains` edge — a scope the fill
    // assembles (a module, a coverage, an entity proposal, a question) or a
    // task key read from a commit message has no single file and line.
    const placesNone: readonly FactKind[] = ['contains', 'commit', 'coverage', 'directory', 'entity-proposal', 'module', 'question', 'repository', 'snapshot', 'task-key'];
    for (const kind of FACT_KINDS_IN_ORDER) {
      const fact = sampleFact(kind);
      const bare = { ...fact, provenance: { source: fact.provenance.source, repository: fact.provenance.repository } };
      if (placesNone.includes(kind)) {
        expect(checkFact(bare)).toEqual([]);
        continue;
      }
      expect(problemsOf(bare).paths).toContain('provenance.place');
    }
  });

  test('an edge is written at a stage at which both its ends exist', () => {
    // 0027: a stage produces only the kinds it declares, and 0026 refuses a
    // write whose referenced nodes do not exist yet. So the last stage that
    // writes an edge kind is at or after the first stage that writes each kind
    // its ends name.
    const stagesOf = (kind: FactKind): number[] => FACT_KINDS[kind].stages.map((stage) => Number(stage.split('-')[0]));
    for (const kind of FACT_EDGE_KINDS) {
      const ends = EDGE_END_KINDS[kind];
      const endKinds: readonly FactKind[] = ends.to === 'term' ? ends.from : [...ends.from, ...ends.to];
      for (const end of endKinds) {
        expect(Math.max(...stagesOf(kind))).toBeGreaterThanOrEqual(Math.min(...stagesOf(end)));
      }
    }
    // The two ends the independent review caught: a module end needs stage 5,
    // a symbol end needs stage 3 or later.
    expect(FACT_KINDS['provides'].stages).toContain('5-modules');
    expect(FACT_KINDS['consumes'].stages).toContain('4-resolution');
    expect(FACT_KINDS['import'].stages).toContain('5-modules');
    expect(FACT_KINDS['dependency'].stages).toContain('5-modules');
  });

  test('an id that is not the identity own digest is refused, and a fact with another problem is digested too', () => {
    const tampered = { ...file, id: `file:${'a'.repeat(64)}` };
    const problems = checkFact(tampered);
    expect(problems.map((problem) => problem.path)).toEqual(['id']);
    expect(problems[0]?.message).toContain(file.id);
    // The design's `check` requirement: every reason is named, so a fact that
    // fails its version and its id names both.
    expect(problemsOf({ ...tampered, schemaVersion: 9 }).paths).toEqual(['schemaVersion', 'id']);
    // Only a part the check already refused stops the digest: a fact whose
    // identity names a machine path is not digested at all.
    expect(problemsOf({ ...file, value: { ...file.value, path: '/opt/madarch-checkout/src/order.ts' } }).paths).toEqual(['value.path']);
  });
});

describe('the explicit mapping to the registry kinds (0021 storage forms)', () => {
  test('every fact kind is mapped once, to itself, by a role the schema closes', () => {
    expect(Object.keys(REGISTRY_KIND_MAPPINGS).sort()).toEqual([...FACT_KINDS_IN_ORDER].sort());
    const relations = ['evidence', 'place', 'subject'];
    for (const kind of FACT_KINDS_IN_ORDER) {
      const mapping = REGISTRY_KIND_MAPPINGS[kind];
      expect(mapping.factKind).toBe(kind);
      expect(relations).toContain(mapping.relation);
      expect(mapping.registryForms.length).toBeGreaterThan(0);
      expect(new Set(mapping.registryForms).size).toBe(mapping.registryForms.length);
      for (const form of mapping.registryForms) expect(REGISTRY_STORAGE_FORMS).toContain(form);
      // The forms are listed in code point order, the project's one order.
      expect([...mapping.registryForms]).toEqual([...mapping.registryForms].sort());
    }
  });

  test('the storage forms are the product schema own five: one declaration, imported and never restated', () => {
    // 0021's amendment names the forms a registry kind may be kept in; the
    // product schema is their one declaration, so a form added there reaches
    // this mapping instead of leaving it behind.
    const union = (StorageForm as unknown as { anyOf: readonly { const: string }[] }).anyOf.map((member) => member.const);
    expect([...union].sort()).toEqual(['component', 'document', 'fact', 'model-element', 'task']);
    expect([...union].sort()).toEqual([...REGISTRY_STORAGE_FORMS].sort());
  });

  test('every storage form a registry kind may be kept in is served by some fact kind', () => {
    for (const form of REGISTRY_STORAGE_FORMS) expect(factKindsForRegistryForm(form).length).toBeGreaterThan(0);
    // A document kind's own place is found by the inventory and the document
    // index; its documents, sections and claims stand behind it.
    expect(factKindsForRegistryForm('document')).toContain('file');
    expect(factKindsForRegistryForm('document')).toContain('section');
    expect(factKindsForRegistryForm('document')).toContain('claim');
  });

  test('the forms a kind serves are answered in code point order, each kind once', () => {
    for (const form of REGISTRY_STORAGE_FORMS) {
      const kinds = factKindsForRegistryForm(form);
      expect([...kinds]).toEqual([...kinds].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
      expect(new Set(kinds).size).toBe(kinds.length);
      for (const kind of kinds) expect(REGISTRY_KIND_MAPPINGS[kind].registryForms).toContain(form);
    }
    // The claim is what every kind of document stands on: it serves every form.
    expect(factKindsForRegistryForm('component')).toContain('claim');
    expect(factKindsForRegistryForm('task')).toContain('claim');
  });

  test('the statuses a fact may carry are read as 0005 states them, layer by layer', () => {
    expect(statusesOfLayer('declared')).toEqual(['proposed', 'accepted', 'rejected']);
    expect(statusesOfLayer('extracted')).toEqual(['proposed']);
    expect(statusesOfLayer('inferred')).toEqual(['proposed']);
    expect(statusesOfLayer('observed')).toEqual(['proposed']);
  });
});
