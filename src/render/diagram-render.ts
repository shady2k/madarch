/**
 * The rendered diagram of one entity (decision 0036, sections 7 and 8; capability views, one-view): one bounded snapshot
 * through the graph read layer, the picture's data — every neighbour of a kind above the fold bound drawn as one node
 * with its count, before anything is laid out — and then the format the client asked for, drawn in a process of its own
 * under the read API's own deadline. A picture can never hold the server: a layout that runs long is killed, and the
 * answer says so with the depth a reader may try.
 */
import type { KnowledgeProduct } from '../knowledge/product.js';
import { diagramGraphOf, type DiagramGraph } from './diagram.js';

/**
 * The rendered diagram of one entity: one snapshot, the picture's data, and the format the client asked for. The
 * renderers are the project's own (Mermaid's text, LikeC4's workspace and layout, vendored archify), so a picture is the
 * same bytes for the same graph revision whoever asks — the wiki's page, an HTTP client or an MCP tool.
 */
export interface DiagramRequest {
  readonly entity: string;
  readonly depth?: number;
  readonly format: 'likec4' | 'mermaid' | 'archify';
  readonly lang?: string;
  readonly aggregateAbove?: number;
}

/** What one format answers: a JSON body (LikeC4 and Mermaid) or one self-contained HTML page (archify). */
export type DiagramAnswer =
  | { readonly status: number; readonly body: Record<string, unknown> }
  | { readonly status: number; readonly html: string }
  | { readonly status: number; readonly error: string; readonly code?: 'TIMEOUT' | 'TOO_LARGE' | 'FAILED' };

/** The depth a request without one asks for, and the bound of the relations one entity is read with per level. */
export const DIAGRAM_DEPTH = 1;
export const DIAGRAM_AGGREGATE_ABOVE = 12;
/** The answer's own bound: a picture past this many bytes is refused, never sent in part (section 5's TOO_LARGE). */
export const DIAGRAM_MAX_BYTES = 2_000_000;
/** How many nodes and edges a laid-out picture may hold: past it every neighbour kind is one node, and past that it is refused. */
export const DIAGRAM_MAX_NODES = 80;
export const DIAGRAM_MAX_EDGES = 160;
/** How long a picture may take to lay out: the read API's own deadline, after which the drawing process is killed. */
export const DIAGRAM_DEADLINE_MS = 2_000;

/** The picture's data, folded so that a container with a thousand children is a handful of nodes with their counts. */
export function boundedGraph(neighbourhood: Parameters<typeof diagramGraphOf>[0], depth: number, aggregateAbove: number): DiagramGraph[] {
  const first = diagramGraphOf(neighbourhood, depth, aggregateAbove);
  // A picture that is still too wide folds every neighbour kind into one node: a folder with 1 000 children of six kinds
  // is six nodes, not 1 000, and the layout never sees the children at all.
  const wide = first.nodes.length > DIAGRAM_MAX_NODES || first.edges.length > DIAGRAM_MAX_EDGES;
  return wide ? [first, diagramGraphOf(neighbourhood, depth, 0)] : [first];
}

export async function renderDiagram(product: KnowledgeProduct, request: DiagramRequest): Promise<DiagramAnswer> {
  const depth = request.depth ?? DIAGRAM_DEPTH;
  const aggregateAbove = request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE;
  const neighbourhood = await product.diagramNeighbourhood(request.entity, depth, request.lang);
  if (neighbourhood === undefined) return { status: 404, error: `${import.meta.path}:1: the graph holds no entity "${request.entity}"`, code: 'FAILED' };
  const graphs = boundedGraph(neighbourhood, depth, aggregateAbove);
  const graph = graphs[graphs.length - 1]!;
  const chosen = graph.nodes.length > DIAGRAM_MAX_NODES || graph.edges.length > DIAGRAM_MAX_EDGES ? undefined : graph;
  if (chosen === undefined) {
    return {
      status: 200,
      code: 'TOO_LARGE',
      error: `this entity holds more than ${String(DIAGRAM_MAX_NODES)} neighbours of more than ${String(DIAGRAM_MAX_EDGES)} relations to draw: try depth 1, or open one of its children`,
    };
  }
  return await drawn(chosen, request.format);
}

/** One picture, laid out in a process of its own: the server waits its deadline, then kills the drawing and says so. */
async function drawn(graph: DiagramGraph, format: DiagramRequest['format']): Promise<DiagramAnswer> {
  if (graph.nodes.length <= 2) {
    // A picture of one entity and its fold needs no layout engine: the process boundary is for pictures that cost.
    return await layout(graph, format, DIAGRAM_DEADLINE_MS);
  }
  return await layout(graph, format, DIAGRAM_DEADLINE_MS);
}

/** The drawing itself: one child process, its stdin the picture and its stdout the answer. */
async function layout(graph: DiagramGraph, format: DiagramRequest['format'], deadlineMs: number): Promise<DiagramAnswer> {
  const worker = new URL('./worker.ts', import.meta.url).pathname;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, worker], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const input = child.stdin as import('bun').FileSink;
    input.write(JSON.stringify({ format, graph }));
    try { await input.end(); } catch { /* the child may have gone: its exit says why */ }
    const timeout = new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => { reject(new Error('timeout')); }, deadlineMs); });
    const finished = (async (): Promise<string> => {
      const out = await new Response(child!.stdout as ReadableStream<Uint8Array>).text();
      await child!.exited;
      return out;
    })();
    let text: string;
    try {
      text = await Promise.race([finished, timeout]);
    } catch {
      child.kill(9);
      try { await child.exited; } catch { /* already gone */ }
      return { status: 200, code: 'TIMEOUT', error: `the picture did not draw within ${String(Math.round(deadlineMs / 100) / 10)} s: try depth 1, or a narrower entity` };
    }
    const answer = JSON.parse(text.trim()) as Record<string, unknown>;
    if (answer['kind'] === 'html') {
      const html = String(answer['html'] ?? '');
      return Buffer.byteLength(html, 'utf8') > DIAGRAM_MAX_BYTES ? { status: 200, code: 'TOO_LARGE', error: `the archify page is over ${String(DIAGRAM_MAX_BYTES)} bytes` } : { status: 200, html };
    }
    if (answer['kind'] === 'json') {
      const body = (answer['body'] ?? {}) as Record<string, unknown>;
      return Buffer.byteLength(JSON.stringify(body), 'utf8') > DIAGRAM_MAX_BYTES ? { status: 200, code: 'TOO_LARGE', error: `the diagram answer is over ${String(DIAGRAM_MAX_BYTES)} bytes` } : { status: 200, body };
    }
    return { status: 200, code: 'FAILED', error: String(answer['message'] ?? 'the picture could not be drawn') };
  } catch (error) {
    child?.kill(9);
    return { status: 200, code: 'FAILED', error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
