/**
 * The rendered diagram of one entity (decision 0036, sections 7 and 8; capability views, one-view): one bounded snapshot
 * through the graph read layer, the picture's data — every neighbour of a kind above the fold bound drawn as one node
 * with its count, before anything is laid out — and then the format the client asked for, drawn in a process of its own
 * under the read API's own deadline. A picture can never hold the server: a layout that runs long is killed, and the
 * answer says so with the depth a reader may try.
 */
import type { KnowledgeProduct } from '../knowledge/product.js';
import { diagramGraphOf, renderArchify, type DiagramGraph } from './diagram.js';
import { withSpan, withSpanSync } from '../obs/trace.js';
import { stages } from '../server/http.js';

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
/** How long a picture may take to lay out: the read API's own deadline, after which the drawing process is killed. */
export const DIAGRAM_DEADLINE_MS = 2_000;

/** The picture's data, folded so that a container with a thousand children is a handful of nodes with their counts. */
export function boundedGraph(neighbourhood: Parameters<typeof diagramGraphOf>[0], depth: number, aggregateAbove: number): DiagramGraph {
  // A group above the bound is folded by the read's own count, so the picture is small whatever the entity holds.
  return diagramGraphOf(neighbourhood, depth, aggregateAbove);
}

export async function renderDiagram(product: KnowledgeProduct, request: DiagramRequest): Promise<DiagramAnswer> {
  const depth = request.depth ?? DIAGRAM_DEPTH;
  const aggregateAbove = request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE;
  const neighbourhood = await withSpan('diagram.read', { 'diagram.depth': depth }, async () => {
    stages.current?.stage('reading the neighbourhood');
    return await product.diagramNeighbourhood(request.entity, depth, request.lang);
  });
  if (neighbourhood === undefined) return { status: 404, error: `${import.meta.path}:1: the graph holds no entity "${request.entity}"`, code: 'FAILED' };
  // Folding by kind keeps every picture small, so there is nothing to refuse: it is drawn, or its process says why not.
  const graph = withSpanSync('diagram.fold', { 'diagram.groups': neighbourhood.groups.length }, () => {
    stages.current?.stage('folding the neighbourhood');
    return boundedGraph(neighbourhood, depth, aggregateAbove);
  });
  return await withSpan('diagram.layout', { 'diagram.format': request.format, 'diagram.nodes': graph.nodes.length, 'diagram.edges': graph.edges.length }, async () => {
    stages.current?.stage(`laying out (${request.format})`);
    return await layout(graph, request.format, DIAGRAM_DEADLINE_MS);
  });
}

/** The drawing itself: one warm process, one line in and one out, the server's deadline over the wait. */
let drawing: { child: ReturnType<typeof Bun.spawn>; queue: Promise<unknown>; waiting: ((line: string) => void) | undefined; ready: Promise<void>; markReady: () => void; ended: boolean } | undefined;

function warm(): NonNullable<typeof drawing> {
  if (drawing !== undefined && !drawing.ended) return drawing;
  const worker = new URL('./worker.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, worker], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const held: NonNullable<typeof drawing> = { child, queue: Promise.resolve(), waiting: undefined, ready, markReady, ended: false };
  void (async () => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        let end = text.indexOf('\n');
        while (end >= 0) {
          const line = text.slice(0, end);
          text = text.slice(end + 1);
          end = text.indexOf('\n');
          if (line.includes('"kind":"ready"')) { held.markReady(); continue; }
          held.waiting?.(line);
        }
      }
    } catch {
      // The process went: the request waiting on it answers its own refusal.
    } finally {
      held.ended = true;
      held.waiting?.('');
    }
  })();
  drawing = held;
  return held;
}

/** One line to the drawing process and the line it answers, or its death. */
async function line(asked: string): Promise<string> {
  const held = warm();
  // The process's own start is not the picture's time: the deadline covers the drawing.
  await Promise.race([held.ready, new Promise<void>((resolve) => setTimeout(resolve, 15_000))]);
  const ask = (): Promise<string> => new Promise<string>((resolve) => {
    held.waiting = (answered) => { held.waiting = undefined; resolve(answered); };
    const sink = held.child.stdin as import('bun').FileSink;
    sink.write(`${asked}\n`);
  });
  const next = held.queue.then(ask, ask);
  held.queue = next.catch(() => undefined);
  return next;
}

async function layout(graph: DiagramGraph, format: DiagramRequest['format'], deadlineMs: number): Promise<DiagramAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('timeout')); }, deadlineMs); });
    const answered = await Promise.race([line(JSON.stringify({ format, graph })), deadline]);
    if (answered === '') return { status: 200, code: 'FAILED', error: 'the picture process stopped' };
    const answer = JSON.parse(answered.trim()) as Record<string, unknown>;
    if (answer['kind'] === 'archify-document') {
      // The page's renderer is the vendored archify process: the server starts it and forwards the picture's presses.
      const document = (answer['document'] ?? {}) as Record<string, unknown>;
      const html = await renderArchify(document, graph);
      return Buffer.byteLength(html, 'utf8') > DIAGRAM_MAX_BYTES ? { status: 200, code: 'FAILED', error: `the archify page is over ${String(DIAGRAM_MAX_BYTES)} bytes` } : { status: 200, html };
    }
    if (answer['kind'] === 'html') {
      const html = String(answer['html'] ?? '');
      return Buffer.byteLength(html, 'utf8') > DIAGRAM_MAX_BYTES ? { status: 200, code: 'FAILED', error: `the archify page is over ${String(DIAGRAM_MAX_BYTES)} bytes` } : { status: 200, html };
    }
    if (answer['kind'] === 'json') {
      const body = (answer['body'] ?? {}) as Record<string, unknown>;
      return Buffer.byteLength(JSON.stringify(body), 'utf8') > DIAGRAM_MAX_BYTES ? { status: 200, code: 'FAILED', error: `the diagram answer is over ${String(DIAGRAM_MAX_BYTES)} bytes` } : { status: 200, body };
    }
    return { status: 200, code: 'FAILED', error: String(answer['message'] ?? 'the picture could not be drawn') };
  } catch {
    // The picture missed its deadline: the process is killed and the next picture starts a fresh one.
    if (drawing !== undefined) { try { drawing.child.kill(9); } catch { /* already gone */ } drawing = undefined; }
    return { status: 200, code: 'TIMEOUT', error: `the picture did not draw within ${String(Math.round(deadlineMs / 100) / 10)} s` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
