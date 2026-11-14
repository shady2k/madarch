/**
 * The rendered diagram of one entity (decision 0036, sections 7 and 8; capability views, one-view): one bounded snapshot
 * through the graph read layer, the picture's data — every neighbour of a kind above the fold bound drawn as one node
 * with its count, before anything is laid out — and then the format the client asked for, drawn in a worker of its own
 * under the read API's own deadline. A picture can never hold the server: a layout that runs long is killed, and the
 * answer says so with the depth a reader may try.
 */
import type { KnowledgeProduct } from '../knowledge/product.js';
import { readWorker, type ReadWork } from './read-worker.js';
import { withSpan } from '../obs/trace.js';

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
  | { readonly status: number; readonly error: string; readonly code?: 'TIMEOUT' | 'TOO_LARGE' | 'FAILED' | 'BAD_INPUT' };

/** The depth a request without one asks for, and the bound of the relations one entity is read with per level. */
export const DIAGRAM_DEPTH = 1;
export const DIAGRAM_AGGREGATE_ABOVE = 12;
/** The answer's own bound: a picture past this many bytes is refused, never sent in part (section 5's TOO_LARGE). */
export const DIAGRAM_MAX_BYTES = 2_000_000;
/** The default whole-read budget, including neighbourhood reading, worker startup, folding and layout. */
export const DIAGRAM_DEADLINE_MS = 30_000;

export async function renderDiagram(product: KnowledgeProduct, request: DiagramRequest, options: { deadlineMs?: number; workerUrl?: URL } = {}): Promise<DiagramAnswer> {
  if (request.depth !== undefined && request.depth !== DIAGRAM_DEPTH) return { status: 400, code: 'BAD_INPUT', error: `${import.meta.path}:1: "depth" must be 1; deeper diagram neighbourhoods are not supported` };
  const deadlineMs = options.deadlineMs ?? product.readDeadlineMs ?? DIAGRAM_DEADLINE_MS;
  return await withSpan('diagram.render', { 'diagram.format': request.format }, async () => {
    try {
      // Real products are read in the worker too: field rendering can be just as CPU-heavy as layout.
      const work: Promise<Extract<ReadWork, { kind: 'diagram' }>> = typeof product.readDescriptor === 'function'
        ? product.readDescriptor().then((descriptor) => ({ kind: 'diagram' as const, descriptor, request }))
        : product.diagramNeighbourhood(request.entity, request.depth ?? DIAGRAM_DEPTH, request.lang, request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE).then((neighbourhood) => ({ kind: 'diagram' as const, ...(neighbourhood === undefined ? {} : { neighbourhood }), request }));
      return await readWorker(work, deadlineMs, options.workerUrl);
    } catch (error) {
      return { status: 200, code: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED', error: error instanceof Error ? error.message : String(error) };
    }
  });
}
