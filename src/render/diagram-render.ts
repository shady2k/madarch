
import type { KnowledgeProduct } from '../knowledge/product.js';
import { archifyDocument, diagramGraphOf, likec4PictureOf, mermaidText, renderArchify } from './diagram.js';

/**
 * The rendered diagram of one entity (decision 0036, sections 7 and 8; capability views, one-view): one snapshot through
 * the graph read layer, the picture's data, and then the format the client asked for. The renderers are the project's own
 * (Mermaid's text, LikeC4's workspace and layout, vendored archify), so a picture is the same bytes for the same graph
 * revision whoever asks — the wiki's page, an HTTP client or an MCP tool.
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
  | { readonly status: number; readonly error: string };

/** The depth a request without one asks for, and the bound of the relations one entity is read with per level. */
export const DIAGRAM_DEPTH = 1;
export const DIAGRAM_AGGREGATE_ABOVE = 12;
/** The answer's own bound: a picture past this many bytes is refused, never sent in part (section 5's TOO_LARGE). */
export const DIAGRAM_MAX_BYTES = 2_000_000;

export async function renderDiagram(product: KnowledgeProduct, request: DiagramRequest): Promise<DiagramAnswer> {
  const depth = request.depth ?? DIAGRAM_DEPTH;
  const aggregateAbove = request.aggregateAbove ?? DIAGRAM_AGGREGATE_ABOVE;
  const neighbourhood = await product.diagramNeighbourhood(request.entity, depth, request.lang);
  if (neighbourhood === undefined) return { status: 404, error: `${import.meta.path}:1: the graph holds no entity "${request.entity}"` };
  const graph = diagramGraphOf(neighbourhood, depth, aggregateAbove);
  if (request.format === 'mermaid') {
    const source = mermaidText(graph);
    return bound({ status: 200, body: { format: 'mermaid', entity: { id: graph.entity.id, kind: graph.entity.kind, label: graph.entity.label, href: graph.entity.href }, depth, folded: graph.folded, truncated: graph.truncated, source } });
  }
  const liked = await likec4PictureOf(graph);
  if (request.format === 'likec4') {
    return bound({ status: 200, body: { format: 'likec4', entity: { id: graph.entity.id, kind: graph.entity.kind, label: graph.entity.label, href: graph.entity.href }, depth, folded: graph.folded, truncated: graph.truncated, workspace: liked.workspace, view: liked.view, links: liked.links } });
  }
  const html = await renderArchify(archifyDocument(graph, liked), graph);
  if (Buffer.byteLength(html, 'utf8') > DIAGRAM_MAX_BYTES) return { status: 200, error: `the archify page is over ${String(DIAGRAM_MAX_BYTES)} bytes` };
  return { status: 200, html };
}

/** A JSON answer, refused when it is past the answer bound: a picture is never sent in part. */
function bound(answer: { status: number; body: Record<string, unknown> }): DiagramAnswer {
  return Buffer.byteLength(JSON.stringify(answer.body), 'utf8') > DIAGRAM_MAX_BYTES
    ? { status: 200, error: `the diagram answer is over ${String(DIAGRAM_MAX_BYTES)} bytes` }
    : answer;
}
