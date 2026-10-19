/**
 * The pages a publication touches (decision 0026, "Pages"; madarch-tzte.23.1): the
 * rule, and the one table that keeps its result, shared by the fact store — which
 * writes it inside the publication's own transaction (`applyPublishedFacts`,
 * `fact-store.ts`) — and the page reads (`graph-pages.ts`), which answer the page
 * set, one page's model and the live channel's changes.
 *
 * It stands in a module of its own and not inside either of them because both need
 * it and neither may import the other: the store would be a reader of pages, and a
 * page's reader a writer of the store.
 *
 * 0026: "Every graph node of a page-worthy kind has a live page at once … and
 * updated in the browser as facts arrive." Which kinds have a page is the product
 * registry's own role column: a page is *about* one node, so the page-worthy kinds
 * are the ones `REGISTRY_KIND_MAPPINGS` gives the role `subject` — the nodes a
 * document of a registry kind may be about. A kind of the roles `place` (where a
 * node lives) and `evidence` (what a claim cites about it) has no page: it is
 * shown, with its code link, on the page of the node it is about.
 */
import { byCodePoint } from '../model/order.js';
import {
  FACT_NODE_KINDS,
  REGISTRY_KIND_MAPPINGS,
  isFactId,
  isFactKind,
  type Fact,
  type FactKind,
} from './facts.js';

/**
 * The fact kinds a node of which has a live page (0026, "Pages"): the node kinds
 * the registry's own mapping gives the role `subject`, in code point order. The
 * table is the one declaration (`REGISTRY_KIND_MAPPINGS`, `facts.ts`), so the
 * modules and packages 0026 names are in it because the registry can be about
 * them, and a kind the table later maps as a subject joins without this list being
 * edited.
 */
export const PAGE_KINDS: readonly FactKind[] = FACT_NODE_KINDS
  .filter((kind) => REGISTRY_KIND_MAPPINGS[kind].relation === 'subject')
  .sort(byCodePoint);

/** Whether a fact kind is one a page exists for. */
export function isPageKind(kind: FactKind): boolean {
  return PAGE_KINDS.includes(kind);
}

/**
 * Whether a fact id names a node a page exists for: a fact id carries its kind in
 * front of its digest (`kind:…`), so the question is answered from the id alone —
 * which is what a publication needs, since it records the pages it touched for a
 * node whose row it has just dropped as well as for one it wrote.
 */
export function isPageId(id: string): boolean {
  if (!isFactId(id)) return false;
  const kind = id.slice(0, id.indexOf(':'));
  return isFactKind(kind) && isPageKind(kind);
}

/** The store's table of what each publication touched: one row per changed page and publication. */
export const PAGE_CHANGE_TABLE = 'fill_page_change';

/**
 * The store's own declaration of `fill_page_change`: `seq` is the publication's
 * place in the product's change order (the number a subscriber resumes from),
 * `node_id` a page the publication touched, and the rest names the publication —
 * its unit, its generation and the publication digest — so a client reads which
 * unit's publication moved a page, and two publications are never one change.
 */
export const PAGE_CHANGE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${PAGE_CHANGE_TABLE} (
    seq bigserial PRIMARY KEY,
    node_id text NOT NULL,
    unit_id text NOT NULL,
    generation integer NOT NULL,
    publication text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${PAGE_CHANGE_TABLE}_unit ON ${PAGE_CHANGE_TABLE} (unit_id)`,
];

/**
 * The pages one publication's facts touch, in code point order: a fact that is a
 * page-worthy node touches its own page, and every fact touches the pages of the
 * page-worthy nodes it names — an edge its two ends, a claim its subject and its
 * object, a question what it is about, a coverage the scope it read, a rule its
 * subject. A publication that drops a fact touches the same pages, which is why
 * the store asks this for what it drops as well as for what it writes: a node
 * whose last holding went away has a page that must disappear, and its neighbours'
 * pages lose a relation.
 *
 * Nothing else is announced: a fact's own kind decides whether it has a page
 * (`isPageId`), so a coverage of a repository's snapshot — a fact of a kind with no
 * page — wakes no client.
 */
export function pagesTouchedBy(facts: readonly Fact[]): readonly string[] {
  const touched = new Set<string>();
  for (const fact of facts) {
    if (isPageKind(fact.kind)) touched.add(fact.id);
    for (const id of namedFactIds(fact.value)) if (isPageId(id)) touched.add(id);
  }
  return [...touched].sort(byCodePoint);
}

/** Whether a fact's value names one fact id anywhere in it: its ends, its subject, its object, its about. */
export function namesFactId(value: unknown, id: string): boolean {
  if (typeof value === 'string') return value === id;
  if (Array.isArray(value)) return value.some((entry) => namesFactId(entry, id));
  if (value === null || typeof value !== 'object') return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).some((key) => namesFactId(fields[key], id));
}

/** Every fact id one fact's value names, anywhere in it, in the order the value's keys stand. */
function namedFactIds(value: unknown): readonly string[] {
  const found: string[] = [];
  const walk = (held: unknown): void => {
    if (typeof held === 'string') {
      if (isFactId(held)) found.push(held);
      return;
    }
    if (Array.isArray(held)) {
      for (const entry of held) walk(entry);
      return;
    }
    if (held === null || typeof held !== 'object') return;
    const fields = held as Record<string, unknown>;
    for (const key of Object.keys(fields).sort(byCodePoint)) walk(fields[key]);
  };
  walk(value);
  return found;
}
