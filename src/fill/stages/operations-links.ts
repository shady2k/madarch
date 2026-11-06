/**
 * The links the operations reading makes across files, as a second static stage
 * (decision 0033, items 5, 14 and 15; madarch-8bdc.2.4).
 *
 * **Why a second stage.** The extract driver reads its areas in a fixed order
 * over one tree: the environment reads of every code file, then the definitions
 * that set the variables, then the services whose code reads them. A per-file
 * stage that published all of it at once would depend on another file's record
 * having been published first, and the plan's order is no dependency. Here the
 * order is the stage graph's: `operations` publishes each file's declarations —
 * including the place a file reads a variable (`code.env-read`) and the value a
 * file sets for one (`code.env-definition`) — and this stage runs after it, one
 * unit per file, and answers the records that name another file's record:
 *
 * - `code.env-var`: the variable, once, with the reads' own aggregate — whether
 *   any read requires it and the first default any read falls back to. Its span
 *   stands at the first read of the variable, so the unit of the file that reads
 *   it first publishes it and every other unit names it.
 * - `code.reads-env`: one edge per file and variable, at the file's first read.
 * - `code.defines`: one edge from a definition to the variable it sets, where
 *   the variable is read at all.
 *
 * **What a unit reads.** The file's own bytes are not read: what a unit needs is
 * on the graph the operations stage published, and a file this stage has already
 * linked is not planned again (its coverage names the blob it stood under).
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { makeNodeFact, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { evidenceAtPlace } from './draft.js';
import { STATIC_READ_ROW_LIMIT, type StaticGraphNode, type StaticStageContext, type StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';
import { readGoMod, readJson } from './manifest-format.js';
import { brokerAddresses, brokerOf, brokersMatching, type BrokerRow } from './operations-records.js';
import { matchesEndpoint, resolveEndpointTarget } from '../../extract/endpoint-target.js';
import type { ExtractedNode } from '../../extract/records.js';
import { HEALTH_PATHS } from './operations-observability.js';
import { symbolNodeKeyOf, publishedOperationsRows } from './operations.js';

/** The stage's id, as it is registered and as its units are named. */
const OPERATIONS_LINKS_STAGE_ID = 'operations-links';

/** The stage's own version, bumped when what it reads, plans or writes changes. */
const OPERATIONS_LINKS_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
const OPERATIONS_LINKS_STAGE_KINDS: readonly string[] = [
  'connects-to', 'contains', 'coverage', 'defines', 'env-var', 'exposes-metric', 'manifest-of', 'metrics-endpoint',
  'probes', 'reads-env', 'served-by', 'service', 'uses-logger',
];

/** The reader every fact of this stage cites: this fill's own linking of one file's records. */
const LINKS_SOURCE: FactSource = { system: 'madarch-operations-links', version: '1' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_LINKS_READ = 'stage-operations-links-published';

/** The read of one repository's published links coverage: one row per file this stage linked, at the blob it stood under. */
function publishedLinksRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_LINKS_READ, repository });
}

/** The families whose files this stage links, in the order their records are published. */
const FAMILY_RANK: Readonly<Record<string, number>> = {
  // A variable is published by the code file that reads it first, and the files that set it
  // and describe its service follow: the order is the plan's, and the stage graph is what
  // makes every one of these files wait for the declarations the operations stage published.
  code: 1,
  // A service's passport reads the variables its code reads, and those are the code files'
  // variables: the manifest that declares the service is linked after them.
  manifest: 2,
  compose: 3,
  kubernetes: 3,
  'environment': 3,
};

/** The families this stage links: the files a variable is read in, set in, or declared for. */
const FAMILIES_LINKED: readonly string[] = ['code', 'manifest', 'compose', 'kubernetes', 'environment'];

/** The stage, built over the source that holds the run's pins. */
export function createOperationsLinksStage(sources: SnapshotSource): FillStage {
  return {
    id: OPERATIONS_LINKS_STAGE_ID,
    version: OPERATIONS_LINKS_STAGE_VERSION,
    staticReading: true,
    // The operations stage's per-file declarations are what this stage links: a graph without
    // them starves it by name, and the stage graph orders the two stages.
    consumes: {
      required: [
        { capability: 'file', scope: 'repository', freshness: 'current' },
        { capability: 'env-read', scope: 'file', freshness: 'current' },
        // The endpoints are published by the operations stage's own units, so the stage graph
        // orders this one after every one of them: a registration's endpoint exists when this
        // stage links it, and the plan's order inside the stage is not what makes it exist.
        { capability: 'http-route', scope: 'file', freshness: 'current' },
        { capability: 'metric', scope: 'file', freshness: 'current' },
      ],
      optional: [],
    },
    produces: OPERATIONS_LINKS_STAGE_KINDS.map((kind) => ({ kind, schemaVersion: 1, scope: 'file' })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planLinks(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeLinksUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(OPERATIONS_LINKS_STAGE_ID, OPERATIONS_LINKS_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/** The units one run fills, in the families' order and then in code point order of the paths. */
async function planLinks(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; rank: number; path: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const linksRead = publishedLinksRead(pin.id);
    const own = publishedOperationsRows(await graph.query(linksRead), pin.id, linksRead);
    const readBlobs = new Map<string, string>(own.map((row) => [row.file, row.blob]));
    const mine = reader.files().filter((entry) => FAMILIES_LINKED.includes(familyOf(entry.path) ?? ''));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    for (const entry of mine) {
      if (readBlobs.get(entry.path) === entry.id) continue;
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), rank: FAMILY_RANK[familyOf(entry.path) ?? 'code'] ?? 9, path: entry.path, scope: `${pin.id}:${entry.path}` });
    }
    for (const row of own) {
      if (present.has(row.file)) continue;
      units.push({ id: fileUnitId(pin.id, row.file), rank: 9, path: row.file, scope: `${pin.id}:${row.file}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => left.rank - right.rank || byCodePoint(left.path, right.path));
  return { units: units.map((unit) => ({ id: unit.id, scope: unit.scope })), coverage: anySource ? 'planned' : 'nothing-found' };
}

/** The family a path belongs to, by the operations stage's own reading of its path. */
function familyOf(path: string): string | undefined {
  if (path.endsWith('.go') || /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path)) return 'code';
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'package.json' || name === 'go.mod') return path.split('/').includes('node_modules') ? undefined : 'manifest';
  if (name === '.env.example') return 'environment';
  if (name.endsWith('.yml') || name.endsWith('.yaml')) {
    const stem = name.slice(0, name.lastIndexOf('.'));
    if (stem === 'compose' || stem === 'docker-compose' || stem.startsWith('compose.') || stem.startsWith('docker-compose.')) return 'compose';
    if (path.startsWith('deploy/') || path === 'deploy') return 'kubernetes';
  }
  return undefined;
}

// ---- one unit ------------------------------------------------------------

/** One unit: the file the unit names, linked from what the operations stage published for it. */
async function executeLinksUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  const source = stage.repository;
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const gaps: CoverageGap[] = [];
  const family = familyOf(planned.path);
  let writes: readonly StageDraftWrite[] = [];
  try {
    if (family === 'code') {
      writes = [...await variableWrites(stage, planned.repository, planned.path, source.commit), ...await loggerUseWrites(stage, planned.repository, planned.path), ...await endpointWrites(stage, planned.repository, planned.path, source.commit)];
    } else if (family === 'manifest') {
      // The service passport and the endpoints it serves are one unit's records: the passport
      // is published by this unit, so the endpoint link is made from what the unit writes, not
      // from a graph read of a node this same unit has not published yet.
      const service = await serviceWrites(stage, planned.repository, planned.path, source.commit);
      writes = [...service, ...await endpointServiceWrites(stage, planned.repository, planned.path, source.commit, service.length > 0)];
    } else if (family === 'kubernetes') {
      writes = [...await definitionWrites(stage, planned.repository, planned.path), ...await probeWrites(stage, planned.repository, planned.path, source.commit)];
    } else {
      writes = await definitionWrites(stage, planned.repository, planned.path);
    }
  } catch (error) {
    gaps.push({ what: `${planned.path}:1: ${error instanceof Error ? error.message : String(error)}`, reason: 'error' });
  }
  for (const write of writes) context.draft.write(write);
  writeCoverage(context, source, planned.path, {
    repository: planned.repository,
    scope: planned.path,
    complete: gaps.length === 0,
    read: [planned.path],
    unread: gaps,
  }, entry.id);
  context.progress(`linked ${planned.path} of ${planned.repository} at ${source.commit}: ${String(writes.length)} ${writes.length === 1 ? 'write' : 'writes'}, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}`, 1);
  return { outcome: 'draft' };
}

/** One fact: a node the graph holds, by its record's own key, label, kind and properties. */
interface LinkNode {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly span: Span;
}

/** Where a record stands: the path and the byte and line range every fact carries. */
interface Span {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One environment read as the operations stage published it for a file. */
interface PublishedRead {
  readonly variable: string;
  readonly service: string;
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly required: boolean;
  readonly default: string | null;
  /** Where the read stands: the bytes and lines the operations stage published for it. */
  readonly span: Span;
}

/** Whether a name is a variable the reading keeps: an upper-case word, as the driver's own filter. */
function isVariableName(name: string): boolean {
  return /[A-Z][A-Z0-9_]+/.test(name);
}


/** One published read as this stage reads it: the record's own fields, and the span it stands at. */
function readOfNode(node: StaticGraphNode, repository: string): PublishedRead | undefined {
  const held = node.properties;
  if (held['repository'] !== repository) return undefined;
  const record = held['record'];
  if (record === null || typeof record !== 'object') return undefined;
  const value = record as Record<string, unknown>;
  const name = value['name'];
  if (typeof name !== 'string' || !isVariableName(name)) return undefined;
  const span = held['span'] as Span | undefined;
  if (span === undefined) return undefined;
  return {
    variable: String(value['variable']), service: String(value['service']), name, path: String(value['path']),
    line: Number(value['line']), symbol: typeof value['symbol'] === 'string' ? value['symbol'] : '',
    required: value['required'] === true, default: typeof value['default'] === 'string' ? value['default'] : null, span,
  };
}

/**
 * Every place one repository reads the environment, as the operations stage
 * published them, in the driver's own order: by path, then by line, then by the
 * variable's name. One paged read of the stage's own kind, and no page wider
 * than the static cap.
 */
async function readsInRepository(stage: StaticStageContext, repository: string): Promise<readonly PublishedRead[]> {
  const rows: PublishedRead[] = [];
  for (const node of await pagesOf(stage, 'code.env-read', 'repository', repository)) {
    const read = readOfNode(node, repository);
    if (read !== undefined) rows.push(read);
  }
  return rows.sort((left, right) => byCodePoint(left.path, right.path) || left.line - right.line || byCodePoint(left.name, right.name));
}

/**
 * One code file's variable records: the variable node of each variable the file
 * reads first, with the aggregate of every read of it, and the file's own
 * `reads-env` edge to it. A variable another file reads first is named and not
 * published again.
 */
async function variableWrites(stage: StaticStageContext, repository: string, path: string, commit: string): Promise<readonly StageDraftWrite[]> {
  const writes: StageDraftWrite[] = [];
  const reads = await readsInRepository(stage, repository);
  const seen = new Set<string>();
  for (const read of reads.filter((entry) => entry.path === path)) {
    if (seen.has(read.variable)) continue;
    seen.add(read.variable);
    const readers = reads.filter((entry) => entry.variable === read.variable);
    const first = readers[0];
    const key = `code.env-var:${read.variable}`;
    if (first !== undefined && first.path === path && first.line === read.line) {
      const defaults = [...new Set(readers.map((entry) => entry.default).filter((value): value is string => value !== null))].sort(byCodePoint);
      const node: LinkNode = {
        key,
        kind: 'code.env-var',
        label: read.name,
        properties: { required: readers.some((entry) => entry.required), default: defaults[0] ?? null },
        span: read.span,
      };
      writes.push(nodeWrite(node, repository, commit), containsWrite(node, repository));
    }
    writes.push(edgeWrite('code.reads-env', `code.file:${path}`, key, { symbol: read.symbol, required: read.required, default: read.default }, read.span, repository));
  }
  return writes;
}


/** The Go standard-library packages a service's passport names as what it runs on. */
const GO_STDLIB_FRAMEWORKS: readonly string[] = ['database/sql', 'net/http'];

/**
 * One manifest's service passport: the unit it declares, its language, the
 * frameworks its files and its manifest name, the infrastructure its variables
 * name, and whether the unit runs tests — the driver's stack passport
 * (`src/extract/operations/stack.ts`), read from the unit's per-file facts and
 * the variables the code files read, which the earlier units published.
 */
async function serviceWrites(stage: StaticStageContext, repository: string, path: string, commit: string): Promise<readonly StageDraftWrite[]> {
  const file = await stage.repository.file(path);
  if (file === undefined || file.content === undefined) return [];
  const text = new TextDecoder().decode(file.content);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const ecosystem = name === 'go.mod' ? 'go' : 'npm';
  // The unit the manifest declares, by the code-facts stage's own membership fact: the folder
  // the manifest stands in, its name and its root.
  const units = (await pagesOf(stage, 'code.service-unit', 'manifestPath', path)).filter((node) => node.properties['repository'] === repository);
  const declared = units.map((node) => ({ name: String(node.properties['name']), root: String(node.properties['root']), file: String(node.properties['file']) }));
  const service = declared[0]?.name;
  if (service === undefined) return [];
  const readPaths = declared.map((entry) => entry.file).sort(byCodePoint);
  const frameworks = new Set<string>();
  let testFramework: string | null = null;
  if (ecosystem === 'go') {
    // What the unit's files import of the standard library, and what the module requires: the
    // driver's own two answers, and neither is a picture of the other.
    for (const held of readPaths) {
      if (!held.endsWith('.go')) continue;
      for (const node of await pagesOf(stage, 'code.binding', 'file', held)) {
        if (node.properties['kind'] !== 'import') continue;
        const specifier = node.properties['specifier'];
        if (typeof specifier === 'string' && GO_STDLIB_FRAMEWORKS.includes(specifier)) frameworks.add(specifier);
      }
    }
    const manifest = readGoMod(text);
    if (manifest.ok) for (const required of manifest.value.requires) frameworks.add(required.path);
    frameworks.delete('');
    testFramework = readPaths.some((held) => held.endsWith('_test.go')) ? 'go test' : null;
  } else {
    const manifest = readJson(text);
    if (!manifest.ok) return [];
    const parsed = manifest.value.value as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    for (const dependency of Object.keys(parsed.dependencies ?? {})) frameworks.add(dependency);
    testFramework = parsed.devDependencies?.['jest'] !== undefined ? 'jest' : null;
  }
  const variables = new Set((await readsInRepository(stage, repository)).map((read) => read.variable));
  const infrastructure: string[] = [];
  if (variables.has(`${service}/DATABASE_URL`)) infrastructure.push('Postgres');
  if (variables.has(`${service}/KAFKA_BROKERS`)) infrastructure.push('Kafka');
  infrastructure.sort(byCodePoint);
  const node: LinkNode = {
    key: `code.service:${service}`,
    kind: 'code.service',
    label: service,
    properties: {
      language: ecosystem === 'go' ? 'go' : 'typescript',
      frameworks: [...frameworks].sort(byCodePoint),
      infrastructure,
      testFramework,
    },
    span: fileSpanOf(path, text),
  };
  const writes: StageDraftWrite[] = [nodeWrite(node, repository, commit), containsWrite(node, repository)];
  writes.push(edgeWrite('code.manifest-of', `code.manifest:${path}`, node.key, {}, node.span, repository));
  return writes;
}

/** The span of one whole file: its bytes, and the lines its text holds. */
function fileSpanOf(path: string, text: string): Span {
  return {
    path,
    byteStart: 0,
    byteEnd: new TextEncoder().encode(text).length,
    lineStart: 1,
    lineEnd: text === '' ? 1 : text.split('\n').length,
  };
}

/**
 * One definition file's `defines` edges: every environment definition it holds
 * points at the variable it sets, where the repository reads that variable. The
 * definition's own node stands in the operations stage's publication; this stage
 * names it.
 */
async function definitionWrites(stage: StaticStageContext, repository: string, path: string): Promise<readonly StageDraftWrite[]> {
  const writes: StageDraftWrite[] = [];
  const reads = await readsInRepository(stage, repository);
  const brokers = await brokersInRepository(stage, repository);
  const services = new Set((await pagesOf(stage, 'code.service', 'repository', repository)).map((node) => node.label));
  for (const node of await pagesOf(stage, 'code.env-definition', 'file', path)) {
    const held = node.properties;
    const record = held['record'];
    const scope = record !== null && typeof record === 'object' ? (record as Record<string, unknown>)['scope'] : undefined;
    const value = record !== null && typeof record === 'object' ? (record as Record<string, unknown>)['value'] : undefined;
    const name = typeof held['recordKey'] === 'string' ? held['recordKey'].slice(held['recordKey'].lastIndexOf('/') + 1) : undefined;
    const key = held['recordKey'];
    if (typeof key !== 'string' || typeof scope !== 'string' || name === undefined) continue;
    const variable = `${scope}/${name}`;
    if (!reads.some((read) => read.variable === variable)) continue;
    const span = held['span'] as Span | undefined;
    if (span === undefined) continue;
    const fromKey = key;
    writes.push(edgeWrite('code.defines', fromKey, `code.env-var:${variable}`, { value: value ?? null }, span, String(held['repository'])));
  }
  // The settings that name a broker's address also say which service talks to it
  // (`src/extract/operations/messaging.ts`): the service the setting is scoped to, and the
  // service whose code reads the variable the setting defines.
  for (const node of await pagesOf(stage, 'code.env-definition', 'file', path)) {
    const key = node.properties['recordKey'];
    if (typeof key !== 'string' || !BROKER_SETTING.test(key)) continue;
    const record = node.properties['record'];
    const value = record !== null && typeof record === 'object' ? (record as Record<string, unknown>)['value'] : undefined;
    const scope = record !== null && typeof record === 'object' ? (record as Record<string, unknown>)['scope'] : undefined;
    const span = node.properties['span'] as Span | undefined;
    if (typeof value !== 'string' || span === undefined) continue;
    for (const address of brokerAddresses(value)) {
      const candidates = brokersMatching(brokers, address);
      const broker = candidates.length === 1 ? candidates[0] : undefined;
      if (broker === undefined) continue;
      const talking = new Set<string>();
      if (typeof scope === 'string') talking.add(scope);
      const variable = key.slice(key.indexOf('#') + 1);
      const at = variable.indexOf('/');
      if (at > 0) talking.add(variable.slice(0, at));
      for (const service of talking) {
        if (!services.has(service)) continue;
        writes.push(edgeWrite('code.connects-to', `code.service:${service}`, broker.key, { address }, span, String(node.properties['repository']), address));
      }
    }
  }
  return writes;
}

/** The settings whose value names a broker's address: the driver's own two names. */
const BROKER_SETTING = /(?:KAFKA_BROKERS|KAFKA_BOOTSTRAP_SERVERS)/;

/** The brokers the earlier stage published for a repository, as the matching rule reads them. */
async function brokersInRepository(stage: StaticStageContext, repository: string): Promise<readonly BrokerRow[]> {
  const rows: BrokerRow[] = [];
  for (const node of await pagesOf(stage, 'code.broker', 'repository', repository)) {
    const held = node.properties['record'];
    const record = held !== null && typeof held === 'object' ? held as Record<string, unknown> : {};
    const key = node.properties['recordKey'];
    if (typeof key !== 'string') continue;
    const addresses = Array.isArray(record['addresses']) ? record['addresses'].map((entry) => String(entry)) : [];
    rows.push(brokerOf(key, node.label, addresses, String(record['source'] ?? '')));
  }
  return rows.sort((left, right) => byCodePoint(left.key, right.key));
}

// ---- the draft -----------------------------------------------------------

/** One node write, as every static stage writes one. */
function nodeWrite(node: LinkNode, repository: string, commit: string): StageDraftWrite {
  return {
    kind: 'node',
    evidence: `${node.span.path}:${String(node.span.lineStart)}`,
    value: {
      key: node.key,
      kind: node.kind,
      label: node.label,
      properties: {
        recordKey: node.key,
        factKind: node.kind.slice('code.'.length),
        repository,
        file: node.span.path,
        span: node.span,
        record: node.properties,
        provenance: { source: LINKS_SOURCE, repository: { id: repository, commit }, place: { file: node.span.path, range: { startLine: node.span.lineStart, endLine: node.span.lineEnd, startColumn: 0, endColumn: 0 } } },
      },
    },
  };
}

/** What a file holds, hung from the file's node: the edge the reading's own closing pass makes (madarch-m38l.16). */
function containsWrite(node: LinkNode, repository: string): StageDraftWrite {
  return {
    kind: 'edge',
    evidence: `${node.span.path}:${String(node.span.lineStart)}`,
    value: {
      relation: 'code.contains',
      from: { key: fileFactIdOf(repository, node.span.path) },
      to: { key: node.key },
      properties: { factKind: 'contains', repository, file: node.span.path, span: node.span, record: {} },
    },
  };
}

/** One edge write, as every static stage writes one. */
function edgeWrite(relation: string, from: string, to: string, properties: Readonly<Record<string, unknown>>, span: Span, repository: string, discriminator = ''): StageDraftWrite {
  return {
    kind: 'edge',
    evidence: `${span.path}:${String(span.lineStart)}`,
    value: {
      relation,
      from: from.startsWith('code.file:') ? { key: fileFactIdOf(repository, from.slice('code.file:'.length)) } : { key: from },
      to: to.startsWith('code.file:') ? { key: fileFactIdOf(repository, to.slice('code.file:'.length)) } : { key: to },
      // The store keys the edge by the discriminator, so it stands on the draft itself; the
      // properties keep the record's own copy, which the comparison reads as the driver's answer.
      ...(discriminator === '' ? {} : { discriminator }),
      properties: { factKind: relation.slice('code.'.length), repository, file: span.path, span, ...(discriminator === '' ? {} : { discriminator }), record: properties },
    },
  };
}

/** One line's span. */
function spanOfLine(path: string, line: number): Span {
  return { path, byteStart: 0, byteEnd: 0, lineStart: line, lineEnd: line };
}

/** One file's coverage: what was linked, and every place this stage could not link, with the blob the bytes stood under. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: LINKS_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob } } }
      : write);
  }
}

/** One page after another of a bounded read by property. */
async function pagesOf(stage: StaticStageContext, kind: string, field: string, value: string): Promise<readonly StaticGraphNode[]> {
  const rows: StaticGraphNode[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty(kind, field, value, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the operations links stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's answers (src/fill/stages/operations-links.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it linked the file: a cancelled unit publishes nothing (src/fill/stages/operations-links.ts)`);
  }
}


// ---- the endpoints, their links and the probes -------------------------------

/** One row of a `code.http-route` fact, as the operations stage published it. */
interface RouteRow {
  readonly path: string;
  readonly method: string;
  readonly ports: readonly string[];
  readonly service: string;
  readonly manifest: string;
  readonly handlerKey: string;
  readonly handlerIdentity: string;
  readonly handlerPath: string;
  readonly handlerSpan: Span;
  readonly handlerExpression: string;
  readonly receiverExpression: string;
  readonly statusOk: boolean;
  readonly span: Span;
}

/** One row of a `code.metric-exposition` fact. */
interface ExpositionRow {
  readonly span: Span;
  readonly path: string;
  readonly holder: string;
  readonly writerBinding: string;
  readonly metrics: readonly string[];
  readonly format: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** One record as the extract readings' node shape, which the endpoint target's rules read. */
function extractedOf(key: string, kind: 'code.probe' | 'code.health-endpoint' | 'code.metrics-endpoint' | 'code.healthcheck', label: string, properties: Readonly<Record<string, unknown>>): ExtractedNode {
  return { key, kind, label, properties: properties as ExtractedNode['properties'] };
}

/** The record a stage's node carries: every published fact keeps its own fields under `record`. */
function recordOf(node: StaticGraphNode): Readonly<Record<string, unknown>> {
  const held = node.properties['record'];
  return held !== null && typeof held === 'object' && !Array.isArray(held) ? held as Readonly<Record<string, unknown>> : {};
}

/** One row as a route, or none where the fact does not hold one. */
function routeOf(node: StaticGraphNode): RouteRow | undefined {
  const held = recordOf(node);
  const span = node.properties['span'] as Span | undefined;
  const handlerSpan = held['handlerSpan'] as Span | undefined;
  if (span === undefined || handlerSpan === undefined) return undefined;
  return {
    path: String(held['path']), method: String(held['method']),
    ports: Array.isArray(held['ports']) ? held['ports'].map((port) => String(port)) : [],
    service: String(held['service'] ?? ''), manifest: String(held['manifest'] ?? ''),
    handlerKey: String(held['handlerKey'] ?? ''), handlerIdentity: String(held['handlerIdentity'] ?? ''),
    handlerPath: String(held['handlerPath'] ?? ''), handlerSpan,
    handlerExpression: String(held['handlerExpression'] ?? ''), receiverExpression: String(held['receiverExpression'] ?? ''),
    statusOk: held['statusOk'] === true, span,
  };
}

/** One row as an exposition, or none. */
function expositionOf(node: StaticGraphNode): ExpositionRow | undefined {
  const held = recordOf(node);
  const evidence = held['evidence'];
  const span = node.properties['span'] as Span | undefined;
  if (evidence === null || typeof evidence !== 'object' || span === undefined) return undefined;
  return {
    span,
    path: String(held['path'] ?? ''), holder: String(held['holder'] ?? ''), writerBinding: String(held['writerBinding'] ?? ''),
    metrics: Array.isArray(held['metrics']) ? held['metrics'].map((metric) => String(metric)) : [],
    format: String(held['format'] ?? ''), evidence: evidence as Readonly<Record<string, unknown>>,
  };
}

/** The endpoint a registration serves, by the kind's own key formula. */
function endpointKeyOf(route: RouteRow): string {
  return HEALTH_PATHS.has(route.path)
    ? `code.health-endpoint:${route.span.path}#${route.handlerIdentity}${route.path === '/healthz' ? '' : route.path}`
    : `code.metrics-endpoint:${route.handlerPath}#${route.handlerIdentity}`;
}

/**
 * One code file's endpoint links: the routes it registers are served by the endpoint the
 * operations stage published, by the handler the route names, and — for a metric registration —
 * by the exposition another file writes. The record's span is the registration's own place, which
 * is this file's; the endpoint's node may stand in the handler's file, which is why this is a
 * link and not a declaration.
 */
async function endpointWrites(stage: StaticStageContext, repository: string, path: string, commit: string): Promise<readonly StageDraftWrite[]> {
  const writes: StageDraftWrite[] = [];
  const routes = (await pagesOf(stage, 'code.http-route', 'repository', repository)).map(routeOf).filter((route): route is RouteRow => route !== undefined && route.span.path === path);
  if (routes.length === 0) return writes;
  const expositions = (await pagesOf(stage, 'code.metric-exposition', 'repository', repository)).map(expositionOf).filter((row): row is ExpositionRow => row !== undefined);
  const metrics = await pagesOf(stage, 'code.metric', 'repository', repository);
  const names = new Map<string, string>();
  for (const node of metrics) {
    const key = node.properties['recordKey'];
    const record = node.properties['record'];
    if (typeof key !== 'string' || record === null || typeof record !== 'object') continue;
    const name = (record as Record<string, unknown>)['name'];
    if (typeof name === 'string') names.set(key, name);
  }
  for (const route of routes) {
    const endpointKey = endpointKeyOf(route);
    const health = HEALTH_PATHS.has(route.path);
    const handlerEnd = await symbolNodeKeyOf(stage, repository, route.handlerKey);
    if (handlerEnd === undefined) continue;
    if (!health) {
      const exposition = expositions.find((row) => row.holder === route.handlerKey);
      if (exposition === undefined) continue;
      const counters = exposition.metrics.map((metric) => names.get(metric) ?? '').filter((name) => name !== '').sort(byCodePoint);
      const node: LinkNode = {
        key: endpointKey,
        kind: 'code.metrics-endpoint',
        label: `${route.path} of ${route.manifest === '' ? route.handlerPath : route.manifest}`,
        properties: {
          path: route.path, method: route.method, ports: [...route.ports], service: route.manifest, format: exposition.format,
          counters, receiverExpression: route.receiverExpression, writerBinding: exposition.writerBinding, handler: handlerEnd,
          handlerExpression: route.handlerExpression, ...exposition.evidence,
        },
        span: route.handlerSpan,
      };
      writes.push(nodeWrite(node, repository, commit));
      writes.push({
        kind: 'edge',
        evidence: `${route.handlerSpan.path}:${String(route.handlerSpan.lineStart)}`,
        value: {
          relation: 'code.contains',
          from: { key: fileFactIdOf(repository, route.handlerSpan.path) },
          to: { key: node.key },
          properties: { factKind: 'contains', repository, file: route.handlerSpan.path, span: route.handlerSpan, record: {} },
        },
      });
      writes.push(edgeWrite('code.served-by', endpointKey, `code.file:${route.handlerPath}`, { service: route.manifest }, route.span, repository));
      writes.push(edgeWrite('code.served-by', endpointKey, handlerEnd, { role: 'handler' }, route.span, repository));
      for (const metric of exposition.metrics) {
        writes.push(edgeWrite('code.exposes-metric', endpointKey, metric, { writerBinding: exposition.writerBinding, ...exposition.evidence }, exposition.span, repository));
      }
      continue;
    }
    writes.push(edgeWrite('code.served-by', endpointKey, `code.file:${path}`, { service: route.service }, route.span, repository));
    writes.push(edgeWrite('code.served-by', endpointKey, handlerEnd, { role: 'handler' }, route.span, repository));
  }
  return writes;
}

/**
 * The endpoints a unit serves, linked to the unit's service passport: run in the manifest's own
 * unit, after the service node stands. The driver's closing pass links an endpoint to the service
 * whose node exists; the endpoint's own span is the link's place, wherever the endpoint stands.
 */
async function endpointServiceWrites(stage: StaticStageContext, repository: string, path: string, commit: string, passportPublished: boolean): Promise<readonly StageDraftWrite[]> {
  const writes: StageDraftWrite[] = [];
  // No passport, no service for an endpoint to be served by: the same unit publishes both, and
  // its own answer says whether the passport stands.
  if (!passportPublished) return writes;
  const units = (await pagesOf(stage, 'code.service-unit', 'manifestPath', path)).filter((node) => node.properties['repository'] === repository);
  const service = units[0] === undefined ? undefined : String(units[0].properties['name'] ?? '');
  const declared = units[0] === undefined ? '' : String(units[0].properties['declared'] ?? '');
  if (service === undefined || service === '') return writes;
  const endpoints: StaticGraphNode[] = [];
  for (const node of await pagesOf(stage, 'code.health-endpoint', 'repository', repository)) if (recordOf(node)['service'] === service) endpoints.push(node);
  for (const node of await pagesOf(stage, 'code.metrics-endpoint', 'repository', repository)) if (recordOf(node)['service'] === declared) endpoints.push(node);
  for (const node of endpoints) {
    const key = node.properties['recordKey'];
    const span = node.properties['span'] as Span | undefined;
    if (typeof key !== 'string' || span === undefined) continue;
    writes.push(edgeWrite('code.served-by', key, `code.service:${service}`, { role: 'service' }, span, repository));
  }
  return writes;
}

/**
 * The probes a Kubernetes file declares, linked to what they watch: the workload they belong to
 * and the endpoint their target claims. The probe's own place is the edge's place.
 */
async function probeWrites(stage: StaticStageContext, repository: string, path: string, commit: string): Promise<readonly StageDraftWrite[]> {
  const writes: StageDraftWrite[] = [];
  const probes = (await pagesOf(stage, 'code.probe', 'file', path)).filter((node) => node.properties['repository'] === repository);
  if (probes.length === 0) return writes;
  const workloads = (await pagesOf(stage, 'code.k8s-deployment', 'file', path)).filter((node) => node.properties['repository'] === repository);
  const endpoints = (await pagesOf(stage, 'code.health-endpoint', 'repository', repository)).map((node) => node.properties['record'] === undefined ? node : node);
  for (const probe of probes) {
    const key = probe.properties['recordKey'];
    const span = probe.properties['span'] as Span | undefined;
    if (typeof key !== 'string' || span === undefined) continue;
    const record = probe.properties['record'];
    const properties = record !== null && typeof record === 'object' ? record as Record<string, unknown> : {};
    // The probe's key names the workload it belongs to, then the container and the probe:
    // `code.probe:<path>#<workload>/<container>/<probe>`.
    const name = key.slice(key.indexOf('#') + 1);
    const workloadName = name.slice(0, name.indexOf('/') < 0 ? name.length : name.indexOf('/'));
    const workload = workloads.find((node) => node.properties['recordKey'] === `code.k8s-deployment:${path}#${workloadName}`);
    if (workload !== undefined) {
      const workloadKey = workload.properties['recordKey'];
      if (typeof workloadKey === 'string') writes.push(edgeWrite('code.probes', key, workloadKey, { role: 'workload' }, span, repository));
    }
    const target = resolveEndpointTarget(extractedOf(key, 'code.probe', probe.label, properties));
    if (target.kind !== 'http') continue;
    const matches = endpoints.filter((node) => {
      const record = node.properties['record'];
      const held = record !== null && typeof record === 'object' ? record as Record<string, unknown> : {};
      return matchesEndpoint(target.target, extractedOf(String(node.properties['recordKey'] ?? ''), node.kind === 'code.metrics-endpoint' ? 'code.metrics-endpoint' : 'code.health-endpoint', node.label, held));
    });
    if (matches.length !== 1) continue;
    const endpointKey = matches[0]!.properties['recordKey'];
    if (typeof endpointKey === 'string') writes.push(edgeWrite('code.probes', key, endpointKey, { role: 'endpoint' }, span, repository));
  }
  return writes;
}


/**
 * The uses of a logger one file writes, linked to the logger another file declares: the use's
 * edge stands at the using file, and the declaration may be published by a unit the plan reaches
 * later, so the operations stage hands this stage the use and the key it names.
 */
async function loggerUseWrites(stage: StaticStageContext, repository: string, path: string): Promise<readonly StageDraftWrite[]> {
  const writes: StageDraftWrite[] = [];
  const uses = (await pagesOf(stage, 'code.logger-use', 'file', path)).filter((node) => node.properties['repository'] === repository);
  for (const node of uses) {
    const held = recordOf(node);
    const logger = held['logger'];
    const ownerKey = held['owner'];
    const evidence = held['evidence'];
    const span = node.properties['span'] as Span | undefined;
    if (typeof logger !== 'string' || span === undefined || evidence === null || typeof evidence !== 'object') continue;
    const discriminator = String(held['discriminator'] ?? '');
    writes.push(edgeWrite('code.uses-logger', logger, `code.file:${path}`, evidence as Record<string, unknown>, span, repository, discriminator));
    if (typeof ownerKey !== 'string' || ownerKey === '') continue;
    const owner = await symbolNodeKeyOf(stage, repository, ownerKey);
    if (owner === undefined) continue;
    writes.push(edgeWrite('code.uses-logger', logger, owner, evidence as Record<string, unknown>, span, repository, discriminator));
  }
  return writes;
}
