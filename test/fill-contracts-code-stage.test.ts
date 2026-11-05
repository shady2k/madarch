/**
 * The contracts-code stage on a repository the test generates (decision 0033,
 * items 5, 14 and 15; madarch-8bdc.2.4): the untrusted inputs one TypeScript
 * file reads and the SQL path it carries, published one unit per file, and the
 * same records the extract driver's contracts reading publishes from that file.
 *
 * The expectations are the fixture's own: `reportText()` writes one `req.query`
 * read and one `$queryRawUnsafe` call, and the test names the records those
 * bytes make. The comparison with the driver reads the same tree with
 * `extractContracts`, sorts both readings by code point and requires the
 * families this stage publishes to be equal — a record one side holds and the
 * other does not is a difference too. A second run of the same commit plans no
 * unit of this stage.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createFillOrchestratorService, type FillOrchestratorService } from '../src/fill/orchestrator-host.js';
import { CONTRACTS_CODE_STAGE_ID } from '../src/fill/stages/contracts-code.js';
import { createGraphStore, type EdgeEntry, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { extractContracts } from '../src/extract/contracts/index.js';
import type { ExtractedEdge, ExtractedNode, Extraction, TreeReader } from '../src/extract/records.js';
import { writeProduct } from './fixtures/code-stages/repository.js';

/** The file the test adds: one untrusted read that reaches a SQL sink. */
const REPORT = 'services/orders/src/api/report.ts';

/** The repository's bytes: one `req.query` read, one SQL builder and one sink. */
function reportText(): string {
  return [
    "import { PrismaClient } from '@prisma/client';",
    '',
    'export function whereClause(status: unknown): string {',
    '  return `status = ${String(status)}`;',
    '}',
    '',
    'export async function report(prisma: PrismaClient, req: any) {',
    '  const status = req.query.status;',
    '  const where = whereClause(status);',
    '  return prisma.$queryRawUnsafe(`select * from orders where ${where}`);',
    '}',
    '',
  ].join('\n');
}

/** One product open for a run: its wiring, its service, and the graph store over the process's one owner. */
interface Open {
  readonly fill: StagesFill;
  readonly owner: DatabaseOwner;
  readonly service: FillOrchestratorService;
  readonly store: GraphStore;
  close(): Promise<void>;
}

let root = '';
let repository = '';
let opened: Open | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-contracts-code-'));
  const made = writeProduct(root);
  repository = made.repository;
  mkdirSync(join(repository, 'services/orders/src/api'), { recursive: true });
  writeFileSync(join(repository, REPORT), reportText());
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] }); };
  git('add', '-A');
  git('commit', '-qm', 'the report of the orders service');
  const owner = createPGliteDatabaseOwner({ btreeGist: true });
  const fill = await createStagesFill({ product: made.product, database: owner });
  let at = 1_700_000_000_000;
  const service = createFillOrchestratorService({
    home: join(root, 'products'),
    owner,
    registry: fill.registry,
    wiring: () => fill.wiring,
    clock: () => (at += 1_000),
    limits: { leaseMs: 86_400_000 },
    maxPasses: 100_000,
  });
  opened = {
    fill,
    owner,
    service,
    store: createGraphStore(owner),
    close: async () => {
      await service.stop();
      await owner.close();
    },
  };
}, 600_000);

afterAll(async () => {
  await opened?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** The repository's paths and bytes, as the driver reads them. */
function treeReader(): TreeReader {
  const walk = (prefix: string): string[] => readdirSync(join(repository, prefix === '' ? '.' : prefix)).flatMap((name) => {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(join(repository, rel)).isDirectory()) return name === '.git' ? [] : walk(rel);
    return [rel];
  });
  const paths = walk('').sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const bytes = new Map<string, Uint8Array>(paths.map((path) => [path, new Uint8Array(readFileSync(join(repository, path)))]));
  return {
    paths,
    read(path: string): Uint8Array {
      const held = bytes.get(path);
      if (held === undefined) throw new Error(`${repository}/${path}: no such path in the fixture repository`);
      return held;
    },
  };
}

/** A node's properties as a record. */
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

/** A value as a text whose key order is its own: two readings of one value compare equal whatever order the graph held its keys in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** The properties a record is compared by: the stage's envelope read away. */
const ENVELOPE: ReadonlySet<string> = new Set(['recordKey', 'factKind', 'layer', 'status', 'provenance', 'repository', 'span']);

/** Whether a row is this stage's own record. */
function ours(row: { readonly properties: unknown }): boolean {
  const provenance = propertiesOf(row)['provenance'];
  if (provenance === null || typeof provenance !== 'object') return false;
  const source = (provenance as Record<string, unknown>)['source'];
  if (source === null || typeof source !== 'object') return false;
  return (source as Record<string, unknown>)['system'] === 'madarch-contracts-code';
}

/** One record of the comparison: its kind, key, label, properties and span. */
interface Record_ {
  readonly kind: string;
  readonly key: string;
  readonly label?: string;
  readonly properties: Record<string, unknown>;
  readonly span?: unknown;
}

/** The driver's key of a node the graph holds: a file by its path, every other kind by the record key it carries. */
function canonicalKeyOf(row: { readonly kind: string; readonly properties: unknown }): string {
  const held = propertiesOf(row);
  if (row.kind === 'code.file' && typeof held['path'] === 'string') return `code.file:${held['path']}`;
  const key = held['recordKey'];
  if (typeof key !== 'string') throw new Error(`the graph answered a ${row.kind} node with no recordKey`);
  return key;
}

/** The records of the two readings, sorted by code point of their keys. */
async function compare(o: Open): Promise<{ readonly differences: readonly string[]; readonly counts: Readonly<Record<string, number>> }> {
  const driver: Extraction = await (async () => {
    const reader = treeReader();
    const shared = await extractCodeWithFacts(reader);
    return await extractContracts(reader, shared.extraction, shared.facts);
  })();
  const kinds = ['code.input', 'code.sql-build', 'code.sql-sink'];
  const relations = ['code.flows-into', 'code.contains'];
  const nodes: NodeVersionRow[] = (await Promise.all(kinds.map(async (kind) => await allPages((page) => o.store.byProperty(kind, 'repository', 'shop', page))))).flat();
  const edges: EdgeEntry[] = (await Promise.all(relations.map(async (relation) => await allPages((page) => o.store.edgesByProperty(relation, 'repository', 'shop', page))))).flat();
  const stage: Record_[] = [];
  for (const row of nodes) {
    if (!ours(row)) continue;
    const held = propertiesOf(row);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(held)) if (!ENVELOPE.has(key)) properties[key] = value;
    stage.push({ kind: row.kind, key: canonicalKeyOf(row), label: row.label, properties, ...(held['span'] === undefined ? {} : { span: held['span'] }) });
  }
  for (const entry of edges) {
    if (!ours(entry.edge)) continue;
    const held = propertiesOf(entry.edge);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(held)) if (!ENVELOPE.has(key) && key !== 'discriminator') properties[key] = value;
    stage.push({
      kind: entry.edge.relation ?? '',
      key: `${entry.edge.relation ?? ''} ${canonicalKeyOf(entry.src)} ${canonicalKeyOf(entry.dst)}`,
      properties,
      ...(held['span'] === undefined ? {} : { span: held['span'] }),
    });
  }
  const expected: Record_[] = [];
  for (const node of driver.nodes as readonly ExtractedNode[]) {
    if (!kinds.includes(node.kind)) continue;
    expected.push({ kind: node.kind, key: node.key, label: node.label, properties: { ...node.properties }, ...(node.span === undefined ? {} : { span: node.span }) });
  }
  for (const edge of driver.edges as readonly ExtractedEdge[]) {
    if (!relations.includes(edge.type)) continue;
    expected.push({ kind: edge.type, key: `${edge.type} ${edge.from} ${edge.to}`, properties: { ...edge.properties }, ...(edge.span === undefined ? {} : { span: edge.span }) });
  }
  const byKey = new Map(stage.map((record) => [`${record.kind}\u0000${record.key}`, record]));
  const differences: string[] = [];
  for (const record of expected) {
    const held = byKey.get(`${record.kind}\u0000${record.key}`);
    if (held === undefined) {
      differences.push(`the stage publishes no ${record.kind} ${record.key}`);
      continue;
    }
    if (record.label !== undefined && held.label !== record.label) differences.push(`${record.kind} ${record.key}: label ${JSON.stringify(held.label)} where the driver reads ${JSON.stringify(record.label)}`);
    for (const key of [...new Set([...Object.keys(record.properties), ...Object.keys(held.properties)])].sort()) {
      if (canonical(record.properties[key]) !== canonical(held.properties[key])) {
        differences.push(`${record.kind} ${record.key}: ${key} is ${JSON.stringify(held.properties[key])} where the driver reads ${JSON.stringify(record.properties[key])}`);
      }
    }
    if (canonical(record.span) !== canonical(held.span)) differences.push(`${record.kind} ${record.key}: span ${JSON.stringify(held.span)} where the driver reads ${JSON.stringify(record.span)}`);
  }
  const expectedKeys = new Set(expected.map((record) => `${record.kind}\u0000${record.key}`));
  for (const record of stage) if (!expectedKeys.has(`${record.kind}\u0000${record.key}`)) differences.push(`the stage publishes a ${record.kind} ${record.key} the driver reads no record of`);
  return { differences: differences.sort(), counts: { expected: expected.length, stage: stage.length } };
}

describe('the contracts-code stage', () => {
  test('publishes the fixture file\'s inputs and SQL path, one unit per file, and the refill plans none', async () => {
    if (opened === undefined) throw new Error('the product was not opened');
    const o = opened;
    const first = await o.service.run({ product: o.fill.product, runId: 'contracts-code-1' });
    if (!first.ok) throw new Error(`the run was refused: ${first.code}: ${first.reason}`);
    expect({ state: first.state, settled: first.settled }).toEqual({ state: 'succeeded', settled: true });
    const second = await o.service.run({ product: o.fill.product, runId: 'contracts-code-2' });
    if (!second.ok) throw new Error(`the refill was refused: ${second.code}: ${second.reason}`);
    expect(second.units.filter((unit) => unit.stageId === CONTRACTS_CODE_STAGE_ID)).toEqual([]);
    const inputs = await allPages((page) => o.store.byProperty('code.input', 'repository', 'shop', page));
    expect(inputs.map((row) => propertiesOf(row)['recordKey'])).toContain(`code.input:${REPORT}#query.status`);
    const sinks = await allPages((page) => o.store.byProperty('code.sql-sink', 'repository', 'shop', page));
    expect(sinks.map((row) => propertiesOf(row)['recordKey'])).toContain(`code.sql-sink:${REPORT}#$queryRawUnsafe`);
    const contains = await allPages((page) => o.store.edgesByProperty('code.contains', 'repository', 'shop', page));
    expect(contains.filter((entry) => canonicalKeyOf(entry.src) === `code.file:${REPORT}` && ours(entry.edge)).length).toBeGreaterThan(0);
  }, 600_000);

  test('publishes exactly the records the driver reads for its families, sorted by code point', async () => {
    if (opened === undefined) throw new Error('the product was not opened');
    const { differences, counts } = await compare(opened);
    expect(counts.expected).toBeGreaterThan(0);
    expect(differences.slice(0, 40)).toEqual([]);
  }, 600_000);
});
