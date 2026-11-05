/**
 * The tracked reads a static stage's plan makes of the 0028 graph (decision
 * 0033's per-file units; decision 0027's staleness from tracked reads). The
 * three static stages read the same five answers — the tree the snapshot
 * published, the repository and commit nodes, the gaps of a file's coverage,
 * the unfiled paths, and the import edges — and every answer is built from the
 * extractors' `code.*` vocabulary the stages publish (decision 0033, item 7).
 *
 * The read is a JSON document, so a plan is recorded and rechecked as data. A
 * read this module does not know is refused by name: the static stages have one
 * reading of the graph, and an empty answer for a read nobody wrote is exactly
 * the silent smaller result decision 0033 forbids.
 */
import { outerTransactionOf, type EdgeEntry, type GraphStore, type NodeVersionRow, type QueryExecutor } from '../../graph/index.js';
import type { StageGraphReader } from '../stage.js';
import { PUBLISHED_REPOSITORY_READ, PUBLISHED_UNFILED_READ, type PublishedRepositoryRow, type PublishedUnfiledRow } from './snapshot.js';
import { PUBLISHED_CONTAINMENT_READ, type PublishedContainmentRow } from './inventory.js';
import { STATIC_GRAPH_READ, staticEdgeOf, staticNodeOf } from './static-context.js';
import { PUBLISHED_COVERAGE_READ, type PublishedCoverageRow } from './syntax.js';
import { PUBLISHED_RESOLVED_READ, type PublishedResolvedRow } from './semantic-resolution.js';
import { CODE_FACTS_PUBLISHED_READ } from './code-facts.js';
import { CONTRACTS_SOURCE_SYSTEM, PUBLISHED_CONTRACTS_READ } from './contracts.js';
import { CONTRACTS_CODE_SOURCE_SYSTEM, PUBLISHED_CONTRACTS_CODE_READ } from './contracts-code.js';
import { CONTRACTS_ROUTES_SOURCE_SYSTEM, PUBLISHED_CONTRACTS_ROUTES_READ } from './contracts-routes.js';
import { PUBLISHED_MACHINES_READ } from './state-machines.js';
import { PUBLISHED_OPERATIONS_READ, publishedOperationsRows } from './operations.js';
import { PUBLISHED_LINKS_READ } from './operations-links.js';
import { PUBLISHED_GAPS_READ } from './syntax-specifiers.js';
import { PUBLISHED_IMPORTS_READ, type PublishedGapRow, type PublishedImportRow } from './syntax-specifiers.js';
import type { PublishedCodeFactsRow } from './code-facts.js';
import type { PublishedMachinesRow } from './state-machines.js';
import { PUBLISHED_TREE_READ, type PublishedTreeRow } from './tree-rows.js';
import { MANIFEST_SOURCE_SYSTEM, PUBLISHED_MANIFESTS_READ } from './build-configuration.js';
import { DOCUMENT_INDEX_SOURCE_SYSTEM, PUBLISHED_DOCUMENTS_READ } from './document-index.js';
import {
  COMMITS_HELD_READ, HISTORY_COVERAGE_READ, HISTORY_SOURCE_SYSTEM_NAME,
} from './history.js';

/** How many rows one plan read may answer: the plan is the orchestrator's, and its answer is one repository. */
const PLAN_PAGE = 5_000;

/** The reader a node's provenance names: the system that wrote the reading, or `''` where it names none. */
function sourceSystemOf(properties: Record<string, unknown>): string {
  const provenance = properties['provenance'];
  const source = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['source'] : undefined;
  const system = source !== null && typeof source === 'object' ? (source as Record<string, unknown>)['system'] : undefined;
  return typeof system === 'string' ? system : '';
}

/**
 * The scopes one stage's own coverage nodes name: its record of the files it
 * read, one row per scope, in code point order. A stage's coverage carries its
 * reader in its identity, so this is what tells one stage's reading of a path
 * from another's.
 */
function coverageScopes(nodes: readonly NodeVersionRow[], kind: string, system: string, repository: string): readonly { readonly kind: string; readonly repository: string; readonly path: string; readonly blob?: string }[] {
  const rows: { kind: string; repository: string; path: string; blob?: string }[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const properties = propertiesOf(node);
    if (properties['factKind'] !== 'coverage' || sourceSystemOf(properties) !== system) continue;
    const scope = properties['scope'];
    if (typeof scope !== 'string' || scope === '' || seen.has(scope)) continue;
    seen.add(scope);
    rows.push({ kind, repository, path: scope, ...(typeof properties['blob'] === 'string' ? { blob: properties['blob'] } : {}) });
  }
  return rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The value a node's fact holds: its properties without the graph's own bookkeeping. */
function factValueOf(properties: Record<string, unknown>): Record<string, unknown> {
  const value = { ...properties };
  for (const key of ['recordKey', 'factKind', 'layer', 'status', 'provenance']) delete value[key];
  return value;
}

/** The place a node's provenance names, as a row's `place`: the file and the range its fact stood at. */
function placeOf(properties: Record<string, unknown>): { readonly file: string; readonly range: Record<string, unknown> } {
  const provenance = properties['provenance'];
  const place = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['place'] : undefined;
  const held = place !== null && typeof place === 'object' ? place as Record<string, unknown> : {};
  return { file: String(held['file'] ?? ''), range: (held['range'] ?? {}) as Record<string, unknown> };
}

/** The coverage value a coverage node carries: the fact's own fields and none of the graph's bookkeeping. */
function coverageValueOf(properties: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const key of ['repository', 'scope', 'complete', 'read', 'unread']) {
    if (properties[key] !== undefined) value[key] = properties[key];
  }
  return value;
}

/** A node's properties, as the graph answered them. */
function propertiesOf(row: NodeVersionRow): Record<string, unknown> {
  return row.properties !== null && typeof row.properties === 'object' && !Array.isArray(row.properties)
    ? row.properties as Record<string, unknown>
    : {};
}

/** The string a node's `recordKey` is, refused when the node carries none. */
function recordKeyOf(row: NodeVersionRow, what: string): string {
  const key = propertiesOf(row)['recordKey'];
  if (typeof key !== 'string' || key === '') {
    throw new Error(`the graph answered a ${what} node ${row.nodeId} with no recordKey: every static node carries the fact id it was read as (src/fill/stages/static-reads.ts)`);
  }
  return key;
}

/**
 * The reader one static stage's plan asks. Every read is answered from `store`,
 * inside the transaction the caller's executor opened when it named one, and
 * every row is built in code point order so the membership digest of one answer
 * does not move with a database's collation.
 */
export function createStaticStageReadReader(store: GraphStore, executor?: QueryExecutor): StageGraphReader {
  // The caller's executor becomes the store's outer transaction at the storage boundary (decision 0033,
  // item 3): a plan read runs in the transaction the orchestrator already opened.
  const transaction = executor === undefined ? undefined : outerTransactionOf(executor);
  const all = async <T>(fetch: (page: { after?: string; limit?: number }) => Promise<{ rows: T[]; next: string | null }>): Promise<T[]> => {
    const rows: T[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await fetch({ ...(after === undefined ? {} : { after }), limit: PLAN_PAGE });
      rows.push(...page.rows);
      if (page.next === null) return rows;
      after = page.next;
    }
  };
  return {
    async query(text: string): Promise<readonly unknown[]> {
      const document = JSON.parse(text) as { readonly read?: unknown; readonly repository?: unknown; readonly scope?: unknown };
      // A unit's own bounded read names no repository: it asks by a key, a global name or a
      // node, and each of those is one answer of one file (decision 0033, item 5). Every
      // other read of a static stage's plan is one repository's.
      if (typeof document.read !== 'string' || (document.read !== STATIC_GRAPH_READ && (typeof document.repository !== 'string' || document.repository.trim() === ''))) {
        throw new Error(`the static stage asked the read ${JSON.stringify(text)}, and a static read is a JSON document naming its read and the repository it was made for (src/fill/stages/static-reads.ts)`);
      }
      const repository = typeof document.repository === 'string' ? document.repository : '';
      switch (document.read) {
        case STATIC_GRAPH_READ: {
          // A bounded read a static unit made through its own context, recorded as the generation's dependency
          // and replayed here inside the publication's transaction. The rows are the context's own shape.
          const read = document as { readonly kind?: unknown; readonly value?: unknown; readonly limit?: unknown; readonly relations?: unknown; readonly direction?: unknown; readonly after?: unknown; readonly nodeKind?: unknown; readonly relation?: unknown; readonly field?: unknown; readonly kindOf?: unknown; readonly fieldOf?: unknown };
          // One edge read carries two recorded names: `edgesByProperty` with a relation and a
          // field, and `edges` with `kindOf` and `fieldOf`. A recorded read is durable data, so a
          // replay answers both spellings; the orchestrator records the first from now on.
          if ((read.kind !== 'key' && read.kind !== 'globalName' && read.kind !== 'neighbourhood' && read.kind !== 'property' && read.kind !== 'edgesByProperty' && read.kind !== 'edges') || typeof read.value !== 'string' || typeof read.limit !== 'number') {
            throw new Error(`the static stage's recorded read ${JSON.stringify(text)} names no bounded read this reader answers: a read is by key, by global name or by one neighbourhood, with its value and cap (src/fill/stages/static-reads.ts)`);
          }
          if (read.after !== undefined && typeof read.after !== 'string') {
            throw new Error(`the static stage's recorded neighbourhood read ${JSON.stringify(text)} names the page cursor ${JSON.stringify(read.after)}, and a cursor is a text (src/fill/stages/static-reads.ts)`);
          }
          const page = { limit: read.limit, ...(read.after === undefined ? {} : { after: read.after }) };
          if (read.kind === 'key') return (await store.byKey(read.value, page, transaction)).rows.map(staticNodeOf);
          if (read.kind === 'edgesByProperty' || read.kind === 'edges') {
            // A read of the edges another unit published, by a value they carry: a replay answers
            // the same page the unit read, inside the publication's transaction. The rows are the
            // shape the recording unit wrote, which is the context's own edge row.
            const relation = read.kind === 'edgesByProperty' ? read.relation : read.kindOf;
            const field = read.kind === 'edgesByProperty' ? read.field : read.fieldOf;
            if (typeof relation !== 'string' || typeof field !== 'string') {
              throw new Error(`the static stage's recorded read ${JSON.stringify(text)} names no relation or field of a read of edges (src/fill/stages/static-reads.ts)`);
            }
            return (await store.edgesByProperty(relation, field, read.value, page, transaction)).rows.map(staticEdgeOf);
          }
          if (read.kind === 'property') {
            // A read by a value: the recorded text names the kind, the field and the value, and a
            // replay answers the same page the unit read (decision 0033, item 5). `kindOf` and
            // `fieldOf` are the names the other recorded spelling gave the same two parts.
            const kind = read.nodeKind ?? read.kindOf;
            const field = read.field ?? read.fieldOf;
            if (typeof kind !== 'string' || typeof field !== 'string') {
              throw new Error(`the static stage's recorded read ${JSON.stringify(text)} names no kind or field of a read by property (src/fill/stages/static-reads.ts)`);
            }
            return (await store.byProperty(kind, field, read.value, page, transaction)).rows.map(staticNodeOf);
          }
          if (read.kind === 'globalName') return (await store.byGlobalName(read.value, page, transaction)).rows.map(staticNodeOf);
          if (!Array.isArray(read.relations) || read.relations.some((relation) => typeof relation !== 'string') || (read.direction !== 'out' && read.direction !== 'in')) {
            throw new Error(`the static stage's recorded neighbourhood read ${JSON.stringify(text)} names no relations or direction (src/fill/stages/static-reads.ts)`);
          }
          return (await store.neighbourhood(read.value, read.relations as readonly string[], read.direction, page, transaction)).rows.map(staticNodeOf);
        }
        case PUBLISHED_TREE_READ: {
          const files = await all((page) => store.byProperty('code.file', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const directories = await all((page) => store.byProperty('code.directory', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const rows: PublishedTreeRow[] = [];
          for (const node of files) {
            const held = propertiesOf(node);
            rows.push({ kind: 'file', repository, path: String(held['path']), ...(typeof held['blob'] === 'string' ? { blob: held['blob'] } : {}) });
          }
          for (const node of directories) {
            rows.push({ kind: 'directory', repository, path: String(propertiesOf(node)['path']) });
          }
          return rows.sort((left, right) => `${left.path}\u0000${left.kind}` < `${right.path}\u0000${right.kind}` ? -1 : `${left.path}\u0000${left.kind}` > `${right.path}\u0000${right.kind}` ? 1 : 0);
        }
        case PUBLISHED_REPOSITORY_READ: {
          const nodes = await all((page) => store.byProperty('code.repository', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const commits = await all((page) => store.byProperty('code.commit', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const rows: PublishedRepositoryRow[] = nodes.map(() => ({ kind: 'repository', repository }));
          for (const node of commits) {
            const held = propertiesOf(node);
            rows.push({ kind: 'snapshot', repository, commit: String(held['commit']) });
          }
          return rows.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'repository' ? -1 : 1));
        }
        case PUBLISHED_UNFILED_READ: {
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          return nodes
            .filter((node) => propertiesOf(node)['unfiledPath'] === true)
            .map((node): PublishedUnfiledRow => ({ kind: 'coverage', repository, path: String(propertiesOf(node)['scope']) }))
            .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        }
        case PUBLISHED_GAPS_READ: {
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const rows: PublishedGapRow[] = [];
          for (const node of nodes) {
            const held = propertiesOf(node);
            if (held['unfiledPath'] === true) continue;
            const file = held['scope'];
            if (typeof file !== 'string' || file === '') continue;
            const unread = held['unread'];
            if (!Array.isArray(unread)) continue;
            for (const gap of unread) {
              if (gap === null || typeof gap !== 'object') continue;
              const what = (gap as Record<string, unknown>)['what'];
              if (typeof what === 'string' && what !== '') rows.push({ kind: 'coverage', file, what });
            }
          }
          return rows.sort((left, right) => (left.file === right.file ? (left.what < right.what ? -1 : left.what > right.what ? 1 : 0) : left.file < right.file ? -1 : 1));
        }
        case PUBLISHED_CONTAINMENT_READ: {
          const found = await all((page) => store.byProperty('code.repository', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          if (found.length === 0) return [];
          const rows: PublishedContainmentRow[] = [];
          for (const repositoryNode of found) {
            const edges = await all((page) => store.relationsWithin(repositoryNode.nodeId, 'code.contains', undefined, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
            for (const entry of edges as readonly EdgeEntry[]) {
              const properties = entry.edge.properties !== null && typeof entry.edge.properties === 'object' ? entry.edge.properties as Record<string, unknown> : {};
              if (properties['factKind'] !== 'contains') continue;
              // The modules stage draws `code.contains` edges of its own (a module holds its
              // members): the inventory's plan reads the containment of the tree, which starts at
              // a node the snapshot stage published.
              if (entry.src.producer !== 'fill.snapshot') continue;
              const child = entry.dst.kind === 'code.file' ? 'file' : entry.dst.kind === 'code.directory' ? 'directory' : undefined;
              if (child === undefined) continue;
              const from = entry.src.kind === 'code.repository' ? '' : String(propertiesOf(entry.src)['path']);
              rows.push({ kind: 'contains', child, from, to: String(propertiesOf(entry.dst)['path']) });
            }
          }
          return rows.sort((left, right) => (`${left.child}\u0000${left.to}` < `${right.child}\u0000${right.to}` ? -1 : `${left.child}\u0000${left.to}` > `${right.child}\u0000${right.to}` ? 1 : 0));
        }
        case PUBLISHED_COVERAGE_READ: {
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          return nodes
            // The syntax stage's own coverage: the reader it cites, and the blob it recorded. A
            // later stage's coverage of the same repository names a scope of its own, and the
            // syntax plan must not read it as a file it read.
            .filter((node) => sourceSystemOf(propertiesOf(node)) === 'tree-sitter' && typeof propertiesOf(node)['blob'] === 'string')
            .map((node): PublishedCoverageRow => ({ kind: 'coverage', file: String(propertiesOf(node)['scope']), blob: String(propertiesOf(node)['blob']) }))
            .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
        }
        case CODE_FACTS_PUBLISHED_READ: {
          // One repository's code-fact coverage: the files the code-facts stage read, each with
          // the blob its bytes stood under. The reader is named, so another stage's coverage of
          // the same file is never taken for this one's.
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const rows: PublishedCodeFactsRow[] = [];
          for (const node of nodes) {
            const held = propertiesOf(node);
            if (held['factKind'] !== 'coverage') continue;
            const provenance = held['provenance'];
            const source = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['source'] : undefined;
            const system = source !== null && typeof source === 'object' ? (source as Record<string, unknown>)['system'] : undefined;
            if (system !== 'madarch-code-facts') continue;
            const file = held['scope'];
            const blob = held['blob'];
            if (typeof file !== 'string' || typeof blob !== 'string') {
              throw new Error(`the graph answered the coverage node ${node.nodeId} of ${JSON.stringify(repository)} with no scope or blob: the code-facts stage's coverage names the file it read and the blob its bytes stood under (src/fill/stages/static-reads.ts)`);
            }
            const unitChain = held['unitChain'];
            // The row is handed on as the node wrote it: the plan's own reader refuses a chain that
            // is not a list of manifest places, rather than dropping it and reading the row as older.
            rows.push({ kind: 'coverage', file, blob, ...(unitChain === undefined ? {} : { unitChain: unitChain as readonly string[] }) });
          }
          return rows.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
        }
        case PUBLISHED_CONTRACTS_READ: {
          // The contract files the contracts stage read, each with the blob its bytes stood under.
          return coverageScopes(await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction)), 'coverage', CONTRACTS_SOURCE_SYSTEM, repository)
            .map((row) => ({ kind: 'coverage', path: row.path, ...(row.blob === undefined ? {} : { blob: row.blob }) }));
        }
        case PUBLISHED_CONTRACTS_CODE_READ: {
          // The source files the contracts-code stage read, each with the blob its bytes stood under.
          return coverageScopes(await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction)), 'coverage', CONTRACTS_CODE_SOURCE_SYSTEM, repository)
            .map((row) => ({ kind: 'coverage', path: row.path, ...(row.blob === undefined ? {} : { blob: row.blob }) }));
        }
        case PUBLISHED_CONTRACTS_ROUTES_READ: {
          // The source files the contracts-routes stage read, each with the blob its bytes stood under.
          return coverageScopes(await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction)), 'coverage', CONTRACTS_ROUTES_SOURCE_SYSTEM, repository)
            .map((row) => ({ kind: 'coverage', path: row.path, ...(row.blob === undefined ? {} : { blob: row.blob }) }));
        }
        case PUBLISHED_MACHINES_READ: {
          // One repository's state machine coverage: the files the state-machines stage read,
          // each with the blob its bytes stood under. The reader is named, so a coverage of
          // another stage's reading of the same file is never taken for this one's.
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const rows: PublishedMachinesRow[] = [];
          for (const node of nodes) {
            const held = propertiesOf(node);
            if (held['factKind'] !== 'coverage') continue;
            const provenance = held['provenance'];
            const source = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['source'] : undefined;
            const system = source !== null && typeof source === 'object' ? (source as Record<string, unknown>)['system'] : undefined;
            if (system !== 'madarch-state-machines') continue;
            const file = held['scope'];
            const blob = held['blob'];
            if (typeof file !== 'string' || typeof blob !== 'string') {
              throw new Error(`the graph answered the coverage node ${node.nodeId} of ${JSON.stringify(repository)} with no scope or blob: the state-machines stage's coverage names the file it read and the blob its bytes stood under (src/fill/stages/static-reads.ts)`);
            }
            rows.push({ kind: 'coverage', file, blob });
          }
          return rows.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
        }
        case PUBLISHED_OPERATIONS_READ: {
          // One repository's operations coverage: the files the operations stage read, each with
          // the blob its bytes stood under. The reader is named, so a coverage of another stage's
          // reading of the same file is never taken for this one's.
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          // The stage's own reader checks each row it wrote: a row of this read names its scope and
          // the blob the bytes stood under, or the plan is told which row is not one it held.
          const held = nodes.filter((node) => sourceSystemOf(propertiesOf(node)) === 'madarch-operations').map((node) => {
            const wrote = propertiesOf(node);
            return { kind: wrote['factKind'], file: wrote['scope'], blob: wrote['blob'] };
          });
          return [...publishedOperationsRows(held, repository, PUBLISHED_OPERATIONS_READ)].sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
        }
        case PUBLISHED_LINKS_READ: {
          // One repository's operations-links coverage: the files the links stage linked, each
          // with the blob its bytes stood under, read by the same row reader as the stage before.
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const held = nodes.filter((node) => sourceSystemOf(propertiesOf(node)) === 'madarch-operations-links').map((node) => {
            const wrote = propertiesOf(node);
            return { kind: wrote['factKind'], file: wrote['scope'], blob: wrote['blob'] };
          });
          return [...publishedOperationsRows(held, repository, PUBLISHED_LINKS_READ)].sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
        }
        case PUBLISHED_RESOLVED_READ: {
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const rows: PublishedResolvedRow[] = [];
          for (const node of nodes) {
            const held = propertiesOf(node);
            if (held['factKind'] !== 'coverage') continue;
            const provenance = held['provenance'];
            const source = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['source'] : undefined;
            const system = source !== null && typeof source === 'object' ? (source as Record<string, unknown>)['system'] : undefined;
            if (system !== 'madarch-resolution') continue;
            const file = held['scope'];
            const blob = held['blob'];
            const read = held['read'];
            if (typeof file !== 'string' || typeof blob !== 'string' || !Array.isArray(read)) {
              throw new Error(`the graph answered the coverage node ${node.nodeId} of ${JSON.stringify(repository)} with no scope, blob or read list: this stage's coverage names the file, the blob it resolved and the files it read (src/fill/stages/static-reads.ts)`);
            }
            rows.push({ kind: 'coverage', file, blob, read: read.map((entry) => String(entry)) });
          }
          return rows.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
        }
        case PUBLISHED_IMPORTS_READ: {
          const rows: PublishedImportRow[] = [];
          const edges = await all((page) => store.edgesByProperty('code.imports', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          for (const entry of edges as readonly EdgeEntry[]) {
            const specifier = (entry.edge.properties !== null && typeof entry.edge.properties === 'object' ? (entry.edge.properties as Record<string, unknown>)['specifier'] : undefined);
            if (typeof specifier !== 'string' || specifier === '') {
              throw new Error(`the graph answered the import edge ${entry.edge.edgeId} with no specifier: an import edge names the text the importing file wrote (src/fill/stages/static-reads.ts)`);
            }
            rows.push({ kind: 'import', from: recordKeyOf(entry.src, 'file'), to: recordKeyOf(entry.dst, 'file'), specifier });
          }
          return rows.sort((left, right) => (`${left.from}\u0000${left.to}\u0000${left.specifier}` < `${right.from}\u0000${right.to}\u0000${right.specifier}` ? -1 : `${left.from}\u0000${left.to}\u0000${left.specifier}` > `${right.from}\u0000${right.to}\u0000${right.specifier}` ? 1 : 0));
        }
        // The build and configuration stage of madarch-8bdc.2.3 reads its own earlier
        // publication back through this name: a coverage node of its own is its record of
        // what it read (the coverage's identity carries its reader), so a plan names the
        // manifests whose reading stands and no other stage's coverage.
        case PUBLISHED_MANIFESTS_READ: {
          return coverageScopes(await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction)), 'manifest', MANIFEST_SOURCE_SYSTEM, repository);
        }
        case PUBLISHED_DOCUMENTS_READ: {
          // The document index's coverage names its scope as `<repository>:<path>`: the plan
          // compares a document's path, so the scope's repository leg is dropped here.
          return coverageScopes(await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction)), 'document', DOCUMENT_INDEX_SOURCE_SYSTEM, repository)
            .map((row) => ({ ...row, path: row.path.startsWith(`${repository}:`) ? row.path.slice(repository.length + 1) : row.path }));
        }
        case COMMITS_HELD_READ: {
          // The commit nodes this repository's history already holds, each with the value it
          // carries: the fact's own fields and none of the graph's bookkeeping.
          const nodes = await all((page) => store.byProperty('code.commit', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          return nodes.map((node) => {
            const held = propertiesOf(node);
            const value: Record<string, unknown> = {};
            for (const key of ['repository', 'commit', 'committedAt', 'authoredAt', 'subject', 'author', 'parents', 'files']) {
              if (held[key] !== undefined) value[key] = held[key];
            }
            return { kind: 'commit', commit: String(held['commit']), value };
          }).sort((left, right) => (left.commit < right.commit ? -1 : left.commit > right.commit ? 1 : 0));
        }
        case HISTORY_COVERAGE_READ: {
          const scope = typeof document.scope === 'string' ? document.scope : '';
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, transaction));
          const held = nodes.filter((node) => propertiesOf(node)['scope'] === scope && sourceSystemOf(propertiesOf(node)) === HISTORY_SOURCE_SYSTEM_NAME);
          if (held.length > 1) {
            throw new Error(`the graph answered ${String(held.length)} coverage nodes of ${JSON.stringify(scope)} in ${JSON.stringify(repository)}, and one stage's coverage of one scope is one node (src/fill/stages/static-reads.ts)`);
          }
          const node = held[0];
          return node === undefined ? [] : [{ kind: 'coverage', value: coverageValueOf(propertiesOf(node)) }];
        }
        default:
          throw new Error(`the static stage asked the read ${JSON.stringify(document.read)} for ${JSON.stringify(repository)}, and this reader answers ${PUBLISHED_TREE_READ}, ${PUBLISHED_REPOSITORY_READ}, ${PUBLISHED_UNFILED_READ}, ${PUBLISHED_CONTAINMENT_READ}, ${PUBLISHED_COVERAGE_READ}, ${PUBLISHED_RESOLVED_READ}, ${PUBLISHED_GAPS_READ}, ${PUBLISHED_IMPORTS_READ}, ${PUBLISHED_MACHINES_READ}, ${CODE_FACTS_PUBLISHED_READ}, ${PUBLISHED_OPERATIONS_READ}, ${PUBLISHED_LINKS_READ}, ${PUBLISHED_MANIFESTS_READ}, ${PUBLISHED_DOCUMENTS_READ}, ${COMMITS_HELD_READ}, ${HISTORY_COVERAGE_READ}, ${PUBLISHED_CONTRACTS_READ}, ${PUBLISHED_CONTRACTS_CODE_READ}, ${PUBLISHED_CONTRACTS_ROUTES_READ}: a static stage has one reading of the graph (src/fill/stages/static-reads.ts)`);
      }
    },
  };
}
