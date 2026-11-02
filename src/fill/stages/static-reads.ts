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
import type { EdgeEntry, GraphStore, NodeVersionRow } from '../../graph/index.js';
import type { OuterTransaction } from '../../history/types.js';
import type { StageGraphReader } from '../stage.js';
import { PUBLISHED_REPOSITORY_READ, PUBLISHED_UNFILED_READ, type PublishedRepositoryRow, type PublishedUnfiledRow } from './snapshot.js';
import { PUBLISHED_CONTAINMENT_READ, type PublishedContainmentRow } from './inventory.js';
import { STATIC_GRAPH_READ, staticNodeOf } from './static-context.js';
import { PUBLISHED_COVERAGE_READ, type PublishedCoverageRow } from './syntax.js';
import { PUBLISHED_GAPS_READ } from './syntax-specifiers.js';
import { PUBLISHED_IMPORTS_READ, type PublishedGapRow, type PublishedImportRow } from './syntax-specifiers.js';
import { PUBLISHED_TREE_READ, type PublishedTreeRow } from './tree-rows.js';

/** How many rows one plan read may answer: the plan is the orchestrator's, and its answer is one repository. */
const PLAN_PAGE = 5_000;

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
 * inside `executor` when the caller opened a transaction, and every row is
 * built in code point order so the membership digest of one answer does not
 * move with a database's collation.
 */
export function createStaticStageReadReader(store: GraphStore, executor?: OuterTransaction): StageGraphReader {
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
      const document = JSON.parse(text) as { readonly read?: unknown; readonly repository?: unknown };
      if (typeof document.read !== 'string' || typeof document.repository !== 'string' || document.repository.trim() === '') {
        throw new Error(`the static stage asked the read ${JSON.stringify(text)}, and a static read is a JSON document naming its read and the repository it was made for (src/fill/stages/static-reads.ts)`);
      }
      const repository = document.repository;
      switch (document.read) {
        case STATIC_GRAPH_READ: {
          // A bounded read a static unit made through its own context, recorded as the generation's dependency
          // and replayed here inside the publication's transaction. The rows are the context's own shape.
          const read = document as { readonly kind?: unknown; readonly value?: unknown; readonly limit?: unknown; readonly relations?: unknown; readonly direction?: unknown };
          if ((read.kind !== 'key' && read.kind !== 'globalName' && read.kind !== 'neighbourhood') || typeof read.value !== 'string' || typeof read.limit !== 'number') {
            throw new Error(`the static stage's recorded read ${JSON.stringify(text)} names no bounded read this reader answers: a read is by key, by global name or by one neighbourhood, with its value and cap (src/fill/stages/static-reads.ts)`);
          }
          const page = { limit: read.limit };
          if (read.kind === 'key') return (await store.byKey(read.value, page, executor)).rows.map(staticNodeOf);
          if (read.kind === 'globalName') return (await store.byGlobalName(read.value, page, executor)).rows.map(staticNodeOf);
          if (!Array.isArray(read.relations) || read.relations.some((relation) => typeof relation !== 'string') || (read.direction !== 'out' && read.direction !== 'in')) {
            throw new Error(`the static stage's recorded neighbourhood read ${JSON.stringify(text)} names no relations or direction (src/fill/stages/static-reads.ts)`);
          }
          return (await store.neighbourhood(read.value, read.relations as readonly string[], read.direction, page, executor)).rows.map(staticNodeOf);
        }
        case PUBLISHED_TREE_READ: {
          const files = await all((page) => store.byProperty('code.file', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
          const directories = await all((page) => store.byProperty('code.directory', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
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
          const nodes = await all((page) => store.byProperty('code.repository', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
          const commits = await all((page) => store.byProperty('code.commit', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
          const rows: PublishedRepositoryRow[] = nodes.map(() => ({ kind: 'repository', repository }));
          for (const node of commits) {
            const held = propertiesOf(node);
            rows.push({ kind: 'snapshot', repository, commit: String(held['commit']) });
          }
          return rows.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'repository' ? -1 : 1));
        }
        case PUBLISHED_UNFILED_READ: {
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
          return nodes
            .filter((node) => propertiesOf(node)['unfiledPath'] === true)
            .map((node): PublishedUnfiledRow => ({ kind: 'coverage', repository, path: String(propertiesOf(node)['scope']) }))
            .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        }
        case PUBLISHED_GAPS_READ: {
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
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
          const found = await all((page) => store.byProperty('code.repository', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
          if (found.length === 0) return [];
          const rows: PublishedContainmentRow[] = [];
          for (const repositoryNode of found) {
            const edges = await all((page) => store.relationsWithin(repositoryNode.nodeId, 'code.contains', undefined, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
            for (const entry of edges as readonly EdgeEntry[]) {
              const properties = entry.edge.properties !== null && typeof entry.edge.properties === 'object' ? entry.edge.properties as Record<string, unknown> : {};
              if (properties['factKind'] !== 'contains') continue;
              const child = entry.dst.kind === 'code.file' ? 'file' : entry.dst.kind === 'code.directory' ? 'directory' : undefined;
              if (child === undefined) continue;
              const from = entry.src.kind === 'code.repository' ? '' : String(propertiesOf(entry.src)['path']);
              rows.push({ kind: 'contains', child, from, to: String(propertiesOf(entry.dst)['path']) });
            }
          }
          return rows.sort((left, right) => (`${left.child}\u0000${left.to}` < `${right.child}\u0000${right.to}` ? -1 : `${left.child}\u0000${left.to}` > `${right.child}\u0000${right.to}` ? 1 : 0));
        }
        case PUBLISHED_COVERAGE_READ: {
          const nodes = await all((page) => store.byProperty('code.coverage', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
          return nodes
            .filter((node) => typeof propertiesOf(node)['blob'] === 'string')
            .map((node): PublishedCoverageRow => ({ kind: 'coverage', file: String(propertiesOf(node)['scope']), blob: String(propertiesOf(node)['blob']) }))
            .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
        }
        case PUBLISHED_IMPORTS_READ: {
          const rows: PublishedImportRow[] = [];
          const edges = await all((page) => store.edgesByProperty('code.imports', 'repository', repository, { ...page, limit: page.limit ?? PLAN_PAGE }, executor));
          for (const entry of edges as readonly EdgeEntry[]) {
            const specifier = (entry.edge.properties !== null && typeof entry.edge.properties === 'object' ? (entry.edge.properties as Record<string, unknown>)['specifier'] : undefined);
            if (typeof specifier !== 'string' || specifier === '') {
              throw new Error(`the graph answered the import edge ${entry.edge.edgeId} with no specifier: an import edge names the text the importing file wrote (src/fill/stages/static-reads.ts)`);
            }
            rows.push({ kind: 'import', from: recordKeyOf(entry.src, 'file'), to: recordKeyOf(entry.dst, 'file'), specifier });
          }
          return rows.sort((left, right) => (`${left.from}\u0000${left.to}\u0000${left.specifier}` < `${right.from}\u0000${right.to}\u0000${right.specifier}` ? -1 : `${left.from}\u0000${left.to}\u0000${left.specifier}` > `${right.from}\u0000${right.to}\u0000${right.specifier}` ? 1 : 0));
        }
        default:
          throw new Error(`the static stage asked the read ${JSON.stringify(document.read)} for ${JSON.stringify(repository)}, and this reader answers ${PUBLISHED_TREE_READ}, ${PUBLISHED_REPOSITORY_READ}, ${PUBLISHED_UNFILED_READ}, ${PUBLISHED_CONTAINMENT_READ}, ${PUBLISHED_COVERAGE_READ}, ${PUBLISHED_GAPS_READ} and ${PUBLISHED_IMPORTS_READ}: a static stage has one reading of the graph (src/fill/stages/static-reads.ts)`);
      }
    },
  };
}
