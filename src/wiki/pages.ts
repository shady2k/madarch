/**
 * The wiki's engine-neutral pages (docs/changes/wiki/capabilities/wiki.md):
 * one data structure computed from the compiled model alone, which each
 * engine's writer turns into its own project. A page has a stable id, a
 * title, a place in the navigation and content blocks — headings, paragraphs
 * and tables whose cells are text, a link to another page by its id (with an
 * anchor onto one of that page's headings), or several such links shown
 * together, and the diagram of the view the page belongs to. Links are by
 * page id: no engine-specific text and no paths live here.
 *
 * Pure and deterministic: the same compiled model and view set give the same
 * pages, in the same order, every time — everything is sorted by code point,
 * never by locale, and nothing reads the clock.
 */
import type { CompiledCategory, CompiledElement, CompiledInterface, CompiledModel, CompiledRelation, CompiledZone } from '../model/compile.js';

/** A link to another page of the same wiki, named by that page's id. */
export interface WikiLinkCell {
  readonly page: string;
  /** The exact text of the heading on that page the link lands on; absent when it targets the page itself. */
  readonly anchor?: string;
  readonly text: string;
}

/**
 * One cell of a table row: plain text, a link to another page by its id, or
 * several links (a zone list, an ancestor chain, an interface's callers)
 * shown together — the writer joins them with ", ".
 */
export type WikiCell = string | WikiLinkCell | readonly WikiLinkCell[];

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

export type WikiBlock = WikiHeadingBlock | WikiParagraphBlock | WikiTableBlock | WikiDiagramBlock;

/**
 * The diagram a home, domain or element page carries: the view the page
 * belongs to (requirement `diagrams`), named by its scope — the element the
 * view is of, or no scope for the landscape. The writer turns the block
 * into the formats the reader switches between; the page data only says
 * which view it is.
 */
export interface WikiDiagramBlock {
  readonly kind: 'diagram';
  /** The element whose view the page shows; absent for the landscape. */
  readonly scope?: string;
}

export interface WikiPage {
  /** The page's stable id: `home`, `domain/<id>`, `element/<id>`, `interfaces`, `zones`, `zone/<id>`, `data-categories`, `data-category/<id>`. */
  readonly id: string;
  readonly title: string;
  /** Where the page sits in the navigation, outermost first; empty for the home page. */
  readonly nav: readonly string[];
  readonly blocks: readonly WikiBlock[];
}

/**
 * Everything the page builders read, resolved once: the model plus the
 * lookups that turn an id into the part it names, each refusing an id the
 * model lacks — a relation, interface or element naming a missing part is
 * an error that names it, never a silently dropped row.
 */
interface ModelParts {
  readonly model: CompiledModel;
  readonly elementById: Map<string, CompiledElement>;
  readonly zoneName: Map<string, string>;
  readonly categoryName: Map<string, string>;
  readonly interfaceById: Map<string, CompiledInterface>;
  /**
   * The element ids the rendered view set holds a view of: what the
   * nearest-view rule walks. The landscape is not listed — it is the rule's
   * own fallback, and a rendered view set always holds it.
   */
  readonly views: ReadonlySet<string>;
}

/**
 * Orders two strings by Unicode code point. Several sorts below must agree
 * with each other and stay off the machine's locale, so they share this one
 * comparator; the link checker sorts its report by it too.
 */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `2 relations`, `1 relation`, `3 data categories`: the counts read as English in every block. */
function count(n: number, noun: string): string {
  const plural = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${n} ${n === 1 ? noun : plural}`;
}

/** The name a page and a table row show for an element: its name, else its id. */
function displayName(element: CompiledElement): string {
  return element.name ?? element.id;
}

/** Elements ordered by the name they are shown under, ties by id. */
function byDisplayName(a: CompiledElement, b: CompiledElement): number {
  return byCodePoint(displayName(a), displayName(b)) || byCodePoint(a.id, b.id);
}

/** The kind of a contract id: the part before its first `::`, else the whole id. */
function contractKind(contract: string): string {
  const separator = contract.indexOf('::');
  return separator < 0 ? contract : contract.slice(0, separator);
}

/** The part an id names, refusing an id no element of the model carries. */
function mustElement(parts: ModelParts, id: string, named: string): CompiledElement {
  const element = parts.elementById.get(id);
  if (element === undefined) throw new Error(`${named} names element "${id}", which the model does not have`);
  return element;
}

/** The link to an element's page: domains keep their own folder, everything else lives under `element/`. */
function elementLink(element: CompiledElement): WikiLinkCell {
  return { page: element.kind === 'domain' ? `domain/${element.id}` : `element/${element.id}`, text: displayName(element) };
}

/** The link to a zone's own page, refusing a zone the model does not declare. */
function zoneLink(parts: ModelParts, zoneId: string, named: string): WikiLinkCell {
  const name = parts.zoneName.get(zoneId);
  if (name === undefined) throw new Error(`${named} names zone "${zoneId}", which the model does not have`);
  return { page: `zone/${zoneId}`, text: name };
}

/** The link to a data category's own page, refusing a category the model does not declare. */
function categoryLink(parts: ModelParts, categoryId: string, named: string): WikiLinkCell {
  const name = parts.categoryName.get(categoryId);
  if (name === undefined) throw new Error(`${named} carries data category "${categoryId}", which the model does not have`);
  return { page: `data-category/${categoryId}`, text: name };
}

/** The link to a contract's section of the interfaces page, refusing an interface the model does not declare. */
function contractLink(parts: ModelParts, interfaceId: string, named: string): WikiLinkCell {
  const iface = parts.interfaceById.get(interfaceId);
  if (iface === undefined) throw new Error(`${named} names interface "${interfaceId}", which the model does not have`);
  return { page: 'interfaces', anchor: contractKind(iface.contract), text: iface.contract };
}

/**
 * The elements a relation or interface reaches through one interface id:
 * the callers — the relations' initiators — once each, in display order,
 * or the em dash when nothing calls it.
 */
function callersOf(parts: ModelParts, interfaceId: string): WikiCell {
  const callers = new Map<string, CompiledElement>();
  for (const relation of parts.model.relations) {
    if (relation.interface !== interfaceId) continue;
    const caller = mustElement(parts, relation.from, `relation "${relation.id}"`);
    callers.set(caller.id, caller);
  }
  if (callers.size === 0) return '—';
  return [...callers.values()].sort(byDisplayName).map(elementLink);
}

/**
 * The view the page of `element` shows (requirement `diagrams`): the view
 * of the part itself, else of its nearest ancestor that has one — the
 * ancestor chain is root first, so the nearest is the last — else the
 * landscape.
 */
function diagramFor(parts: ModelParts, element: CompiledElement): WikiDiagramBlock {
  if (parts.views.has(element.id)) return { kind: 'diagram', scope: element.id };
  for (let i = element.ancestors.length - 1; i >= 0; i--) {
    const ancestorId = element.ancestors[i]!;
    if (parts.views.has(ancestorId)) return { kind: 'diagram', scope: ancestorId };
  }
  return { kind: 'diagram' };
}

/** The home page: the model's counts, the elements by kind, and every domain by name, each linking to its page. */
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
      { kind: 'heading', level: 2, text: 'Landscape' },
      // The home page is about the whole system: its diagram is the landscape.
      { kind: 'diagram' },
    ],
  };
}

/** One domain's page: its diagram, then its elements — everything under it — with kind and technology, each linking to its page. */
function domainPage(parts: ModelParts, domain: CompiledElement, elements: readonly CompiledElement[]): WikiPage {
  return {
    id: `domain/${domain.id}`,
    title: displayName(domain),
    nav: ['Domains'],
    blocks: [
      { kind: 'paragraph', text: `The ${displayName(domain)} domain holds ${count(elements.length, 'element')}.` },
      diagramFor(parts, domain),
      {
        kind: 'table',
        columns: ['Element', 'Kind', 'Technology'],
        rows: elements.map((element) => [elementLink(element), element.kind, element.technology ?? '—']),
      },
    ],
  };
}

/**
 * One element's page: its kind, technology, zones and ancestor chain in one
 * row, the view it belongs to under it; the interfaces it provides with
 * their callers; and its outgoing and incoming relations, each row naming
 * the other end, the relation's name, its interface's contract, its action
 * and its data categories.
 */
function elementPage(parts: ModelParts, element: CompiledElement): WikiPage {
  const rootAncestor = element.ancestors.length > 0 ? parts.elementById.get(element.ancestors[0]!) : undefined;
  // Under its domain in the navigation; people, externals and the broker stand beside the domains.
  const nav = rootAncestor?.kind === 'domain' ? ['Domains', displayName(rootAncestor)] : ['Partners and people'];

  const zones = element.zones.map((zoneId) => zoneLink(parts, zoneId, `element "${element.id}"`));
  const ancestors = element.ancestors.map((ancestorId) => elementLink(mustElement(parts, ancestorId, `element "${element.id}"`)));

  const blocks: WikiBlock[] = [
    {
      kind: 'table',
      columns: ['Kind', 'Technology', 'Zones', 'Ancestors'],
      rows: [[element.kind, element.technology ?? '—', zones.length > 0 ? zones : '—', ancestors.length > 0 ? ancestors : '—']],
    },
  ];
  // The page's diagram comes between the facts row and the relations below.
  blocks.push(diagramFor(parts, element));

  const provided = parts.model.interfaces.filter((iface) => iface.provider === element.id);
  if (provided.length > 0) {
    blocks.push({ kind: 'heading', level: 2, text: 'Provides' });
    blocks.push({
      kind: 'table',
      columns: ['Contract', 'Callers'],
      rows: [...provided]
        .sort((a, b) => byCodePoint(a.contract, b.contract) || byCodePoint(a.id, b.id))
        .map((iface) => [contractLink(parts, iface.id, `interface "${iface.id}"`), callersOf(parts, iface.id)]),
    });
  }

  // A relation row: the other end linked, then the relation's name, its interface's contract, its action and its categories.
  const relationRow = (relation: CompiledRelation, otherEnd: CompiledElement): readonly WikiCell[] => {
    const named = `relation "${relation.id}"`;
    const categories = new Map<string, WikiLinkCell>();
    for (const transfer of relation.transfers ?? []) {
      for (const categoryId of transfer.categories) {
        if (!categories.has(categoryId)) categories.set(categoryId, categoryLink(parts, categoryId, named));
      }
    }
    const categoryCells: WikiCell =
      categories.size > 0 ? [...categories.values()].sort((a, b) => byCodePoint(a.text, b.text)) : '—';
    return [
      elementLink(otherEnd),
      relation.name ?? relation.id,
      relation.interface === undefined ? '—' : contractLink(parts, relation.interface, named),
      relation.action ?? '—',
      categoryCells,
    ];
  };
  const relationRows = (relations: readonly CompiledRelation[], end: 'from' | 'to'): (readonly WikiCell[])[] =>
    relations
      .map((relation) => ({ relation, otherEnd: mustElement(parts, relation[end], `relation "${relation.id}"`) }))
      .sort((a, b) => byDisplayName(a.otherEnd, b.otherEnd) || byCodePoint(a.relation.id, b.relation.id))
      .map(({ relation, otherEnd }) => relationRow(relation, otherEnd));

  const outgoing = parts.model.relations.filter((relation) => relation.from === element.id);
  if (outgoing.length > 0) {
    blocks.push({ kind: 'heading', level: 2, text: 'Outgoing relations' });
    blocks.push({
      kind: 'table',
      columns: ['Other end', 'Name', 'Interface', 'Action', 'Data categories'],
      rows: relationRows(outgoing, 'to'),
    });
  }

  const incoming = parts.model.relations.filter((relation) => relation.to === element.id);
  if (incoming.length > 0) {
    blocks.push({ kind: 'heading', level: 2, text: 'Incoming relations' });
    blocks.push({
      kind: 'table',
      columns: ['Other end', 'Name', 'Interface', 'Action', 'Data categories'],
      rows: relationRows(incoming, 'from'),
    });
  }

  return { id: `element/${element.id}`, title: displayName(element), nav, blocks };
}

/** The interfaces page: every contract, grouped by its kind, each with its provider and its callers. */
function interfacesPage(parts: ModelParts): WikiPage {
  const byKind = new Map<string, CompiledInterface[]>();
  for (const iface of parts.model.interfaces) {
    const kind = contractKind(iface.contract);
    const group = byKind.get(kind) ?? [];
    group.push(iface);
    byKind.set(kind, group);
  }
  const blocks: WikiBlock[] = [
    { kind: 'paragraph', text: `The model declares ${count(parts.model.interfaces.length, 'interface')}.` },
  ];
  for (const kind of [...byKind.keys()].sort(byCodePoint)) {
    blocks.push({ kind: 'heading', level: 2, text: kind });
    blocks.push({
      kind: 'table',
      columns: ['Contract', 'Provider', 'Callers'],
      rows: [...byKind.get(kind)!]
        .sort((a, b) => byCodePoint(a.contract, b.contract) || byCodePoint(a.id, b.id))
        .map((iface) => [
          iface.contract,
          elementLink(mustElement(parts, iface.provider, `interface "${iface.id}"`)),
          callersOf(parts, iface.id),
        ]),
    });
  }
  return { id: 'interfaces', title: 'Interfaces', nav: ['Interfaces'], blocks };
}

/** The model's zones or categories in the order the wiki shows them: by shown name, ties by id. */
function orderedNamedParts<T extends { id: string; name?: string }>(declared: readonly T[]): readonly { part: T; name: string }[] {
  return declared
    .map((part) => ({ part, name: part.name ?? part.id }))
    .sort((a, b) => byCodePoint(a.name, b.name) || byCodePoint(a.part.id, b.part.id));
}

/** The zones index: every zone, listed and linked, with the count of the elements it holds. */
function zonesPage(parts: ModelParts, zones: readonly { part: CompiledZone; name: string }[]): WikiPage {
  const membersOf = (zoneId: string): number => parts.model.elements.filter((element) => element.zones.includes(zoneId)).length;
  return {
    id: 'zones',
    title: 'Zones',
    nav: ['Zones'],
    blocks: [
      { kind: 'paragraph', text: `The model declares ${count(parts.model.zones.length, 'zone')}.` },
      {
        kind: 'table',
        columns: ['Zone', 'Elements'],
        rows: zones.map(({ part, name }) => [zoneLink(parts, part.id, 'the zones page'), String(membersOf(part.id))]),
      },
    ],
  };
}

/** One zone's page: the elements it holds — empty zones included — with kind, each linking to its page. */
function zonePage(parts: ModelParts, zone: CompiledZone): WikiPage {
  const members = parts.model.elements.filter((element) => element.zones.includes(zone.id)).sort(byDisplayName);
  return {
    id: `zone/${zone.id}`,
    title: zone.name ?? zone.id,
    // The index page leads the single group: every zone page sits beside it, one level deep.
    nav: ['Zones'],
    blocks: [
      {
        kind: 'table',
        columns: ['Element', 'Kind'],
        rows: members.map((element) => [elementLink(element), element.kind]),
      },
    ],
  };
}

/** The data categories index: every category, listed and linked, with the count of the relations that carry it. */
function categoriesPage(parts: ModelParts, categories: readonly { part: CompiledCategory; name: string }[]): WikiPage {
  const carriersOf = (categoryId: string): number =>
    parts.model.relations.filter((relation) => (relation.transfers ?? []).some((transfer) => transfer.categories.includes(categoryId))).length;
  return {
    id: 'data-categories',
    title: 'Data categories',
    nav: ['Data categories'],
    blocks: [
      { kind: 'paragraph', text: `The model declares ${count(parts.model.categories.length, 'data category')}.` },
      {
        kind: 'table',
        columns: ['Data category', 'Relations'],
        rows: categories.map(({ part, name }) => [categoryLink(parts, part.id, 'the data categories page'), String(carriersOf(part.id))]),
      },
    ],
  };
}

/** One data category's page: the relations that carry it, each with its name and its ends linked. */
function categoryPage(parts: ModelParts, category: CompiledCategory): WikiPage {
  const carriers = parts.model.relations
    .filter((relation) => (relation.transfers ?? []).some((transfer) => transfer.categories.includes(category.id)))
    .sort((a, b) => byCodePoint(a.name ?? a.id, b.name ?? b.id) || byCodePoint(a.id, b.id));
  return {
    id: `data-category/${category.id}`,
    title: category.name ?? category.id,
    nav: ['Data categories'],
    blocks: [
      {
        kind: 'table',
        columns: ['Relation', 'From', 'To'],
        rows: carriers.map((relation) => [
          relation.name ?? relation.id,
          elementLink(mustElement(parts, relation.from, `relation "${relation.id}"`)),
          elementLink(mustElement(parts, relation.to, `relation "${relation.id}"`)),
        ]),
      },
    ],
  };
}

/**
 * The pages this task builds: the home page, one page per domain and per
 * non-domain element, the interfaces page, and the zones and data
 * categories indexes — each followed by a page per zone and per category.
 * `views` holds the element ids the rendered view set has a view of; every
 * home, domain and element page carries the diagram of the view it belongs
 * to (requirement `diagrams`).
 */
export function wikiPages(model: CompiledModel, views: readonly string[]): WikiPage[] {
  const parts: ModelParts = {
    model,
    elementById: new Map(model.elements.map((element) => [element.id, element])),
    zoneName: new Map(model.zones.map((zone) => [zone.id, zone.name ?? zone.id])),
    categoryName: new Map(model.categories.map((category) => [category.id, category.name ?? category.id])),
    interfaceById: new Map(model.interfaces.map((iface) => [iface.id, iface])),
    views: new Set(views),
  };
  validateParts(parts);

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

  const pages: WikiPage[] = [homePage(model, domains, descendantsOf)];
  const underDomain = new Set<string>();
  // Root domains only, each walked once: a nested domain's page comes out
  // inside its root's walk, after its parent, and every element's page is
  // written once — under the root domain it belongs to.
  const roots = domains.filter((domain) => !domain.ancestors.some((id) => parts.elementById.get(id)?.kind === 'domain'));
  const walkDomain = (current: CompiledElement): void => {
    const children = [...(childrenOf.get(current.id) ?? [])].sort(byDisplayName);
    for (const child of children) {
      underDomain.add(child.id);
      if (child.kind === 'domain') {
        pages.push(domainPage(parts, child, descendantsOf(child)));
      } else {
        pages.push(elementPage(parts, child));
      }
      walkDomain(child);
    }
  };
  for (const domain of roots) {
    pages.push(domainPage(parts, domain, descendantsOf(domain)));
    walkDomain(domain);
  }
  // Elements no domain holds: people, externals and the broker at the top level.
  const independents = model.elements.filter((element) => element.kind !== 'domain' && !underDomain.has(element.id)).sort(byDisplayName);
  pages.push(...independents.map((element) => elementPage(parts, element)));
  pages.push(interfacesPage(parts));
  const zones = orderedNamedParts(model.zones);
  pages.push(zonesPage(parts, zones), ...zones.map(({ part }) => zonePage(parts, part)));
  const categories = orderedNamedParts(model.categories);
  pages.push(categoriesPage(parts, categories), ...categories.map(({ part }) => categoryPage(parts, part)));
  return pages;
}

/**
 * Every reference the pages will make, checked before any page is built: a
 * relation, interface or element naming an id the model lacks is an error
 * naming it here, even where no page would have rendered the row, and so is
 * a view naming an element the model does not have — a diagram block naming
 * no view never gets built. The link builders are the validators — the same
 * refusal wherever the reference is read.
 */
function validateParts(parts: ModelParts): void {
  for (const scope of parts.views) mustElement(parts, scope, 'the view set');
  for (const element of parts.model.elements) {
    for (const zoneId of element.zones) zoneLink(parts, zoneId, `element "${element.id}"`);
    for (const ancestorId of element.ancestors) mustElement(parts, ancestorId, `element "${element.id}"`);
  }
  for (const iface of parts.model.interfaces) mustElement(parts, iface.provider, `interface "${iface.id}"`);
  for (const relation of parts.model.relations) {
    const named = `relation "${relation.id}"`;
    mustElement(parts, relation.from, named);
    mustElement(parts, relation.to, named);
    if (relation.interface !== undefined) contractLink(parts, relation.interface, named);
    for (const transfer of relation.transfers ?? []) {
      for (const categoryId of transfer.categories) categoryLink(parts, categoryId, named);
    }
  }
}
