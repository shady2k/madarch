#!/usr/bin/env bun
/**
 * The task's own measurement of one fill (madarch-8bdc.2.5): what a fill costs
 * and what it leaves in the store, before and after a change of the storage
 * shape. It is not a check of the code; it is the number the change is judged by.
 *
 *   bun scripts/fill-measure.ts fill --work <folder> --out <file.json> [--repo <folder>]
 *   bun scripts/fill-measure.ts dump --store <folder> --out <file.json>
 *   bun scripts/fill-measure.ts bench --store <folder> --out <file.json> [--nodes <n> --edges <n>]
 *
 * `fill` generates the training repository (or takes `--repo`), makes a product of
 * it, runs the product's first fill to rest, and dumps: the wall clock, the store's
 * bytes, and every logical record a reader sees — a node by kind, label and
 * properties, an edge by relation, the keys of its two ends, its discriminator,
 * its position and its properties — with a digest of each and a count per kind,
 * relation and producer.
 *
 * `dump` answers the same records from a store that already exists, so a store
 * filled by another command is measured by this one's own reading.
 *
 * `bench` fills one synthetic unit of `--nodes` nodes and `--edges` edges and
 * reports the wall clock of each publication and the store's bytes per row: the
 * cost of writing, which a fill's wall clock mixes with reading, planning and
 * the reader's turn between statements.
 *
 * Reads go through the storage layer's own row contract (`NODE_COLUMNS`,
 * `nodeRow`, `EDGE_COLUMNS`, `edgeRow`), so the dump is the reader's answer and
 * not a second interpretation of the tables: a change of the columns behind
 * that contract is invisible here, which is the point.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EDGE_COLUMNS, EDGE_FROM, NODE_COLUMNS, NODE_FROM, edgeRow, nodeRow } from '../src/graph/versions.js';
import { createGraphStore } from '../src/graph/index.js';

/**
 * The database owner, loaded by a path the import graph does not resolve: a measurement is a
 * one-off reading of a database file, like `scripts/score-reference-graph.ts`, and decision 0033
 * item 3 keeps a connection out of every module the product serves — this script serves nothing.
 */
const engine = join(import.meta.dir, '..');
const load = async (path: string) => await import(pathToFileURL(join(engine, path)).href);
const { createDatabaseOwner, createDatabaseOwner } = await load('src/adapters/database-owner.ts') as typeof import('../src/adapters/database-owner.js');
type DatabaseOwner = Awaited<ReturnType<typeof createDatabaseOwner>>;
import { canonicalJsonDigest } from '../src/model/canonical.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { generateTrainingRepository, makeProduct } from '../test/knowledge-fixture.js';

const USAGE = 'usage: bun scripts/fill-measure.ts fill --work <folder> --out <file> [--repo <folder>] | dump --store <folder> --out <file> | bench --store <folder> --out <file> [--nodes n --edges n]';

interface Options {
  readonly mode: 'fill' | 'dump' | 'bench';
  readonly work: string;
  readonly store: string;
  readonly out: string;
  readonly repo: string | undefined;
  readonly nodes: number;
  readonly edges: number;
}

function parse(argv: readonly string[]): Options {
  const mode = argv[0];
  if (mode !== 'fill' && mode !== 'dump' && mode !== 'bench') throw new Error(USAGE);
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const number = (name: string, fallback: number): number => {
    const held = value(name);
    if (held === undefined) return fallback;
    const parsed = Number(held);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} is a positive whole number, got ${held}`);
    return parsed;
  };
  return {
    mode,
    work: value('work') ?? '',
    store: value('store') ?? '',
    out: value('out') ?? '',
    repo: value('repo'),
    nodes: number('nodes', 2000),
    edges: number('edges', 1500),
  };
}

interface Dumped {
  readonly nodes: { kind: string; label: string; properties: unknown; contentSha256: string | null; claimDigest: string | null }[];
  readonly edges: { relation: string; srcKey: string; dstKey: string; discriminator: string; position: unknown; properties: unknown }[];
}

/** Whether the store has `table.column`: the old shape's time columns are read only where they stand. */
async function hasColumn(owner: DatabaseOwner, table: string, column: string): Promise<boolean> {
  const found = await owner.transaction('snapshot', (tx) => tx.query('SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', [table, column]));
  return found.rows.length > 0;
}

/** Whether the store has a table of that name. */
async function hasTable(owner: DatabaseOwner, table: string): Promise<boolean> {
  const found = await owner.transaction('snapshot', (tx) => tx.query('SELECT 1 FROM information_schema.tables WHERE table_name = $1', [table]));
  return found.rows.length > 0;
}

/** Every logical record the store holds, as the reader's own row contract answers it. */
async function dumpStore(owner: DatabaseOwner): Promise<Dumped> {
  const versioned = await hasColumn(owner, 'node_version', 'recorded_to');
  const nodes = await owner.transaction('snapshot', async (tx) => {
    const where = versioned ? ` AND v.recorded_to = 'infinity'` : '';
    const found = await tx.query(`SELECT ${NODE_COLUMNS} FROM ${NODE_FROM} WHERE true${where}`, []);
    return found.rows.map((row) => nodeRow(row as Record<string, unknown>));
  });
  const edges = await owner.transaction('snapshot', async (tx) => {
    const where = versioned ? ` AND e.recorded_to = 'infinity'` : '';
    const found = await tx.query(`SELECT ${EDGE_COLUMNS} FROM ${EDGE_FROM} WHERE true${where}`, []);
    return found.rows.map((row) => edgeRow(row as Record<string, unknown>));
  });
  const keys = new Map<string, string>();
  for (const node of nodes) {
    const properties = node.properties as Record<string, unknown> | null;
    const key = properties !== null && typeof properties === 'object' && typeof properties['recordKey'] === 'string' ? String(properties['recordKey']) : `node:${node.nodeId}`;
    keys.set(node.nodeId, key);
  }
  return {
    nodes: nodes.map((node) => ({ kind: node.kind, label: node.label, properties: node.properties, contentSha256: node.contentSha256, claimDigest: node.claimDigest })),
    edges: edges.map((edge) => ({
      relation: edge.relation,
      srcKey: keys.get(edge.src) ?? `node:${edge.src}`,
      dstKey: keys.get(edge.dst) ?? `node:${edge.dst}`,
      discriminator: edge.discriminator,
      position: edge.position,
      properties: edge.properties,
    })),
  };
}

/** The folder's bytes, every file under it. */
function folderBytes(folder: string): number {
  let total = 0;
  const visit = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) total += statSync(path).size;
    }
  };
  if (existsSync(folder)) visit(folder);
  return total;
}

/** The bytes of each table with its indexes, as the database states them. */
async function tableBytes(owner: DatabaseOwner): Promise<Record<string, number>> {
  const found = await owner.transaction('snapshot', (tx) => tx.query(
    `SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY c.relname`,
  ));
  const out: Record<string, number> = {};
  for (const row of found.rows as { name: string; bytes: string }[]) out[row.name] = Number(row.bytes);
  return out;
}

/** Counts and digests: one entry per kind and per relation, and one digest of the whole answer. */
function digestOf(dumped: Dumped): Record<string, unknown> {
  const byKind = new Map<string, { count: number; digest: string }>();
  const lines: string[] = [];
  for (const node of dumped.nodes) {
    const text = JSON.stringify({ claimDigest: node.claimDigest, contentSha256: node.contentSha256, kind: node.kind, label: node.label, properties: node.properties });
    lines.push(`${node.kind}\u0000${text}`);
    const held = byKind.get(node.kind) ?? { count: 0, digest: '' };
    byKind.set(node.kind, { count: held.count + 1, digest: '' });
  }
  const byRelation = new Map<string, number>();
  for (const edge of dumped.edges) {
    lines.push(`${edge.relation}\u0000${JSON.stringify({ discriminator: edge.discriminator, dst: edge.dstKey, position: edge.position, properties: edge.properties, relation: edge.relation, src: edge.srcKey })}`);
    byRelation.set(edge.relation, (byRelation.get(edge.relation) ?? 0) + 1);
  }
  lines.sort();
  const kinds: Record<string, number> = {};
  for (const [kind, held] of [...byKind].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) kinds[kind] = held.count;
  const perKindDigest: Record<string, string> = {};
  for (const kind of Object.keys(kinds)) {
    const mine = lines.filter((line) => line.startsWith(`${kind}\u0000`));
    perKindDigest[kind] = canonicalJsonDigest(mine);
  }
  const relations: Record<string, number> = {};
  for (const [relation, count] of [...byRelation].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) relations[relation] = count;
  return { kinds, perKindDigest, relations, allDigest: canonicalJsonDigest(lines), nodes: dumped.nodes.length, edges: dumped.edges.length };
}

/** One store's answer: the dump, its digests, the bytes and the tables. */
async function measureStore(storeFolder: string): Promise<Record<string, unknown>> {
  const owner = await createDatabaseOwner({ store: join(storeFolder, 'graph'), btreeGist: true });
  try {
    const dumped = await dumpStore(owner);
    return { ...digestOf(dumped), storeBytes: folderBytes(storeFolder), tables: await tableBytes(owner) };
  } finally {
    await owner.close();
  }
}

/** Runs the product's first fill to rest and answers the wall clock and the run. */
async function fill(work: string, repository: string | undefined): Promise<{ productFolder: string; storeRoot: string; wallMs: number; runs: unknown[] }> {
  const repositoryFolder = repository ?? join(work, 'training');
  const storeRoot = join(work, 'store');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'home'), { recursive: true });
  if (repository === undefined) generateTrainingRepository(repositoryFolder);
  const productFolder = makeProduct(join(work, 'home'), 'training-shop', repositoryFolder);
  const product = new KnowledgeProduct({ productFolder, storeRoot });
  const started = performance.now();
  try {
    await product.startFill();
    await product.settled();
    const status = await product.status();
    return { productFolder, storeRoot, wallMs: performance.now() - started, runs: [status.kinds.map((kind) => ({ kind: kind.kind, count: kind.count }))] };
  } finally {
    await product.close();
  }
}

/** One synthetic unit of `nodes` nodes and `edges` edges, published once, timed. */
async function bench(store: string, nodeCount: number, edgeCount: number): Promise<Record<string, unknown>> {
  rmSync(store, { recursive: true, force: true });
  mkdirSync(store, { recursive: true });
  const owner = await createDatabaseOwner({ store: join(store, 'graph'), btreeGist: true });
  try {
    const graph = createGraphStore(owner);
    await graph.createSchema();
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      key: `bench.node:${String(index)}`,
      kind: 'code.symbol',
      label: 'identifier',
      properties: { id: `bench.node:${String(index)}`, recordKey: `bench.node:${String(index)}`, path: `src/file${String(index % 200)}.ts`, file: `src/file${String(index % 200)}.ts`, repository: 'bench', span: { path: `src/file${String(index % 200)}.ts`, byteStart: index * 4, byteEnd: index * 4 + 3, lineStart: index + 1, lineEnd: index + 1 }, syntaxKind: 'identifier', children: [], fields: {}, factKind: 'expression' },
    }));
    const edges = Array.from({ length: edgeCount }, (_, index) => ({
      relation: 'code.declares',
      from: { key: `bench.node:${String(index % nodeCount)}` },
      to: { key: `bench.node:${String((index * 7 + 3) % nodeCount)}` },
      properties: { factKind: 'declares', repository: 'bench' },
    }));
    const started = performance.now();
    await graph.publishUnit({ producer: 'bench', scopeKey: 'bench/one', inputDigest: 'bench-input', leaseToken: 'bench-lease', leaseUntil: '2999-01-01T00:00:00.000000Z', nodes, edges });
    const publishMs = performance.now() - started;
    const dumped = await dumpStore(owner);
    const bytes = folderBytes(store);
    const rows = dumped.nodes.length + dumped.edges.length;
    return { publishMs, wallMs: performance.now() - started, rows, storeBytes: bytes, bytesPerRow: bytes / rows, tables: await tableBytes(owner) };
  } finally {
    await owner.close();
  }
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.out === '') throw new Error(USAGE);
  let answer: Record<string, unknown>;
  if (options.mode === 'fill') {
    if (options.work === '') throw new Error(USAGE);
    const filled = await fill(resolve(options.work), options.repo === undefined ? undefined : resolve(options.repo));
    const products = readdirSync(filled.storeRoot).filter((name) => existsSync(join(filled.storeRoot, name, 'graph')));
    if (products.length !== 1) throw new Error(`the fill left ${String(products.length)} stores under ${filled.storeRoot}`);
    answer = { work: resolve(options.work), wallMs: filled.wallMs, runs: filled.runs, ...(await measureStore(join(filled.storeRoot, products[0]!))) };
  } else if (options.mode === 'dump') {
    if (options.store === '') throw new Error(USAGE);
    answer = { store: resolve(options.store), ...(await measureStore(resolve(options.store))) };
  } else {
    if (options.store === '') throw new Error(USAGE);
    answer = { store: resolve(options.store), ...(await bench(resolve(options.store), options.nodes, options.edges)) };
  }
  writeFileSync(resolve(options.out), `${JSON.stringify(answer, null, 2)}\n`);
  console.log(JSON.stringify(answer, null, 2));
}

await main();
