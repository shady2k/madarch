/** The CPU read, fold, layout and HTML work lives off the API event loop. */
import { createPostgresDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { readPublishedManifest } from '../graph/manifest-publication.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { executeGraphql, structureRevisionOf } from '../graph/graphql-execute.js';
import { ReadContext, type DiagramNeighbourhood } from '../graph/graphql-read.js';
import { readProductTemplates } from '../graph/product-templates.js';
import { diagramGraphOf, archifyDocument, likec4PictureOf, mermaidText, renderArchify } from '../render/diagram.js';
import { DIAGRAM_DEPTH, DIAGRAM_AGGREGATE_ABOVE, DIAGRAM_MAX_BYTES, type DiagramAnswer } from '../render/diagram-render.js';
import type { ReadWork } from '../render/read-worker.js';

declare const self: Worker;
const stage = (name: string): void => self.postMessage({ kind: 'stage', stage: name });
// Exact picture inputs include all labels, links, folds and language-specific words. Reads still take a fresh snapshot.
const pictures = new Map<string, DiagramAnswer>();
async function neighbourhood(owner: DatabaseOwner, folder: string, asked: Extract<ReadWork, {kind: 'diagram'}>): Promise<DiagramNeighbourhood | undefined> {
  return await owner.transaction('snapshot', async (tx) => {
    await tx.query("SELECT set_config('statement_timeout', $1, true)", [String(asked.deadlineMs ?? 30_000)]);
    const manifest = await readPublishedManifest(tx);
    if (manifest === undefined) throw new Error(`${folder}/madarch/catalog.yaml:1: the graph holds no published manifest`);
    const published = publishedManifestOf(manifest);
    const templates = readProductTemplates(folder);
    const structure = structureRevisionOf(graphqlSchemaOf(published), templates.templates);
    return await new ReadContext(tx, manifest, published, folder, asked.request.lang, structure, templates).diagramNeighbourhood(asked.request.entity, asked.request.depth ?? DIAGRAM_DEPTH, asked.request.lang, asked.request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE);
  });
}
async function diagram(asked: Extract<ReadWork, {kind: 'diagram'}>, owner?: DatabaseOwner): Promise<DiagramAnswer> {
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
    if (asked.request.format === 'likec4') answer = { status: 200, body: { format: 'likec4', entity: graph.entity, depth: graph.depth, folded: graph.folded, truncated: graph.truncated, workspace: liked.workspace, view: liked.view, links: liked.links } };
    else answer = { status: 200, html: await renderArchify(archifyDocument(graph, liked), graph, { timeoutMs: asked.deadlineMs ?? 30_000, started: (pid, folder) => self.postMessage({ kind: 'renderer', pid, folder }), stopped: () => self.postMessage({ kind: 'renderer' }) }) };
  }
  const bytes = Buffer.byteLength('html' in answer ? answer.html : JSON.stringify('body' in answer ? answer.body : answer));
  if (bytes > DIAGRAM_MAX_BYTES) return { status: 200, code: 'TOO_LARGE', error: `${import.meta.path}:1: the diagram answer is over ${String(DIAGRAM_MAX_BYTES)} bytes` };
  if (pictures.size >= 8) pictures.delete(pictures.keys().next().value!);
  pictures.set(key, answer);
  return answer;
}
self.onmessage = async (event: MessageEvent<ReadWork>) => {
  let owner: DatabaseOwner | undefined;
  try {
    const asked = event.data;
    if (asked.descriptor !== undefined) owner = await createPostgresDatabaseOwner(asked.descriptor.connection);
    const answer = asked.kind === 'graphql'
      ? await executeGraphql(owner!, { folder: asked.descriptor.folder, deadlineMs: asked.deadlineMs ?? 30_000 }, asked.operation)
      : await diagram(asked, owner);
    await owner?.close();
    self.postMessage({ kind: 'answer', answer });
  } catch (error) {
    await owner?.close().catch(() => undefined);
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
