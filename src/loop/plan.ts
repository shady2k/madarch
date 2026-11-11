/**
 * The refresh decides before it asks (madarch-m38l.7; the owner, 2026-10-23:
 * "При обновлении агент ведь должен опираться на то, что уже есть? Мы же не
 * будем заставлять его все перегенерировать сначала?").
 *
 * A page needs an agent unit when, and only when:
 *
 * - it is missing (the product page, or a domain the product page links);
 * - the content language was changed (every page, as a translation);
 * - a ground of one of its statements changed or is gone since it was written
 *   (`changedGrounds`, the digest on the statement's edge against git now);
 * - an answered question or a correction is about it;
 * - a service appeared in the graph after the product page was written and no
 *   page names it (the product page, which declares the domains).
 *
 * Every other page costs no agent run. `decide` is the pure rule; `planRefresh`
 * gathers its inputs from the product's files, the graph and git; `briefsFor`
 * reads what changed (old and new text of each changed ground) for the units
 * that edit. A question or correction that is about no page is returned in
 * `unplaced`, never dropped.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { changedGrounds, graphKnowledgePages, type GroundChange, type IndexedPage } from '../knowledge/index/index.js';
import { DOMAINS_FOLDER, PRODUCT_PATH } from '../writer/units.js';
import { parseStatementRef, type Correction, type Question } from './entities.js';

import { graphQuestions, graphCorrections, type LoopGraph } from './graph.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

const run = promisify(execFile);

type PlanReason =
  | { readonly kind: 'missing' }
  | { readonly kind: 'language'; readonly from: string | null; readonly to: string }
  | { readonly kind: 'ground-changed' | 'ground-removed'; readonly statement: string; readonly ground: string }
  | { readonly kind: 'answer'; readonly question: string; readonly title: string }
  | { readonly kind: 'correction'; readonly correction: string; readonly statement: string }
  | { readonly kind: 'new-service'; readonly services: readonly string[] }
  /** The product page links a domain whose page is missing: the product unit declares it again. */
  | { readonly kind: 'missing-domain'; readonly domain: string }
  /** A person's confirmed task reaches this page («Поправить страницы сейчас»): the run edits exactly the pages it reaches. */
  | { readonly kind: 'task'; readonly task: string; readonly title: string };

interface PlannedPage {
  readonly id: string;
  readonly path: string;
  readonly reasons: readonly PlanReason[];
}

export interface Unplaced {
  readonly kind: 'question' | 'correction';
  readonly slug: string;
  readonly title: string;
  readonly reason: string;
}

export interface RefreshPlan {
  readonly languageChanged: boolean;
  /** The pages that get an agent unit, in path order, each with why. */
  readonly pages: readonly PlannedPage[];
  /** The pages that exist and get none. */
  readonly unchanged: readonly string[];
  readonly unplaced: readonly Unplaced[];
  /** Files of the loop that could not be read (file:line: reason). */
  readonly problems: readonly string[];
}

interface DecideInput {
  /** The product's pages (product and domain kinds), as the index reads them. */
  readonly pages: readonly IndexedPage[];
  readonly grounds: readonly GroundChange[];
  readonly questions: readonly Question[];
  readonly corrections: readonly Correction[];
  /** Services that appeared in the graph after the product page was written and that no page names. */
  readonly newServices: readonly string[];
  readonly language: { readonly from: string | null; readonly to: string; readonly changed: boolean };
  readonly problems?: readonly string[];
}

const isKnowledgePage = (page: IndexedPage): boolean => page.file === PRODUCT_PATH || page.file.startsWith(`${DOMAINS_FOLDER}/`);

/** The page ids a question's or correction's `about` entry points at, by the pages' own links to it. */
function placeOf(entry: string, pages: readonly IndexedPage[]): string[] {
  const statement = parseStatementRef(entry);
  if (statement !== undefined) return pages.some((page) => page.id === statement.page) ? [statement.page] : [];
  if (pages.some((page) => page.id === entry)) return [entry];
  return pages.filter((page) => page.relates.includes(entry) || page.statements.some((s) => s.grounds.includes(entry) || s.mentions.includes(entry))).map((page) => page.id);
}

export function decide(input: DecideInput): RefreshPlan {
  const pages = input.pages.filter(isKnowledgePage);
  const byId = new Map(pages.map((page) => [page.id, page] as const));
  const reasons = new Map<string, PlanReason[]>();
  const add = (id: string, reason: PlanReason): void => {
    if (!reasons.has(id)) reasons.set(id, []);
    reasons.get(id)!.push(reason);
  };
  if (input.language.changed) for (const page of pages) add(page.id, { kind: 'language', from: input.language.from, to: input.language.to });
  for (const change of input.grounds) {
    if (change.status !== 'changed' && change.status !== 'removed') continue;
    if (!byId.has(change.page)) continue;
    add(change.page, { kind: change.status === 'changed' ? 'ground-changed' : 'ground-removed', statement: change.statement, ground: change.ground });
  }
  const unplaced: Unplaced[] = [];
  for (const question of input.questions) {
    if (question.status !== 'answered' || question.resolvedBy.length > 0) continue;
    const places = new Set<string>();
    for (const entry of question.about) for (const id of placeOf(entry, pages)) places.add(id);
    if (question.askedIn !== null && byId.has(question.askedIn)) places.add(question.askedIn);
    if (places.size === 0) unplaced.push({ kind: 'question', slug: question.slug, title: question.title, reason: `no page of the product is about ${question.about.join(', ') || 'anything'}, so the answer reaches no page: add a page that is, or name another page in the question's "about" in ${question.file}` });
    for (const id of places) add(id, { kind: 'answer', question: question.slug, title: question.title });
  }
  for (const correction of input.corrections) {
    if (correction.status !== 'open') continue;
    const places = placeOf(correction.about, pages);
    if (places.length === 0) unplaced.push({ kind: 'correction', slug: correction.slug, title: correction.title, reason: `the page ${parseStatementRef(correction.about)?.page ?? correction.about} is not among the product's pages any more, so the correction reaches no page (${correction.file})` });
    for (const id of places) add(id, { kind: 'correction', correction: correction.slug, statement: correction.about });
  }
  const product = pages.find((page) => page.file === PRODUCT_PATH);
  if (product === undefined) add(`product:*`, { kind: 'missing' });
  else {
    if (input.newServices.length > 0) add(product.id, { kind: 'new-service', services: [...input.newServices].sort(byCodePoint) });
    // A domain the product page links and no page exists for is written, and the product unit declares it again.
    for (const target of product.mentions) {
      const slug = /^domain:([a-z][a-z0-9-]*)$/.exec(target)?.[1];
      if (slug === undefined || byId.has(target)) continue;
      add(target, { kind: 'missing' });
      add(product.id, { kind: 'missing-domain', domain: slug });
    }
  }
  const planned: PlannedPage[] = [];
  for (const [id, why] of reasons) {
    const page = byId.get(id);
    planned.push({ id: page === undefined ? id : page.id, path: page !== undefined ? page.file : id.startsWith('domain:') ? `${DOMAINS_FOLDER}/${id.slice('domain:'.length)}.md` : PRODUCT_PATH, reasons: why.sort((a, b) => byCodePoint(JSON.stringify(a), JSON.stringify(b))) });
  }
  planned.sort((a, b) => byCodePoint(a.path, b.path));
  const touched = new Set(planned.map((page) => page.path));
  return {
    languageChanged: input.language.changed,
    pages: planned,
    unchanged: pages.map((page) => page.file).filter((file) => !touched.has(file)).sort(byCodePoint),
    unplaced: unplaced.sort((a, b) => byCodePoint(`${a.kind}:${a.slug}`, `${b.kind}:${b.slug}`)),
    problems: input.problems ?? [],
  };
}


/** The one graph holds no code.service kind yet: a plan names no service the graph does not hold. */
async function servicesSince(_owner: DatabaseOwner, _since: string, _named: ReadonlySet<string>): Promise<string[]> {
  return [];
}

async function commitTime(repository: string, commit: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['show', '-s', '--format=%cI', commit], { cwd: repository, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    const when = new Date(stdout.trim());
    return Number.isNaN(when.getTime()) ? undefined : when.toISOString();
  } catch {
    return undefined;
  }
}

export interface PlanOptions {
  readonly graph: LoopGraph;
  readonly manifest: KindsManifest;
  readonly owner: DatabaseOwner;
  readonly productFolder: string;
  /** The code repository the pages are written from. */
  readonly repository: { readonly name: string; readonly path: string };
  /** The commit the graph describes now (the repository's head the fill pinned). */
  readonly commit: string;
  /** The language the pages should be in, whether that is a change, and the one they are in. */
  readonly language: { readonly from: string | null; readonly to: string; readonly changed: boolean };
}

export interface Planned {
  readonly plan: RefreshPlan;
  /** Everything `briefsFor` needs, so the graph is read once. */
  readonly inputs: DecideInput & { readonly options: PlanOptions };
}

export async function planRefresh(options: PlanOptions): Promise<Planned> {
  const read = await graphKnowledgePages(options.graph, options.manifest);
  const pages = read.pages.filter(isKnowledgePage);
  const questions = await graphQuestions(options.graph);
  const corrections = await graphCorrections(options.graph);
  const problems = [...read.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`)];
  const grounds = pages.length === 0 ? [] : await changedGrounds(options.owner, { commit: options.commit });
  const product = pages.find((page) => page.file === PRODUCT_PATH);
  let newServices: string[] = [];
  const written = product?.writtenAt.find((entry) => entry.repository === options.repository.name)?.commit;
  if (product !== undefined && written !== undefined) {
    const since = await commitTime(options.repository.path, written);
    if (since !== undefined) {
      const named = new Set<string>();
      for (const page of pages) {
        for (const key of [...page.relates, ...page.mentions]) named.add(key);
        for (const statement of page.statements) for (const key of [...statement.grounds, ...statement.mentions]) named.add(key);
      }
      newServices = await servicesSince(options.owner, since, named);
    }
  }
  const inputs = { pages, grounds, questions, corrections, newServices, language: options.language, problems };
  return { plan: decide(inputs), inputs: { ...inputs, options } };
}

// ---- what changed -----------------------------------------------------------------------------
