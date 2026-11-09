/**
 * LikeC4 and archify representations of one graph-checked view (decision 0026; madarch-m38l.15). LikeC4 parses and lays
 * out the view in the server; its JSON model is rendered by the lazily loaded React runtime in the wiki app. Archify
 * renders a page from the same LikeC4 layout. In a release binary its renderer is bundled with the app and executed by
 * Bun's embedded runtime, so an installed binary needs neither a checkout nor an external Node installation.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagramWorkspace } from '../product-wiki/graph-workspace.js';
import { renderArchifyPage } from '../wiki/archify-page.js';
import { archifyDocument, archifyPageLinks, type ArchifyDocument, type ArchifyLayoutedView } from '../wiki/archify.js';
import { LikeC4 } from 'likec4';
import { shapeOf, type GraphView } from './views.js';
import { diagramTitleNodes } from './diagram-titles.js';


const FRAME_SOURCE = fileURLToPath(import.meta.url);
/** Use the real call site, not a line number that drifts whenever the adapter changes. */
function frameFailure(message: string): { ok: false; message: string } {
  const site = new Error().stack?.split('\n').find((line) => line.includes(FRAME_SOURCE) && !line.includes('frameFailure'))?.trim();
  return { ok: false, message: `${site ?? `${FRAME_SOURCE} (call-site line unavailable)`}: ${message}` };
}

export type Frame = { ok: true; html: string } | { ok: false; message: string };

let frameScratch: string | undefined;
/** Derived HTML lives only for this process, not in the install cache whose POSIX ownership rules Windows cannot check. */
function scratchOf(workspace: string): { ok: true; folder: string } | { ok: false; message: string } {
  try {
    if (frameScratch === undefined) {
      frameScratch = mkdtempSync(join(tmpdir(), 'madarch-view-'));
      process.once('exit', () => { if (frameScratch !== undefined) rmSync(frameScratch, { recursive: true, force: true }); });
    }
    const folder = join(frameScratch, `view-${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    return { ok: true, folder };
  } catch (error) {
    return frameFailure(`the archify frame scratch under ${tmpdir()} could not be created: ${String(error)}`);
  }
}

/** The workspace of a view, with every element's link the wiki's own address. */
export function workspaceOf(view: GraphView) {
  // Domain maps and deployments carry ownership as nesting, without invalid holder-to-child arrows.
  // Other view types can draw explicit holder-to-child arrows, which LikeC4 refuses for nested elements.

  const shape = shapeOf(view);
  const drawable = (view.spec.type === 'domain-map' || view.spec.type === 'deployment') ? shape : { ...shape, elements: shape.elements.map((element) => ({ ...element, parent: undefined })) };
  return diagramWorkspace(drawable, { pageAddress: (id) => view.elements.find((element) => element.id === id)?.href ?? '' });
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
    return frameFailure(`LikeC4 could not lay out the ${view.spec.type} view: ${error instanceof Error ? error.message : String(error)}`);
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
/**
 * The layout of the view, read off the LikeC4 model the LikeC4 tab already lays out: one parse of the workspace serves
 * both renderers, and the archify page cannot fail where the model succeeded. `$data` is LikeC4's own serialised model;
 * its view holds the nodes and edges at their laid-out positions.
 */
function layoutOfModel(model: unknown, viewId: string): { ok: true; view: ArchifyLayoutedView } | { ok: false; message: string } {
  type Held = { views?: Record<string, { nodes?: ReadonlyArray<Record<string, unknown>>; edges?: ReadonlyArray<Record<string, unknown>> }> };
  const views = (model as Held | null)?.views;
  const view = views === undefined ? undefined : views[viewId];
  if (view === undefined) return { ok: false, message: `the LikeC4 model madarch laid out holds no view "${viewId}"` };
  const nodes = (view.nodes ?? []).map((node) => ({
    id: String(node['id']),
    kind: String(node['kind'] ?? 'external'),
    title: String(node['title'] ?? node['id']),
    ...(typeof node['technology'] === 'string' ? { technology: node['technology'] } : {}),
    parent: node['parent'] === undefined || node['parent'] === null ? null : String(node['parent']),
    x: Number(node['x']), y: Number(node['y']), width: Number(node['width']), height: Number(node['height']),
  }));
  const edges = (view.edges ?? []).map((edge) => {
    const box = edge['labelBBox'] as { x: number; y: number; width: number; height: number } | null | undefined;
    const label = edge['label'];
    return {
      source: String(edge['source']),
      target: String(edge['target']),
      ...(typeof label === 'string' ? { label } : {}),
      ...(box === undefined || box === null ? {} : { labelAt: [box.x + box.width / 2, box.y + box.height / 2] as const }),
    };
  });
  return { ok: true, view: { id: viewId, title: viewId, nodes, edges } };
}

/** The layout of the workspace, parsed by LikeC4 here: the fallback for a model the LikeC4 tab could not read. */
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
    return { ok: false, message: `LikeC4 could not lay out the ${viewId} view: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await likec4?.[Symbol.asyncDispose]?.();
  }
}

/** The archify page of a view: the vendored renderer's page over the layout LikeC4 computes, with the click bridge. */
export async function archifyFrame(view: GraphView, env: Readonly<Record<string, string | undefined>>): Promise<Frame> {
  if (view.spec.type === 'er') return frameFailure('ER tables are drawn only by Mermaid erDiagram; table links remain under the picture');
  const held = workspaceOf(view);
  const scratch = scratchOf(held.workspace);
  if (!scratch.ok) return scratch;
  const page = join(scratch.folder, 'frame.html');
  if (existsSync(page)) return { ok: true, html: readFileSync(page, 'utf8') };
  // The layout comes from the model the LikeC4 tab lays out, so the archify page never re-parses the workspace: one parse
  // serves both renderers, and a view the model laid out is a view archify can draw.
  const modelled = await likec4Model(view);
  const fromModel = modelled.ok ? layoutOfModel(modelled.model, held.viewId) : undefined;
  // The model the LikeC4 tab lays out is the first source of the layout; a workspace LikeC4 refuses is parsed here, so
  // a refusal names the DSL rather than leaving the frame empty.
  const layout = fromModel !== undefined && fromModel.ok ? fromModel : await layoutOf(held.workspace, held.viewId);
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
    const details = new Map(view.elements.filter((element) => element.columns !== undefined).map((element) => [held.elementIds.get(element.id), element.columns!.map((column) => `${column.name} ${column.type ?? 'text'}${column.key ? ' PK' : ''}${column.fk ? ' FK' : ''}`).join(', ')]));
    // Archify's fixed 30px boundary padding cannot be halved with LikeC4 geometry: a grouped child at x=40
    // would move to x=20 and put its boundary outside the canvas. Keep grouped views at their native scale.
    const layoutScale = view.spec.type === 'domain-map' || view.spec.type === 'deployment' ? 1 : 0.5;
    const compact = { ...layout.view, nodes: layout.view.nodes.map((node) => ({ ...node, ...(details.has(node.id) ? { technology: details.get(node.id)! } : {}), x: node.x * layoutScale, y: node.y * layoutScale, width: node.width * layoutScale, height: node.height * layoutScale })), edges: layout.view.edges.map((edge) => ({ ...edge, ...(edge.labelAt ? { labelAt: [edge.labelAt[0] * layoutScale, edge.labelAt[1] * layoutScale] as const } : {}) })) };
    document = archifyDocument(compact, { output: 'view.html', dashed });
  } catch (error) {
    return frameFailure(`the archify document of the ${view.spec.type} view could not be built: ${error instanceof Error ? error.message : String(error)}`);
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
    // The page draws at the diagram's own size and scrolls: a page squeezed into the frame would keep the picture and
    // lose its words. Full screen, the frame is the window, so the diagram fits it there.
    const natural = `<style>html,body{margin:0!important;padding:0!important;overflow:hidden!important}.diagram-container{box-sizing:border-box!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;overflow:auto!important}svg{max-width:none!important;transform:none!important;clip-path:none!important}html[data-embed="true"] .diagram-nav{display:inline-flex!important;position:fixed!important;right:8px!important;bottom:8px!important;translate:none!important}html[data-embed="true"] .diagram-nav button:not([data-view]){display:none!important}</style>`;
    const fit = `<script>
(function () {
  document.documentElement.setAttribute('data-embed', 'true');
  var svg = document.querySelector('.diagram-container > svg');
  if (!svg) return;
  var box = svg.viewBox.baseVal;
  var titlePairs = (${diagramTitleNodes.toString()})(svg, 'archify', '');
  var titles = titlePairs.map(function(pair) { return pair.title; });
  var nodes = Array.from(svg.querySelectorAll('g[id^="node-"]'));
  var contentX = Math.min.apply(null, nodes.map(function (n) { return n.getBBox().x; }));
  var contentY = Math.min.apply(null, nodes.map(function (n) { return n.getBBox().y; }));
  var fonts = titles.map(function (n) { return parseFloat(getComputedStyle(n).fontSize); }).filter(function (n) { return n > 0; });
  var initial = null, currentScale = 1;
  var container = svg.parentElement;
  function controls() {
    document.querySelectorAll('.diagram-nav [data-view]').forEach(function(button) {
      var action = button.getAttribute('data-view');
      button.disabled = action === 'out' ? currentScale <= initial.minimum + 0.0001 : action === 'in' ? currentScale >= initial.maximum : false;
      if (action === 'reset') {
        var percent = button.querySelector('[data-view-percent]');
        if (percent) percent.textContent = Math.round(currentScale * 100) + '%';
      }
    });
  }
  function zoom(next) {
    next = Math.max(initial.minimum, Math.min(initial.maximum, next));
    var viewport = container.getBoundingClientRect(), rect = svg.getBoundingClientRect();
    var focusX = (viewport.left + container.clientWidth / 2 - rect.left) / currentScale;
    var focusY = (viewport.top + container.clientHeight / 2 - rect.top) / currentScale;
    currentScale = next;
    svg.style.setProperty('width', (box.width * next) + 'px', 'important');
    svg.style.setProperty('height', (box.height * next) + 'px', 'important');
    var marginX = Math.max(0, (container.clientWidth - box.width * next) / 2), marginY = Math.max(0, (container.clientHeight - box.height * next) / 2);
    svg.style.setProperty('margin-left', marginX + 'px', 'important');
    svg.style.setProperty('margin-top', marginY + 'px', 'important');
    container.scrollLeft = Math.max(0, marginX + focusX * next - container.clientWidth / 2);
    container.scrollTop = Math.max(0, marginY + focusY * next - container.clientHeight / 2);
    svg.setAttribute('data-current-scale', String(next));
    controls();
  }
  container.addEventListener('scroll', function(event) {
    event.stopImmediatePropagation();
    if (initial) controls();
  }, true);
  container.addEventListener('wheel', function(event) {
    if (!initial || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    zoom(currentScale * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, {capture:true, passive:false});
  document.addEventListener('click', function(event) {
    var button = event.target.closest && event.target.closest('.diagram-nav [data-view]');
    if (!button || !initial) return;
    event.preventDefault(); event.stopImmediatePropagation();
    var action = button.getAttribute('data-view');
    if (action === 'reset') { fit(); return; }
    if (action === 'in') zoom(currentScale * 1.25);
    if (action === 'out') zoom(currentScale / 1.25);
  }, true);
  function fit() {
    var parent = svg.parentElement;
    var full = new URLSearchParams(location.search).get('fullscreen') === '1';
    var floor = (full ? 9 : 11) / (fonts.length ? Math.min.apply(null, fonts) : 11);
    var availableWidth = parent.clientWidth - 24, availableHeight = parent.clientHeight - 24;
    var fitted = Math.min(availableWidth / box.width, availableHeight / box.height);
    var whole = fitted >= floor;
    var scale = whole ? Math.min(fitted, Math.max(1, floor)) : floor;
    var offsetX = whole ? Math.max(0, (parent.clientWidth - box.width * scale) / 2) : 12 - (contentX - box.x) * scale;
    var offsetY = whole ? Math.max(0, (parent.clientHeight - box.height * scale) / 2) : 12 - (contentY - box.y) * scale;
    if (!whole) {
      var inverse = svg.getScreenCTM().inverse();
      var rects = titles.map(function (title, index) {
        var r = title.getBoundingClientRect();
        var a = new DOMPoint(r.left,r.top).matrixTransform(inverse), b = new DOMPoint(r.right,r.bottom).matrixTransform(inverse);
        var n = titlePairs[index].node.getBoundingClientRect();
        var na = new DOMPoint(n.left,n.top).matrixTransform(inverse), nb = new DOMPoint(n.right,n.bottom).matrixTransform(inverse);
        return {x:a.x,y:a.y,width:b.x-a.x,height:b.y-a.y,node:{x:na.x,y:na.y,width:nb.x-na.x,height:nb.y-na.y}};
      });
      var first = rects.slice().sort(function(a,b) { return a.y-b.y || a.x-b.x; })[0];
      var boundaries = rects.concat(rects.map(function(r) { return r.node; }));
      var xs = Array.from(new Set([contentX].concat(boundaries.flatMap(function (r) { return [r.x - 12 / floor, r.x + r.width + 12 / floor, r.x + r.width - (parent.clientWidth - 12) / floor]; })))).sort(function (a,b) { return a-b; });
      var ys = Array.from(new Set([contentY].concat(boundaries.map(function (r) { return r.y - 12 / floor; })))).sort(function (a,b) { return a-b; });
      var found = false;
      for (var top of ys) {
        if (top < contentY) continue;
        for (var left of xs) {
          if (left < contentX) continue;
          var dx = 12 - left * floor, dy = 12 - top * floor, cuts = 0, visible = 0;
          if (first && (dx+first.x*floor<0 || dx+(first.x+first.width)*floor>parent.clientWidth || dy+first.y*floor<0 || dy+(first.y+first.height)*floor>parent.clientHeight)) continue;
          rects.forEach(function (r) {
            var l=dx+r.x*floor, a=dy+r.y*floor, right=l+r.width*floor, bottom=a+r.height*floor;
            var inside=l>=0 && right<=parent.clientWidth && a>=0 && bottom<=parent.clientHeight;
            var n=r.node, nl=dx+n.x*floor, nr=nl+n.width*floor, nt=dy+n.y*floor, nb=nt+n.height*floor;
            if(nr>0 && nl<parent.clientWidth && nb>0 && nt<parent.clientHeight && !inside) cuts++;
            else if (right>0 && l<parent.clientWidth && bottom>0 && a<parent.clientHeight) {
              if(!inside) cuts++; else visible++;
            }
          });
          if (cuts===0 && visible>=Math.min(2,titles.length)) { offsetX=dx+box.x*floor; offsetY=dy+box.y*floor; found=true; break; }
        }
        if(found) break;
      }
      if (!found && first) { offsetX=12-(first.x-box.x)*floor; offsetY=12-(first.y-box.y)*floor; }
      svg.setAttribute('data-reading-window-valid', String(found));
    } else svg.setAttribute('data-reading-window-valid', 'true');
    window.parent.postMessage({madarch:'reading-window',readable:svg.getAttribute('data-reading-window-valid')==='true'}, '*');
    svg.style.setProperty('width', (box.width * scale) + 'px', 'important');
    svg.style.setProperty('height', (box.height * scale) + 'px', 'important');
    svg.style.setProperty('margin-left', Math.max(0, offsetX) + 'px', 'important');
    svg.style.setProperty('margin-top', Math.max(0, offsetY) + 'px', 'important');
    svg.setAttribute('data-whole-fit', String(whole));
    svg.setAttribute('data-initial-scale', String(scale));
    parent.scrollLeft = Math.max(0, -offsetX); parent.scrollTop = Math.max(0, -offsetY);
    initial = {minimum: Math.min(fitted, scale), maximum: Math.max(4, scale * 3)};
    currentScale = scale;
    svg.setAttribute('data-current-scale', String(scale));
    controls();
  }
  fit(); document.fonts.ready.then(fit); addEventListener('resize', fit);
})();
</script>`;
    html = html.replace('</head>', `${natural}</head>`);
    html = html.replace('</body>', `${fit}<script>${FORWARD_CLICKS.replace('__ELEMENTS__', '{}')}</script></body>`);
    writeFileSync(page, html);
    return { ok: true, html };
  } catch (error) {
    return frameFailure(`the archify page of the ${view.spec.type} view could not be linked: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A failed iframe is still an HTTP failure, with a safe diagnostic and an explicit fallback message. */
export function archifyFailurePage(lang: string | undefined, message: string): string {
  const sentence = lang === 'ru' ? 'Эту диаграмму не удалось нарисовать в archify. Выберите другой рендерер.' : 'This diagram could not be drawn by archify. Choose another renderer.';
  const data = JSON.stringify({ madarch: 'failed', renderer: 'archify', message }).replaceAll('<', '\\u003c');
  return `<!DOCTYPE html><html lang="${lang === 'ru' ? 'ru' : 'en'}"><head><meta charset="utf-8"><title>archify</title></head><body data-frame-error="archify"><p>${sentence}</p><pre>${escapeHtml(message)}</pre><script>parent.postMessage(${data}, '*');</script></body></html>`;
}
