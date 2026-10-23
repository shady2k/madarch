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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { changedGrounds, documentSections, gitReader, readKnowledgePages, type GroundChange, type GitReader, type IndexedPage } from '../knowledge/index/index.js';
import { NOTE_CHARACTERS, type ChangeNote, type EditBrief } from '../writer/edit.js';
import { DOMAINS_FOLDER, PRODUCT_PATH, type UnitsInput, type UnitsNeeded } from '../writer/run.js';
import { parseStatementRef, readCorrections, readQuestions, type Correction, type Question } from './entities.js';

const run = promisify(execFile);

export type PlanReason =
  | { readonly kind: 'missing' }
  | { readonly kind: 'language'; readonly from: string | null; readonly to: string }
  | { readonly kind: 'ground-changed' | 'ground-removed'; readonly statement: string; readonly ground: string }
  | { readonly kind: 'answer'; readonly question: string; readonly title: string }
  | { readonly kind: 'correction'; readonly correction: string; readonly statement: string }
  | { readonly kind: 'new-service'; readonly services: readonly string[] }
  /** The product page links a domain whose page is missing: the product unit declares it again. */
  | { readonly kind: 'missing-domain'; readonly domain: string };

export interface PlannedPage {
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

export interface DecideInput {
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

// ---- gathering --------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

/** The services that appeared in the graph after `since` (an ISO time) and that no page of the product names. */
export async function servicesSince(owner: DatabaseOwner, since: string, named: ReadonlySet<string>): Promise<string[]> {
  const rows = (await owner.run((tx) => tx.query<Raw>(
    `SELECT v.properties->>'recordKey' AS key FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE k.key = 'code.service' AND v.properties ? 'recordKey' AND v.recorded_to = 'infinity'
     GROUP BY 1 HAVING min(v.valid_from) > $1::timestamptz AND bool_or(v.valid_to = 'infinity') ORDER BY 1`,
    [since],
  ))).rows;
  return rows.map((row) => String(row['key'])).filter((key) => !named.has(key)).sort(byCodePoint);
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
  const read = readKnowledgePages(options.productFolder);
  const pages = read.pages.filter(isKnowledgePage);
  const questions = readQuestions(options.productFolder);
  const corrections = readCorrections(options.productFolder);
  const problems = [...read.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`), ...questions.problems.map((p) => p.message), ...corrections.problems.map((p) => p.message)];
  const grounds = pages.length === 0 ? [] : await changedGrounds(options.owner, { commit: options.commit, git: gitReader(options.repository.path) });
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
  const inputs = { pages, grounds, questions: questions.items, corrections: corrections.items, newServices, language: options.language, problems };
  return { plan: decide(inputs), inputs: { ...inputs, options } };
}

// ---- what changed -----------------------------------------------------------------------------

const MAX_NOTES_PER_PAGE = 40;

/** The path a graph key names in the repository, when it names one. */
function pathOfKey(key: string): string | undefined {
  if (key.startsWith('code.file:') || key.startsWith('code.directory:')) return key.slice(key.indexOf(':') + 1);
  if (key.startsWith('code.symbol:')) {
    const rest = key.slice('code.symbol:'.length);
    const hash = rest.indexOf('#');
    return hash < 0 ? rest : rest.slice(0, hash);
  }
  return undefined;
}

const cutText = (text: string): string => (text.length > NOTE_CHARACTERS ? `${text.slice(0, NOTE_CHARACTERS)}\n[cut at ${NOTE_CHARACTERS} characters]` : text);

async function diffOf(repository: string, from: string, to: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['diff', '--no-color', '-U2', from, to, '--', path], { cwd: repository, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    return stdout.trim() === '' ? null : cutText(stdout.trim());
  } catch {
    return null;
  }
}

async function textsOfGround(change: GroundChange, repository: string, reader: GitReader, now: string): Promise<{ before: string | null; after: string | null }> {
  const written = change.writtenCommit;
  if (written === null) return { before: null, after: null };
  const doc = /^doc:([^#]+)#(.+)$/.exec(change.ground);
  if (doc !== null) {
    const sectionIn = async (commit: string): Promise<string | null> => {
      const text = await reader.text(commit, doc[1]!);
      return text === null ? null : documentSections(text).find((section) => section.anchor === doc[2]!.toLowerCase())?.text ?? null;
    };
    const before = await sectionIn(written);
    const after = change.status === 'removed' ? null : await sectionIn(now);
    return { before: before === null ? null : cutText(before), after: after === null ? null : cutText(after) };
  }
  const path = pathOfKey(change.ground);
  if (path === undefined) return { before: null, after: null };
  if (change.status === 'removed') {
    const old = await reader.text(written, path);
    return { before: old === null ? null : cutText(old.split('\n').slice(0, 80).join('\n')), after: null };
  }
  return { before: null, after: await diffOf(repository, written, now, path) };
}

/** The brief of each planned page: the page as it stands and what changed. Pages with no text yet get no brief. */
export async function briefsFor(planned: Planned): Promise<Map<string, EditBrief>> {
  const { plan, inputs } = planned;
  const { options } = inputs;
  const reader = gitReader(options.repository.path);
  const byId = new Map(inputs.pages.map((page) => [page.id, page] as const));
  const questions = new Map(inputs.questions.map((question) => [question.slug, question] as const));
  const corrections = new Map(inputs.corrections.map((correction) => [correction.slug, correction] as const));
  const out = new Map<string, EditBrief>();
  for (const entry of plan.pages) {
    const page = byId.get(entry.id);
    if (page === undefined) continue;
    let current: string;
    try {
      current = readFileSync(join(options.productFolder, page.file), 'utf8');
    } catch (error) {
      throw new Error(`src/loop/plan.ts: ${join(options.productFolder, page.file)} cannot be read to be edited: ${(error as Error).message}`);
    }
    const notes: ChangeNote[] = [];
    let omitted = 0;
    const sentenceOf = (statement: string): string => page.statements.find((s) => s.id === statement)?.text ?? '';
    for (const reason of entry.reasons) {
      if (notes.length >= MAX_NOTES_PER_PAGE) { omitted += 1; continue; }
      switch (reason.kind) {
        case 'ground-changed':
        case 'ground-removed': {
          const change = inputs.grounds.find((candidate) => candidate.page === entry.id && candidate.statement === reason.statement && candidate.ground === reason.ground);
          const texts = change === undefined ? { before: null, after: null } : await textsOfGround(change, options.repository.path, reader, options.commit);
          notes.push({ kind: reason.kind, statement: reason.statement, sentence: sentenceOf(reason.statement), ground: reason.ground, ...texts });
          break;
        }
        case 'answer': {
          const question = questions.get(reason.question);
          if (question?.answer == null) break;
          notes.push({ kind: 'answer', question: question.slug, title: question.title, answer: question.answer.text, by: `${question.answer.by.name} <${question.answer.by.email}>`, at: question.answer.at, sides: question.sides });
          break;
        }
        case 'correction': {
          const correction = corrections.get(reason.correction);
          if (correction === undefined) break;
          notes.push({ kind: 'correction', correction: correction.slug, statement: parseStatementRef(correction.about)?.statement ?? correction.about, sentence: correction.statement, reason: correction.reason, by: `${correction.by.name} <${correction.by.email}>` });
          break;
        }
        case 'new-service': notes.push({ kind: 'new-service', services: reason.services }); break;
        case 'language': notes.push({ kind: 'language', from: reason.from, to: reason.to }); break;
        case 'missing':
        case 'missing-domain': break;
      }
    }
    out.set(page.file, { current, notes, omitted });
  }
  return out;
}

/** The writer's seam: the plan as the writer reads it. */
export function neededFrom(planned: Planned, briefs: ReadonlyMap<string, EditBrief>): (input: UnitsInput) => UnitsNeeded {
  return (input) => {
    const paths = new Set(planned.plan.pages.map((page) => page.path));
    const linked = input.productPage === null ? [] : [...input.productPage.matchAll(/\(madarch:domain:([a-z][a-z0-9-]*)\)/g)].map((match) => `${DOMAINS_FOLDER}/${match[1]}.md`);
    const missing = linked.filter((path) => !input.domainPages.includes(path));
    const first = input.productPage === null;
    return {
      product: first || paths.has(PRODUCT_PATH) || missing.length > 0,
      domain: (path) => first || !input.domainPages.includes(path) || paths.has(path),
      brief: (path) => briefs.get(path),
    };
  };
}
