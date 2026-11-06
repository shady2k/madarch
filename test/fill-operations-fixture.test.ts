/**
 * Two shapes the port's assumptions name, read by the fill and by the extract
 * driver over the same tree (madarch-8bdc.2.4):
 *
 * - a Dockerfile that exposes no port while the service's code listens on one;
 * - a setting that names a broker's address, which links the service that talks
 *   to the broker.
 *
 * The repository is the test's own and is read twice: the product is filled with
 * the operations stages (every other stage disabled, so the case times what it
 * compares), and the same commit is read with `extractOperations`. The records
 * the two shapes make — the Dockerfile, the port it does not expose, the process
 * and the listens, the broker and its two links — are compared as
 * `<kind> <key> <canonical record>` lines in code point order; every difference
 * names the kind (or relation) and the key it stands at. The comparison asserts
 * first that the fixture has the shape it is written for: the Dockerfile exposes
 * nothing, the port's one record stands at the code file's listen, and the two
 * links end at the broker the setting's address names.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { extractOperations } from '../src/extract/operations/index.js';
import type { ExtractedEdge, ExtractedNode, SourceSpan, TreeReader } from '../src/extract/records.js';
import { createFillOrchestratorService, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createGraphStore, type GraphStore, type NodeVersionRow } from '../src/graph/index.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';

const REPOSITORY = 'shop';
const PRODUCT = 'shop-product';
const DOCKERFILE = 'services/shop/Dockerfile';
const INDEX = 'services/shop/src/index.ts';
const COMPOSE = 'docker-compose.yml';

/** The producers this comparison reads: the per-file operations declarations and the links stage. */
const STAGE_PRODUCERS: readonly string[] = ['fill.operations', 'fill.operations-links'];

/** The node kinds the two shapes make. */
const COMPARED_KINDS: readonly string[] = ['code.broker', 'code.dockerfile', 'code.port', 'code.process'];

/** The relations the two shapes make. */
const COMPARED_RELATIONS: readonly string[] = ['code.configured-by', 'code.connects-to', 'code.exposes', 'code.listens-on', 'code.publishes', 'code.starts'];

let root = '';
let owner: DatabaseOwner | undefined;
let service: FillOrchestratorService | undefined;
let fill: StagesFill | undefined;
let store: GraphStore | undefined;
let run: FillRunResult | undefined;
let driverNodes: readonly ExtractedNode[] = [];
let driverEdges: readonly ExtractedEdge[] = [];

/** The repository the test writes: a manifest, a service listening on 3000 whose Dockerfile exposes nothing, and a compose file naming the broker. */
function writeRepository(folder: string): void {
  mkdirSync(join(folder, 'services/shop/src'), { recursive: true });
  writeFileSync(join(folder, 'services/shop/package.json'), `${JSON.stringify({ name: 'shop', version: '1.0.0', dependencies: { express: '^4.21.2' } }, null, 2)}\n`);
  writeFileSync(join(folder, INDEX), [
    'import express from "express";',
    '',
    'const broker = process.env.KAFKA_BROKERS;',
    'const app = express();',
    '',
    'app.listen(3000, () => {',
    '  console.log(`shop listening, broker ${String(broker)}`);',
    '});',
    '',
  ].join('\n'));
  // No EXPOSE: the port the code listens on is the only place the tree names it.
  writeFileSync(join(folder, DOCKERFILE), [
    'FROM node:22',
    'WORKDIR /app',
    'COPY . .',
    'CMD ["node", "dist/index.js"]',
    '',
  ].join('\n'));
  // A second service whose Dockerfile starts a command the tree holds no source file for: the
  // driver gives that process the Dockerfile's own bytes, and so does the fill.
  mkdirSync(join(folder, 'services/worker'), { recursive: true });
  writeFileSync(join(folder, 'services/worker/package.json'), `${JSON.stringify({ name: 'worker', version: '1.0.0' }, null, 2)}\n`);
  writeFileSync(join(folder, 'services/worker/Dockerfile'), [
    'FROM python:3.13',
    'WORKDIR /app',
    'CMD ["/app/worker"]',
    '',
  ].join('\n'));
  writeFileSync(join(folder, COMPOSE), [
    'services:',
    '  shop:',
    '    build: ./services/shop',
    '    environment:',
    '      KAFKA_BROKERS: kafka:9092',
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the fixture repository');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-operations-fixture-'));
  const repository = join(root, REPOSITORY);
  writeRepository(repository);
  const product = join(root, 'product');
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', REPOSITORY), 'dir');
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 7d3f6a10-4b2c-4e58-9a71-2c8b5d0e6f93',
    `name: ${PRODUCT}`,
    'repos:',
    `  - name: ${REPOSITORY}`,
    '    url: file:///shop',
    'fill:',
    '  stages:',
    ...['build-configuration', 'document-index', 'history', 'inventory', 'modules', 'semantic-resolution', 'state-machines', 'syntax'].flatMap((id) => [`    ${id}:`, '      enabled: false']),
    '',
  ].join('\n'));
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: product, stdio: ['ignore', 'pipe', 'pipe'] }); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'the product of the fixture repository');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  fill = await createStagesFill({ product, database: owner });
  let at = 1_700_000_000_000;
  service = createFillOrchestratorService({
    home: join(root, 'products'), owner, registry: fill.registry, wiring: () => fill!.wiring,
    clock: () => (at += 1_000), limits: { leaseMs: 86_400_000 }, maxPasses: 100_000,
  });
  store = createGraphStore(owner);
  const once = await service.run({ product: fill.product, runId: 'fixture-one' });
  if (!once.ok) throw new Error(`the fill was refused: ${once.code}: ${once.reason}`);
  const failed = once.units.filter((unit) => unit.state === 'failed');
  if (failed.length > 0) throw new Error(`the fill left ${String(failed.length)} unit(s) failed: ${failed.map((unit) => `${unit.unitId} (stage ${unit.stageId}, ${String(unit.attempts)} attempts)`).join(', ')}`);
  if (once.state !== 'succeeded') throw new Error(`the fill did not succeed: state ${once.state}, settled ${String(once.settled)}, work ${String(once.work)}, passes ${String(once.passes)}`);
  run = once;
  const paths = execFileSync('git', ['-C', repository, 'ls-tree', '-r', 'HEAD', '--name-only'], { encoding: 'utf8' }).split('\n').filter((path) => path !== '').sort();
  const bytes = new Map<string, Uint8Array>(paths.map((path) => [path, new Uint8Array(readFileSync(join(repository, path)))]));
  const tree: TreeReader = {
    paths,
    read(path: string): Uint8Array {
      const held = bytes.get(path);
      if (held === undefined) throw new Error(`${repository}/${path}:1: ${path} is no committed file of the fixture`);
      return held;
    },
  };
  const code = await extractCodeWithFacts(tree);
  const extraction = extractOperations(tree, code.extraction, code.facts);
  driverNodes = extraction.nodes.filter((node) => COMPARED_KINDS.includes(node.kind));
  driverEdges = extraction.edges.filter((edge) => COMPARED_RELATIONS.includes(edge.type));
}, 900_000);

afterAll(async () => {
  await service?.stop();
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

/** The node properties a read answered, as a record. */
function propertiesOf(node: { readonly properties: unknown }): Record<string, unknown> {
  return node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties as Record<string, unknown>
    : {};
}

/** A span as the comparison reads it, or none: the record cites no line. */
function spanText(span: SourceSpan | undefined): string {
  return span === undefined ? 'none' : `${span.path}@${String(span.byteStart)}-${String(span.byteEnd)}:${String(span.lineStart)}-${String(span.lineEnd)}`;
}

/** One value in the comparison's canonical spelling: object keys in code point order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, held]) => [key, canonical(held)]));
  }
  return value;
}

/** The record text of one node. */
function nodeText(kind: string, key: string, label: string, properties: unknown, span: unknown): string {
  return `${kind} ${key} ${JSON.stringify(canonical({ label, properties, span }))}`;
}

/** The record text of one edge. */
function edgeText(type: string, from: string, to: string, discriminator: string, properties: unknown, span: unknown): string {
  return `${type} ${from} -> ${to} ${JSON.stringify(canonical({ discriminator, properties, span }))}`;
}

/** The graph's own key of an edge end: a file by its path, a record by the key it carries. */
function endKeyOf(row: NodeVersionRow): string {
  const held = propertiesOf(row);
  if (row.kind === 'code.file') return `code.file:${String(held['path'])}`;
  return typeof held['recordKey'] === 'string' ? held['recordKey'] : `graph:${row.nodeId}`;
}

/** Every row of one kind the stage producers published, one page after another. */
async function publishedNodes(): Promise<{ kind: string; key: string; label: string; properties: unknown; span: unknown }[]> {
  const rows: { kind: string; key: string; label: string; properties: unknown; span: unknown }[] = [];
  for (const kind of COMPARED_KINDS) {
    const page = await store!.readAll(async (next) => await store!.byProperty(kind, 'repository', REPOSITORY, next));
    for (const row of page) {
      if (!STAGE_PRODUCERS.includes(row.producer)) continue;
      const held = propertiesOf(row);
      rows.push({ kind: row.kind, key: String(held['recordKey']), label: row.label, properties: held['record'], span: held['span'] });
    }
  }
  return rows;
}

/** Every edge of one compared relation the stage producers published, one page after another. */
async function publishedEdges(): Promise<{ relation: string; from: string; to: string; discriminator: string; properties: unknown; span: unknown }[]> {
  const rows: { relation: string; from: string; to: string; discriminator: string; properties: unknown; span: unknown }[] = [];
  for (const relation of COMPARED_RELATIONS) {
    const page = await store!.readAll(async (next) => await store!.edgesByProperty(relation, 'repository', REPOSITORY, next));
    for (const entry of page) {
      const held = propertiesOf(entry.edge);
      if (held['factKind'] !== relation.slice('code.'.length)) continue;
      rows.push({ relation, from: endKeyOf(entry.src), to: endKeyOf(entry.dst), discriminator: String(held['discriminator'] ?? ''), properties: held['record'], span: held['span'] });
    }
  }
  return rows;
}

/** The differences between the driver's reading and the stage's, each named by its kind and key. */
function differencesOf(want: readonly string[], have: readonly string[]): string[] {
  const missing = want.filter((text) => !have.includes(text));
  const unexpected = have.filter((text) => !want.includes(text));
  return [...missing.map((text) => `missing: ${text}`), ...unexpected.map((text) => `unexpected: ${text}`)].sort();
}

describe('a Dockerfile that exposes nothing, and a setting that names a broker', () => {
  test('the fill published every unit', () => {
    expect({ state: run?.state, settled: run?.settled, failed: (run?.units ?? []).filter((unit) => unit.state === 'failed').map((unit) => unit.unitId) })
      .toEqual({ state: 'succeeded', settled: true, failed: [] });
  }, 300_000);

  test('the fixture has the two shapes: no exposed port, and a broker the setting names', () => {
    // The Dockerfile names no port, and the driver agrees: the only port record stands at the code's listen.
    const exposes = driverEdges.filter((edge) => edge.type === 'code.exposes' && edge.from === `code.dockerfile:${DOCKERFILE}`);
    expect(exposes).toEqual([]);
    const ports = driverNodes.filter((node) => node.kind === 'code.port');
    expect(ports.map((node) => [node.key, node.span?.path, node.span?.lineStart])).toEqual([['code.port:shop/3000', INDEX, 6]]);
    // Both processes the Dockerfiles start: the shop's stands at the code file its command names,
    // the worker's at the Dockerfile, because the tree holds no source file the command names.
    const processes = driverNodes.filter((node) => node.kind === 'code.process').map((node) => `${node.key} ${node.span?.path ?? 'none'}`).sort();
    expect(processes).toEqual([
      `code.process:services/shop/src/index.ts ${INDEX}`,
      'code.process:worker services/worker/Dockerfile',
    ]);
    // The setting's address names the broker, and the service that reads the variable talks to it.
    const broker = driverNodes.find((node) => node.kind === 'code.broker');
    expect(broker?.key).toBe('code.broker:address/kafka:9092');
    const links = driverEdges.filter((edge) => edge.type === 'code.connects-to' || edge.type === 'code.configured-by');
    expect(links.map((edge) => `${edge.type} ${edge.from} -> ${edge.to}`).sort()).toEqual([
      `code.configured-by ${broker?.key} -> code.env-definition:${COMPOSE}#shop/KAFKA_BROKERS`,
      `code.connects-to code.service:shop -> ${broker?.key}`,
    ]);
  }, 300_000);

  test('every record of the two shapes the stage published answers the driver', async () => {
    const wantNodes = driverNodes.map((node) => nodeText(node.kind, node.key, node.label, node.properties, node.span)).sort();
    const haveNodes = (await publishedNodes()).map((node) => nodeText(node.kind, node.key, node.label, node.properties, node.span)).sort();
    expect(differencesOf(wantNodes, haveNodes)).toEqual([]);
    const wantEdges = driverEdges.map((edge) => edgeText(edge.type, edge.from, edge.to, edge.discriminator, edge.properties, edge.span)).sort();
    const haveEdges = (await publishedEdges()).map((edge) => edgeText(edge.relation, edge.from, edge.to, edge.discriminator, edge.properties, edge.span)).sort();
    expect(differencesOf(wantEdges, haveEdges)).toEqual([]);
  }, 900_000);
});
