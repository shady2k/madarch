#!/usr/bin/env bun
/**
 * `bun scripts/score-reference-graph.ts <repository folder> <graph database>` —
 * the training score of a filled graph against the reference graph
 * (`examples/training-repository/reference-graph/`).
 *
 *   bun scripts/score-reference-graph.ts /work/out/training /work/out/home/.madarch/fill/state.db
 *   … [--graph <reference folder>] [--json]
 *
 * The graph is read through its own reader (`src/knowledge/graph-read.ts`) at
 * the repository's scope. Every record is named by one function
 * (`scripts/reference-graph-natural-key.ts`), and the names are compared as
 * strings: a node is found when its kind and its natural id are the
 * reference's, an edge when its relation and both ends are.
 *
 * The tables are per node kind and per relation, and each row is split by the
 * reference entry's reading: `parsed` and `declared` are what a static fill can
 * reach, `judgement` is what a reader decides (scored separately, and the
 * graph's count beside it is the whole of the kind, because a graph record
 * does not carry a reading). `precision` is what share of the graph's records
 * of the kind the row explains, `recall` what share of the reference entries
 * the graph holds, and `F1` the harmonic mean; a share with no denominator is
 * printed as `—`.
 *
 * Then the lists: every reference entry the graph does not hold, with its
 * evidence; every graph record the reference does not state, with the place the
 * graph gives; and every kind the graph holds that the reference leaves out by
 * design, by name.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { EXTRACTOR_RELATIONS } from '../src/extract/vocabulary.js';
import { STAGE_EDGE_TYPES } from '../src/extract/code/stage-vocabulary.js';
import { GraphReader, type GraphEntity, type RelationEdge } from '../src/knowledge/graph-read.js';
import { NAMED_KINDS, naturalKeyOf } from './reference-graph-natural-key.js';

const USAGE = 'usage: bun scripts/score-reference-graph.ts <repository folder> <graph database> [--graph <reference folder>] [--repository <name>] [--json]';

class UsageError extends Error {}

interface EvidenceItem {
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly quote?: string;
  readonly command?: string;
}

interface ReferenceNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly reading: string;
  readonly evidence: readonly EvidenceItem[];
}

interface ReferenceEdge {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
  readonly reading: string;
  readonly evidence: readonly EvidenceItem[];
}

interface Classification {
  readonly parsed: boolean;
  readonly declared: boolean;
  readonly judgement: boolean;
}

const STATIC = 'parsed+declared';
const JUDGEMENT = 'judgement';

interface Row {
  readonly name: string;
  readonly kind: string;
  readonly label: string;
  readonly class: string;
  readonly reference: number;
  readonly graph: number;
  readonly truePositives: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

interface Missing {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly reading: string;
  readonly evidence: readonly EvidenceItem[];
}

interface Extra {
  readonly kind: string;
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly place: string;
}

interface Result {
  readonly table: readonly Row[];
  readonly missing: readonly Missing[];
  readonly extra: readonly Extra[];
  readonly excluded: readonly { readonly kind: string; readonly count: number; readonly reason: string }[];
  readonly unmapped: readonly { readonly kind: string; readonly key: string; readonly reason: string }[];
  readonly scope: string;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  let repository: string | undefined;
  let database: string | undefined;
  let graphFolder: string | undefined;
  let repositoryName: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--json') json = true;
    else if (argument === '--repository') {
      repositoryName = argv[index + 1];
      if (repositoryName === undefined || repositoryName.startsWith('--')) throw new UsageError('--repository names the repository the graph reads, and none was given');
      index += 1;
    } else if (argument === '--graph') {
      graphFolder = argv[index + 1];
      if (graphFolder === undefined || graphFolder.startsWith('--')) throw new UsageError('--graph names the reference folder, and none was given');
      index += 1;
    } else if (argument.startsWith('--')) throw new UsageError(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
    else if (repository === undefined) repository = argument;
    else if (database === undefined) database = argument;
    else throw new UsageError(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
  }
  if (repository === undefined || database === undefined) throw new UsageError(USAGE);
  const folder = resolve(repository);
  const graph = resolve(graphFolder ?? join(import.meta.dir, '..', 'examples', 'training-repository', 'reference-graph'));
  const result = await score(folder, resolve(database), graph, repositoryName ?? basename(folder));
  if (json) console.log(JSON.stringify(result, null, 2));
  else report(result);
  return 0;
}

/** Reads the reference: every node and every edge, with the reading it was written in. */
function readReference(graphRoot: string): { nodes: ReferenceNode[]; edges: ReferenceEdge[] } {
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.yaml')) files.push(path);
    }
  };
  walk(graphRoot);
  const nodes: ReferenceNode[] = [];
  const edges: ReferenceEdge[] = [];
  for (const file of files) {
    const held = parseYaml(readFileSync(file, 'utf8')) as { nodes?: ReferenceNode[]; edges?: ReferenceEdge[] } | null;
    if (held === null) throw new Error(`${file}: the reference file holds no YAML mapping`);
    nodes.push(...(held.nodes ?? []));
    edges.push(...(held.edges ?? []));
  }
  return { nodes, edges };
}

/** The name of the class a reading belongs to, or null for a reading this scorer does not know. */
function classOf(reading: string): string | null {
  if (reading === 'parsed' || reading === 'declared') return STATIC;
  if (reading === 'judgement') return JUDGEMENT;
  return null;
}

function places(evidence: readonly EvidenceItem[]): string {
  return evidence.map((item) => item.command !== undefined ? `\`${item.command}\`` : `${item.path}:${String(item.startLine)}${item.endLine !== item.startLine ? `-${String(item.endLine)}` : ''}`).join(', ');
}

/** Where the graph says the record stands: its span, or the place of its provenance, or nothing. */
function placeOf(entity: GraphEntity): string {
  if (entity.span !== undefined) return `${entity.span.path}:${String(entity.span.lineStart)}`;
  const provenance = entity.properties['provenance'];
  if (provenance !== null && typeof provenance === 'object') {
    const place = (provenance as Record<string, unknown>)['place'];
    if (place !== null && typeof place === 'object') {
      const file = (place as Record<string, unknown>)['file'];
      const range = (place as Record<string, unknown>)['range'];
      if (typeof file === 'string' && range !== null && typeof range === 'object') {
        const line = (range as Record<string, unknown>)['startLine'];
        if (typeof line === 'number') return `${file}:${String(line)}`;
      }
    }
  }
  const file = entity.properties['file'];
  return typeof file === 'string' ? file : '—';
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function f1Of(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null || precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

async function score(folder: string, database: string, graphRoot: string, repositoryName: string): Promise<Result> {
  if (!existsSync(database)) throw new UsageError(`${database}: no such graph database`);
  const reference = readReference(graphRoot);
  const owner: DatabaseOwner = createPGliteDatabaseOwner({ path: database, btreeGist: true });
  try {
    const instant = new Date().toISOString();
    const reader = new GraphReader(owner, () => instant);

    // Every entity of every kind that belongs to the repository, named by the one function.
    // The graph reads across its scopes; a record says which repository it was read from in
    // `properties.repository` (and, under the extract driver, in its provenance).
    const entities: GraphEntity[] = [];
    const unmapped: { kind: string; key: string; reason: string }[] = [];
    const byDesign = new Map<string, number>();
    let repositoryNode = '';
    for (const { kind } of await reader.kindCounts()) {
      let after: string | undefined;
      for (;;) {
        const page = await reader.list(kind, { limit: 500, ...(after === undefined ? {} : { after }) });
        for (const entity of page.rows) {
          if (repositoryOf(entity) !== repositoryName) continue;
          if (!NAMED_KINDS.has(kind)) {
            byDesign.set(kind, (byDesign.get(kind) ?? 0) + 1);
            continue;
          }
          if (kind === 'code.repository') repositoryNode = entity.nodeIds[0] ?? '';
          entities.push(entity);
        }
        if (page.next === null) break;
        after = page.next;
      }
    }
    if (entities.length === 0) {
      throw new UsageError(`the graph holds no record of a repository named ${JSON.stringify(repositoryName)}; the run that filled this database read nothing of it`);
    }
    const keyToName = new Map<string, string>();
    const graphNodes = new Map<string, Map<string, GraphEntity>>();
    for (const entity of entities) {
      try {
        const name = naturalKeyOf({ kind: entity.kind, key: entity.key, label: entity.label, properties: entity.properties });
        keyToName.set(entity.key, name);
        const held = graphNodes.get(entity.kind) ?? new Map<string, GraphEntity>();
        held.set(name, entity);
        graphNodes.set(entity.kind, held);
      } catch (error) {
        unmapped.push({ kind: entity.kind, key: entity.key, reason: (error as Error).message });
      }
    }

    // Every edge of every relation the producers declare, and of every relation the reference uses.
    const relations = new Set<string>([...EXTRACTOR_RELATIONS.keys(), ...STAGE_EDGE_TYPES.map((relation) => relation.key), ...reference.edges.map((edge) => edge.relation)]);
    const graphEdges = new Map<string, Map<string, RelationEdge>>();
    for (const relation of [...relations].sort()) {
      const edges = await reader.relationEdges(relation, 100_000);
      const held = new Map<string, RelationEdge>();
      for (const edge of edges.rows) {
        const own = edge.properties['repository'];
        if (typeof own === 'string' && own !== repositoryName) continue;
        const from = keyToName.get(edge.from.key);
        const to = keyToName.get(edge.to.key);
        if (from === undefined || to === undefined) continue;
        held.set(`${from}\u0000${to}`, edge);
      }
      if (held.size > 0) graphEdges.set(relation, held);
    }

    const table: Row[] = [];
    const missing: Missing[] = [];
    const extra: Extra[] = [];

    // Nodes, by kind and by class.
    const referenceNodes = new Map<string, Map<string, ReferenceNode>>();
    for (const node of reference.nodes) {
      const held = referenceNodes.get(node.kind) ?? new Map<string, ReferenceNode>();
      held.set(node.id, node);
      referenceNodes.set(node.kind, held);
    }
    for (const kind of [...new Set([...referenceNodes.keys(), ...graphNodes.keys()])].sort()) {
      const refs = referenceNodes.get(kind) ?? new Map<string, ReferenceNode>();
      const held = graphNodes.get(kind) ?? new Map<string, GraphEntity>();
      for (const className of [STATIC, JUDGEMENT]) {
        const wanted = [...refs.values()].filter((node) => classOf(node.reading) === className);
        const truePositives = wanted.filter((node) => held.has(node.id)).length;
        const precision = share(truePositives, held.size);
        const recall = share(truePositives, wanted.length);
        table.push({ name: kind, kind: 'node', label: className, class: className, reference: wanted.length, graph: held.size, truePositives, precision, recall, f1: f1Of(precision, recall) });
      }
      for (const node of refs.values()) {
        if (!held.has(node.id)) missing.push({ kind, id: node.id, label: node.label, reading: node.reading, evidence: node.evidence });
      }
      for (const [name, entity] of held) {
        if (!refs.has(name)) extra.push({ kind, id: name, key: entity.key, label: entity.label, place: placeOf(entity) });
      }
    }

    // Edges, by relation and by class; the identity of an edge is its relation and both ends.
    const referenceEdges = new Map<string, Map<string, ReferenceEdge>>();
    for (const edge of reference.edges) {
      const held = referenceEdges.get(edge.relation) ?? new Map<string, ReferenceEdge>();
      held.set(`${edge.from}\u0000${edge.to}`, edge);
      referenceEdges.set(edge.relation, held);
    }
    for (const relation of [...new Set([...referenceEdges.keys(), ...graphEdges.keys()])].sort()) {
      const refs = referenceEdges.get(relation) ?? new Map<string, ReferenceEdge>();
      const held = graphEdges.get(relation) ?? new Map<string, RelationEdge>();
      for (const className of [STATIC, JUDGEMENT]) {
        const wanted = [...refs.values()].filter((edge) => classOf(edge.reading) === className);
        const truePositives = wanted.filter((edge) => held.has(`${edge.from}\u0000${edge.to}`)).length;
        const precision = share(truePositives, held.size);
        const recall = share(truePositives, wanted.length);
        table.push({ name: relation, kind: 'edge', label: className, class: className, reference: wanted.length, graph: held.size, truePositives, precision, recall, f1: f1Of(precision, recall) });
      }
      for (const edge of refs.values()) {
        if (!held.has(`${edge.from}\u0000${edge.to}`)) missing.push({ kind: relation, id: `${edge.from} -> ${edge.to}`, label: '', reading: edge.reading, evidence: edge.evidence });
      }
      for (const [name, edge] of held) {
        if (!refs.has(name)) {
          const [from, to] = name.split('\u0000') as [string, string];
          extra.push({ kind: relation, id: `${from} -> ${to}`, key: edge.properties['discriminator'] === undefined ? '' : String(edge.properties['discriminator']), label: '', place: edgePlace(edge) });
        }
      }
    }

    // Kinds the graph holds that the reference leaves out by design.
    const excluded: { kind: string; count: number; reason: string }[] = [];
    for (const [kind, count] of [...byDesign.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      excluded.push({ kind, count, reason: reasonFor(kind) });
    }
    for (const [kind, held] of [...graphNodes.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      if (referenceNodes.has(kind)) continue;
      excluded.push({ kind, count: held.size, reason: reasonFor(kind) });
    }
    return { table, missing, extra, excluded, unmapped, scope: `${repositoryName} (${repositoryNode})` };
  } finally {
    await owner.close();
  }
}

/** The repository a record says it was read from. */
function repositoryOf(entity: GraphEntity): string | undefined {
  const own = entity.properties['repository'];
  if (typeof own === 'string') return own;
  const provenance = entity.properties['provenance'];
  if (provenance !== null && typeof provenance === 'object') {
    const repository = (provenance as Record<string, unknown>)['repository'];
    if (repository !== null && typeof repository === 'object') {
      const id = (repository as Record<string, unknown>)['id'];
      if (typeof id === 'string') return id;
    }
  }
  return undefined;
}

function edgePlace(edge: RelationEdge): string {
  const span = edge.properties['span'];
  if (span !== null && typeof span === 'object') {
    const path = (span as Record<string, unknown>)['path'];
    const line = (span as Record<string, unknown>)['lineStart'];
    if (typeof path === 'string' && typeof line === 'number') return `${path}:${String(line)}`;
  }
  const file = edge.properties['file'];
  return typeof file === 'string' ? file : '—';
}

/** Why the reference does not state a kind the graph holds: the mapping's own reason, or the by-design list. */
const BY_DESIGN: Readonly<Record<string, string>> = {
  'code.binding': 'internal: a name a declaration binds',
  'code.call': 'internal: a call site',
  'code.callable': 'internal: the callables a file declares',
  'code.comment': 'internal: a comment',
  'code.coverage': 'internal: the bytes a stage read',
  'code.deploy-unit': 'internal: a deployment unit of neither Dockerfile nor compose form',
  'code.directory': 'internal: a directory, a containment intermediate',
  'code.export': 'internal: a name a file exports',
  'code.expression': 'internal: one expression',
  'code.env-read': 'internal: one place a file reads one variable',
  'code.http-route': 'internal: one registration, from which the endpoint is made',
  'code.link-target': 'internal: what a document link names',
  'code.listener-port': 'internal: a port a file\'s code listens on',
  'code.logger-use': 'internal: one place a file uses a logger',
  'code.mention': 'internal: one place a file writes a name',
  'code.metric-exposition': 'internal: the exposition a callable writes',
  'code.rank': 'internal: an importance the modules stage measures',
  'code.schema-reading': 'internal: one place a table\'s use cites',
  'code.service-unit': 'internal: the unit a file belongs to',
  'code.storage-evidence': 'internal: one file\'s evidence of a database',
  'code.test': 'internal: a test the operations reading names (the reference states code.test-case)',
};

function reasonFor(kind: string): string {
  return BY_DESIGN[kind] ?? 'the reference leaves this kind out by design';
}

function number(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

function report(result: Result): void {
  console.log(`Reference graph against the filled graph, at the repository scope ${result.scope}.`);
  console.log(`A row is a kind of node or a relation, split by the reference entry's reading: ${STATIC} is what a static fill can reach, ${JUDGEMENT} is what a reader decides.`);
  console.log('');
  console.log(['name', 'entry', 'reading', 'ref', 'graph', 'tp', 'precision', 'recall', 'f1'].join('\t'));
  for (const row of result.table) {
    console.log([row.name, row.kind, row.label, String(row.reference), String(row.graph), String(row.truePositives), number(row.precision), number(row.recall), number(row.f1)].join('\t'));
  }
  console.log('');
  console.log(`Missing: ${String(result.missing.length)} reference entries the graph does not hold.`);
  for (const entry of result.missing) console.log(`MISSING\t${entry.kind}\t${entry.id}\t${entry.reading}\t${places(entry.evidence)}`);
  console.log('');
  console.log(`Extra: ${String(result.extra.length)} graph records the reference does not state.`);
  for (const entry of result.extra) console.log(`EXTRA\t${entry.kind}\t${entry.id}\t${entry.place}`);
  console.log('');
  console.log(`Excluded: ${String(result.excluded.length)} kinds the graph holds that the reference leaves out by design.`);
  for (const entry of result.excluded) console.log(`EXCLUDED\t${entry.kind}\t${String(entry.count)}\t${entry.reason}`);
  console.log('');
  if (result.unmapped.length > 0) {
    console.log(`Unmapped: ${String(result.unmapped.length)} graph records the one mapping function cannot name.`);
    for (const entry of result.unmapped.slice(0, 40)) console.log(`UNMAPPED\t${entry.kind}\t${entry.key}\t${entry.reason}`);
  }
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${resolve(process.argv[1] ?? 'scripts/score-reference-graph.ts')}:1: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
