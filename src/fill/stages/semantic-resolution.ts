/**
 * Stage 4 of the fill (decision 0026, "semantic resolution"; decision 0033's
 * "The file is the unit of static work"): what a file's names mean. The stage
 * reads the mentions and imports the file pass published, resolves each mention
 * by bounded graph queries, and publishes the `call`, `reference` and
 * `inheritance` edges those mentions fold into, a positioned occurrence per
 * resolved mention, and the file's coverage.
 *
 * **The unit reads no bytes.** A mention is the file pass's reading of a place
 * (decision 0033, item 14: "symbols with global names, mentions, imports as
 * written, gaps"): the syntax stage publishes one `code.mention` node per place,
 * hung from the file's node, and the import its name is bound by as the file
 * wrote it. This stage reads its file's node by key, its mentions and its own
 * symbols through bounded pages of one neighbourhood each, and each bound name by
 * global name — the graph, resolved per file by querying it by global name (item
 * 14; item 5's capability boundary). No symbol table of a module, a tree or a
 * repository is built: what a unit holds is its own file's symbols, its own
 * file's mentions, and one answer per name it asks about.
 *
 * **What resolves.** A mention names a symbol of the repository when the name is
 *
 * 1. a declaration of the file the mention stands in — stage 3's `symbol` nodes
 *    of that file, nearest in scope first (the rule `resolution-facts.ts`
 *    states, which the extract driver's compiler-index path still uses);
 * 2. an import of the file whose specifier answers a file of this repository:
 *    the symbol the target file declares under the name the import binds, asked
 *    for by its global name (`<repository>:<path>#<name>`), the `default` one
 *    for a default import, and the member's name for `ns.name`;
 * 3. nothing, where the name is a parameter, a global, a built-in, or an import
 *    of a package outside the repository: those are outside this reader's claim,
 *    and no edge is drawn to a guess.
 *
 * **What a resolution writes.** A mention this stage claims and cannot tie to a
 * symbol — a relative specifier that names no file, a target file that declares
 * no such name, a mention standing in no symbol of the file — is a coverage gap
 * with its own place (`src/a.ts:3:14`), which is what "not enough data" means
 * (0005). A mention folded into a pair of symbols is one edge per pair and
 * relation, carrying the count of the places it stands for; each resolved
 * mention is one positioned `code.occurrence` edge from the file to the symbol,
 * which is the evidence a reader follows back to the bytes.
 *
 * **The plan reads what the previous runs published.** A unit stands for a
 * source file whose resolution coverage is absent or names another blob than the
 * pinned commit holds, for a file that imports a file whose blob moved or that
 * the commit no longer holds (its names stand on that file's symbols), for a
 * file whose specifier answers a different file now (`movedBySpecifiers`, the
 * helper stage 3's own plan calls), and for a published file the commit no longer
 * holds, whose unit publishes nothing and retracts what it wrote.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import {
  isRepositoryPath, makeNodeFact, repositoryPath, FACT_KINDS,
  type CoverageGap, type CoverageValue, type FactRange, type FactSource, type RepositoryPath, type SymbolKind,
} from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { evidenceAtPlace, refuseRow, rowRecord, unknownKeys } from './draft.js';
import { rolesFor } from './inventory.js';
import { mentionRowsIn, MENTION_NODE_KIND, MENTION_RELATION, type MentionRow } from './mention-graph.js';
import { EDGE_OF_USE, innermostSymbol, nearestDeclaration, topLevelSymbol, type ResolutionSymbolRow } from './resolution-facts.js';
import type { ExtractedResolutionMention } from './resolution-extract.js';
import {
  STATIC_READ_ROW_LIMIT, staticGraphRead, type StaticGraphNode, type StaticStageContext,
} from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf, type StaticEdgeDraft, type StaticNodeDraft } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import {
  movedBySpecifiers, publishedGapRows, publishedGapsRead, publishedImportRows, publishedImportsRead,
} from './syntax-specifiers.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
export const SEMANTIC_RESOLUTION_STAGE_ID = 'semantic-resolution';

/** The stage's own version, bumped when what it writes or plans changes. */
export const SEMANTIC_RESOLUTION_STAGE_VERSION = 2;

/** The fact kinds the stage produces, in code point order. */
export const SEMANTIC_RESOLUTION_STAGE_KINDS: readonly string[] = ['call', 'coverage', 'inherits', 'occurrence', 'reference'];

/**
 * The reader every fact of this stage cites as its source: this fill's own
 * reading of what a file binds and mentions. The bytes were read by stage 3;
 * this stage read the graph, and its edges say what the graph answered.
 */
const RESOLUTION_SOURCE: FactSource = { system: 'madarch-resolution', version: '2' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_RESOLVED_READ = 'stage-4-published-resolution';

/** The read of one repository's published resolutions. */
export function publishedResolvedRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_RESOLVED_READ, repository });
}

/** One row of that read: one file this stage resolved, at the blob its bytes stood under, and the files it read. */
export interface PublishedResolvedRow {
  readonly kind: 'coverage';
  readonly file: string;
  readonly blob: string;
  readonly read: readonly string[];
}

/** The keys a row of that read holds, and no others. */
const RESOLVED_ROW_FIELDS: readonly string[] = ['blob', 'file', 'kind', 'read'];

/** The node kinds this stage reads back: the file pass's symbols and mentions, and its own coverage. */
const SYMBOL_NODE_KIND = 'code.symbol';

/** The relation a file's symbols hang from the file by, as the file pass publishes them (`defines`). */
const DEFINES_RELATION = 'code.contains';

/** The relation each folded edge kind is published as, in the extractors' vocabulary (decision 0033, item 7). */
const RELATION_OF_EDGE: Readonly<Record<'call' | 'inherits' | 'reference', string>> = {
  call: 'code.calls',
  inherits: 'code.inherits',
  reference: 'code.references',
};

/** The fact kind each relation stands for, so a folded edge's properties name the fact it is (as the file pass's do). */
const FACT_OF_RELATION: Readonly<Record<string, string>> = {
  'code.calls': 'call',
  'code.inherits': 'inherits',
  'code.references': 'reference',
};

/** The most rows one page of a unit's neighbourhood read answers; the cap a static read may not widen. */
const PAGE = STATIC_READ_ROW_LIMIT;

/**
 * The stage, built over the source that holds the run's pins: `plan` reads the
 * published tree, the imports and this stage's own resolutions; each unit reads
 * one file's mentions and symbols from the graph and resolves them.
 */
export function createSemanticResolutionStage(sources: SnapshotSource): FillStage {
  return {
    id: SEMANTIC_RESOLUTION_STAGE_ID,
    version: SEMANTIC_RESOLUTION_STAGE_VERSION,
    staticReading: true,
    // The file nodes stage 0 published are what the plan compares blobs against; the
    // mentions stage 3 published are what every unit resolves, and its import edges say
    // which files a unit's answer stands on. A graph without them is a resolution with
    // nothing to resolve, which the registry reports as starvation rather than a stage
    // that writes edges to nodes nobody published.
    consumes: {
      required: [
        { capability: 'file', scope: 'repository', freshness: 'current' },
        { capability: 'import', scope: 'repository', freshness: 'current' },
        { capability: 'mention', scope: 'file', freshness: 'current' },
        { capability: 'symbol', scope: 'file', freshness: 'current' },
      ],
      optional: [],
    },
    // A unit's publication replaces only that unit's facts (0027): its edges hang from
    // a symbol of its own file and end at a symbol the graph holds, and its coverage
    // carries its own reader's identity, so no other stage's node is corrected.
    produces: [
      { kind: 'call', schemaVersion: FACT_KINDS['call'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'inherits', schemaVersion: FACT_KINDS['inherits'].version, scope: 'file' },
      { kind: 'occurrence', schemaVersion: FACT_KINDS['occurrence'].version, scope: 'file' },
      { kind: 'reference', schemaVersion: FACT_KINDS['reference'].version, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planResolution(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeResolutionUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(SEMANTIC_RESOLUTION_STAGE_ID, SEMANTIC_RESOLUTION_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run of the resolution fills, in code point order of the unit
 * ids, so two runs of one commit plan the same units in the same order.
 */
async function planResolution(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const importsRead = publishedImportsRead(pin.id);
    const imports = publishedImportRows(await graph.query(importsRead), pin.id, importsRead);
    const gapsRead = publishedGapsRead(pin.id);
    const gaps = publishedGapRows(await graph.query(gapsRead), pin.id, gapsRead);
    const resolvedRead = publishedResolvedRead(pin.id);
    const resolved = publishedResolvedRows(await graph.query(resolvedRead), pin.id, resolvedRead);
    // What this stage's own last run resolved, by file: the blob it resolved and the
    // files it read. A target it already read is one its edges already name, so the
    // specifier rule below plans that file once and not on every run of one commit.
    const resolvedBlob = new Map<string, string>(resolved.map((row) => [row.file, row.blob]));
    const readOf = new Map<string, ReadonlySet<string>>(resolved.map((row) => [row.file, new Set(row.read)]));
    const mine = reader.files().filter((entry) => isSourcePath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    const held = new Set<string>(reader.files().map((entry) => String(entry.path)));
    // A source file whose resolution is absent or stood on another blob is one this run
    // plans; a file whose file node does not stand yet is the run's re-plan wave, and a
    // published path the commit no longer holds is the retraction of a resolved file.
    const moved = new Set<string>();
    for (const entry of mine) {
      if (resolvedBlob.get(entry.path) === entry.id) continue;
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      moved.add(entry.path);
    }
    for (const path of resolvedBlob.keys()) if (!present.has(path) && isSourcePath(path)) moved.add(path);
    const again = new Set(moved);
    // A file whose resolution read another file stands on that file's symbols: a read
    // target whose blob moved, or that the commit no longer holds, re-plans the reader.
    // The read list is this stage's own record — the files it asked the graph about — so
    // the rule follows what the resolution really read and not what an import edge says.
    for (const row of resolved) {
      if (!present.has(row.file)) continue;
      for (const read of row.read) {
        if (read === row.file) continue;
        if (!present.has(read) || moved.has(read)) again.add(row.file);
      }
    }
    // The two rules about a specifier whose answer moved, which stage 3's plan calls for
    // its own gap and edge, bounded by this stage's own last reading.
    for (const path of movedBySpecifiers({
      repository: pin.id,
      paths: held,
      published: tree.files.keys(),
      imports,
      gaps,
      answered: (file, target) => readOf.get(file)?.has(target) === true,
    })) {
      again.add(path);
    }
    for (const path of again) {
      if (!present.has(path)) continue;
      if (!tree.files.has(path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, path), scope: `${pin.id}:${path}` });
    }
    for (const path of resolvedBlob.keys()) {
      // A published source path the commit no longer holds: the unit publishes nothing,
      // and the publication retracts what an earlier run wrote for it.
      if (present.has(path) || !isSourcePath(path)) continue;
      units.push({ id: fileUnitId(pin.id, path), scope: `${pin.id}:${path}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** Whether a path is a file this stage resolves: the inventory's own rule, the role the path names. */
function isSourcePath(path: string): boolean {
  return rolesFor(path).includes('source');
}

// ---- one unit ------------------------------------------------------------

/** One symbol of the unit's file, as the graph answered it: the node's key and the row the scope rules read. */
interface FileSymbol {
  readonly key: string;
  readonly row: ResolutionSymbolRow;
}

/** One place a mention resolved, before the edges are folded. */
interface Site {
  readonly mention: MentionRow;
  readonly from: string;
  readonly to: string;
  readonly relation: string;
}

/**
 * One unit: the source file the unit names, resolved against the graph. A path
 * the commit no longer holds publishes nothing, so an earlier run's edges and
 * coverage for a file that was deleted or renamed away are retracted by the
 * publication itself.
 */
async function executeResolutionUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const source = staticSourceOf(unit, context);
  refuseWhenCancelled(unit, context);
  const repository = planned.repository;
  const path = planned.path;
  const fileKey = fileFactIdOf(repository, path);
  const fileRead = staticGraphRead({ kind: 'key', value: fileKey, limit: 2 });
  const files = await source.byKey(fileKey, { limit: 2 });
  if (files.length === 0) {
    // No file node stands at the path: the commit does not hold it (a retraction), or
    // the snapshot has not published it. The unit publishes nothing, which ends what an
    // earlier run wrote for a file that left the tree.
    context.progress(`${path} of ${repository} stands at no node of the graph (the read ${fileRead}): this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  if (files.length > 1) {
    throw new Error(`the read ${fileRead} answered ${String(files.length)} current nodes, and one key names one node: two nodes under the key ${JSON.stringify(fileKey)} of ${path} in ${repository} are a corrupt graph, never a choice (decision 0028; src/fill/stages/semantic-resolution.ts)`);
  }
  const file = files[0]!;
  if (file.kind !== 'code.file') {
    throw new Error(`the key ${JSON.stringify(fileKey)} of ${path} in ${repository} stands on a ${JSON.stringify(file.kind)} node, and a resolution reads the file's own node: the snapshot stage publishes one code.file node per path (src/fill/stages/semantic-resolution.ts)`);
  }
  refuseWhenCancelled(unit, context);
  const mentionPages = await neighbourhoodPages(source, file.id, MENTION_RELATION);
  const symbolPages = await neighbourhoodPages(source, file.id, DEFINES_RELATION);

  const held: FileSymbol[] = [];
  // The file pass's `defines` edges name its symbols, and another stage's `code.contains` edges
  // from the same file name what it declares (the data-model stage's tables and migrations): only
  // a symbol node is a symbol of the file this unit resolves (madarch-8bdc.2.4).
  for (const page of symbolPages) for (const node of page.rows) if (node.kind === SYMBOL_NODE_KIND) held.push(symbolOf(node, path, page.read));
  const rows = held.map((symbol) => symbol.row);
  const mentions: MentionRow[] = [];
  for (const page of mentionPages) mentions.push(...mentionRowsIn(page.rows, page.read));
  const keyOfId = new Map<string, string>(held.map((symbol) => [symbol.row.id, symbol.key]));

  /** One cross-file answer, asked once per global name in a unit and kept for the unit's own scope. */
  const asked = new Map<string, FileSymbol | undefined>();
  const byGlobalName = async (name: string): Promise<FileSymbol | undefined> => {
    const kept = asked.get(name);
    if (kept !== undefined) return kept;
    const read = staticGraphRead({ kind: 'globalName', value: name, limit: PAGE });
    const answered = await source.byGlobalName(name, { limit: PAGE });
    // A file may declare one name twice (an enum and a type of one name, two overloads): the
    // graph holds one symbol per declaration, and the name names the first of them in code
    // point order of the keys — the rule `topLevelSymbol` applies to a file's own symbols, so
    // the same file answers the same symbol here as it does there.
    const held = answered.map((node) => symbolOf(node, undefined, read)).sort((left, right) => byCodePoint(left.key, right.key));
    const found = held[0];
    asked.set(name, found);
    return found;
  };

  const sites: Site[] = [];
  const gaps: CoverageGap[] = [];
  const readFiles = new Set<string>([path]);
  let unresolved = 0;
  for (const mention of mentions) {
    if (mention.parameterBound) continue;
    const place = `${path}:${String(mention.range.startLine)}:${String(mention.range.startColumn)}`;
    const target = await targetOfMention(mention, repository, rows, byGlobalName, readFiles);
    if (target.kind === 'out-of-claim') continue;
    if (target.kind === 'unresolved') {
      unresolved += 1;
      gaps.push({ what: `${mention.name} at ${place}, ${target.why}`, reason: 'unsupported' });
      continue;
    }
    // The caller: the innermost symbol of this file whose own span holds the mention.
    const caller = innermostSymbol(rows, mention.range.startLine, mention.range.startColumn);
    const from = caller === undefined ? undefined : keyOfId.get(caller.id);
    if (from === undefined) {
      unresolved += 1;
      gaps.push({ what: `${mention.name} at ${place}, whose ${mention.use} stands in no symbol this file declares`, reason: 'unsupported' });
      continue;
    }
    sites.push({ mention, from, to: target.symbol.key, relation: RELATION_OF_EDGE[EDGE_OF_USE[mention.use]!] });
  }

  // A coverage's gaps are one per place, in code point order of what they say: the fact
  // schema fixes that order, and a file whose mentions are read in source order is not in
  // it (the training repository's `index.ts` and `token.mjs` show both).
  const unread = [...new Map(gaps.map((gap) => [gap.what, gap])).values()].sort((left, right) => byCodePoint(left.what, right.what));
  const coverage: CoverageValue = {
    repository,
    scope: path,
    complete: unread.length === 0,
    read: [...readFiles].sort(byCodePoint),
    unread,
  };
  const commit = source.repository.commit;
  const evidence = evidenceAtPlace({ repository, commit }, path);
  for (const write of resolutionWrites({ repository, commit, path, fileKey, sites, coverage, blob: blobOf(file), evidence })) {
    context.draft.write(write);
  }
  const calls = sites.filter((site) => site.relation === 'code.calls').length;
  const references = sites.filter((site) => site.relation === 'code.references').length;
  const inherits = sites.filter((site) => site.relation === 'code.inherits').length;
  context.progress(
    `resolved ${path} of ${repository} at ${commit}: ${String(sites.length)} ${sites.length === 1 ? 'mention' : 'mentions'} tied to a symbol (${String(calls)} ${calls === 1 ? 'call' : 'calls'}, ${String(references)} ${references === 1 ? 'reference' : 'references'}, ${String(inherits)} inherited), ${String(unresolved)} unresolved, ${String(readFiles.size - 1)} other ${readFiles.size - 1 === 1 ? 'file' : 'files'} asked by global name`,
    1,
  );
  return { outcome: 'draft' };
}

/** What resolving one mention answered: a symbol, a claim this reader does not make, or a failure with its reason. */
type MentionAnswer =
  | { readonly kind: 'resolved'; readonly symbol: FileSymbol }
  | { readonly kind: 'out-of-claim' }
  | { readonly kind: 'unresolved'; readonly why: string };

/** The file and the name an import binds a mention to, as the file pass recorded it. */
type BoundTarget =
  | { readonly kind: 'target'; readonly target: string; readonly name: string; readonly what: string }
  | { readonly kind: 'out-of-claim' }
  | { readonly kind: 'unresolved'; readonly why: string };

/**
 * The symbol one mention names: by the file's own declarations (nearest in scope,
 * then top-level), then by the import its name is bound by, asked for by global
 * name. `ns.name` is resolved through the namespace binding's file, and never by
 * a declaration of this file.
 */
async function targetOfMention(
  mention: MentionRow,
  repository: string,
  rows: readonly ResolutionSymbolRow[],
  byGlobalName: (name: string) => Promise<FileSymbol | undefined>,
  readFiles: Set<string>,
): Promise<MentionAnswer> {
  if (mention.through === undefined) {
    const declared = nearestDeclaration(rows, mentionAsExtracted(mention)) ?? topLevelSymbol(rows, mention.name);
    if (declared !== undefined) {
      const held = rows.find((row) => row.id === declared.id);
      if (held === undefined) {
        return { kind: 'unresolved', why: `the scope rule named the symbol ${JSON.stringify(declared.id)}, which the symbols read from the file do not hold` };
      }
      return { kind: 'resolved', symbol: { key: held.id, row: held } };
    }
  }
  const bound = boundTargetOf(mention);
  if (bound.kind !== 'target') return bound;
  readFiles.add(bound.target);
  const found = await byGlobalName(`${repository}:${bound.target}#${bound.name}`);
  if (found === undefined) {
    return { kind: 'unresolved', why: `${bound.what} ${JSON.stringify(bound.name)}, and the file ${JSON.stringify(bound.target)} declares no symbol of that name` };
  }
  if (found.row.file !== repositoryPath(bound.target)) {
    throw new Error(`the global name ${JSON.stringify(`${repository}:${bound.target}#${bound.name}`)} answered the symbol ${JSON.stringify(found.key)}, which is declared in ${JSON.stringify(found.row.file)}: a global name names a symbol of one file (decision 0033, item 14; src/fill/stages/semantic-resolution.ts)`);
  }
  return { kind: 'resolved', symbol: found };
}

/** The file and the name the import a mention is bound by names; a namespace member, a default and a named import alike. */
function boundTargetOf(mention: MentionRow): BoundTarget {
  const binding = mention.binding;
  if (binding === undefined) return { kind: 'out-of-claim' };
  if (mention.through !== undefined) {
    if (binding.form !== 'namespace') return { kind: 'out-of-claim' };
    return { kind: 'target', target: binding.target, name: binding.name ?? mention.name, what: `the namespace ${JSON.stringify(mention.through)} names` };
  }
  // A namespace binding names a module, and the schema holds no symbol for a module:
  // a bare mention of it names nothing an edge can end at.
  if (binding.form === 'namespace') return { kind: 'out-of-claim' };
  const wanted = binding.form === 'named' ? binding.name : 'default';
  if (wanted === undefined) return { kind: 'unresolved', why: `the import ${JSON.stringify(binding.specifier)} binds ${JSON.stringify(binding.local)} to no named export` };
  return { kind: 'target', target: binding.target, name: wanted, what: `the import ${JSON.stringify(binding.specifier)} binds ${JSON.stringify(binding.local)} to` };
}

/** A mention as the scope rules read it: the name, the use and the place it stands at. */
function mentionAsExtracted(mention: MentionRow): ExtractedResolutionMention {
  return {
    name: mention.name,
    use: mention.use,
    access: mention.access === 'write-access' ? 'write-access' : 'read-access',
    span: {
      startLine: mention.range.startLine,
      startColumn: mention.range.startColumn,
      endLine: mention.range.endLine,
      endColumn: mention.range.endColumn,
      startByte: mention.range.startByte ?? 0,
      endByte: mention.range.endByte ?? 0,
    },
    ...(mention.through === undefined ? {} : { through: mention.through }),
    parameterBound: mention.parameterBound,
  };
}

/** One symbol node read back: the key the graph holds it under and the row the scope rules read. */
function symbolOf(node: StaticGraphNode, path: string | undefined, read: string): FileSymbol {
  if (node.kind !== SYMBOL_NODE_KIND) {
    throw new Error(`the read ${read} answered a ${JSON.stringify(node.kind)} node (${node.id}) where it answers a file's own symbols: a symbol is a ${JSON.stringify(SYMBOL_NODE_KIND)} node (src/fill/stages/semantic-resolution.ts)`);
  }
  const held = node.properties;
  const key = textOf(held['recordKey'], 'recordKey', node.id, read);
  const qualifiedName = textOf(held['qualifiedName'], 'qualifiedName', node.id, read);
  const file = textOf(held['file'], 'file', node.id, read);
  if (!isRepositoryPath(file)) {
    throw new Error(`the read ${read} answered the symbol node ${node.id}, and its file ${JSON.stringify(file)} is no repository path (src/fill/stages/semantic-resolution.ts)`);
  }
  if (path !== undefined && file !== path) {
    throw new Error(`the read ${read} answered the symbol node ${node.id}, which is declared in ${JSON.stringify(file)}, and the read was for the symbols of ${JSON.stringify(path)}: one read is one file's symbols (src/fill/stages/semantic-resolution.ts)`);
  }
  const symbolKind = textOf(held['symbolKind'], 'symbolKind', node.id, read);
  return {
    key,
    row: {
      id: key,
      file: repositoryPath(file),
      qualifiedName,
      symbolKind: symbolKind as SymbolKind,
      range: rangeOf(node, read),
    },
  };
}

/** The declaration range a symbol node carries, from the place its fact was read at. */
function rangeOf(node: StaticGraphNode, read: string): FactRange {
  const provenance = node.properties['provenance'];
  const place = provenance === null || typeof provenance !== 'object' ? undefined : (provenance as Record<string, unknown>)['place'];
  const range = place === null || typeof place !== 'object' ? undefined : (place as Record<string, unknown>)['range'];
  const held = range === null || typeof range !== 'object' || Array.isArray(range) ? undefined : range as Record<string, unknown>;
  if (held === undefined) {
    throw new Error(`the read ${read} answered the symbol node ${node.id} with no place.range, and a symbol's declaration range is what tells the nearest declaration of a mention (src/fill/stages/semantic-resolution.ts)`);
  }
  const out = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    const value = held[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`the read ${read} answered the symbol node ${node.id}, and its place.range.${field} is ${JSON.stringify(value)}: a range is whole numbers from 0 (src/fill/stages/semantic-resolution.ts)`);
    }
    out[field] = value;
  }
  if (out.endLine < out.startLine) {
    throw new Error(`the read ${read} answered the symbol node ${node.id}, and its range ends on line ${String(out.endLine)} and starts on line ${String(out.startLine)}: a range's end is never before its start (src/fill/stages/semantic-resolution.ts)`);
  }
  return out;
}

/** A non-empty text at a field of a node, or the refusal naming the node, the field and the read. */
function textOf(value: unknown, field: string, nodeId: string, read: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`the read ${read} answered the node ${nodeId}, and its ${field} is ${JSON.stringify(value)}: this is a non-empty text there (src/fill/stages/semantic-resolution.ts)`);
  }
  return value;
}

/** The blob the file node names: what this stage's plan compares against the pinned commit. */
function blobOf(file: StaticGraphNode): string {
  const held = file.properties['blob'];
  if (typeof held !== 'string' || held === '') {
    throw new Error(`the file node ${file.id} carries no blob, and the plan is what tells one reading of a file from the next: the snapshot stage publishes the blob a file stood under (src/fill/stages/semantic-resolution.ts)`);
  }
  return held;
}

/** One page of one neighbourhood, with the read text the orchestrator recorded it under. */
interface NeighbourhoodPage {
  readonly rows: readonly StaticGraphNode[];
  readonly read: string;
}

/**
 * Every page of one neighbourhood of the file's node, read through the unit's
 * bounded context: each page is its own query, recorded as its own dependency,
 * and the stage asks for the next one until the graph answers no cursor. The
 * rows are the reader's own — a page is never widened, and a list is never
 * truncated.
 */
async function neighbourhoodPages(source: StaticStageContext, nodeId: string, relation: string): Promise<readonly NeighbourhoodPage[]> {
  const pages: NeighbourhoodPage[] = [];
  let after: string | undefined;
  for (;;) {
    const options = { relations: [relation], direction: 'out' as const, limit: PAGE, ...(after === undefined ? {} : { after }) };
    const page = await source.neighbourhood(nodeId, options);
    pages.push({
      rows: page.rows,
      read: staticGraphRead({ kind: 'neighbourhood', value: nodeId, limit: PAGE, relations: [relation], direction: 'out', ...(after === undefined ? {} : { after }) }),
    });
    if (page.next === null) return pages;
    after = page.next;
  }
}

/** What one unit's draft writes: an occurrence per resolved mention, its folded edges, and the file's coverage. */
function resolutionWrites(input: {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly fileKey: string;
  readonly sites: readonly Site[];
  readonly coverage: CoverageValue;
  readonly blob: string;
  readonly evidence: string;
}): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [];
  const folded = new Map<string, { readonly relation: string; readonly from: string; readonly to: string; readonly use: string; count: number; span: FactRange }>();
  for (const site of input.sites) {
    const range = site.mention.range;
    if (range.startByte === undefined || range.endByte === undefined) {
      throw new Error(`the mention ${JSON.stringify(site.mention.key)} of ${input.path} carries no byte span, and a code.occurrence is a positioned relation: the file pass's own span gives one (src/fill/stages/semantic-resolution.ts)`);
    }
    writes.push({
      kind: 'edge',
      evidence: input.evidence,
      value: {
        relation: 'code.occurrence',
        from: { key: input.fileKey },
        to: { key: site.to },
        position: { start: range.startByte, end: range.endByte },
        properties: {
          factKind: 'occurrence',
          repository: input.repository,
          file: input.path,
          mention: site.mention.key,
          name: site.mention.name,
          use: site.mention.use,
          roles: [site.mention.access],
          precision: 'syntactic',
        },
      },
    });
    const identity = `${site.relation}\u0000${site.from}\u0000${site.to}`;
    const held = folded.get(identity);
    if (held === undefined) folded.set(identity, { relation: site.relation, from: site.from, to: site.to, use: site.mention.use, count: 1, span: range });
    else {
      held.count += 1;
      // The edge names the first place it was read at, as the extract driver's own fold keeps it: a call site's
      // place is what a reader follows back to the bytes (src/extract/code/index.ts, `fold`).
      if ((range.startByte ?? 0) < (held.span.startByte ?? 0)) (held as { span: FactRange }).span = range;
    }
  }
  for (const edge of folded.values()) {
    const factKind = FACT_OF_RELATION[edge.relation]!;
    writes.push({
      kind: 'edge',
      evidence: input.evidence,
      value: {
        relation: edge.relation,
        from: { key: edge.from },
        to: { key: edge.to },
        properties: {
          factKind,
          repository: input.repository,
          file: input.path,
          use: edge.use,
          count: edge.count,
          precision: 'syntactic',
          span: { path: input.path, byteStart: edge.span.startByte, byteEnd: edge.span.endByte, lineStart: edge.span.startLine, lineEnd: edge.span.endLine },
        },
      },
    });
  }
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: RESOLUTION_SOURCE, repository: { id: input.repository, commit: input.commit } },
    value: input.coverage,
  });
  for (const write of graphWritesOf(fact, input.evidence)) {
    // The blob the plan compares against the pinned commit stands on the coverage node, as
    // stage 3's coverage carries it: the file node's blob is every reading's, and this one
    // says which reading of the file this resolution stands on.
    writes.push(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob: input.blob } } }
      : write);
  }
  return writes;
}

/** The unit's static repository, refused by name where the run handed none: a static unit reads only through its own context. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the resolution stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/semantic-resolution.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands, and a unit that has read nothing is no draft: an empty publication retracts what the unit wrote before. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it resolved the pinned file: a cancelled unit publishes nothing`);
  }
}

// ---- reading a read's rows ------------------------------------------------

/**
 * The plan's own read, read: each row is one file's coverage as this stage
 * published it, the blob its bytes stood under, and the files it read. A row
 * naming another kind, a file that is no repository path, a blob that is no blob
 * id, a list of paths that is not one, or a key this read does not define is
 * refused, naming the read, the row and the field.
 */
export function publishedResolvedRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedResolvedRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'what a file\'s resolution read');
    unknownKeys(held, RESOLVED_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || !isRepositoryPath(file)) {
      throw refuseRow(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a coverage stands for a file of the repository`);
    }
    const blob = held['blob'];
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) {
      throw refuseRow(read, index, repository, `its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    }
    const readFiles = held['read'];
    if (!Array.isArray(readFiles)) {
      throw refuseRow(read, index, repository, `its read ${JSON.stringify(readFiles)} is no list of paths: a coverage names the files its resolution read`);
    }
    const paths = readFiles.map((entry, at) => {
      if (typeof entry !== 'string' || !isRepositoryPath(entry)) {
        throw refuseRow(read, index, repository, `its read[${String(at)}] ${JSON.stringify(entry)} is no repository path`);
      }
      return entry;
    });
    return { kind: 'coverage', file, blob, read: paths };
  });
}

