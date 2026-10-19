/**
 * The two generated documents one graph diagram's tabs show (madarch-tzte.23.4):
 * the LikeC4 webcomponent the LikeC4 tab draws, and the archify page the archify
 * tab shows in its frame — both made from the diagram's own workspace
 * (`graph-workspace.ts`), so the two renderers draw one model and not two.
 *
 * Both are generated once and kept: the LikeC4 webcomponent under the wiki's cache
 * root by the workspace's content hash (`likec4Webcomponent`), and the archify page
 * under a folder named the same way. The same diagram therefore answers the same
 * bytes on a second ask, and two diagrams never share one folder.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archifyDocument, archifyPageLinks, type ArchifyDocument } from '../wiki/archify.js';
import { layoutedViews, renderArchifyPage } from '../wiki/archify-page.js';
import { ensureWikiCacheRoot } from '../wiki/cache.js';
import type { DiagramModel } from '../fill/diagrams.js';
import { graphPageHref } from '../fill/diagrams.js';
import { diagramWorkspace, webcomponentElement, webcomponentPrefix } from './graph-workspace.js';
import { likec4Address } from './graph-diagrams.js';
import { LIKEC4_DRAWINGS_SOURCE } from './likec4-drawings.js';
import { likec4Webcomponent, type LikeC4Bundle } from './likec4-webcomponent.js';

/** The cache folder one diagram's generated documents stand in: named by the workspace's own bytes. */
function scratchOf(workspace: string, env: Readonly<Record<string, string | undefined>>): { readonly ok: true; readonly root: string } | { readonly ok: false; readonly message: string } {
  const cache = ensureWikiCacheRoot(env);
  if (!cache.ok) return cache;
  const folder = join(cache.root, `graph-diagram-${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return { ok: true, root: folder };
}

/** The diagram's LikeC4 webcomponent bundle, generated from its workspace with an element name of its own. */
export function graphLikeC4Bundle(model: DiagramModel, options: { readonly env: Readonly<Record<string, string | undefined>> }): LikeC4Bundle {
  const workspace = diagramWorkspace(model, { pageAddress: graphPageHref }).workspace;
  return likec4Webcomponent(workspace, options.env, { prefix: webcomponentPrefix(workspace) });
}

/** One archify page, or the refusal naming what could not be rendered and why. */
export type GraphArchifyPage = { readonly ok: true; readonly html: string } | { readonly ok: false; readonly message: string };

/**
 * One diagram as an archify page: the layout LikeC4 computes for the diagram's
 * view, the archify document of it (`archifyDocument`: a component per element at
 * LikeC4's own position, a connection per arrow with the model's dashes), the page
 * the vendored renderer writes from that document, and — wrapped around the
 * rendered components — the link from every element to its page, which archify's
 * document schema has no field for.
 */
export async function graphArchifyPage(model: DiagramModel, options: { readonly env: Readonly<Record<string, string | undefined>> }): Promise<GraphArchifyPage> {
  const held = diagramWorkspace(model, { pageAddress: graphPageHref });
  const cache = scratchOf(held.workspace, options.env);
  if (!cache.ok) return { ok: false, message: cache.message };
  const page = join(cache.root, 'page.html');
  if (existsSync(page)) return { ok: true, html: readFileSync(page, 'utf8') };
  let layouted: Awaited<ReturnType<typeof layoutedViews>>;
  try {
    layouted = await layoutedViews(held.workspace);
  } catch (error) {
    return { ok: false, message: `the ${model.type} diagram's workspace could not be laid out: ${error instanceof Error ? error.message : String(error)}` };
  }
  const view = layouted.get(held.viewId);
  if (view === undefined) {
    return { ok: false, message: `LikeC4 did not lay out the ${model.type} diagram's view "${held.viewId}": the archify page needs the view laid out (src/product-wiki/graph-render.ts)` };
  }
  // The connections the model draws dashed, keyed by the layout's own ends: an assumption or an unresolved end
  // reaches archify as its own dashed variant and not as a fact.
  const dashed = new Set<string>();
  for (const edge of model.edges) {
    if (!edge.dashed) continue;
    const from = held.elementIds.get(edge.from);
    const to = held.elementIds.get(edge.to);
    if (from === undefined || to === undefined) continue;
    dashed.add(`${from}\u0000${to}`);
  }
  let document: ArchifyDocument;
  try {
    document = archifyDocument(view, { output: 'graph-diagram.html', dashed });
  } catch (error) {
    return { ok: false, message: `the ${model.type} diagram's archify document could not be built: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rendered = renderArchifyPage(document, join(cache.root, 'document.json'), join(cache.root, 'rendered.html'));
  if (rendered.status !== 0 || !existsSync(join(cache.root, 'rendered.html'))) {
    return { ok: false, message: `the ${model.type} diagram's archify page could not be rendered: ${rendered.output}` };
  }
  // The links: every element whose kind has a page opens it, and the rest of the page is the renderer's own output.
  const links: Record<string, string> = {};
  for (const element of model.elements) {
    const component = held.componentIds.get(element.id);
    if (component === undefined || element.page === undefined) continue;
    links[component] = graphPageHref(element.page.id);
  }
  let html: string;
  try {
    html = archifyPageLinks(readFileSync(join(cache.root, 'rendered.html'), 'utf8'), links);
  } catch (error) {
    return { ok: false, message: `the ${model.type} diagram's archify page could not be linked: ${error instanceof Error ? error.message : String(error)}` };
  }
  writeFileSync(page, html);
  return { ok: true, html };
}

/**
 * One diagram as a page of LikeC4's own: a document that carries the diagram's
 * webcomponent bundle and the element it defines, sized to the frame the app shows
 * it in.
 *
 * It is a page and not a bare element inside the app for the reason the archify tab
 * is one too: LikeC4 arrives as its own document with its own script (the bundle
 * `likec4 gen webcomponent` makes, the one the static wiki already ships), so the app
 * frames the server's page instead of loading some megabytes into its own tree, and
 * the element is defined before the view is asked for whatever order the app loads
 * in.
 *
 * LikeC4 draws into a shadow root inside a shadow root (`likec4-drawings.ts`), so the
 * page's watchdog reads the composed tree: a page that asked the element's own shadow
 * root would call every drawing empty — that measurement, and not the renderer, is
 * what madarch-pdkl reported.
 */
export function graphLikeC4Page(model: DiagramModel, options: { readonly node: string }): { readonly ok: true; readonly html: string; readonly viewId: string } {
  const held = diagramWorkspace(model, { pageAddress: graphPageHref });
  const name = webcomponentElement(webcomponentPrefix(held.workspace));
  const script = likec4Address(options.node, model.type);
  // The page is the frame's whole document: the bundle draws into the element, and the element fills the frame.
  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${htmlText(model.title)}</title>`,
    '<style>',
    'html, body { margin: 0; height: 100%; background: transparent; }',
    `${name} { display: block; width: 100%; height: 100%; min-height: 480px; }`,
    '</style>',
    '</head>',
    '<body>',
    `<${name} view-id="${htmlText(held.viewId)}"></${name}>`,
    `<script src="${script}"></script>`,
    // LikeC4 draws into the shadow root it owns and, inside it, into a second one of its own: the drawings are
    // counted through both (`LIKEC4_DRAWINGS_SOURCE`). A browser where LikeC4 really drew nothing is told so in
    // words, rather than showing an empty frame that reads as a diagram nobody could draw.
    '<script>',
    `var likec4Drawings = ${LIKEC4_DRAWINGS_SOURCE};`,
    'window.setTimeout(function () {',
    `  var name = ${JSON.stringify(name)};`,
    '  var element = document.querySelector(name);',
    '  var drawings = element === null ? [] : likec4Drawings(element);',
    '  if (drawings.length > 0) return;',
    '  // The sentence names what this page can really see: whether the element was ever defined, and whether it',
    '  // holds a drawing. A bundle that never arrived is another failure than a view that stands empty.',
    "  var defined = !!(window.customElements && window.customElements.get(name));",
    "  var said = document.createElement('p');",
    "  said.setAttribute('data-likec4-undrawn', defined ? 'empty' : 'not-loaded');",
    "  said.style.cssText = 'margin: 1em; font: 14px/1.5 system-ui, sans-serif; color: #333;';",
    `  said.textContent = (defined`,
    `    ? ${JSON.stringify(`LikeC4's element is defined and its view of ${model.title} stands empty in this browser.`)}`,
    `    : ${JSON.stringify(`LikeC4's bundle did not load, so ${model.title} has no drawing to show.`)}`,
    "  ) + ' The Mermaid and archify tabs draw the same model.';",
    '  document.body.appendChild(said);',
    '}, 8000);',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { ok: true, html, viewId: held.viewId };
}

/** HTML's own specials escaped: a title is text, never markup. */
function htmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
