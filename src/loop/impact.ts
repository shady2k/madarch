/**
 * What a change reaches, computed through the graph (madarch-m38l.14; the
 * owner, 2026-10-23: "нужно посмотреть что это изменение затронет через граф").
 *
 * The engine, never the agent, decides this list. It starts from the grounds of
 * an answer or a task and takes, in this order:
 *
 * - the statements that stand on those grounds on every page
 *   (`statementsRelyingOn`), each with the page and the line it stands at;
 * - then the pages that link those statements, those pages or the same
 *   entities, so a reader sees what moves beyond the sentence itself.
 *
 * A read that cannot be made is an error naming its file and line or its graph
 * key: a list smaller than what the product really reaches is never answered.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { readKnowledgePages, readKnowledgePagesFrom, statementsRelyingOn, type IndexedPage, type RelyingStatement } from '../knowledge/index/index.js';
import type { ProductFileSource } from '../knowledge/product-files.js';
import type { KindsManifest } from '../knowledge/kinds.js';
import { DOMAINS_FOLDER, PRODUCT_PATH } from '../writer/units.js';
import { parseStatementRef } from './entities.js';

/** One statement a change reaches: where it stands, what it says and the ground that reached it. */
export interface ImpactedStatement {
  readonly page: string;
  readonly pageTitle: string;
  readonly pageKind: string;
  readonly file: string;
  readonly line: number;
  /** The statement's name on its page (its first footnote's name): what a correction and a scope name it by. */
  readonly statement: string;
  readonly text: string;
  /** The first ground, in code-point order, that reached the statement: what a reader sees named. */
  readonly ground: string;
  /** Every ground that reached the statement: a sentence may stand on more than one of them. */
  readonly grounds: readonly string[];
  readonly how: 'grounds' | 'mentions';
}

/** One page a change reaches: every page a reached statement stands on, then every page linking one. */
interface ImpactedPage {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly kind: string;
  readonly because: 'statement' | 'link';
}

export interface TaskImpact {
  /** A ground the graph answers nothing for: the index may not have been published yet, and the list may be shorter. */
  readonly unindexed: readonly string[];
  /** The grounds the impact was computed from, de-duplicated, in code-point order. */
  readonly grounds: readonly string[];
  readonly pages: readonly ImpactedPage[];
  /** The product's own pages among `pages`: exactly the pages the writer may rewrite. */
  readonly writable: readonly string[];
  /** The grounds that name a code or a document place: the nodes a planned change is marked on. */
  readonly entities: readonly string[];
  readonly statements: readonly ImpactedStatement[];
  readonly counts: { readonly pages: number; readonly statements: number };
}

/** A read of the product's pages that cannot be made: it names each file and line, and answers no list. */
class ImpactReadError extends Error {}

/** The graph keys a page names: its own relations and every entity its statements stand on. */
function keysOf(page: IndexedPage): string[] {
  const keys = new Set<string>([...page.relates, ...page.mentions]);
  for (const statement of page.statements) for (const key of [...statement.grounds, ...statement.mentions]) keys.add(key);
  return [...keys];
}

const isPathKey = (ground: string): boolean => /^(code\.|doc:)/.test(ground);

function rowOf(row: RelyingStatement, ground: string): ImpactedStatement {
  return { page: row.page, pageTitle: row.pageTitle, pageKind: row.pageKind, file: row.file, line: row.line, statement: row.statement, text: row.text, ground, grounds: [ground], how: row.how };
}

/**
 * The impact of a set of grounds, read through the graph and the product's pages. A reader of a page passes the graph's
 * stored files and the manifest it read; a writer passes neither and reads the working tree it is about to change.
 */
export async function impactOf(owner: DatabaseOwner, productFolder: string, grounds: readonly string[], stored?: { readonly files: ProductFileSource; readonly manifest: KindsManifest }): Promise<TaskImpact> {
  const wanted = [...new Set(grounds.map((ground) => ground.trim()).filter((ground) => ground !== ''))].sort(byCodePoint);
  if (wanted.length === 0) throw new ImpactReadError('an impact needs at least one ground: the graph key of a document section, a code place or a statement');
  const read = stored === undefined ? readKnowledgePages(productFolder) : readKnowledgePagesFrom(stored.files, stored.manifest);
  if (read.findings.length > 0) {
    throw new ImpactReadError(`the impact cannot be computed, because not every page of this product can be read:\n${read.findings.map((finding) => `  ${finding.file}:${finding.line}: ${finding.message}`).join('\n')}`);
  }
  const pages = read.pages;
  const byId = new Map(pages.map((page) => [page.id, page] as const));
  const statements = new Map<string, ImpactedStatement>();
  const reached: ImpactedPage[] = [];
  const reach = (page: IndexedPage, because: 'statement' | 'link'): void => {
    const at = reached.findIndex((held) => held.id === page.id);
    if (at < 0) { reached.push({ id: page.id, title: page.title, file: page.file, kind: page.kind, because }); return; }
    // A page a reached statement stands on is said so, whatever an earlier link said.
    if (because === 'statement' && reached[at]!.because === 'link') reached[at] = { ...reached[at]!, because };
  };
  const refs = new Set<string>();
  const unindexed: string[] = [];
  for (const ground of wanted) {
    const before = statements.size;
    // A ground that names a statement of a page reaches that statement itself, and the statements that stand on it.
    const ref = parseStatementRef(ground);
    const named = ref === undefined ? undefined : byId.get(ref.page)?.statements.find((candidate) => candidate.id === ref.statement);
    if (ref !== undefined && named !== undefined) {
      const page = byId.get(ref.page)!;
      const key = `${page.id}#${named.id}`;
      if (!statements.has(key)) statements.set(key, { page: page.id, pageTitle: page.title, pageKind: page.kind, file: page.file, line: named.line, statement: named.id, text: named.text, ground, grounds: [ground], how: 'grounds' });
      refs.add(key);
      reach(page, 'statement');
    }
    for (const row of await statementsRelyingOn(owner, ground)) {
      const key = `${row.page}#${row.statement}`;
      const held = statements.get(key);
      // A sentence that stands on two grounds is listed once, with every ground that reached it.
      if (held !== undefined) {
        if (!held.grounds.includes(ground)) statements.set(key, { ...held, grounds: [...held.grounds, ground].sort(byCodePoint) });
        continue;
      }
      statements.set(key, rowOf(row, ground));
      refs.add(key);
      const page = byId.get(row.page);
      if (page !== undefined) reach(page, 'statement');
    }
    // A ground the graph answers nothing for may be a ground the index has not published yet: said, never hidden.
    if (statements.size === before) unindexed.push(ground);
  }
  // The second hop: a page that links a reached statement, or one of the same grounds the reached statements stand
  // on, is reached too — the brief's own rule, not every page that happens to link a reached page. Prose links that
  // the writer inserts over names (madarch-ztyq.8) are reading aids, not evidence, so they do not widen the scope.
  const entities = new Set<string>(wanted);
  for (const statement of statements.values()) {
    const one = byId.get(statement.page)?.statements.find((candidate) => candidate.id === statement.statement);
    for (const key of one?.grounds ?? []) entities.add(key);
  }
  for (const page of pages) {
    if (reached.some((held) => held.id === page.id)) continue;
    if (keysOf(page).some((key) => entities.has(key) || refs.has(key))) reach(page, 'link');
  }
  const orderedPages = [...reached].sort((a, b) => byCodePoint(a.file, b.file) || byCodePoint(a.id, b.id));
  const orderedStatements = [...statements.values()].sort((a, b) => byCodePoint(a.page, b.page) || a.line - b.line || byCodePoint(a.statement, b.statement));
  const writable = [...new Set(orderedPages.map((page) => page.file))].filter((file) => file === PRODUCT_PATH || file.startsWith(`${DOMAINS_FOLDER}/`)).sort(byCodePoint);
  return {
    grounds: wanted,
    unindexed,
    pages: orderedPages,
    writable,
    entities: wanted.filter(isPathKey),
    statements: orderedStatements,
    counts: { pages: orderedPages.length, statements: orderedStatements.length },
  };
}
