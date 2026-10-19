/**
 * One diagram model as a LikeC4 workspace (madarch-tzte.23.4; decision 0026,
 * "Diagrams"): the model madarch-tzte.23.2 builds, written as the `.c4` text the
 * pinned LikeC4 reads — a `specification` with one element kind per kind the
 * diagram shows, a `model` with every element and every arrow, and one `view`
 * that holds them all.
 *
 * Two renderers read it: the LikeC4 tab, whose webcomponent the server generates
 * from this text (`likec4Webcomponent`), and the archify tab, whose layout is the
 * one LikeC4 computes for the view (`layoutedViews`, `archifyDocument`). The
 * elements are flat — a diagram is a set of things a view shows and not a tree —
 * so the archify document draws every one of them as a component.
 *
 * What the model says survives the writing:
 *
 * - a dashed arrow is LikeC4's own `style { line dashed }`, so an assumption or an
 *   unresolved end is drawn dashed and a fact is drawn solid;
 * - an element links to its page (`link`, the app's own address for it), and its
 *   code place rides in the one spare line LikeC4 draws under a name
 *   (`technology`), the same place a reader follows in the facts list;
 * - a table's columns are its `technology` line as well, because LikeC4 draws no
 *   attribute list of its own.
 *
 * The text is a pure function of the model and the address prefix it is written
 * for: the same model gives the same bytes on every machine, the element ids are
 * the model's own positions in code point order, and nothing here reads the clock.
 */
import { createHash } from 'node:crypto';
import { byCodePoint } from '../model/order.js';
import type { DiagramElement, DiagramModel } from '../fill/diagrams.js';

/** Every element's LikeC4 id is `n` and its position in the model, which no name of the kind can collide with. */
const ID_PREFIX = 'n';

/** The one view a diagram's workspace holds: the diagram itself. */
const VIEW_ID = 'index';

/** One diagram's workspace, and what a reader of the generated webcomponent needs of it. */
export interface DiagramWorkspace {
  /** The whole `.c4` file. */
  readonly workspace: string;
  /** The view's id, the one `<element view-id=…>` names. */
  readonly viewId: string;
  /** Each element's LikeC4 id, by the model's element id. */
  readonly elementIds: ReadonlyMap<string, string>;
  /** The archive component id archify gives each element's component (`componentId` of its LikeC4 id). */
  readonly componentIds: ReadonlyMap<string, string>;
}

/** The name a LikeC4 webcomponent's custom element takes: its generation prefix and `-view`. */
export function webcomponentElement(prefix: string): string {
  return `${prefix}-view`;
}

/**
 * The generation prefix of one workspace's webcomponent, made from the
 * workspace's own bytes: the same text gives the same prefix on every machine, so
 * a bundle is cacheable by it, and two diagrams' bundles can stand on one page
 * without the second one's `customElements.define` colliding with the first's
 * (`likec4` defines the element unconditionally).
 */
export function webcomponentPrefix(workspace: string): string {
  return `madarch-graph-${createHash('sha256').update(workspace).digest('hex').slice(0, 12)}`;
}

/**
 * The workspace of one diagram model, with every element's page link made by
 * `pageAddress` — the app's own root-relative address for a page, which a products
 * home prefixes once when it answers the document (`http.ts`, `withProductPrefix`),
 * so the prefix never lands twice.
 */
export function diagramWorkspace(model: DiagramModel, options: { readonly pageAddress: (id: string) => string }): DiagramWorkspace {
  const elements = model.elements.map((element, at) => ({ element, id: `${ID_PREFIX}${String(at)}` }));
  const ids = new Map(elements.map((held) => [held.element.id, held.id]));
  const componentIds = new Map(elements.map((held) => [held.element.id, `c${held.id}`]));
  const kinds = [...new Set(model.elements.map((element) => element.kind ?? 'unresolved'))].sort(byCodePoint);
  const lines = [
    `// Rendered by madarch from the graph; the diagram is madarch's own model, not a file of a checkout.`,
    '',
    'specification {',
    ...kinds.map((kind) => `  element ${kind}`),
    '}',
    '',
    'model {',
  ];
  for (const held of elements) {
    lines.push(...elementLines(held.element, held.id, options));
  }
  if (model.edges.length > 0) lines.push('');
  for (const edge of model.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from === undefined || to === undefined) {
      throw new Error(`the ${model.type} diagram's arrow from "${edge.from}" to "${edge.to}" names ${from === undefined ? `"${edge.from}"` : `"${edge.to}"`}, which the model holds no element of: a LikeC4 workspace writes only the model's own elements (src/product-wiki/graph-workspace.ts)`);
    }
    const line = `  ${from} -> ${to} ${text(edge.label)}`;
    // A dashed arrow is the one LikeC4 draws dashed: an assumption, or an end the graph does not hold.
    if (edge.dashed) lines.push(`${line} {`, '    style {', '      line dashed', '    }', '  }');
    else lines.push(line);
  }
  lines.push('}', '', 'views {', `  view ${VIEW_ID} {`, `    title ${text(model.title)}`, '    include *', '  }', '}', '');
  return { workspace: lines.join('\n'), viewId: VIEW_ID, elementIds: ids, componentIds };
}

/** One element's lines: its kind and name, the page it opens where its kind has one, and its code place or columns. */
function elementLines(element: DiagramElement, id: string, options: { readonly pageAddress: (id: string) => string }): string[] {
  const kind = element.kind ?? 'unresolved';
  const head = `  ${id} = ${kind} ${text(element.label)}`;
  const body: string[] = [];
  // LikeC4 draws one spare line under a name, so a table's columns ride beside its place and not instead of it.
  const parts = [element.place === undefined ? undefined : placeText(element), (element.columns ?? []).length === 0 ? undefined : columnsText(element)].filter((part): part is string => part !== undefined);
  if (parts.length > 0) body.push(`    technology ${text(parts.join(' · '))}`);
  // A page's address is the app's own, root-relative: a products home prefixes it when it answers the document.
  if (element.page !== undefined) body.push(`    link ${options.pageAddress(element.page.id)}`);
  if (body.length === 0) return [head];
  return [`${head} {`, ...body, '  }'];
}

/** Where an element stands in code, as one line: the repository, the file and the lines, exactly as a fact's place reads. */
export function placeText(element: DiagramElement): string {
  const place = element.place!;
  return `${place.repository} · ${place.file}:${String(place.line)}-${String(place.endLine)}`;
}

/** A table's columns, as LikeC4's one spare line: each column's name and its type, in the model's own order. */
export function columnsText(element: DiagramElement): string {
  return (element.columns ?? []).map((column) => (column.dataType === undefined ? column.label : `${column.label} ${column.dataType}`)).join(', ');
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\u0000': '\\0',
};

/** A LikeC4 string: in double quotes, a quote, a backslash and every control character LikeC4 has an escape for escaped. */
function text(value: string): string {
  return `"${value.replace(/["\\\b\f\n\r\t\v\u0000]/g, (char) => ESCAPES[char]!)}"`;
}
