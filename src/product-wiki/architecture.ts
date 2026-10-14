/**
 * The wiki's Architecture section, computed server-side (feature E,
 * madarch-iuc.15): from the merged product model (src/product-wiki/model.ts)
 * the view set the shared renderer builds, each view's Mermaid source and
 * relation table (exactly what madarch's Mermaid page draws), the element
 * pages' facts (kind, technology, relations in and out, links), and the
 * document pages that name an element (the backlink rule's conservative
 * word-boundary match). One ask computes the whole bundle; the server
 * answers /api/architecture with it, fresh at every ask, and refuses
 * nothing — compile errors ride inside the bundle as values.
 *
 * Everything here is pure and deterministic: the same model gives the same
 * bundle, sorted by code point, never the clock.
 */
import { renderModel } from '../render/prepare.js';
import { mermaidOfPageText } from './mermaid-page.js';
import type { CompiledModel, CompiledElement, CompiledRelation, CompiledInterface } from '../model/compile.js';
import { byCodePoint } from '../model/order.js';
import type { ProductModelResult } from './model.js';

/** One view page: what the browser draws and what the table under it says. */
export interface ArchitectureView {
  /** The view's scope element id; `""` is the landscape. */
  readonly scope: string;
  /** The view's title as a reader reads it: the element's display name, or the landscape's. */
  readonly title: string;
  /** The Mermaid flowchart source, init directive included. */
  readonly mermaid: string;
  /** The table under the diagram: the arrows by number, exactly the renderer's page table. */
  readonly table: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] };
  /** The elements the view shows that have a view of their own: drill-down targets. */
  readonly opens: readonly string[];
  /** The view one level up; absent for the landscape and for a top element's view. */
  readonly up?: string;
}

/** One relation row of an element page. */
export interface ElementRelation {
  readonly relationId: string;
  /** The other end's element id. */
  readonly other: string;
  readonly name?: string;
  /** The relation's interface contract, when it names one. */
  readonly interface?: string;
  /** The relation's action on a topic or queue. */
  readonly action?: string;
}

/** One element page's facts. */
export interface ArchitectureElement {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly technology?: string;
  readonly parent?: string;
  readonly ancestors: readonly string[];
  /** The ids of the outgoing relations (the element is the initiator). */
  readonly outgoing: readonly ElementRelation[];
  /** The ids of the incoming relations. */
  readonly incoming: readonly ElementRelation[];
  /** The contracts of the interfaces this element provides. */
  readonly provides: readonly string[];
  /** The pages (by path within the product) whose text names this element. */
  readonly namedBy: readonly string[];
}

/** The whole Architecture answer. */
export interface ArchitectureBundle {
  /** What the shown model was built from less than the whole input (a declared repository with no checkout, an unreadable model file), each named at its place. */
  readonly notes: readonly { file: string; line: number; path: string; message: string }[];
  /** Present only when the merged model compiled; absent with errors. */
  readonly model?: {
    readonly elements: readonly ArchitectureElement[];
    readonly views: readonly ArchitectureView[];
  };
  /**
   * The rendered LikeC4 workspace's text, present with the model: the
   * server generates the LikeC4 webcomponent bundle from it (the same
   * generation the static wiki's build runs), keyed by its content hash.
   */
  readonly workspace?: string;
  /** The compile's own errors, each naming file, line and path. */
  readonly errors: readonly { file: string; line: number; path: string; message: string }[];
  /** The loader's warnings, when the model compiled. */
  readonly warnings: readonly { file: string; line: number; path: string; message: string }[];
  /** Where the model was read from, in reading order. */
  readonly sources: readonly string[];
}

/** The element's display name: its name, else its id. */
export function elementTitle(element: CompiledElement): string {
  return element.name ?? element.id;
}

/**
 * Whether a page's Markdown names the element — the same conservative rule
 * the client's document links follow (wiki/app/src/view.tsx linkElements),
 * one rule on both sides, plain character comparison: the id as written,
 * with no word character, dot or hyphen on either side (a hyphen and a dot
 * are part of an id, so `not-shop` never names `shop` and `a.b` never
 * names `b`), read outside fenced blocks, inline code spans and the
 * targets of existing links. A mention inside a code span is no match: the
 * conservative direction is no match.
 */
export function textNamesElement(text: string, id: string): boolean {
  if (text.length === 0 || id.length === 0) return false;
  let fence = '';
  for (const line of text.split('\n')) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (mark !== null) {
      const run = mark[1]!;
      if (fence === '') fence = run[0]!;
      else if (fence === run[0] && line.trim() === run[0]!.repeat(run.length)) fence = '';
      continue;
    }
    if (fence !== '') continue;
    const clean = maskCodeAndLinks(line);
    let at = clean.indexOf(id);
    while (at >= 0) {
      const before = at === 0 ? '' : clean[at - 1]!;
      const after = at + id.length >= clean.length ? '' : clean[at + id.length]!;
      if (!isIdChar(before) && !isIdChar(after)) return true;
      at = clean.indexOf(id, at + 1);
    }
  }
  return false;
}

/** Whether the character keeps an id bound to a larger word: word characters, dots and hyphens do. */
function isIdChar(char: string): boolean {
  return char !== '' && /\w|[.-]/.test(char);
}


/**
 * One line with its inline code spans and its link destinations masked
 * out. A destination runs from `](` to its closing `)`, counted by depth
 * so a destination with a parenthesised or quoted title
 * (`[x](shop "the shop")`) is masked whole; the id inside it is no
 * mention. The same masking the client's rewrite applies.
 */
function maskCodeAndLinks(line: string): string {
  let masked = '';
  let at = 0;
  while (at < line.length) {
    const open = line.indexOf('](', at);
    if (open < 0) break;
    const from = open + 1;
    let depth = 0;
    let close = -1;
    for (let at2 = from; at2 < line.length; at2++) {
      if (line[at2] === '(') depth++;
      else if (line[at2] === ')') {
        depth--;
        if (depth === 0) {
          close = at2;
          break;
        }
      }
    }
    if (close < 0) break; // an unclosed link: nothing after it is masked
    masked += line.slice(at, from) + '\u0000' + line.slice(close);
    at = close;
  }
  masked += line.slice(at);
  return masked.replace(/`[^`]*`/g, '``');
}

/** The relation rows of one element, one end at a time. */
function relationsOf(model: CompiledModel, id: string, end: 'from' | 'to'): ElementRelation[] {
  const rows: ElementRelation[] = [];
  for (const relation of model.relations) {
    if (relation[end] !== id) continue;
    const other = end === 'from' ? relation.to : relation.from;
    rows.push({
      relationId: relation.id,
      other,
      ...(relation.name === undefined ? {} : { name: relation.name }),
      ...(relation.interface === undefined ? {} : { interface: interfaceContract(model, relation.interface) }),
      ...(relation.action === undefined ? {} : { action: relation.action }),
    });
  }
  return rows.sort((a, b) => byCodePoint(a.other, b.other) || byCodePoint(a.relationId, b.relationId));
}

function interfaceContract(model: CompiledModel, interfaceId: string): string {
  return model.interfaces.find((iface) => iface.id === interfaceId)?.contract ?? interfaceId;
}

/**
 * The pages whose text names the element, in code point order of their
 * paths: the conservative whole-text word-boundary match over each page's
 * Markdown. `pages` maps a page's path within the product to its text.
 */
export function pagesNamingElement(pages: ReadonlyMap<string, string>, id: string): string[] {
  const named: string[] = [];
  for (const [path, text] of pages) {
    if (textNamesElement(text, id)) named.push(path);
  }
  return named.sort(byCodePoint);
}

/** The bundle of one compiled model plus the product's pages. */
export async function architectureBundle(
  model: CompiledModel,
  notes: readonly { file: string; line: number; path: string; message: string }[],
  warnings: ProductModelResult['warnings'],
  sources: readonly string[],
  pages: ReadonlyMap<string, string>,
): Promise<ArchitectureBundle> {
  // The views, from the shared renderer at the model's fixed moment.
  const rendering = await renderModel(model, { source: 'product-model', commit: 'product', at: 0 });
  if (rendering.pages === undefined || rendering.workspace === undefined) {
    return {
      notes: notes.map(noteOf),
      errors: rendering.errors.map((message) => ({ file: 'model', line: 1, path: '', message })),
      warnings: warnings.map(warningOf),
      sources,
    };
  }

  // One ArchitectureView per rendered page, the pairing the static build
  // reads off the workspace (src/wiki/build.ts diagramAssets): the pages
  // come in the view set's order, the landscape first. The drill-down and
  // the way up follow the view set's own rule: an element with children has
  // a view, and a view opens the child views it shows and leads up to the
  // nearest ancestor with a view, or to the landscape.
  const hasView = new Set(model.elements.filter((element) => model.elements.some((child) => child.parent === element.id)).map((element) => element.id));
  const elementById = new Map(model.elements.map((element) => [element.id, element]));
  const upOf = (scope: string): string | undefined => {
    const element = elementById.get(scope);
    for (let at = element?.parent; at !== undefined; at = elementById.get(at)?.parent) {
      if (hasView.has(at)) return at;
    }
    return undefined; // the landscape
  };
  const views: ArchitectureView[] = rendering.pages.map((page) => {
    const scope = page.file === '_landscape.md' ? '' : page.file.replace(/\.md$/, '');
    const { mermaid, table } = mermaidOfPageText(page.content);
    const scopeElement = scope === '' ? undefined : elementById.get(scope);
    const opens = scope === ''
      ? [...hasView].filter((id) => elementById.get(id)?.parent === undefined)
      : model.elements.filter((element) => element.parent === scope && hasView.has(element.id)).map((element) => element.id);
    const up = scope === '' ? undefined : upOf(scope);
    return {
      scope,
      title: scope === '' ? 'Landscape' : elementTitle(scopeElement ?? ({ id: scope } as CompiledElement)),
      mermaid,
      table,
      opens: opens.sort(byCodePoint),
      ...(up === undefined ? {} : { up }),
    };
  });

  const elements: ArchitectureElement[] = model.elements.map((element) => ({
    id: element.id,
    name: elementTitle(element),
    kind: element.kind,
    ...(element.technology === undefined ? {} : { technology: element.technology }),
    ...(element.parent === undefined ? {} : { parent: element.parent }),
    ancestors: element.ancestors,
    outgoing: relationsOf(model, element.id, 'from'),
    incoming: relationsOf(model, element.id, 'to'),
    provides: model.interfaces.filter((iface) => iface.provider === element.id).map((iface) => iface.contract).sort(byCodePoint),
    namedBy: pagesNamingElement(pages, element.id),
  })).sort((a, b) => byCodePoint(a.id, b.id));

  return { notes: notes.map(noteOf), model: { elements, views }, workspace: rendering.workspace, errors: [], warnings: warnings.map(warningOf), sources };
}

/** A problem, as the bundle's own shape (the server's and the bundle's are one). */
function noteOf(problem: { file: string; line: number; path: string; message: string }): { file: string; line: number; path: string; message: string } {
  return { file: problem.file, line: problem.line, path: problem.path, message: problem.message };
}

/** A loader warning, as the bundle's warning shape. */
function warningOf(warning: { file: string; line: number; path: string; message: string }): { file: string; line: number; path: string; message: string } {
  return { file: warning.file, line: warning.line, path: warning.path, message: warning.message };
}
