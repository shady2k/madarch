/**
 * The wiki's engine-neutral pages (docs/changes/wiki/capabilities/wiki.md):
 * one data structure computed from the compiled model alone, which each
 * engine's writer turns into its own project. A page has a stable id, a
 * title, a place in the navigation and content blocks — headings, paragraphs
 * and tables whose cells are text or links to another page by its id; later
 * tasks add diagram references and the element, interface, zone and category
 * pages to the same structure. Links are by page id: no engine-specific text
 * and no paths live here.
 *
 * Pure and deterministic: the same compiled model gives the same pages, in
 * the same order, every time — everything is sorted by code point, never by
 * locale, and nothing reads the clock.
 */
import type { CompiledElement, CompiledModel } from '../model/compile.js';

/** A link to another page of the same wiki, named by that page's id. */
export interface WikiLinkCell {
  readonly page: string;
  readonly text: string;
}

/** One cell of a table row: plain text, or a link to another page by its id. */
export type WikiCell = string | WikiLinkCell;

export interface WikiHeadingBlock {
  readonly kind: 'heading';
  readonly level: 2 | 3;
  readonly text: string;
}

export interface WikiParagraphBlock {
  readonly kind: 'paragraph';
  readonly text: string;
}

export interface WikiTableBlock {
  readonly kind: 'table';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly WikiCell[])[];
}

export type WikiBlock = WikiHeadingBlock | WikiParagraphBlock | WikiTableBlock;

export interface WikiPage {
  /** The page's stable id: `home`, `domain/<element id>`, and the later tasks' `element/<id>` and friends. */
  readonly id: string;
  readonly title: string;
  /** Where the page sits in the navigation, outermost first; empty for the home page. */
  readonly nav: readonly string[];
  readonly blocks: readonly WikiBlock[];
}

/**
 * Orders two strings by Unicode code point. Several sorts below must agree
 * with each other and stay off the machine's locale, so they share this one
 * comparator.
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `2 relations`, `1 relation`: the counts read as English in every block. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The name a page and a table row show for an element: its name, else its id. */
function displayName(element: CompiledElement): string {
  return element.name ?? element.id;
}

/** Elements ordered by the name they are shown under, ties by id. */
function byDisplayName(a: CompiledElement, b: CompiledElement): number {
  const byName = byCodePoint(displayName(a), displayName(b));
  return byName !== 0 ? byName : byCodePoint(a.id, b.id);
}

/**
 * The home page: the model's counts, the elements by kind, and every domain
 * by name, each linking to its page.
 */
function homePage(model: CompiledModel, domains: readonly CompiledElement[], descendants: (domain: CompiledElement) => readonly CompiledElement[]): WikiPage {
  const byKind = new Map<string, number>();
  for (const element of model.elements) byKind.set(element.kind, (byKind.get(element.kind) ?? 0) + 1);
  return {
    id: 'home',
    title: 'Home',
    nav: [],
    blocks: [
      {
        kind: 'paragraph',
        text: `The model holds ${count(model.elements.length, 'element')}, ${count(model.interfaces.length, 'interface')} and ${count(model.relations.length, 'relation')}.`,
      },
      { kind: 'heading', level: 2, text: 'Elements by kind' },
      {
        kind: 'table',
        columns: ['Kind', 'Elements'],
        rows: [...byKind.keys()].sort(byCodePoint).map((kind) => [kind, String(byKind.get(kind))]),
      },
      { kind: 'heading', level: 2, text: 'Domains' },
      {
        kind: 'table',
        columns: ['Domain', 'Elements'],
        rows: domains.map((domain) => [{ page: `domain/${domain.id}`, text: displayName(domain) }, String(descendants(domain).length)]),
      },
    ],
  };
}

/** One domain's page: its elements — everything under it — with kind and technology. */
function domainPage(domain: CompiledElement, elements: readonly CompiledElement[]): WikiPage {
  return {
    id: `domain/${domain.id}`,
    title: displayName(domain),
    nav: ['Domains'],
    blocks: [
      { kind: 'paragraph', text: `The ${displayName(domain)} domain holds ${count(elements.length, 'element')}.` },
      {
        kind: 'table',
        columns: ['Element', 'Kind', 'Technology'],
        rows: elements.map((element) => [displayName(element), element.kind, element.technology ?? '—']),
      },
    ],
  };
}

/**
 * The pages this task builds: the home page and one page per domain. Later
 * tasks extend the same structure with the element, interface, zone and
 * category pages and the diagrams.
 */
export function wikiPages(model: CompiledModel): WikiPage[] {
  const childrenOf = new Map<string, CompiledElement[]>();
  for (const element of model.elements) {
    const siblings = childrenOf.get(element.parent ?? '') ?? [];
    siblings.push(element);
    childrenOf.set(element.parent ?? '', siblings);
  }

  const domains = model.elements.filter((element) => element.kind === 'domain').sort(byDisplayName);
  // Every element under a domain, direct children and deeper, in display order.
  const descendantsOf = (domain: CompiledElement): CompiledElement[] => {
    const found: CompiledElement[] = [];
    const walk = (id: string): void => {
      const children = [...(childrenOf.get(id) ?? [])].sort(byDisplayName);
      for (const child of children) {
        found.push(child);
        walk(child.id);
      }
    };
    walk(domain.id);
    return found;
  };

  return [homePage(model, domains, descendantsOf), ...domains.map((domain) => domainPage(domain, descendantsOf(domain)))];
}
