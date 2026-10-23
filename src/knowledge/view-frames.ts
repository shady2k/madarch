/**
 * LikeC4 and archify representations of one graph-checked view (decision 0026; madarch-m38l.15). LikeC4 parses and lays
 * out the view in the server; its JSON model is rendered by the lazily loaded React runtime in the wiki app. Archify
 * renders a page from the same LikeC4 layout. In a release binary its renderer is bundled with the app and executed by
 * Bun's embedded runtime, so an installed binary needs neither a checkout nor an external Node installation.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagramWorkspace } from '../product-wiki/graph-workspace.js';
import { renderArchifyPage } from '../wiki/archify-page.js';
import { archifyDocument, archifyPageLinks, type ArchifyDocument, type ArchifyLayoutedView } from '../wiki/archify.js';
import { ensureWikiCacheRoot } from '../wiki/cache.js';
import { LikeC4 } from 'likec4';
import { shapeOf, type GraphView } from './views.js';


export type Frame = { ok: true; html: string } | { ok: false; message: string };

/** The cache folder of one workspace's documents. */
function scratchOf(workspace: string, env: Readonly<Record<string, string | undefined>>): { ok: true; folder: string } | { ok: false; message: string } {
  const cache = ensureWikiCacheRoot(env);
  if (!cache.ok) return cache;
  const folder = join(cache.root, `view-${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return { ok: true, folder };
}

/** The workspace of a view, with every element's link the wiki's own address. */
export function workspaceOf(view: GraphView) {
  return diagramWorkspace(shapeOf(view), { pageAddress: (id) => view.elements.find((element) => element.id === id)?.href ?? '' });
}

// ---- LikeC4 --------------------------------------------------------------------------------------------

/** The layouted LikeC4 model, computed in-process and drawn by the browser runtime shipped in the wiki app. */
export async function likec4Model(view: GraphView): Promise<{ ok: true; model: unknown; elementLinks: Record<string, string> } | { ok: false; message: string }> {
  const held = workspaceOf(view);
  try {
    const likec4 = await LikeC4.fromSource(held.workspace, { logger: false, printErrors: false, throwIfInvalid: true });
    try {
      const model = await likec4.layoutedModel();
      const elementLinks: Record<string, string> = {};
      for (const element of view.elements) {
        const id = held.elementIds.get(element.id);
        if (id !== undefined && element.href !== null) elementLinks[id] = element.href;
      }
      return { ok: true, model: model.$data, elementLinks };
    } finally {
      await likec4[Symbol.asyncDispose]?.();
    }
  } catch (error) {
    return { ok: false, message: `LikeC4 could not lay out the ${view.spec.type} view: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The script a frame runs to forward a click on an element, or on a link in LikeC4's own details, to the wiki. */
const FORWARD_CLICKS = `
window.__elements = __ELEMENTS__;
function forward(href) { parent.postMessage({ madarch: 'open', href: href }, '*'); }
document.addEventListener('click', function (event) {
  var path = event.composedPath ? event.composedPath() : [];
  for (var at = 0; at < path.length; at++) {
    var node = path[at];
    if (!node || !node.getAttribute) continue;
    var href = node.tagName && node.tagName.toLowerCase() === 'a' ? node.getAttribute('href') : null;
    if (href && href.charAt(0) === '/') { event.preventDefault(); event.stopPropagation(); forward(href); return; }
    var id = node.getAttribute('data-id') || node.getAttribute('data-node-id') || node.getAttribute('data-likec4-fqn');
    if (id && window.__elements[id]) { event.preventDefault(); event.stopPropagation(); forward(window.__elements[id]); return; }
  }
}, true);
`;

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');


// ---- archify -------------------------------------------------------------------------------------------

/** The script the layout child runs: LikeC4's layout of every view of the workspace on its input, as JSON on its output. */
async function layoutOf(workspace: string, viewId: string): Promise<{ ok: true; view: ArchifyLayoutedView } | { ok: false; message: string }> {
  let likec4: Awaited<ReturnType<typeof LikeC4.fromSource>> | undefined;
  try {
    likec4 = await LikeC4.fromSource(workspace, { logger: false, printErrors: false, throwIfInvalid: true });
    const diagrams = await likec4.diagrams();
    const view = diagrams.find((diagram) => diagram.id === viewId);
    if (view === undefined) return { ok: false, message: `LikeC4 did not lay out the view "${viewId}"` };
    return {
      ok: true,
      view: {
        id: view.id,
        title: view.title ?? view.id,
        nodes: view.nodes.map((node) => ({ id: node.id, kind: node.kind ?? 'external', title: node.title, parent: node.parent ?? null, x: node.x, y: node.y, width: node.width, height: node.height })),
        // LikeC4 spells an absent label as `null` as well as `undefined`, and an edge without one carries no box:
        // the archify edge takes a label only when it holds a string, and the label's place only with its box.
        edges: view.edges.map((edge) => {
          const box = edge.labelBBox;
          return {
            source: edge.source,
            target: edge.target,
            ...(typeof edge.label === 'string' ? { label: edge.label } : {}),
            ...(box === undefined || box === null ? {} : { labelAt: [box.x + box.width / 2, box.y + box.height / 2] as const }),
          };
        }),
      },
    };
  } catch (error) {
    return { ok: false, message: `LikeC4 could not lay out the workspace: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await likec4?.[Symbol.asyncDispose]?.();
  }
}

/** The archify page of a view: the vendored renderer's page over the layout LikeC4 computes, with the click bridge. */
export async function archifyFrame(view: GraphView, env: Readonly<Record<string, string | undefined>>): Promise<Frame> {
  const held = workspaceOf(view);
  const scratch = scratchOf(held.workspace, env);
  if (!scratch.ok) return scratch;
  const page = join(scratch.folder, 'frame.html');
  if (existsSync(page)) return { ok: true, html: readFileSync(page, 'utf8') };
  const layout = await layoutOf(held.workspace, held.viewId);
  if (!layout.ok) return layout;
  const dashed = new Set<string>();
  for (const edge of view.edges) {
    if (!edge.dashed) continue;
    const from = held.elementIds.get(edge.from);
    const to = held.elementIds.get(edge.to);
    if (from !== undefined && to !== undefined) dashed.add(`${from}\u0000${to}`);
  }
  let document: ArchifyDocument;
  try {
    document = archifyDocument(layout.view, { output: 'view.html', dashed });
  } catch (error) {
    return { ok: false, message: `the archify document of the ${view.spec.type} view could not be built: ${error instanceof Error ? error.message : String(error)}` };
  }
  const input = join(scratch.folder, 'document.json');
  const output = join(scratch.folder, 'rendered.html');
  writeFileSync(input, JSON.stringify(document));
  const rendered = await renderArchifyPage(document, input, output);
  if (rendered.status !== 0 || !existsSync(output)) {
    // The renderer's own words, and the two paths it was given: a refusal nobody can locate is a refusal nobody can act on.
    return { ok: false, message: `${input}:1: the archify page of the ${view.spec.type} view could not be rendered into ${output} (renderer exit ${String(rendered.status)}):\n${rendered.output.trim() || 'it printed nothing'}` };
  }
  const links: Record<string, string> = {};
  for (const element of view.elements) {
    const component = held.componentIds.get(element.id);
    if (component !== undefined && element.href !== null) links[component] = element.href;
  }
  try {
    let html = archifyPageLinks(readFileSync(output, 'utf8'), Object.fromEntries(Object.entries(links).filter(([id]) => readFileSync(output, 'utf8').includes(`<g id="node-${id}" `))));
    html = html.replace('</body>', `<script>${FORWARD_CLICKS.replace('__ELEMENTS__', '{}')}</script></body>`);
    writeFileSync(page, html);
    return { ok: true, html };
  } catch (error) {
    return { ok: false, message: `the archify page of the ${view.spec.type} view could not be linked: ${error instanceof Error ? error.message : String(error)}` };
  }
}
