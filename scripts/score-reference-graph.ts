#!/usr/bin/env bun
/**
 * `bun scripts/score-reference-graph.ts <reference folder> <repository folder> <graph database>`
 * — the training score of a filled graph against the reference graph, matched by
 * place.
 *
 *   bun scripts/score-reference-graph.ts <reference folder> <repository folder> <graph database>
 *   … [--json]
 *
 * The reference says where a fact stands (the lines its evidence cites) and the
 * graph says where a record stands (its span, or the place of its provenance).
 * The match (`scripts/reference-graph-by-place.ts`) pairs them by kind, file and
 * overlapping lines — never by spelling. Where several records of a kind
 * overlap one entry, the one whose own name the entry states wins; otherwise the
 * entry is matched once, to the nearest place, and the match is counted as
 * ambiguous for its kind. A record that states no place is counted per kind as
 * `no place`; a fact with no file at all (a commit, a task, an author, the
 * repository) is matched by the identity it states — `IDENTITY_KINDS` lists them
 * and why. An edge matches when its relation is equal and both ends are records
 * matched to the entries the edge names.
 *
 * The name-only match the first scorer used is kept as a second set of columns,
 * for comparison.
 *
 * Three optional things of the reference are honoured: `scored: false` on an
 * entry or an edge (out of every count, reported as a total), `scope` on an edge
 * (`direct` is scored, any other value is reported apart), and a `SCORING.md` at
 * the reference's root listing `recall: yes` or `recall: no` per kind and
 * relation (a `no` prints `n/a` for recall).
 *
 * The scorer names no repository: the repository is the folder it is given, and
 * the graph's records are the ones that say that name.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { byCodePoint } from '../src/model/order.js';
import { EXTRACTOR_RELATIONS } from '../src/extract/vocabulary.js';
import { STAGE_EDGE_TYPES } from '../src/extract/code/stage-vocabulary.js';
import { GraphReader, type GraphEntity, type RelationEdge } from '../src/knowledge/graph-read.js';
import { NAMED_KINDS, naturalKeyOf } from './reference-graph-natural-key.js';
import {
  catalogEdgeOf, catalogKindOf, catalogNameOf, catalogRelationOf, kindMappingOf, relationMappingOf,
  type CanonicalEdge,
} from './reference-graph-catalog.js';
import {
  IDENTITY_KINDS, matchEdges, matchNodes, placeOfProperties, readScoring,
  type GraphEdge, type NodeRecord, type ReferenceEdge, type ReferenceEntry, type Scoring,
} from './reference-graph-by-place.js';

const USAGE = 'usage: bun scripts/score-reference-graph.ts <reference folder> <repository folder> <graph database> [--json]';

/**
 * The database owner and the graph's reader, loaded by a path the import graph
 * does not resolve: a scorer is a one-off measurement of a database file, like
 * `scripts/extract-truth-audit.ts`, and the architecture rule keeps a
 * connection out of every module the product serves — this script serves
 * nothing.
 */
const engine = join(import.meta.dir, '..');
const load = async (path: string) => await import(pathToFileURL(join(engine, path)).href);
const { createPGliteDatabaseOwner } = await load('src/adapters/database-owner.ts') as typeof import('../src/adapters/database-owner.js');
type DatabaseOwner = import('../src/adapters/database-owner.js').DatabaseOwner;

class UsageError extends Error {}

interface EvidenceItem {
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly command?: string;
}

interface ReferenceNode extends ReferenceEntry {
  readonly label: string;
  readonly reading: string;
  readonly evidence: readonly EvidenceItem[];
}

interface ReferenceEdgeEntry extends ReferenceEdge {
  readonly reading: string;
  readonly evidence: readonly EvidenceItem[];
}

interface Row {
  readonly name: string;
  readonly kind: 'node' | 'edge';
  readonly class: string;
  readonly reference: number;
  readonly graph: number;
  readonly truePositives: number;
  /** The graph's records of this row that are no true positive: `graph` is `truePositives + extra`. */
  readonly extra: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly nameReference: number;
  readonly nameGraph: number;
  readonly nameTruePositives: number;
  readonly namePrecision: number | null;
  readonly nameRecall: number | null;
  readonly noPlace: number;
  readonly ambiguous: number;
  readonly recallScored: boolean;
}

interface Missing {
  readonly kind: string;
  readonly id: string;
  readonly reading: string;
  readonly evidence: readonly EvidenceItem[];
}

interface Extra {
  readonly kind: string;
  readonly key: string;
  readonly label: string;
  readonly place: string;
  /** For an edge, the table row it counts in: an edge states no reading, so its extra is the row that holds it. */
  readonly class?: string;
}

interface Result {
  readonly repository: string;
  readonly scope: string;
  readonly table: readonly Row[];
  readonly missing: readonly Missing[];
  readonly extra: readonly Extra[];
  readonly excluded: readonly { readonly kind: string; readonly count: number; readonly reason: string }[];
  readonly excludedRelations: readonly { readonly relation: string; readonly count: number; readonly reason: string }[];
  readonly edgesApart: readonly { readonly kind: string; readonly count: number }[];
  readonly noPlace: readonly { readonly kind: string; readonly count: number }[];
  readonly ambiguous: readonly { readonly kind: string; readonly entries: number; readonly records: number }[];
  readonly identity: readonly { readonly kind: string; readonly property: string; readonly why: string; readonly matched: number }[];
  readonly scopedApart: readonly { readonly scope: string; readonly count: number }[];
  readonly unscored: { readonly nodes: number; readonly edges: number };
  readonly outOfScope: readonly { readonly name: string; readonly reference: number; readonly graph: number; readonly why: string }[];
  readonly mappings: readonly {
    readonly sort: 'kind' | 'relation';
    readonly extractor: string;
    readonly catalog: string;
    readonly direction: 'same' | 'inverse';
  }[];
  readonly totals: Readonly<Record<string, Readonly<Record<string, {
    reference: number; graph: number; truePositives: number; extra: number;
    nameReference: number; nameGraph: number; nameTruePositives: number;
  }>>>>;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const words: string[] = [];
  let json = false;
  for (const argument of argv) {
    if (argument === '--json') json = true;
    else if (argument.startsWith('--')) throw new UsageError(`the argument ${JSON.stringify(argument)} is not one this command knows; --help lists them`);
    else words.push(argument);
  }
  if (words.length !== 3) throw new UsageError(USAGE);
  const [referenceFolder, repositoryFolder, database] = words as [string, string, string];
  const result = await score(resolve(referenceFolder), resolve(repositoryFolder), resolve(database));
  if (json) console.log(JSON.stringify(result, null, 2));
  else report(result);
  return 0;
}

function readReference(root: string): { nodes: ReferenceNode[]; edges: ReferenceEdgeEntry[]; scoring: Map<string, Scoring> } {
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.yaml')) files.push(path);
    }
  };
  walk(root);
  const nodes: ReferenceNode[] = [];
  const edges: ReferenceEdgeEntry[] = [];
  for (const file of files) {
    const held = parseYaml(readFileSync(file, 'utf8')) as { nodes?: ReferenceNode[]; edges?: ReferenceEdgeEntry[] } | null;
    if (held === null) continue;
    nodes.push(...(held.nodes ?? []));
    edges.push(...(held.edges ?? []));
  }
  const scoringFile = join(root, 'SCORING.md');
  return { nodes, edges, scoring: existsSync(scoringFile) ? readScoring(readFileSync(scoringFile, 'utf8')) : new Map() };
}

function places(evidence: readonly EvidenceItem[]): string {
  return evidence.map((item) => item.command !== undefined ? `\`${item.command}\`` : `${item.path ?? '?'}:${String(item.startLine ?? '?')}${item.endLine !== item.startLine ? `-${String(item.endLine ?? '?')}` : ''}`).join(', ');
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function f1Of(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null || precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

/** The record's own name: from its record fields, its own properties, its global name's tail, or its label. */
function nameOf(entity: GraphEntity): string | undefined {
  const inner = entity.properties['record'];
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    const name = (inner as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.length > 0) return name;
  }
  const own = entity.properties['name'];
  if (typeof own === 'string' && own.length > 0) return own;
  const global = entity.properties['globalName'];
  if (typeof global === 'string') {
    const hash = global.lastIndexOf('#');
    if (hash >= 0) return global.slice(hash + 1);
  }
  return entity.label.length > 0 ? entity.label : undefined;
}

/** The identity a record of an identity kind states. */
function identityOf(entity: GraphEntity): string | undefined {
  const held = IDENTITY_KINDS[entity.kind];
  if (held === undefined) return undefined;
  const own = entity.properties[held.property];
  if (typeof own === 'string' && own.length > 0) return own;
  const inner = entity.properties['record'];
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    const value = (inner as Record<string, unknown>)[held.property];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** The place a record states, by the module's one rule. */
function placeOfEntity(entity: GraphEntity): { path: string; startLine: number; endLine: number } | undefined {
  return placeOfProperties(entity.kind, entity.properties);
}

/** Where a record stands, as a report prints it. */
function placeText(entity: GraphEntity): string {
  const place = placeOfEntity(entity);
  return place === undefined ? '—' : `${place.path}:${String(place.startLine)}`;
}

/** Which repository a record says it was read from. */
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

function classOf(reading: string): string {
  return reading === 'judgement' ? 'judgement' : 'parsed+declared';
}

/** An edge of the graph in the comparison's vocabulary, as the table scores one relation of it. */
export interface GraphEdgeRow {
  readonly relation: string;
  readonly class: string;
  readonly reference: number;
  readonly graph: number;
  readonly truePositives: number;
  readonly extra: number;
}

/** A reference edge the match scores: its relation and ends in the catalog's vocabulary, and its class. */
export interface ScoredReferenceEdge {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
  readonly class: string;
}

/** The graph edges the table does not count in any row, by the kind they touch. */
export interface EdgeApart {
  readonly kind: string;
  readonly count: number;
}

/**
 * Splits the graph's edges at the kinds the reference scores. An edge with an end
 * whose kind the reference keeps apart (it states no entry of that kind) is
 * reported in `apart` and is never in scope: it counts in neither side of a
 * relation, which is what its kind's own absence means. The edges in scope are
 * distinct by relation and ends.
 */
export function classifyEdges(
  edges: readonly CanonicalEdge[],
  kindOf: ReadonlyMap<string, string>,
  referenceKinds: ReadonlySet<string>,
): { readonly inScope: readonly CanonicalEdge[]; readonly apart: readonly EdgeApart[] } {
  const inScope: CanonicalEdge[] = [];
  const seen = new Set<string>();
  const apart = new Map<string, number>();
  for (const edge of edges) {
    const fromKind = kindOf.get(edge.from) ?? '';
    const toKind = kindOf.get(edge.to) ?? '';
    if (!referenceKinds.has(fromKind) || !referenceKinds.has(toKind)) {
      const kind = !referenceKinds.has(fromKind) ? fromKind : toKind;
      apart.set(kind === '' ? '—' : kind, (apart.get(kind === '' ? '—' : kind) ?? 0) + 1);
      continue;
    }
    const key = `${edge.relation}\u0000${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inScope.push(edge);
  }
  return {
    inScope,
    apart: [...apart.entries()].map(([kind, count]) => ({ kind, count })).sort((left, right) => byCodePoint(left.kind, right.kind)),
  };
}

/** One graph edge no reference edge of its relation explains, and the table row it counts in. */
export interface ExtraEdge extends CanonicalEdge {
  readonly class: string;
}

/**
 * The table's relation rows, and the graph edges no reference edge explains.
 *
 * A graph edge is a true positive when both of its ends are records the match
 * paired with reference entries and the reference states that edge: the first
 * such graph edge in code point order is the reference edge's witness, and a
 * second one that names the same reference edge is an extra, since one reference
 * fact has one witness. Every other edge in scope is an extra: the reference
 * states no edge between its ends.
 *
 * An edge states no reading of its own (a record of the graph carries none), so
 * an extra counts in the parsed+declared row when the relation has one there,
 * and in the judgement row when the reference states the relation only as a
 * judgement. A row's graph is therefore its true positives plus its extras, and
 * an edge the reference keeps apart is in neither: `classifyEdges` never puts it
 * in scope.
 */
export function edgeRowCounts(input: {
  readonly inScope: readonly CanonicalEdge[];
  readonly relations: readonly string[];
  readonly referenceEdges: readonly ScoredReferenceEdge[];
  readonly matched: ReadonlySet<string>;
  readonly recordToEntry: ReadonlyMap<string, string>;
}): { readonly rows: readonly GraphEdgeRow[]; readonly extras: readonly ExtraEdge[] } {
  const keyOf = (edge: CanonicalEdge): string => `${edge.relation}\u0000${edge.from}\u0000${edge.to}`;
  const sorted = [...input.inScope].sort((left, right) => byCodePoint(left.relation, right.relation) || byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to));
  const classOfReference = new Map<string, string>();
  const hasParsed = new Map<string, boolean>();
  for (const edge of input.referenceEdges) {
    const key = keyOf(edge);
    if (!classOfReference.has(key)) classOfReference.set(key, edge.class);
    hasParsed.set(edge.relation, (hasParsed.get(edge.relation) ?? false) || edge.class === 'parsed+declared');
  }
  const witnesses = new Set<string>();
  const witnessClass = new Map<string, string>();
  const extras: ExtraEdge[] = [];
  for (const edge of sorted) {
    const key = keyOf(edge);
    const from = input.recordToEntry.get(edge.from);
    const to = input.recordToEntry.get(edge.to);
    const reference = from === undefined || to === undefined ? undefined : `${edge.relation}\u0000${from}\u0000${to}`;
    const held = reference === undefined ? undefined : classOfReference.get(reference);
    if (reference !== undefined && held !== undefined && input.matched.has(reference) && !witnesses.has(reference)) {
      witnesses.add(reference);
      witnessClass.set(key, held);
      continue;
    }
    extras.push({ ...edge, class: hasParsed.get(edge.relation) === true ? 'parsed+declared' : 'judgement' });
  }
  const rows: GraphEdgeRow[] = [];
  for (const relation of [...input.relations].sort(byCodePoint)) {
    const held = sorted.filter((edge) => edge.relation === relation);
    const mine = extras.filter((edge) => edge.relation === relation);
    for (const className of ['parsed+declared', 'judgement']) {
      const truePositives = held.filter((edge) => witnessClass.get(keyOf(edge)) === className).length;
      const extra = mine.filter((edge) => edge.class === className).length;
      rows.push({
        relation, class: className,
        reference: input.referenceEdges.filter((edge) => edge.relation === relation && edge.class === className).length,
        graph: truePositives + extra, truePositives, extra,
      });
    }
  }
  return { rows, extras };
}

/** Whether an edge is scored at all: not `scored: false`, and its scope direct or absent. */
function scoredEdge(edge: ReferenceEdge): boolean {
  return edge.scored !== false && (edge.scope === undefined || edge.scope === 'direct');
}

async function score(referenceRoot: string, repositoryFolder: string, database: string): Promise<Result> {
  if (!existsSync(database)) throw new UsageError(`${database}: no such graph database`);
  if (!existsSync(referenceRoot)) throw new UsageError(`${referenceRoot}: no such reference folder`);
  const reference = readReference(referenceRoot);
  const repository = basename(repositoryFolder);
  const owner: DatabaseOwner = createPGliteDatabaseOwner({ path: database, btreeGist: true });
  try {
    const instant = new Date().toISOString();
    const reader = new GraphReader(owner, () => instant);
    const entities: GraphEntity[] = [];
    let scope = '';
    for (const { kind } of await reader.kindCounts()) {
      let after: string | undefined;
      for (;;) {
        const page = await reader.list(kind, { limit: 500, ...(after === undefined ? {} : { after }) });
        for (const entity of page.rows) {
          if (repositoryOf(entity) !== repository) continue;
          if (kind === 'code.repository') scope = entity.nodeIds[0] ?? '';
          entities.push(entity);
        }
        if (page.next === null) break;
        after = page.next;
      }
    }
    if (entities.length === 0) throw new UsageError(`the graph holds no record of a repository named ${JSON.stringify(repository)}: its records say which repository they were read from, and none says this one`);

    // Both sides are read in the catalog's vocabulary: every kind and relation is
    // resolved through the mapping, and a key without a row is compared as written.
    const originalKindOfRecord = new Map<string, string>(entities.map((entity) => [entity.key, entity.kind]));
    const matchEntries: ReferenceEntry[] = reference.nodes.map((node) => ({
      id: node.id,
      kind: catalogKindOf(node.kind),
      evidence: node.evidence,
      ...(node.scored === false ? { scored: false as const } : {}),
    }));
    const originalKindOfEntry = new Map<string, string>(reference.nodes.map((node) => [node.id, node.kind]));

    const records: NodeRecord[] = entities.map((entity) => {
      const name = nameOf(entity);
      const identity = identityOf(entity);
      const place = placeOfEntity(entity);
      return {
        key: entity.key,
        kind: catalogKindOf(entity.kind),
        ...(name === undefined ? {} : { name }),
        ...(place === undefined ? {} : { place }),
        ...(identity === undefined ? {} : { identity }),
      };
    });
    const match = matchNodes(matchEntries, records);

    // The names a reference's SCORING.md keeps out of every count (`scored: no`),
    // in the catalog's vocabulary.
    const scoring = new Map<string, Scoring>();
    for (const [name, held] of reference.scoring) scoring.set(catalogNameOf(name), held);
    const scoredOut = new Set([...scoring.entries()].filter(([, held]) => held.scored === false).map(([name]) => name));
    const allKinds = new Set([...matchEntries.map((entry) => entry.kind), ...records.map((record) => record.kind)]);
    const outOfScopeKinds = new Set([...scoredOut].filter((name) => allKinds.has(name)));

    // Every edge the graph holds, of every relation the producers declare, in the
    // catalog's vocabulary.
    const relations = [...new Set([...EXTRACTOR_RELATIONS.keys(), ...STAGE_EDGE_TYPES.map((relation) => relation.key), ...reference.edges.map((edge) => edge.relation)])].sort();
    const rawGraphEdges: { relation: string; from: string; to: string; row: RelationEdge }[] = [];
    for (const relation of relations) {
      const found = await reader.relationEdges(relation, 100_000);
      for (const edge of found.rows) {
        const own = edge.properties['repository'];
        if (typeof own === 'string' && own !== repository) continue;
        rawGraphEdges.push({ relation, from: edge.from.key, to: edge.to.key, row: edge });
      }
    }
    const graphEdgeOf = (edge: { relation: string; from: string; to: string }): CanonicalEdge => catalogEdgeOf(edge.relation, edge.from, edge.to);
    const graphEdgeRows = new Map<string, RelationEdge>();
    for (const edge of rawGraphEdges) {
      const held = graphEdgeOf(edge);
      graphEdgeRows.set(`${held.relation}\u0000${held.from}\u0000${held.to}`, edge.row);
    }
    const canonicalGraphRelations = new Set(rawGraphEdges.map((edge) => graphEdgeOf(edge).relation));

    // A relation the reference keeps out of every count, as SCORING.md says.
    const outOfScopeRelations = new Set([...scoredOut].filter((name) => canonicalGraphRelations.has(name) || reference.edges.some((edge) => catalogRelationOf(edge.relation) === name)));
    // An edge is comparable only when both of its ends are records of kinds the
    // reference states; an edge that touches a kind the reference leaves out by
    // design is reported apart, like the record itself.
    const referenceKindsForEdges = new Set(matchEntries.map((entry) => entry.kind).filter((kind) => !outOfScopeKinds.has(kind)));
    const kindOfKey = new Map<string, string>(records.map((record) => [record.key, record.kind]));
    const comparable = rawGraphEdges
      .filter((edge) => !outOfScopeRelations.has(graphEdgeOf(edge).relation))
      .map((edge) => graphEdgeOf(edge));
    const { inScope, apart: edgesApart } = classifyEdges(comparable, kindOfKey, referenceKindsForEdges);
    // An edge that touches an entry `scored: false` leaves every count too.
    const unscoredNodes = new Set(reference.nodes.filter((node) => node.scored === false).map((node) => node.id));
    const unscoredEdges = new Set(reference.edges.filter((edge) => edge.scored === false || unscoredNodes.has(edge.from) || unscoredNodes.has(edge.to)));
    const scoredReferenceEdges = reference.edges.filter((edge) => !unscoredEdges.has(edge));
    const canonicalReferenceEdges = scoredReferenceEdges.map((edge) => ({ ...graphEdgeOf(edge), original: edge }));
    const edgeMatch = matchEdges(
      canonicalReferenceEdges.map((edge) => ({ relation: edge.relation, from: edge.from, to: edge.to, reading: edge.original.reading, evidence: edge.original.evidence, ...(edge.original.scored === false ? { scored: false as const } : {}), ...(edge.original.scope === undefined ? {} : { scope: edge.original.scope }) })),
      inScope,
      match.recordToEntry,
    );
    // The rows' own accounting: a relation's graph is its true positives and its
    // extras, and an edge the reference keeps apart (`edgesApart`) is in neither.
    const accounting = edgeRowCounts({
      inScope,
      relations: [...new Set(canonicalReferenceEdges.map((edge) => edge.relation))].filter((relation) => !outOfScopeRelations.has(relation)),
      referenceEdges: canonicalReferenceEdges
        .filter((edge) => scoredEdge(edge.original))
        .map((edge) => ({ relation: edge.relation, from: edge.from, to: edge.to, class: classOf(edge.original.reading) })),
      matched: edgeMatch.matched,
      recordToEntry: match.recordToEntry,
    });

    // The name-only match, for comparison: the natural id of a record against the
    // entry's id, grouped in the catalog's vocabulary.
    const nameKey = new Map<string, string>();
    for (const entity of entities) {
      if (!NAMED_KINDS.has(entity.kind)) continue;
      try {
        nameKey.set(entity.key, naturalKeyOf({ kind: entity.kind, key: entity.key, label: entity.label, properties: entity.properties }));
      } catch { /* a record the naming function cannot name has no name column */ }
    }
    const namesByKind = new Map<string, Set<string>>();
    for (const entity of entities) {
      const name = nameKey.get(entity.key);
      if (name === undefined) continue;
      const held = namesByKind.get(entity.kind) ?? new Set<string>();
      held.add(name);
      namesByKind.set(entity.kind, held);
    }
    const nameFound = new Set<string>();
    for (const node of reference.nodes) {
      if (node.scored === false) continue;
      if (namesByKind.get(node.kind)?.has(node.id) === true) nameFound.add(node.id);
    }
    const nameEdgesHeld = new Set<string>();
    for (const edge of inScope) {
      const from = nameKey.get(edge.from);
      const to = nameKey.get(edge.to);
      if (from === undefined || to === undefined) continue;
      nameEdgesHeld.add(`${edge.relation}\u0000${from}\u0000${to}`);
    }
    const originalKindsOf = (catalog: string): string[] => [...new Set(reference.nodes.map((node) => node.kind).concat(entities.map((entity) => entity.kind)).filter((kind) => catalogKindOf(kind) === catalog))];

    // The names a reference's SCORING.md keeps out of every count (`scored: no`).
    const referenceKinds = new Set(matchEntries.map((entry) => entry.kind).filter((kind) => !outOfScopeKinds.has(kind)));
    const table: Row[] = [];
    const missing: Missing[] = [];
    const extra: Extra[] = [];
    const ambiguous: { kind: string; entries: number; records: number }[] = [];
    const noPlace: { kind: string; count: number }[] = [];

    // Nodes, by kind and by class: a kind the reference never uses is reported
    // apart (it is left out by design), never scored.
    const kinds = [...referenceKinds].sort();
    for (const kind of kinds) {
      const entries = matchEntries.filter((entry) => entry.kind === kind && entry.scored !== false);
      const held = entities.filter((entity) => catalogKindOf(entity.kind) === kind);
      const originals = originalKindsOf(kind);
      const names = originals.reduce((sum, original) => sum + (namesByKind.get(original)?.size ?? 0), 0);
      const ambiguity = match.ambiguous.get(kind);
      if (ambiguity !== undefined) ambiguous.push(ambiguity);
      const unplaced = match.noPlace.get(kind);
      if (unplaced !== undefined) noPlace.push({ kind, count: unplaced });
      for (const className of ['parsed+declared', 'judgement']) {
        const wanted = entries.filter((entry) => classOf(reference.nodes.find((node) => node.id === entry.id)?.reading ?? 'parsed') === className);
        const tp = wanted.filter((entry) => match.entryToRecord.has(entry.id)).length;
        const tpName = wanted.filter((entry) => nameFound.has(entry.id)).length;
        const precision = share(tp, held.length);
        const recall = share(tp, wanted.length);
        table.push({
          name: kind, kind: 'node', class: className,
          reference: wanted.length, graph: held.length, truePositives: tp, extra: held.length - tp,
          precision, recall, f1: f1Of(precision, recall),
          nameReference: wanted.length, nameGraph: names, nameTruePositives: tpName,
          namePrecision: share(tpName, names), nameRecall: share(tpName, wanted.length),
          noPlace: unplaced ?? 0,
          ambiguous: ambiguity?.entries ?? 0,
          recallScored: scoring.get(kind)?.recall !== false,
        });
      }
      for (const entry of entries) {
        if (!match.entryToRecord.has(entry.id)) {
          const node = reference.nodes.find((held2) => held2.id === entry.id)!;
          missing.push({ kind, id: entry.id, reading: node.reading, evidence: node.evidence });
        }
      }
      for (const entity of held) {
        if (match.recordToEntry.has(entity.key)) continue;
        if (placeOfEntity(entity) === undefined) continue; // counted under `no place`
        extra.push({ kind, key: entity.key, label: entity.label, place: placeText(entity) });
      }
    }

    // Relations, by relation and by class, in the catalog's vocabulary.
    const referenceRelations = new Set(canonicalReferenceEdges.map((edge) => edge.relation).filter((relation) => !outOfScopeRelations.has(relation)));
    const relationsHeld = [...referenceRelations].sort();
    const extraCount = new Map<string, number>();
    for (const entry of accounting.extras) {
      const key = `${entry.relation}\u0000${entry.class}`;
      extraCount.set(key, (extraCount.get(key) ?? 0) + 1);
    }
    for (const relation of relationsHeld) {
      for (const className of ['parsed+declared', 'judgement']) {
        const edges = canonicalReferenceEdges.filter((edge) => edge.relation === relation && scoredEdge(edge.original) && classOf(edge.original.reading) === className);
        const row = accounting.rows.find((held) => held.relation === relation && held.class === className);
        if (row === undefined) continue;
        const tpName = edges.filter((edge) => nameEdgesHeld.has(`${edge.relation}\u0000${edge.from}\u0000${edge.to}`)).length;
        const precision = share(row.truePositives, row.graph);
        const recall = share(row.truePositives, edges.length);
        table.push({
          name: relation, kind: 'edge', class: className,
          reference: edges.length, graph: row.graph, truePositives: row.truePositives, extra: row.extra,
          precision, recall, f1: f1Of(precision, recall),
          nameReference: edges.length,
          nameGraph: [...nameEdgesHeld].filter((key) => key.startsWith(`${relation}\u0000`)).length,
          nameTruePositives: tpName,
          namePrecision: share(tpName, [...nameEdgesHeld].filter((key) => key.startsWith(`${relation}\u0000`)).length),
          nameRecall: share(tpName, edges.length),
          noPlace: 0, ambiguous: 0,
          recallScored: scoring.get(relation)?.recall !== false,
        });
        for (const edge of edges) {
          if (!edgeMatch.matched.has(`${edge.relation}\u0000${edge.from}\u0000${edge.to}`)) {
            missing.push({ kind: relation, id: `${edge.original.from} -> ${edge.original.to}`, reading: edge.original.reading, evidence: edge.original.evidence });
          }
        }
      }
    }
    for (const entry of accounting.extras) {
      const row = graphEdgeRows.get(`${entry.relation}\u0000${entry.from}\u0000${entry.to}`);
      extra.push({ kind: entry.relation, key: `${entry.from} -> ${entry.to}`, label: '', place: row === undefined ? '—' : edgePlace(row), class: entry.class });
    }

    // Kinds the graph holds that the reference leaves out by design.
    const excluded: { kind: string; count: number; reason: string }[] = [];
    const byKind = new Map<string, number>();
    for (const entity of entities) {
      const kind = catalogKindOf(entity.kind);
      if (!referenceKinds.has(kind)) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    for (const [kind, count] of [...byKind.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      excluded.push({ kind, count, reason: reasonFor(kind) });
    }

    const excludedRelations: { relation: string; count: number; reason: string }[] = [];
    const edgesByRelation = new Map<string, number>();
    for (const edge of inScope) if (!referenceRelations.has(edge.relation)) edgesByRelation.set(edge.relation, (edgesByRelation.get(edge.relation) ?? 0) + 1);
    for (const [relation, count] of [...edgesByRelation.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      excludedRelations.push({ relation, count, reason: 'the reference states no edge of this relation' });
    }
    const outOfScope: { name: string; reference: number; graph: number; why: string }[] = [];
    for (const [name, held] of [...outOfScopeKinds].map((kind) => [kind, entities.filter((entity) => catalogKindOf(entity.kind) === kind).length] as const).sort(([left], [right]) => (left < right ? -1 : 1))) {
      outOfScope.push({
        name,
        reference: matchEntries.filter((entry) => entry.kind === name).length,
        graph: held,
        why: scoring.get(name)?.why ?? 'the reference keeps this kind out of every count',
      });
    }
    for (const [name, held] of [...outOfScopeRelations].map((relation) => [relation, rawGraphEdges.filter((edge) => graphEdgeOf(edge).relation === relation).length] as const).sort(([left], [right]) => (left < right ? -1 : 1))) {
      outOfScope.push({
        name,
        reference: reference.edges.filter((edge) => catalogRelationOf(edge.relation) === name).length,
        graph: held,
        why: scoring.get(name)?.why ?? 'the reference keeps this relation out of every count',
      });
    }
    const identity = Object.entries(IDENTITY_KINDS).map(([kind, held]) => ({ kind, property: held.property, why: held.why, matched: match.identity.get(kind) ?? 0 }));
    const scopedApart = [...edgeMatch.scopedApart.entries()].map(([heldScope, count]) => ({ scope: heldScope, count })).sort((left, right) => (left.scope < right.scope ? -1 : 1));
    const unscored = { nodes: unscoredNodes.size, edges: unscoredEdges.size };

    // Which mappings the comparison used, as a list: every key either side names
    // that the mapping ties, with its catalog name and direction.
    const mappings: Result['mappings'][number][] = [];
    const seenKinds = new Map<string, string>();
    for (const node of reference.nodes) seenKinds.set(node.kind, 'kind');
    for (const entity of entities) seenKinds.set(entity.kind, 'kind');
    for (const edge of reference.edges) seenKinds.set(edge.relation, 'relation');
    for (const edge of rawGraphEdges) seenKinds.set(edge.relation, 'relation');
    for (const [key, sort] of seenKinds) {
      const kindRow = kindMappingOf(key);
      if (kindRow !== undefined) { mappings.push({ sort: 'kind', extractor: kindRow.extractor, catalog: kindRow.catalog, direction: 'same' }); continue; }
      const relationRow = relationMappingOf(key);
      if (relationRow !== undefined) mappings.push({ sort: 'relation', extractor: relationRow.extractor, catalog: relationRow.catalog, direction: relationRow.direction });
    }
    mappings.sort((left, right) => (left.sort === right.sort ? (left.extractor < right.extractor ? -1 : left.extractor > right.extractor ? 1 : 0) : left.sort === 'kind' ? -1 : 1));

    return { repository, scope, table, missing, extra, excluded, excludedRelations, edgesApart, noPlace, ambiguous, identity, scopedApart, unscored, outOfScope, mappings, totals: totalsOf(table) };
  } finally {
    await owner.close();
  }
}

function totalsOf(table: readonly Row[]): Result['totals'] {
  const out: Record<string, Record<string, { reference: number; graph: number; truePositives: number; extra: number; nameReference: number; nameGraph: number; nameTruePositives: number }>> = {};
  for (const kind of ['node', 'edge'] as const) {
    out[kind] = {};
    for (const className of ['parsed+declared', 'judgement']) {
      const rows = table.filter((row) => row.kind === kind && row.class === className);
      out[kind]![className] = {
        reference: rows.reduce((sum, row) => sum + row.reference, 0),
        graph: rows.reduce((sum, row) => sum + row.graph, 0),
        truePositives: rows.reduce((sum, row) => sum + row.truePositives, 0),
        extra: rows.reduce((sum, row) => sum + row.extra, 0),
        nameReference: rows.reduce((sum, row) => sum + row.nameReference, 0),
        nameGraph: rows.reduce((sum, row) => sum + row.nameGraph, 0),
        nameTruePositives: rows.reduce((sum, row) => sum + row.nameTruePositives, 0),
      };
    }
  }
  return out;
}

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
  'code.test': 'internal: a test the operations reading names',
};

function reasonFor(kind: string): string {
  return BY_DESIGN[kind] ?? 'the reference leaves this kind out by design';
}

function number(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

function report(result: Result): void {
  console.log(`Reference against the filled graph of ${result.repository}, matched by place (scope ${result.scope}).`);
  console.log('A row is a kind or a relation: `ref` counts the reference entries of the class, `graph` the graph\'s records of the kind, `tp` the entries the match found; precision is tp/graph and recall tp/ref. The name columns give the same counts under the name-only match.');
  console.log('');
  console.log(['name', 'entry', 'reading', 'ref', 'graph', 'tp', 'precision', 'recall', 'f1', 'name ref', 'name tp', 'name recall', 'no place', 'ambiguous'].join('\t'));
  for (const row of result.table) {
    console.log([row.name, row.kind, row.class, String(row.reference), String(row.graph), String(row.truePositives), number(row.precision), row.recallScored ? number(row.recall) : 'n/a', number(row.f1), String(row.nameReference), String(row.nameTruePositives), number(row.nameRecall), String(row.noPlace), String(row.ambiguous)].join('\t'));
  }
  console.log('');
  for (const kind of ['node', 'edge'] as const) {
    for (const className of ['parsed+declared', 'judgement']) {
      const held = result.totals[kind]![className]!;
      console.log(`TOTAL ${kind} ${className}: place ref ${String(held.reference)} graph ${String(held.graph)} tp ${String(held.truePositives)} extra ${String(held.extra)}; name ref ${String(held.nameReference)} tp ${String(held.nameTruePositives)}`);
    }
  }
  console.log('');
  console.log(`Missing: ${String(result.missing.length)} reference entries the graph does not hold at their place.`);
  for (const entry of result.missing) console.log(`MISSING\t${entry.kind}\t${entry.id}\t${entry.reading}\t${places(entry.evidence)}`);
  console.log('');
  console.log(`Extra: ${String(result.extra.length)} graph records no reference entry stands at. An edge's last field is the table row it counts in.`);
  for (const entry of result.extra) console.log(`EXTRA\t${entry.kind}\t${entry.key}\t${entry.place}\t${entry.class ?? ''}`);
  console.log('');
  console.log(`Excluded: ${String(result.excluded.length)} kinds and ${String(result.excludedRelations.length)} relations the reference leaves out by design.`);
  for (const entry of result.excluded) console.log(`EXCLUDED\t${entry.kind}\t${String(entry.count)}\t${entry.reason}`);
  for (const entry of result.excludedRelations) console.log(`EXCLUDED\t${entry.relation}\t${String(entry.count)}\t${entry.reason}`);
  for (const entry of result.edgesApart) console.log(`EDGES-APART\t${entry.kind}\t${String(entry.count)}\tthe edges that touch a kind the reference leaves out`);
  console.log('');
  console.log(`No place: ${String(result.noPlace.length)} kinds hold records that state no place.`);
  for (const entry of result.noPlace) console.log(`NO-PLACE\t${entry.kind}\t${String(entry.count)}`);
  console.log('');
  console.log(`Ambiguous: ${String(result.ambiguous.length)} kinds had an entry several records overlapped and no name singled one out.`);
  for (const entry of result.ambiguous) console.log(`AMBIGUOUS\t${entry.kind}\t${String(entry.entries)} entries\t${String(entry.records)} records`);
  console.log('');
  console.log('Identity kinds: matched by the identity they state, not by a place.');
  for (const entry of result.identity) console.log(`IDENTITY\t${entry.kind}\t${entry.property}\t${String(entry.matched)} matched\t${entry.why}`);
  console.log('');
  if (result.scopedApart.length > 0) {
    console.log('Reported apart (an edge whose scope is not direct):');
    for (const entry of result.scopedApart) console.log(`SCOPED\t${entry.scope}\t${String(entry.count)}`);
  }
  console.log(`Unscored (scored: false): ${String(result.unscored.nodes)} entries, ${String(result.unscored.edges)} edges.`);
  if (result.outOfScope.length > 0) {
    console.log('Out of scope by SCORING.md (scored: no):');
    for (const entry of result.outOfScope) console.log(`OUT-OF-SCOPE\t${entry.name}\t${String(entry.reference)} reference, ${String(entry.graph)} graph\t${entry.why}`);
  }
  console.log('');
  console.log(`Mappings used: ${String(result.mappings.length)} (the catalog's vocabulary is the comparison's; a key without a row is compared as written).`);
  for (const entry of result.mappings) console.log(`MAPPING\t${entry.sort}\t${entry.extractor}\t${entry.catalog}\t${entry.direction}`);
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${resolve(process.argv[1] ?? 'scripts/score-reference-graph.ts')}: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}
