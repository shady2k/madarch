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
import { readKnowledgePages, statementsRelyingOn, type IndexedPage, type RelyingStatement } from '../knowledge/index/index.js';
import { DOMAINS_FOLDER, PRODUCT_PATH } from '../writer/run.js';
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
  /** The ground of the change the statement stands on, or the statement's own reference. */
  readonly ground: string;
  readonly how: 'grounds' | 'mentions';
}

/** One page a change reaches: every page a reached statement stands on, then every page linking one. */
export interface ImpactedPage {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly kind: string;
  readonly because: 'statement' | 'link';
}

export interface TaskImpact {
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
export class ImpactReadError extends Error {}

/** The graph keys a page names: its own relations and every entity its statements stand on. */
function keysOf(page: IndexedPage): string[] {
  const keys = new Set<string>([...page.relates, ...page.mentions]);
  for (const statement of page.statements) for (const key of [...statement.grounds, ...statement.mentions]) keys.add(key);
  return [...keys];
}

/** The path a graph key names in a repository, when it names one; a document section keeps its path. */
export function pathOfGround(ground: string): string | undefined {
  const doc = /^doc:([^#]+)(?:#.*)?$/.exec(ground);
  if (doc !== null) return doc[1];
  const code = /^code\.(?:file|directory):(.+)$/.exec(ground);
  if (code !== null) return code[1];
  const symbol = /^code\.symbol:(.+)$/.exec(ground);
  if (symbol !== null) return symbol[1]!.split('#')[0];
  return undefined;
}

const isPathKey = (ground: string): boolean => /^(code\.|doc:)/.test(ground);

function rowOf(row: RelyingStatement, ground: string): ImpactedStatement {
  return { page: row.page, pageTitle: row.pageTitle, pageKind: row.pageKind, file: row.file, line: row.line, statement: row.statement, text: row.text, ground, how: row.how };
}

/**
 * The impact of a set of grounds, read through the graph and the product's pages.
 * `productFolder` is read for the pages themselves: their links and their statements.
 */
export async function impactOf(owner: DatabaseOwner, productFolder: string, grounds: readonly string[]): Promise<TaskImpact> {
  const wanted = [...new Set(grounds.map((ground) => ground.trim()).filter((ground) => ground !== ''))].sort(byCodePoint);
  if (wanted.length === 0) throw new ImpactReadError('an impact needs at least one ground: the graph key of a document section, a code place or a statement');
  const read = readKnowledgePages(productFolder);
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
  for (const ground of wanted) {
    // A ground that names a statement of a page reaches that statement itself; every other one is asked of the graph.
    const ref = parseStatementRef(ground);
    const named = ref === undefined ? undefined : byId.get(ref.page)?.statements.find((candidate) => candidate.id === ref.statement);
    if (ref !== undefined && named !== undefined) {
      const page = byId.get(ref.page)!;
      const key = `${page.id}#${named.id}`;
      if (!statements.has(key)) statements.set(key, { page: page.id, pageTitle: page.title, pageKind: page.kind, file: page.file, line: named.line, statement: named.id, text: named.text, ground, how: 'grounds' });
      refs.add(key);
      reach(page, 'statement');
      continue;
    }
    for (const row of await statementsRelyingOn(owner, ground)) {
      const key = `${row.page}#${row.statement}`;
      const held = statements.get(key);
      if (held !== undefined && held.how === 'grounds') continue;
      statements.set(key, rowOf(row, ground));
      refs.add(key);
      const page = byId.get(row.page);
      if (page !== undefined) reach(page, 'statement');
    }
  }
  // The second hop: a page that links a reached statement, a reached page or the same entity is reached too.
  const reachedPages = new Set(reached.map((page) => page.id));
  for (const page of pages) {
    if (reachedPages.has(page.id)) continue;
    if (keysOf(page).some((key) => wanted.includes(key) || reachedPages.has(key) || refs.has(key))) reach(page, 'link');
  }
  const orderedPages = [...reached].sort((a, b) => byCodePoint(a.file, b.file) || byCodePoint(a.id, b.id));
  const orderedStatements = [...statements.values()].sort((a, b) => byCodePoint(a.page, b.page) || a.line - b.line || byCodePoint(a.statement, b.statement));
  const writable = [...new Set(orderedPages.map((page) => page.file))].filter((file) => file === PRODUCT_PATH || file.startsWith(`${DOMAINS_FOLDER}/`)).sort(byCodePoint);
  return {
    grounds: wanted,
    pages: orderedPages,
    writable,
    entities: wanted.filter(isPathKey),
    statements: orderedStatements,
    counts: { pages: orderedPages.length, statements: orderedStatements.length },
  };
}
