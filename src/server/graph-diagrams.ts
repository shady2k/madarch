/**
 * The graph's diagrams over HTTP (madarch-tzte.23.4; decision 0026, "Diagrams"):
 * the diagrams of one node's page, and the two generated documents their tabs
 * show — the LikeC4 webcomponent bundle and the archify page.
 *
 * The answers are the wiki's own kind: they stand beside `GET /api/graph/page` and
 * answer under a product's prefix in a products home. The reads behind the first
 * one are the fill's (`src/fill/graph-diagrams.ts`); the two documents are made
 * here from the model the same source answers, so a tab and its model can never
 * disagree.
 *
 * A misconfigured `MADARCH_WIKI_DIAGRAM` is a 500 naming the value and the three
 * the setting accepts, exactly as the static build refuses it (exit 2): a wiki
 * whose first tab nobody can name is a wiki somebody configured wrong, and it says
 * so rather than choosing a tab in silence.
 */
import type { GraphPagesSource } from '../fill/graph-pages.js';
import type { DiagramType } from '../fill/diagrams.js';
import { chosenDiagramTab, graphDiagramsAnswer } from '../product-wiki/graph-diagrams.js';
import { graphArchifyPage, graphLikeC4Bundle, graphLikeC4Page } from '../product-wiki/graph-render.js';
import type { Handled, ReplyMaker } from './http.js';

/** The graph diagram routes, over one product's source. */
export interface GraphDiagramsPart {
  /** `GET /api/graph/diagrams?id=…`: one node's diagrams, each with its renderers' tabs. */
  diagrams: (request: Request) => Promise<Handled>;
  /** `GET /api/graph/likec4.js?id=…&type=…`: one diagram's LikeC4 webcomponent bundle. */
  likec4: (request: Request) => Promise<Handled>;
  /** `GET /api/graph/likec4.html?id=…&type=…`: one diagram as a page of LikeC4's own, framed by the app. */
  likec4Page: (request: Request) => Promise<Handled>;
  /** `GET /api/graph/archify?id=…&type=…`: one diagram as an archify page. */
  archify: (request: Request) => Promise<Handled>;
}

/** The diagram types a tab's address may name: the seven the models draw. */
const TYPES: readonly DiagramType[] = ['c4-component', 'c4-container', 'c4-context', 'er', 'module-dependency', 'sequence', 'state'];

/** One page and one type, asked of a tab's address: the node's id and the diagram's type, or the refusal naming what is missing. */
function askOf(request: Request): { readonly ok: true; readonly id: string; readonly type: DiagramType } | { readonly ok: false; readonly handled: Handled } {
  const parameters = new URL(request.url).searchParams;
  const id = parameters.get('id');
  const type = parameters.get('type');
  const refused = (field: string, message: string): { readonly ok: false; readonly handled: Handled } => ({ ok: false, handled: { response: Response.json({ message, error: { field, message } }, { status: 400 }), refusal: message } });
  if (id === null || id.trim() === '') return refused('id', '"id" is required: the fact id of the graph node whose diagram is asked for, like "module:1f…"');
  if (type === null || type.trim() === '') return refused('type', `"type" is required: the diagram's type, one of ${TYPES.join(', ')}`);
  const held = TYPES.find((candidate) => candidate === type);
  if (held === undefined) return refused('type', `"type" ${JSON.stringify(type)} is no diagram type: the types are ${TYPES.join(', ')}`);
  return { ok: true, id, type: held };
}

/** What a page the graph holds no page for answers: the page model's own code and words, as the page route answers them. */
function pageRefused(refused: ReplyMaker['refused'], read: { readonly code: string; readonly message: string }): Handled {
  const status = read.code === 'graph-pages/not-a-fact-id' ? 400 : 404;
  return refused(status, { field: 'id', message: read.message, code: read.code, logMessage: `${read.code}: a diagram was asked for and not answered` });
}

/**
 * The diagram routes over one product's source. Every address a document carries is
 * root-relative: a products home prefixes an HTML answer once when it serves it
 * (`http.ts`, `withProductPrefix`), so the prefix lands exactly where the app's own
 * addresses get it too.
 */
export function createGraphDiagramsPart(makers: Pick<ReplyMaker, 'json' | 'refused'> & { readonly errorLog: (line: string) => void }, source: GraphPagesSource, options: { readonly env: Readonly<Record<string, string | undefined>> }): GraphDiagramsPart {
  const { json } = makers;
  const chosen = chosenDiagramTab(options.env);
  const readDiagrams = async (id: string) => await source.diagrams(id);
  /** One node's diagrams, read once per ask: the tab's address and the answer's diagrams are the same read. */
  const diagramOf = async (id: string, type: DiagramType) => {
    const read = await readDiagrams(id);
    if (!read.ok) return read;
    const held = read.diagrams.find((diagram) => diagram.spec.type === type);
    return held === undefined ? { ok: false as const, code: 'graph-diagrams/no-such-diagram', message: `the page ${id} holds no ${type} diagram: a page draws the diagrams its node's kind stands in (src/fill/graph-diagrams.ts)` } : { ok: true as const, diagram: held };
  };
  return {
    diagrams: async (request: Request): Promise<Handled> => {
      const asked = new URL(request.url).searchParams.get('id');
      if (asked === null || asked.trim() === '') return makers.refused(400, { field: 'id', message: '"id" is required: the fact id of the graph node whose diagrams are asked for, like "module:1f…"' });
      if (!chosen.ok) {
        makers.errorLog(`the graph's diagrams cannot choose their first tab: ${chosen.message}`);
        return makers.refused(500, { message: chosen.message });
      }
      const read = await readDiagrams(asked);
      if (!read.ok) return pageRefused(makers.refused, read);
      const answer = graphDiagramsAnswer({
        product: read.page.product,
        node: read.page.node,
        diagrams: read.diagrams,
        chosen: chosen.tab,
        readAt: read.page.readAt,
      });
      return { response: json(200, answer) };
    },
    likec4: async (request: Request): Promise<Handled> => {
      const asked = askOf(request);
      if (!asked.ok) return asked.handled;
      const held = await diagramOf(asked.id, asked.type);
      if (!held.ok) return pageRefused(makers.refused, held);
      const bundle = graphLikeC4Bundle(held.diagram.model, { env: options.env });
      if (!bundle.ok) {
        makers.errorLog(`the ${asked.type} diagram of ${asked.id} cannot be served as a LikeC4 webcomponent: ${bundle.message}`);
        return makers.refused(500, { message: bundle.message });
      }
      return { response: new Response(bundle.script, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } }) };
    },
    likec4Page: async (request: Request): Promise<Handled> => {
      const asked = askOf(request);
      if (!asked.ok) return asked.handled;
      const held = await diagramOf(asked.id, asked.type);
      if (!held.ok) return pageRefused(makers.refused, held);
      const page = graphLikeC4Page(held.diagram.model, { node: asked.id });
      return { response: new Response(page.html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } }) };
    },
    archify: async (request: Request): Promise<Handled> => {
      const asked = askOf(request);
      if (!asked.ok) return asked.handled;
      const held = await diagramOf(asked.id, asked.type);
      if (!held.ok) return pageRefused(makers.refused, held);
      const page = await graphArchifyPage(held.diagram.model, { env: options.env });
      if (!page.ok) {
        makers.errorLog(`the ${asked.type} diagram of ${asked.id} cannot be served as an archify page: ${page.message}`);
        return makers.refused(500, { message: page.message });
      }
      // The page is the renderer's own document, framed by the app: it carries no script of the wiki's and
      // nothing a reader types, so it is served as the one file it is.
      return { response: new Response(page.html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } }) };
    },
  };
}
