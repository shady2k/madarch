/**
 * The contracts stage against the extract driver's own reading, on the
 * generated training repository (madarch-8bdc.2.4): every record the driver's
 * contracts reading publishes from the repository — the contract documents, the
 * operations, channels and messages they declare, the routes and entry points
 * the code registers, the untrusted input and SQL path a file carries, and the
 * edges that link them — is compared with the record the stage publishes into
 * the 0028 graph, sorted by code point and named by kind and key.
 *
 * **What a record is.** A node is its kind, key, label, properties and span; an
 * edge is its relation, its two ends, its properties and the discriminator the
 * driver gives it. The stage publishes the driver's properties beside its own
 * envelope (`recordKey`, `factKind`, `layer`, `provenance`, `repository`); the
 * comparison reads the envelope away and requires every other key to stand
 * exactly as the driver wrote it, in both directions — a record the stage
 * publishes and the driver does not is a difference too.
 *
 * **The ends.** The graph keys a file and a symbol by a digest of what the
 * record is, where the driver keys it by its path: an edge's end is read as the
 * driver's own key of the node it names (`code.file:<path>`,
 * `code.symbol:<path>#<qualified name>`), so the two readings of one link are
 * compared by the link and not by the store's identity.
 *
 * **The families not yet ported.** `REMAINING` names, by family, the records
 * this branch does not publish yet. The list may only shrink: a family listed
 * here must still differ, and a family not listed must not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type EdgeEntry, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { extractContracts } from '../src/extract/contracts/index.js';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import type { ExtractedEdge, ExtractedNode, Extraction, TreeReader } from '../src/extract/records.js';

const GENERATOR = fileURLToPath(new URL('../examples/training-repository/generate.mjs', import.meta.url));
const REPOSITORY = 'training';
const PRODUCT = 'training-shop';

/**
 * The record families this branch does not publish yet, by name. A family is a
 * set of node kinds and relations (see `FAMILIES`), and the list may only
 * shrink: the test refuses a family that reaches zero differences while it is
 * still named here, so a ported family is taken off in the commit that ports it.
 */
const REMAINING: readonly string[] = [
  'calls-remote',
  'publishes',
];

/** One family: the node kinds and edge relations it is compared by. */
const FAMILIES: Readonly<Record<string, { readonly kinds: readonly string[]; readonly relations: readonly string[] }>> = {
  contracts: { kinds: ['code.contract'], relations: ['code.declares', 'code.carries'] },
  operations: { kinds: ['code.operation'], relations: [] },
  channels: { kinds: ['code.channel', 'code.message'], relations: [] },
  routes: { kinds: ['code.route'], relations: ['code.handled-by', 'code.references'] },
  'entry-points': { kinds: ['code.entry-point'], relations: ['code.starts', 'code.belongs-to'] },
  inputs: { kinds: ['code.input'], relations: [] },
  sql: { kinds: ['code.sql-build', 'code.sql-sink'], relations: ['code.flows-into'] },
  containment: { kinds: [], relations: ['code.contains'] },
  serves: { kinds: [], relations: ['code.serves'] },
  'calls-remote': { kinds: [], relations: ['code.calls-remote'] },
  consumes: { kinds: [], relations: ['code.consumes'] },
  publishes: { kinds: [], relations: ['code.publishes'] },
};

/** Every kind and relation the comparison reads. */
const ALL_KINDS: readonly string[] = [...new Set(Object.values(FAMILIES).flatMap((family) => family.kinds))];
const ALL_RELATIONS: readonly string[] = [...new Set(Object.values(FAMILIES).flatMap((family) => family.relations))];

/** The properties a stage's node or edge carries as its own envelope, never as the record the driver published. */
const ENVELOPE: ReadonlySet<string> = new Set(['recordKey', 'factKind', 'layer', 'status', 'provenance', 'repository']);

/** One record as the comparison reads it: a node's kind, key, label, properties and span, or an edge's relation, ends, properties and discriminator. */
interface Reading {
  readonly kind: string;
  readonly key: string;
  readonly label?: string;
  readonly from?: string;
  readonly to?: string;
  readonly properties: Record<string, unknown>;
  readonly span?: unknown;
  readonly discriminator?: string;
}

/** One difference between the driver's reading and the stage's, named by kind and key. */
interface Difference {
  readonly family: string;
  readonly side: 'missing' | 'extra' | 'property' | 'span' | 'label' | 'end' | 'discriminator';
  readonly kind: string;
  readonly key: string;
  readonly detail: string;
}

let root = '';
let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;
let fill: StagesFill | undefined;
let service: ReturnType<typeof createFillOrchestratorService> | undefined;
let driver: Extraction | undefined;
let stageNodes: readonly NodeVersionRow[] = [];
let stageEdges: readonly EdgeEntry[] = [];
let refill: readonly { readonly unitId: string; readonly stageId: string }[] = [];
/** The graph's key for each symbol the graph holds, by the driver's own name for it (`<file>#<qualified name>`). */
let symbolKeys: ReadonlyMap<string, string> = new Map();
/** Every reference link the graph holds, by its two ends: one link is one edge, whichever stage published it. */
let referenceLinks: ReadonlySet<string> = new Set();
/** The driver records a stage of another reading satisfies as one shared link (ends only). */
const aliased: string[] = [];

/** The paths of the generated repository, in code point order, and their bytes. */
function folderReader(dir: string): TreeReader {
  const walk = (prefix: string): string[] => readdirSync(join(dir, prefix === '' ? '.' : prefix)).flatMap((name) => {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(join(dir, rel)).isDirectory()) return name === '.git' ? [] : walk(rel);
    return [rel];
  });
  const paths = walk('').sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const bytes = new Map<string, Uint8Array>(paths.map((path) => [path, new Uint8Array(readFileSync(join(dir, path)))]));
  return {
    paths,
    read(path: string): Uint8Array {
      const held = bytes.get(path);
      if (held === undefined) throw new Error(`${dir}/${path}: no such path in the generated repository`);
      return held;
    },
  };
}

/** The node properties a read answered, as a record. */
function propertiesOf(row: { readonly properties: unknown }): Record<string, unknown> {
  return row.properties !== null && typeof row.properties === 'object' && !Array.isArray(row.properties)
    ? row.properties as Record<string, unknown>
    : {};
}

/** Every page of one bounded read. */
async function allPages<T>(fetch: (page: { readonly limit: number; readonly after?: string }) => Promise<{ readonly rows: readonly T[]; readonly next: string | null }>): Promise<readonly T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after === undefined ? { limit: 1000 } : { limit: 1000, after });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** The graph's key of one node of the graph: a file by its path (the driver's own name for it), and every other kind by the record key it carries. */
function canonicalKeyOf(row: { readonly kind: string; readonly properties: unknown }): string {
  const held = propertiesOf(row);
  if (row.kind === 'code.file' && typeof held['path'] === 'string') return `code.file:${held['path']}`;
  // A symbol is named by the graph's own key, and the driver's `code.symbol:<path>#<name>` is read
  // through `canonicalSymbol`, the one function that maps the two names of one declaration.
  const key = held['recordKey'];
  if (typeof key !== 'string') throw new Error(`the graph answered a ${row.kind} node with no recordKey: every static node carries the fact id it was read as`);
  return key;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-contracts-training-'));
  const repository = join(root, 'training');
  execFileSync(process.execPath, [GENERATOR, repository], { stdio: ['ignore', 'pipe', 'pipe'] });
  const product = join(root, 'product');
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', REPOSITORY), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 7b3e1f42-8a6d-4c19-9f30-2d5b8e6a1c72',
    `name: ${PRODUCT}`,
    'repos:',
    `  - name: ${REPOSITORY}`,
    '    url: file:///training',
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the product of the training repository');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    home: join(root, 'products'), owner, registry: fill.registry, wiring: () => fill!.wiring,
    clock: () => (at += 1_000), limits: { leaseMs: 86_400_000 }, maxPasses: 100_000,
  });
  store = createGraphStore(owner);
  // Two runs: the first reads the repository, the second is the refill of the same commit, which
  // plans nothing. A unit that fails is named with the reason the run recorded for it.
  for (const runId of ['contracts-training-1', 'contracts-training-2']) {
    const run = await service.run({ product: fill.product, runId });
    if (!run.ok) throw new Error(`the fill ${runId} was refused: ${run.code}: ${run.reason}`);
    if (run.state !== 'succeeded' || !run.settled) {
      // Every unit the run did not publish is named with the last attempt's own reason, so a unit
      // waiting for a retry is an attempt that failed and not a loop that ran dry in silence.
      const progress = await service.progress(fill.product.folder);
      const events = progress?.events ?? [];
      const unpublished = (run.units ?? []).filter((unit) => unit.state !== 'published');
      const said = unpublished.map((unit) => {
        const own = events.filter((event) => event.unitId === unit.unitId);
        const last = own.filter((event) => ['unit-retried', 'unit-failed', 'unit-refused', 'unit-blocked'].includes(event.type)).at(-1) ?? own.at(-1);
        return `${unit.unitId} (stage ${unit.stageId}, state ${unit.state}, attempt ${String(unit.attempts)}): ${last?.summary ?? 'the run recorded no event for it'}`;
      });
      throw new Error(`the fill ${runId} did not settle: ${run.state}, settled ${String(run.settled)}, stopped ${String(run.stoppedBecause)}; ${String(unpublished.length)} not published:\n${said.join('\n')}`);
    }
    if (runId === 'contracts-training-2') refill = run.units;
  }
  // The driver's own reading of the same tree, at the same bytes.
  const reader = folderReader(repository);
  const shared = await extractCodeWithFacts(reader);
  driver = await extractContracts(reader, shared.extraction, shared.facts);
  stageNodes = (await Promise.all(ALL_KINDS.map(async (kind) => await allPages((page) => store!.byProperty(kind, 'repository', REPOSITORY, page))))).flat();
  stageEdges = (await Promise.all(ALL_RELATIONS.map(async (relation) => await allPages((page) => store!.edgesByProperty(relation, 'repository', REPOSITORY, page))))).flat();
  // The one named function that reads the driver's symbol reference as the graph's key (decision 4 of
  // the coordinator's note): the driver names a declaration `code.symbol:<path>#<qualified name>`, the
  // graph names the syntax stage's node for it by its record key, and the inline callbacks the
  // contracts-code stage publishes by their own key. One declaration has two names, and this is where
  // the two readings are compared.
  const symbols = await allPages((page) => store!.byProperty('code.symbol', 'repository', REPOSITORY, page));
  const callables = await allPages((page) => store!.byProperty('code.callable', 'repository', REPOSITORY, page));
  const keys = new Map<string, string>();
  // The syntax stage's node for a declaration answers first; the code-facts stage's callable fact is
  // the node for a callable the syntax pass keeps none of (an inline handler).
  for (const node of [...symbols, ...callables]) {
    const held = propertiesOf(node);
    const file = held['file'];
    const qualifiedName = held['qualifiedName'];
    const key = held['recordKey'];
    if (typeof file !== 'string' || typeof qualifiedName !== 'string' || typeof key !== 'string') continue;
    if (keys.has(`${file}#${qualifiedName}`)) continue;
    keys.set(`${file}#${qualifiedName}`, key);
  }
  symbolKeys = keys;
  const references = await allPages((page) => store!.edgesByProperty('code.references', 'repository', REPOSITORY, page));
  referenceLinks = new Set(references.map((entry) => `${propertiesOf(entry.src)['recordKey']}\u0000${propertiesOf(entry.dst)['recordKey']}`));
}, 1_800_000);

/**
 * The graph's key for a driver symbol reference (`code.symbol:<path>#<qualified name>`), through the
 * one function the comparison names: the syntax stage's node for that declaration, or the inline
 * callback the contracts-code stage published at it. A reference the graph cannot answer is refused
 * by name, so a missing symbol is a named difference and never a silently smaller comparison.
 */
function canonicalSymbol(reference: string): string {
  if (!reference.startsWith('code.symbol:')) return reference;
  const rest = reference.slice('code.symbol:'.length);
  const at = rest.lastIndexOf('#');
  if (at < 0) return reference;
  const found = symbolKeys.get(`${rest.slice(0, at)}#${rest.slice(at + 1)}`);
  if (found === undefined) throw new Error(`the driver names the symbol ${reference}, and the graph holds no symbol or callback of that name: the comparison cannot map it (test/fill-contracts-training.test.ts)`);
  return found;
}

afterAll(async () => {
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** The driver's records, by family. */
function driverRecords(): Reading[] {
  if (driver === undefined) throw new Error('the driver did not read the repository');
  const records: Reading[] = [];
  for (const node of driver.nodes as readonly ExtractedNode[]) {
    const properties = { ...node.properties } as Record<string, unknown>;
    // A route names its handler by the driver's symbol key; the graph names the same declaration by
    // its own key, and the one function maps it.
    if (typeof properties['handlerKey'] === 'string') properties['handlerKey'] = canonicalSymbol(properties['handlerKey']);
    records.push({ kind: node.kind, key: node.key, label: node.label, properties, ...(node.span === undefined ? {} : { span: node.span }) });
  }
  for (const edge of driver.edges as readonly ExtractedEdge[]) {
    const from = canonicalSymbol(edge.from);
    const to = canonicalSymbol(edge.to);
    records.push({ kind: edge.type, key: `${edge.type}\u0000${from}\u0000${to}`, from, to, properties: { ...edge.properties }, ...(edge.span === undefined ? {} : { span: edge.span }), discriminator: edge.discriminator });
  }
  return records;
}

/** The stage's records, by family: the envelope read away, the ends read as the driver's keys. */
function stageRecords(): Reading[] {
  if (store === undefined) throw new Error('the graph was not opened');
  const records: Reading[] = [];
  for (const row of stageNodes) {
    if (!ours(row) || internal(row)) continue;
    const held = propertiesOf(row);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(held)) if (!ENVELOPE.has(key) && key !== 'span') properties[key] = value;
    records.push({ kind: row.kind, key: canonicalKeyOf(row), label: row.label, properties, ...(held['span'] === undefined ? {} : { span: held['span'] }) });
  }
  for (const entry of stageEdges) {
    const properties = propertiesOf(entry.edge);
    if (!ours(entry.edge)) continue;
    if (internal(entry.src) || internal(entry.dst)) continue;
    const held: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) if (!ENVELOPE.has(key) && key !== 'span' && key !== 'discriminator') held[key] = value;
    const from = canonicalKeyOf(entry.src);
    const to = canonicalKeyOf(entry.dst);
    records.push({
      kind: entry.edge.relation ?? '',
      key: `${entry.edge.relation ?? ''}\u0000${from}\u0000${to}`,
      from,
      to,
      properties: held,
      ...(properties['span'] === undefined ? {} : { span: properties['span'] }),
      discriminator: typeof properties['discriminator'] === 'string' ? properties['discriminator'] : '',
    });
  }
  return records;
}

/** The per-file facts this reading publishes for later stages, which the extract driver never reads. */
const INTERNAL_PREFIXES: readonly string[] = ['code.middleware-chain:', 'code.router-mount:', 'code.go-package:', 'code.kafka-site:', 'code.go-consumer:', 'code.publisher-site:', 'code.file-names:', 'code.remote-call-site:'];

/** Whether a row is one of the reading's own per-file facts rather than a record of the extractor's. */
function internal(row: { readonly kind: string; readonly properties: unknown }): boolean {
  if (INTERNAL_PREFIXES.some((prefix) => row.kind.startsWith(prefix))) return true;
  const key = propertiesOf(row)['recordKey'];
  return typeof key === 'string' && INTERNAL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Whether a row is one of this reading's records: only its own stages' rows are compared. */
function ours(row: { readonly properties: unknown }): boolean {
  const provenance = propertiesOf(row)['provenance'];
  if (provenance === null || typeof provenance !== 'object') return false;
  const source = (provenance as Record<string, unknown>)['source'];
  if (source === null || typeof source !== 'object') return false;
  const system = (source as Record<string, unknown>)['system'];
  return system === 'madarch-contracts' || system === 'madarch-contracts-code' || system === 'madarch-contracts-routes' || system === 'madarch-contracts-links';
}

/** The families one record belongs to: a node by its kind, an edge by its relation. */
function familiesOf(kind: string): readonly string[] {
  return Object.entries(FAMILIES).filter(([, family]) => family.kinds.includes(kind) || family.relations.includes(kind)).map(([name]) => name);
}

/** A value as a text whose key order is its own: the graph's JSONB holds a record's keys in its own order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const held = value as Record<string, unknown>;
    return `{${Object.keys(held).sort().map((key) => `${JSON.stringify(key)}:${canonical(held[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Whether two values are the same value, whatever order the graph held the keys of one in. */
function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

/** Every difference between the two readings, one family at a time. */
function differences(): Difference[] {
  const found: Difference[] = [];
  const expected = driverRecords();
  const actual = stageRecords();
  const expectedKeys = new Set(expected.map((record) => `${record.kind}\u0000${record.key}`));
  const actualByKey = new Map(actual.map((record) => [`${record.kind}\u0000${record.key}`, record]));
  for (const record of expected) {
    for (const family of familiesOf(record.kind)) {
      const held = actualByKey.get(`${record.kind}\u0000${record.key}`);
      if (held === undefined) {
        // One link is one edge (decision 0028): where the resolution stage already tied a mention,
        // the graph holds its `code.references` edge for the same two ends, and this reading's
        // registration is that link. The comparison accepts the shared link by its ends and names
        // it, never as a silent match of properties.
        if (record.kind === 'code.references' && record.from !== undefined && record.to !== undefined && referenceLinks.has(`${record.from}\u0000${record.to}`)) {
          const note = `${record.from} -> ${record.to}`;
          if (!aliased.includes(note)) aliased.push(note);
          continue;
        }
        found.push({ family, side: 'missing', kind: record.kind, key: record.key, detail: `the stage publishes no ${record.kind} ${record.key}` });
        continue;
      }
      if (record.label !== undefined && held.label !== record.label) found.push({ family, side: 'label', kind: record.kind, key: record.key, detail: `label ${JSON.stringify(held.label)} where the driver reads ${JSON.stringify(record.label)}` });
      const keys = new Set([...Object.keys(record.properties), ...Object.keys(held.properties)]);
      for (const key of [...keys].sort()) {
        if (!same(record.properties[key], held.properties[key])) {
          found.push({ family, side: 'property', kind: record.kind, key: record.key, detail: `${key} is ${JSON.stringify(held.properties[key])} where the driver reads ${JSON.stringify(record.properties[key])}` });
        }
      }
      if (!same(record.span, held.span)) found.push({ family, side: 'span', kind: record.kind, key: record.key, detail: `span ${JSON.stringify(held.span)} where the driver reads ${JSON.stringify(record.span)}` });
      if (record.discriminator !== undefined && held.discriminator !== record.discriminator) found.push({ family, side: 'discriminator', kind: record.kind, key: record.key, detail: `discriminator ${JSON.stringify(held.discriminator)} where the driver reads ${JSON.stringify(record.discriminator)}` });
    }
  }
  for (const record of actual) {
    if (expectedKeys.has(`${record.kind}\u0000${record.key}`)) continue;
    for (const family of familiesOf(record.kind)) found.push({ family, side: 'extra', kind: record.kind, key: record.key, detail: `the stage publishes a ${record.kind} ${record.key} the driver reads no record of` });
  }
  return found;
}

describe('the contracts stage against the extract driver (training repository)', () => {
  test('every family not listed as remaining is published exactly as the driver reads it', () => {
    const found = differences();
    const remaining = new Set(REMAINING);
    const ported = Object.keys(FAMILIES).filter((family) => !remaining.has(family));
    const strays = found.filter((difference) => ported.includes(difference.family));
    expect(strays.slice(0, 40)).toEqual([]);
    expect(strays.length).toBe(0);
  }, 600_000);

  test('every family listed as remaining still differs, so the list only shrinks', () => {
    const found = differences();
    const empty = REMAINING.filter((family) => !found.some((difference) => difference.family === family));
    expect(empty).toEqual([]);
  }, 600_000);

  test('a reference link two readings share is one edge, matched by its two ends', () => {
    // The graph holds one edge per relation and two ends, so a registration the resolution stage
    // already tied is that edge. Every shared record is named here, and both of its ends are symbols
    // the graph holds — the link is real, and only its properties are the resolution's reading.
    const keys = new Set(symbolKeys.values());
    const unresolved = aliased.filter((note) => note.split(' -> ').some((end) => !keys.has(end)));
    expect(unresolved).toEqual([]);
    expect(aliased.length).toBeGreaterThan(0);
  }, 60_000);

  test('the refill of one commit plans no unit of this reading', () => {
    expect(refill).toEqual([]);
  }, 60_000);

  test('the comparison is not vacuous: the driver reads records of every family', () => {
    const expected = driverRecords();
    for (const [family, held] of Object.entries(FAMILIES)) {
      const count = expected.filter((record) => held.kinds.includes(record.kind) || held.relations.includes(record.kind)).length;
      expect({ family, count: count > 0 }).toEqual({ family, count: true });
    }
  }, 600_000);
});
