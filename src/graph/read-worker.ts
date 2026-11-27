/** The CPU read, fold, layout and HTML work lives off the API event loop. */
import { createPostgresDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { withSpan } from '../obs/trace.js';
import { readPublishedManifest } from '../graph/manifest-publication.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { executeGraphql, structureRevisionOf } from '../graph/graphql-execute.js';
import { declareFileTextQueue, readFileTextByBlob } from '../knowledge/file-texts.js';
import { readProduct } from '../product/manifest.js';
import type { QueueService } from '../fill/queue.js';
import { openFillRunQueue } from '../fill/run-jobs.js';
import { join } from 'node:path';
import { ReadContext, type DiagramNeighbourhood } from '../graph/graphql-read.js';
import { readPublishedTemplates } from '../graph/product-templates.js';
import { diagramGraphOf, archifyDocument, likec4PictureOf, mermaidText, renderArchify } from '../render/diagram.js';
import { DIAGRAM_DEPTH, DIAGRAM_AGGREGATE_ABOVE, DIAGRAM_MAX_BYTES, type DiagramAnswer } from '../render/diagram-render.js';
import type { ReadDescriptor, ReadWork } from '../render/read-worker.js';
import type { PoolConfig } from 'pg';
import { LOG_LEVELS, LOG_SOURCES, logsAnswer } from '../knowledge/logs.js';

declare const self: Worker;
const stage = (name: string): void => self.postMessage({ kind: 'stage', stage: name });
// Exact picture inputs include all labels, links, folds and language-specific words. Reads still take a fresh snapshot.
const pictures = new Map<string, DiagramAnswer>();
/**
 * Answers by the graph's own write revision, checked before the read. `assertion.recorded_sequence` is assigned by the
 * database on every write and is unique, so its maximum names the revision a freshly read graph is at: the same
 * revision is the same graph, and a picture of it is the same picture (decision 0036, sections 7 and 8). The bounded
 * map keeps a warm read worker from paying the whole catalogue read again for a page it has just drawn; any write
 * moves the revision and the next request reads afresh.
 */
const warm = new Map<string, DiagramAnswer>();
async function graphRevision(owner: DatabaseOwner): Promise<string> {
  return await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
    const sql = 'SELECT coalesce(max(recorded_sequence),0)::text AS revision FROM assertion';
    span.setAttribute('db.sql.bytes', Buffer.byteLength(sql));
    const answer = await owner.run(tx => tx.query<{ revision: string }>(sql));
    span.setAttribute('db.rows', answer.rows.length);
    return answer.rows[0]!.revision;
  });
}
async function neighbourhood(owner: DatabaseOwner, folder: string, asked: Extract<ReadWork, {kind: 'diagram'}>): Promise<DiagramNeighbourhood | undefined> {
  return await owner.transaction('snapshot', async (tx) => {
    await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = "SELECT set_config('statement_timeout', $1, true)";
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await tx.query(statementSql, [String(asked.deadlineMs ?? 30_000)]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined) throw new Error(`${folder}/madarch/catalog.yaml:1: the graph holds no published manifest`);
    const published = publishedManifestOf(manifest);
    // The templates are the graph's entities (the owner's decision of 2026-11-15), read in this page's own snapshot.
    const templates = await readPublishedTemplates(tx, manifest);
    const structure = structureRevisionOf(graphqlSchemaOf(published), templates.templates.templates);
    return await new ReadContext(tx, manifest, published, folder, asked.request.lang, structure, templates.templates, templates.files, new Map(templates.templates.templates.map((one) => [one.name, one.body])), templates.findings).diagramNeighbourhood(asked.request.entity, asked.request.depth ?? DIAGRAM_DEPTH, asked.request.lang, asked.request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE);
  });
}
async function diagram(asked: Extract<ReadWork, {kind: 'diagram'}>, owner?: DatabaseOwner): Promise<DiagramAnswer> {
  const request = { entity: asked.request.entity, depth: asked.request.depth ?? DIAGRAM_DEPTH, aggregateAbove: asked.request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE, format: asked.request.format, lang: asked.request.lang ?? null, base: asked.request.base ?? '' };
  const warmKey = owner === undefined || asked.descriptor === undefined ? undefined : JSON.stringify(['diagram', asked.descriptor.folder, await graphRevision(owner), request]);
  const remembered = warmKey === undefined ? undefined : warm.get(warmKey);
  if (remembered !== undefined) return remembered;
  stage('reading the neighbourhood');
  const hood = owner === undefined ? asked.neighbourhood : await neighbourhood(owner, asked.descriptor!.folder, asked);
  if (hood === undefined) return { status: 404, code: 'FAILED', error: `${import.meta.path}:1: the graph holds no entity "${asked.request.entity}"` };
  stage('folding the neighbourhood');
  const graph = diagramGraphOf(hood, asked.request.depth ?? DIAGRAM_DEPTH, asked.request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE, asked.request.base ?? '');
  const key = JSON.stringify({ graph, format: asked.request.format });
  const cached = pictures.get(key);
  if (cached !== undefined) return cached;
  stage(`laying out (${asked.request.format})`);
  let answer: DiagramAnswer;
  if (asked.request.format === 'mermaid') {
    answer = { status: 200, body: { format: 'mermaid', entity: graph.entity, depth: graph.depth, folded: graph.folded, truncated: graph.truncated, source: mermaidText(graph) } };
  } else {
    const liked = await likec4PictureOf(graph);
    if (asked.request.format === 'likec4') answer = { status: 200, body: { format: 'likec4', entity: graph.entity, depth: graph.depth, folded: graph.folded, truncated: graph.truncated, workspace: liked.workspace, view: liked.view, links: liked.links, titles: liked.titles, root: liked.root } };
    else answer = { status: 200, html: await renderArchify(archifyDocument(graph, liked), graph, { timeoutMs: asked.deadlineMs ?? 30_000, started: (pid, folder) => self.postMessage({ kind: 'renderer', pid, folder }), stopped: () => self.postMessage({ kind: 'renderer' }) }) };
  }
  const bytes = Buffer.byteLength('html' in answer ? answer.html : JSON.stringify('body' in answer ? answer.body : answer));
  if (bytes > DIAGRAM_MAX_BYTES) return { status: 200, code: 'TOO_LARGE', error: `${import.meta.path}:1: the diagram answer is over ${String(DIAGRAM_MAX_BYTES)} bytes` };
  if (pictures.size >= 8) pictures.delete(pictures.keys().next().value!);
  pictures.set(key, answer);
  if (warmKey !== undefined) {
    if (warm.size >= 8) warm.delete(warm.keys().next().value!);
    warm.set(warmKey, answer);
  }
  return answer;
}
/**
 * The logs page's read inside the read worker (madarch-64o5.88): the same page of every log the product keeps, filtered
 * by the operation's arguments. It opens no database and reads no product file.
 */
function logsReaderOf(descriptor: ReadDescriptor): ((asked: Readonly<Record<string, unknown>>) => unknown) | undefined {
  if (descriptor.store === undefined || descriptor.knowledgeRoot === undefined) return undefined;
  const paths = { store: descriptor.store, knowledgeRoot: descriptor.knowledgeRoot };
  return (asked) => {
    const sources = Array.isArray(asked['sources']) ? asked['sources'] : [];
    for (const name of sources) {
      if (typeof name !== 'string' || !(LOG_SOURCES as readonly string[]).includes(name)) throw new Error(`${import.meta.path}:1: "sources" is one of ${LOG_SOURCES.join(', ')}, got ${JSON.stringify(name)}`);
    }
    const level = asked.level;
    if (level !== undefined && (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level))) throw new Error(`${import.meta.path}:1: "level" is one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(level)}`);
    const whole = (key: string): number | undefined => {
      const held = asked[key];
      return typeof held === 'number' && Number.isFinite(held) && held >= 0 ? Math.floor(held) : undefined;
    };
    const from = whole('from');
    const before = whole('before');
    const limit = whole('limit');
    const run = typeof asked['run'] === 'string' && asked['run'] !== '' ? asked['run'] : undefined;
    const text = typeof asked['q'] === 'string' ? asked['q'] : undefined;
    return logsAnswer(paths, {
      ...(sources.length === 0 ? {} : { sources: sources as import('../knowledge/logs.js').LogSourceName[] }),
      ...(level === undefined ? {} : { level: level as import('../knowledge/logs.js').LogLevel }),
      ...(run === undefined ? {} : { run }),
      ...(text === undefined ? {} : { q: text }),
      ...(from === undefined ? {} : { since: from }),
      ...(before === undefined ? {} : { before }),
      ...(limit === undefined ? {} : { limit }),
    });
  };
}

self.onmessage = async (event: MessageEvent<ReadWork>) => {
  let owner: DatabaseOwner | undefined;
  let texts: ReturnType<typeof fileTextOf> | undefined;
  try {
    const asked = event.data;
    if (asked.descriptor !== undefined) owner = await createPostgresDatabaseOwner(asked.descriptor.connection);
    let answer: unknown;
    if (asked.kind === 'graphql') {
      texts = fileTextOf(asked.descriptor.connection, asked.descriptor.folder);
      answer = await executeGraphql(owner!, { folder: asked.descriptor.folder, deadlineMs: asked.deadlineMs ?? 30_000, readText: texts.read, logs: logsReaderOf(asked.descriptor) }, asked.operation);
    } else answer = await diagram(asked, owner);
    await texts?.close();
    await owner?.close();
    self.postMessage({ kind: 'read-complete', answer });
  } catch (error) {
    await texts?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * The read a page's `source` field answers with (decision 0037): the file's blob comes from the graph, and the bytes come
 * from the store's one queue, which the fill role answers. The read worker holds the store's connection, so it asks the
 * queue itself, and no working copy is opened.
 *
 * The queue stands on a database owner of its own, opened with the first `source` read and closed with the message: a
 * `pg-boss` queue cannot stand inside the read-only snapshot `executeGraphql` holds — its work would be invisible to the
 * fill role until the commit, and the owner refuses a queue opened inside its own transaction (`OwnWorkError`). A page
 * that reads no source opens nothing and pays nothing.
 */
function fileTextOf(connection: PoolConfig, product: string): { read: (ask: { readonly repository: string; readonly path: string; readonly blob: string; readonly moved: boolean; readonly from: number; readonly to?: number; readonly fromColumn?: number }) => Promise<Record<string, unknown> | undefined>; close: () => Promise<void> } {
  let queueOwner: DatabaseOwner | undefined;
  let opened: Promise<QueueService> | undefined;
  const queue = async (): Promise<QueueService> => {
    queueOwner ??= await createPostgresDatabaseOwner(connection);
    opened ??= openFillRunQueue(queueOwner).then(async (held) => { await declareFileTextQueue(held); return held; });
    return await opened;
  };
  const read = async (ask: { readonly repository: string; readonly path: string; readonly blob: string; readonly moved: boolean; readonly from: number; readonly to?: number; readonly fromColumn?: number }): Promise<Record<string, unknown> | undefined> => {
    // The repository is the one the product connected, read where its manifest declares it: a folder under repos/, or the
    // product folder itself, checked by the host before a byte is read.
    const held = readProduct(product);
    const root = held.ok && ask.repository === held.product.name ? product : join(product, 'repos', ask.repository);
    const answer = await readFileTextByBlob(await queue(), {
      product, repository: ask.repository, root, blob: ask.blob, from: ask.from,
      fromColumn: ask.moved ? null : ask.fromColumn ?? null,
      to: ask.moved ? null : ask.to ?? null,
    });
    return { ...answer, blob: ask.blob, from: ask.from, ...(ask.moved ? { moved: true } : {}) };
  };
  return { read, close: async () => { const held = queueOwner; queueOwner = undefined; opened = undefined; await held?.close(); } };
}
