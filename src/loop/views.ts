/**
 * What the wiki shows of the loop (madarch-m38l.7): the questions and their
 * answers, and the problems: corrections people recorded and what the engine
 * found itself (a ground that is gone, a link that names nothing, a file it
 * cannot read). The rows are plain data; the app words them, in both languages.
 * Every problem says who fixes it: the agent at the next refresh, or a person.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { changedGrounds, gitReader, readKnowledgePages, type IndexedPage } from '../knowledge/index/index.js';
import type { Resolution } from '../knowledge/resolve.js';
import { DOMAINS_FOLDER, PRODUCT_PATH } from '../writer/run.js';
import { parseStatementRef, readCorrections, readQuestions, type Author, type Correction, type Question } from './entities.js';
import type { Unplaced } from './plan.js';
import type { StarterOffer } from '../knowledge/starter-upgrade.js';

export type QuestionState = 'open' | 'answered' | 'closed';

export interface QuestionRow {
  readonly slug: string;
  readonly id: string;
  readonly title: string;
  readonly type: Question['type'];
  readonly state: QuestionState;
  readonly askedIn: string | null;
  readonly askedAt: string | null;
  readonly about: readonly string[];
  readonly answeredBy: Author | null;
  readonly answeredAt: string | null;
  /** The pages whose rewrite used the answer. */
  readonly closedBy: readonly string[];
}

export interface QuestionListing {
  readonly rows: readonly QuestionRow[];
  readonly open: number;
  readonly answered: number;
  readonly closed: number;
  /** Question files that could not be read, each with its file and line. */
  readonly problems: readonly string[];
}

const stateOf = (question: Question): QuestionState => (question.status === 'open' ? 'open' : question.resolvedBy.length > 0 ? 'closed' : 'answered');

export function rowOf(question: Question): QuestionRow {
  return {
    slug: question.slug, id: question.id, title: question.title, type: question.type, state: stateOf(question), askedIn: question.askedIn, askedAt: question.askedAt,
    about: question.about, answeredBy: question.answer?.by ?? null, answeredAt: question.answer?.at ?? null, closedBy: question.resolvedBy,
  };
}

/** The questions of a product: open first, then answered, then closed; each group by id. */
export function listQuestions(productFolder: string): QuestionListing {
  const read = readQuestions(productFolder);
  const order: Record<QuestionState, number> = { open: 0, answered: 1, closed: 2 };
  const rows = read.items.map(rowOf).sort((a, b) => order[a.state] - order[b.state] || byCodePoint(a.id, b.id));
  return { rows, open: rows.filter((r) => r.state === 'open').length, answered: rows.filter((r) => r.state === 'answered').length, closed: rows.filter((r) => r.state === 'closed').length, problems: read.problems.map((problem) => problem.message) };
}

export interface QuestionDetail extends QuestionRow {
  readonly file: string;
  readonly question: string;
  readonly why: string;
  readonly sides: readonly { readonly claim: string; readonly grounds: readonly string[] }[];
  readonly answer: { readonly text: string; readonly by: Author; readonly at: string } | null;
  /** How every target the question names resolves (`madarch:` links, by the target as written without the scheme). */
  readonly resolutions: Record<string, Resolution>;
  readonly resolvedAt: string | null;
}

export async function questionDetail(productFolder: string, slug: string, resolve: (url: string) => Promise<Resolution>): Promise<QuestionDetail | undefined> {
  const read = readQuestions(productFolder);
  const question = read.items.find((candidate) => candidate.slug === slug);
  if (question === undefined) {
    const broken = read.problems.find((problem) => problem.file.endsWith(`/${slug}.md`));
    if (broken !== undefined) throw new Error(broken.message);
    return undefined;
  }
  const resolutions: Record<string, Resolution> = {};
  const targets = new Set<string>([...question.about, ...question.sides.flatMap((side) => side.grounds), ...question.resolvedBy]);
  for (const target of [...targets].sort(byCodePoint)) {
    // A statement is shown through its page.
    const statement = parseStatementRef(target);
    resolutions[target] = await resolve(`madarch:${statement === undefined ? target : statement.page}`);
  }
  return { ...rowOf(question), file: question.file, question: question.question, why: question.why, sides: question.sides, answer: question.answer, resolutions, resolvedAt: question.resolvedAt };
}

// ---- problems ---------------------------------------------------------------------------------

export type ProblemKind = 'correction' | 'ground-removed' | 'broken-link' | 'unreadable-file' | 'unplaced';
/** Who fixes it: the agent when the pages are refreshed, or a person. */
export type Fixer = 'agent' | 'person';

export interface Problem {
  readonly kind: ProblemKind;
  readonly fixer: Fixer;
  /** A correction that a rewrite already used is closed. */
  readonly closed: boolean;
  /** The page it is about (id), when there is one. */
  readonly page: string | null;
  readonly pageTitle: string | null;
  readonly statement: string | null;
  readonly sentence: string | null;
  /** The ground or link that is broken, or the correction's slug. */
  readonly target: string | null;
  readonly reason: string;
  readonly file: string;
  readonly line: number | null;
  readonly by: Author | null;
  readonly at: string | null;
}

export interface ProblemListing {
  readonly problems: readonly Problem[];
  readonly open: number;
  readonly closed: number;
  /** Why a check could not be made (no single repository, say): said, never skipped silently. */
  readonly notes: readonly string[];
  /** What the current starter set holds and this product's edited manifest lacks; each can be added (madarch-m38l.11). */
  readonly starter: readonly StarterOffer[];
}

export interface ProblemInput {
  readonly productFolder: string;
  readonly owner: DatabaseOwner;
  /** The single code repository the pages are written from, with the commit the graph describes; absent when there is not exactly one. */
  readonly repository?: { readonly name: string; readonly path: string; readonly commit: string };
  readonly resolve: (url: string) => Promise<Resolution>;
  /** Findings of the manifest and of the product's Markdown, already read. */
  readonly findings: readonly { readonly file: string; readonly line: number; readonly message: string }[];
  readonly unplaced?: readonly Unplaced[];
  readonly starter?: readonly StarterOffer[];
}

const isPage = (page: IndexedPage): boolean => page.file === PRODUCT_PATH || page.file.startsWith(`${DOMAINS_FOLDER}/`);

export async function listProblems(input: ProblemInput): Promise<ProblemListing> {
  const out: Problem[] = [];
  const notes: string[] = [];
  const read = readKnowledgePages(input.productFolder);
  const pages = read.pages.filter(isPage);
  const byId = new Map(pages.map((page) => [page.id, page] as const));
  const none = { page: null, pageTitle: null, statement: null, sentence: null, target: null, by: null, at: null, line: null, closed: false } as const;
  const corrections = readCorrections(input.productFolder);
  for (const correction of corrections.items) out.push(correctionProblem(correction, byId));
  for (const problem of corrections.problems) out.push({ ...none, kind: 'unreadable-file', fixer: 'person', reason: problem.message.slice(problem.file.length + String(problem.line).length + 2), file: problem.file, line: problem.line });
  for (const problem of readQuestions(input.productFolder).problems) out.push({ ...none, kind: 'unreadable-file', fixer: 'person', reason: problem.message.slice(problem.file.length + String(problem.line).length + 2), file: problem.file, line: problem.line });
  for (const finding of [...input.findings, ...read.findings]) out.push({ ...none, kind: 'unreadable-file', fixer: 'person', reason: finding.message, file: finding.file, line: finding.line });
  for (const miss of input.unplaced ?? []) out.push({ ...none, kind: 'unplaced', fixer: 'person', target: miss.slug, reason: miss.reason, file: miss.kind === 'question' ? `docs/questions/${miss.slug}.md` : `docs/corrections/${miss.slug}.md` });
  // Grounds and links that name nothing.
  const seen = new Set<string>();
  for (const page of pages) {
    for (const statement of page.statements) {
      for (const target of [...statement.grounds, ...statement.mentions]) {
        if (/^(question|correction):/.test(target)) continue;
        const key = `${page.id}\u0000${statement.id}\u0000${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const resolution = await input.resolve(`madarch:${target}`);
        if (resolution.state === 'broken') {
          out.push({ ...none, kind: 'broken-link', fixer: 'agent', page: page.id, pageTitle: page.title, statement: statement.id, sentence: statement.text, target, reason: resolution.reason, file: page.file, line: statement.line });
        }
      }
    }
  }
  // Grounds that are gone from the code or the documents since a page was written.
  if (input.repository === undefined) {
    if (pages.length > 0) notes.push('the pages name no single code repository, so grounds that disappeared from the code are not looked for');
  } else if (pages.length > 0) {
    const changes = await changedGrounds(input.owner, { commit: input.repository.commit, git: gitReader(input.repository.path) });
    for (const change of changes) {
      if (change.status !== 'removed') continue;
      const page = byId.get(change.page);
      if (page === undefined) continue;
      const duplicate = out.some((p) => p.kind === 'broken-link' && p.page === change.page && p.statement === change.statement && p.target === change.ground);
      if (duplicate) continue;
      out.push({ ...none, kind: 'ground-removed', fixer: 'agent', page: page.id, pageTitle: page.title, statement: change.statement, sentence: change.text, target: change.ground, reason: `${change.ground} is no longer in ${input.repository.name} at the commit the graph describes`, file: page.file, line: change.line });
    }
  }
  const order: Record<ProblemKind, number> = { correction: 0, 'ground-removed': 1, 'broken-link': 2, unplaced: 3, 'unreadable-file': 4 };
  out.sort((a, b) => Number(a.closed) - Number(b.closed) || order[a.kind] - order[b.kind] || byCodePoint(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || byCodePoint(a.target ?? '', b.target ?? ''));
  return { problems: out, open: out.filter((p) => !p.closed).length, closed: out.filter((p) => p.closed).length, notes, starter: input.starter ?? [] };
}

function correctionProblem(correction: Correction, pages: ReadonlyMap<string, IndexedPage>): Problem {
  const ref = parseStatementRef(correction.about);
  const page = ref === undefined ? undefined : pages.get(ref.page);
  return {
    kind: 'correction', fixer: 'agent', closed: correction.status === 'applied', page: ref?.page ?? null, pageTitle: page?.title ?? null, statement: ref?.statement ?? null, sentence: correction.statement,
    target: correction.slug, reason: correction.reason, file: correction.file, line: null, by: correction.by, at: correction.at,
  };
}
