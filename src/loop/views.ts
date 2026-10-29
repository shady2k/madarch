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
import { KINDS_FILE, type FindingKind } from '../knowledge/kinds.js';
import { entityAddress, sourceAddress, type Resolution } from '../knowledge/resolve.js';
import { DOMAINS_FOLDER, PRODUCT_PATH } from '../writer/run.js';
import { parseStatementRef, readCorrections, readQuestions, type Author, type Correction, type Question } from './entities.js';
import { closingCommit, type RepositoryRef, type TaskClosure } from './closure.js';
import { impactOf, type TaskImpact } from './impact.js';
import { impactGroundsOf, type PlannedMarks } from './planned.js';
import { readTasks, scopeWords, type PlaceView, type PlannedTask, type TaskScope } from './tasks.js';
import type { Unplaced } from './plan.js';
import type { StarterOffer } from '../knowledge/starter-upgrade.js';
import { ruleForKind } from '../problems/rules.js';
import { problemId, type ProblemSection, type ProblemLink, type ProblemSeverity, type ProblemSettings, type ProblemScope, type SonarKind } from '../problems/types.js';

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

/** The kind of a wiki finding; the code and the documents carry kinds of their own. */
export type ProblemKind = 'correction' | 'ground-removed' | 'broken-link' | 'unreadable-file' | 'unread-passage' | 'unplaced' | 'manifest';
/** Who fixes it: the agent when the pages are refreshed, or a person. */
export type Fixer = 'agent' | 'person';

export interface Problem {
  /** The problem's stable id: its rule and the place it names, never its position in the list. */
  readonly id: string;
  /** The section of the Problems page the problem belongs to. */
  readonly section: ProblemSection;
  /** The rule that found it (`wiki.broken-link`, `security.sql-input`, ...); the manifest tunes rules by this id. */
  readonly rule: string;
  /** The kind of finding in the SonarQube taxonomy. */
  readonly kind: string;
  readonly sonar: SonarKind;
  readonly severity: ProblemSeverity;
  /** The place it stands, as a link; the entity page it is about, when there is one. */
  readonly place: ProblemLink;
  readonly entity: ProblemLink | null;
  /** The chain that shows why (input → builder → sink), each a link where one can be opened. */
  readonly evidence: readonly ProblemLink[];
  /** What «Создать задачу» opens a task on; absent where the page offers no task. */
  readonly scope?: ProblemScope;
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
  /** The file's place on this machine, when the reader knows it: the identity above is what a reader navigates by. */
  readonly source?: string;
  readonly by: Author | null;
  readonly at: string | null;
}

export interface ProblemListing {
  readonly problems: readonly Problem[];
  /** How many problems each section of the page holds, dismissals left out. */
  readonly sections: Readonly<Record<ProblemSection, number>>;
  readonly open: number;
  readonly closed: number;
  /** Problems a person marked «Не проблема»; their records are files in the product repository. */
  readonly dismissed: number;
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
  readonly findings: readonly { readonly file: string; readonly line: number; readonly message: string; readonly kind?: FindingKind; readonly source?: string }[];
  readonly unplaced?: readonly Unplaced[];
  readonly starter?: readonly StarterOffer[];
  /** The product's `problems:` rules and thresholds, read from its manifest (`problems:`). */
  readonly settings: ProblemSettings;
  /** Ids a person marked «Не проблема»: they are left out of the sections and counted. */
  readonly dismissed?: ReadonlySet<string>;
  /** The code and document sections, already judged; the wiki finds its own. */
  readonly extraProblems?: readonly Problem[];
}

const isPage = (page: IndexedPage): boolean => page.file === PRODUCT_PATH || page.file.startsWith(`${DOMAINS_FOLDER}/`);

/** The place of a wiki finding: the page when there is one, else the file and its line. */
const placeOfWiki = (page: string | null, file: string, line: number | null): ProblemLink => {
  if (page !== null) return { label: page, href: entityAddress(page), key: page };
  // A file of a repository is a place in that repository's source; a product file has no repository in the query.
  const code = /^repos\/([^/]+)\/(.+)$/.exec(file);
  const href = code === null || code[2] === undefined
    ? sourceAddress(null, file, line ?? undefined)
    : sourceAddress(code[1] ?? null, code[2], line ?? undefined);
  return { label: line === null ? file : `${file}:${line}`, href, key: null };
};

/**
 * One wiki finding, with the rule that names it: the rule data gives the Sonar kind and the
 * severity, the manifest may lower the severity, and the id is the rule with the place it names.
 */
function wikiProblem(
  kind: ProblemKind,
  identity: string,
  fields: {
    reason: string; file: string; line: number | null; target: string | null; page: string | null; pageTitle: string | null;
    statement: string | null; sentence: string | null; fixer: Fixer; closed: boolean; by: Author | null; at: string | null;
    source?: string; place?: ProblemLink; entity?: ProblemLink | null; evidence?: readonly ProblemLink[];
  },
  settings: ProblemSettings,
  notes: string[],
): Problem | undefined {
  const rule = ruleForKind(settings, kind);
  if (rule === undefined) {
    const note = `the manifest declares no wiki rule of the kind "${kind}": the findings it would name are not on the page`;
    if (!notes.includes(note)) notes.push(note);
    return undefined;
  }
  const severity = rule.severity;
  const place = fields.place ?? placeOfWiki(fields.page, fields.file, fields.line);
  const entity = fields.entity ?? (fields.page === null ? null : { label: fields.pageTitle ?? fields.page, href: entityAddress(fields.page), key: fields.page });
  return {
    id: problemId(rule.id, identity), section: rule.section, rule: rule.id, kind, sonar: rule.sonar, severity,
    fixer: fields.fixer, closed: fields.closed,
    page: fields.page, pageTitle: fields.pageTitle, statement: fields.statement, sentence: fields.sentence,
    target: fields.target, reason: fields.reason, file: fields.file, line: fields.line,
    ...(fields.source === undefined ? {} : { source: fields.source }),
    place, entity,
    evidence: fields.evidence ?? [],
    by: fields.by, at: fields.at,
    ...((fields.file === '' || rule.action === 'none') ? {} : { scope: { type: 'file', path: fields.file } }),
  };
}

export async function listProblems(input: ProblemInput): Promise<ProblemListing> {
  const out: Problem[] = [];
  const notes: string[] = [];
  const add = (problem: Problem | undefined): void => { if (problem !== undefined) out.push(problem); };
  const read = readKnowledgePages(input.productFolder);
  const pages = read.pages.filter(isPage);
  const byId = new Map(pages.map((page) => [page.id, page] as const));
  const none = { page: null, pageTitle: null, statement: null, sentence: null, target: null, by: null, at: null, line: null, closed: false } as const;
  const corrections = readCorrections(input.productFolder);
  for (const correction of corrections.items) add(correctionProblem(correction, byId, input.settings, notes));
  for (const problem of corrections.problems) add(wikiProblem('unreadable-file', `${problem.file}:${problem.line}:${problem.message}`, {
    ...none, fixer: 'person', reason: problem.message.slice(problem.file.length + String(problem.line).length + 2), file: problem.file, line: problem.line,
  }, input.settings, notes));
  for (const problem of readQuestions(input.productFolder).problems) add(wikiProblem('unreadable-file', `${problem.file}:${problem.line}:${problem.message}`, {
    ...none, fixer: 'person', reason: problem.message.slice(problem.file.length + String(problem.line).length + 2), file: problem.file, line: problem.line,
  }, input.settings, notes));
  // Every finding is kept: two passages of one table row stand on the same line, and one message would hide the other
  // (the twelfth review). Only an exact repeat — the same kind, message and place — is dropped.
  const seenFinding = new Set<string>();
  for (const finding of [...input.findings, ...read.findings]) {
    // A finding in the manifest is the manifest's own rule; every other finding keeps the kind it carries.
    const kind = (finding.kind ?? (finding.file === KINDS_FILE ? 'manifest' : 'unreadable-file')) as ProblemKind;
    // A passage no reader decided is the agent's to read at the next fill; a file that cannot be read is a person's.
    const fixer = kind === 'unread-passage' ? 'agent' : 'person';
    const key = `${finding.file}:${finding.line}:${kind}:${finding.message}`;
    if (seenFinding.has(key)) continue;
    seenFinding.add(key);
    add(wikiProblem(kind, key, {
      ...none, fixer, reason: finding.message, file: finding.file, line: finding.line, ...(finding.source === undefined ? {} : { source: finding.source }),
    }, input.settings, notes));
  }
  for (const miss of input.unplaced ?? []) {
    const file = miss.kind === 'question' ? `docs/questions/${miss.slug}.md` : `docs/corrections/${miss.slug}.md`;
    const entity = miss.kind === 'question' ? { label: miss.slug, href: `/k/questions/${encodeURIComponent(miss.slug)}`, key: `question:${miss.slug}` } : null;
    add(wikiProblem('unplaced', `${miss.kind}:${miss.slug}`, { ...none, fixer: 'person', target: miss.slug, reason: miss.reason, file, entity }, input.settings, notes));
  }
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
          add(wikiProblem('broken-link', key, {
            ...none, fixer: 'agent', page: page.id, pageTitle: page.title, statement: statement.id, sentence: statement.text, target,
            reason: resolution.reason, file: page.file, line: statement.line,
            evidence: [{ label: target, href: null, key: target }],
          }, input.settings, notes));
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
      add(wikiProblem('ground-removed', `${page.id}\u0000${change.statement}\u0000${change.ground}`, {
        ...none, fixer: 'agent', page: page.id, pageTitle: page.title, statement: change.statement, sentence: change.text, target: change.ground,
        reason: `${change.ground} is no longer in ${input.repository.name} at the commit the graph describes`, file: page.file, line: change.line,
        evidence: [{ label: change.ground, href: null, key: change.ground }],
      }, input.settings, notes));
    }
  }
  out.push(...(input.extraProblems ?? []));
  const dismissed = input.dismissed ?? new Set<string>();
  // A rule the manifest switched off is not on the page, whichever section judged it; a problem whose rule the
  // manifest does not declare at all is a note of its section, never a row the page cannot explain.
  const declared = input.settings.rules;
  const kept = out.filter((problem) => !dismissed.has(problem.id) && declared[problem.rule] !== undefined && declared[problem.rule]?.enabled !== false);
  const order: Record<string, number> = { correction: 0, 'ground-removed': 1, 'broken-link': 2, unplaced: 3, 'unreadable-file': 4, 'unread-passage': 5, manifest: 6 };
  kept.sort((a, b) => Number(a.closed) - Number(b.closed) || (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || byCodePoint(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || byCodePoint(a.target ?? '', b.target ?? '') || byCodePoint(a.rule, b.rule));
  const sections = { code: 0, documents: 0, wiki: 0 } as Record<ProblemSection, number>;
  for (const problem of kept) sections[problem.section] += 1;
  return { problems: kept, sections, open: kept.filter((p) => !p.closed).length, closed: kept.filter((p) => p.closed).length, dismissed: out.filter((problem) => dismissed.has(problem.id)).length, notes, starter: input.starter ?? [] };
}

function correctionProblem(correction: Correction, pages: ReadonlyMap<string, IndexedPage>, settings: ProblemSettings, notes: string[]): Problem | undefined {
  const ref = parseStatementRef(correction.about);
  const page = ref === undefined ? undefined : pages.get(ref.page);
  return wikiProblem('correction', correction.slug, {
    fixer: 'agent', closed: correction.status === 'applied', page: ref?.page ?? null, pageTitle: page?.title ?? null, statement: ref?.statement ?? null, sentence: correction.statement,
    target: correction.slug, reason: correction.reason, file: correction.file, line: null, by: correction.by, at: correction.at,
    evidence: [{ label: correction.statement, href: null, key: null }],
  }, settings, notes);
}
// ---- the scoped tasks of answers (madarch-m38l.14) ------------------------------------------

/** One scope of a task, as it is stored and as a reader says it. */
export interface TaskScopeRow {
  readonly scope: TaskScope;
  readonly words: string;
  /** The place as a reader says it: a heading and a title, each a link. */
  readonly place: PlaceView;
}

/** How a task closed: by a commit of a repository, or by a person. */
export type TaskClosureView =
  | { readonly repository: string; readonly commit: string; readonly at: string; readonly subject: string }
  | { readonly person: true; readonly at: string | null };

export interface TaskRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: 'open' | 'closed';
  readonly file: string;
  readonly question: string;
  readonly answer: string;
  /** The problem this task was opened from, when it was (madarch-m38l.19). */
  readonly problemId?: string;
  readonly at: string;
  readonly by: Author;
  readonly grounds: readonly string[];
  readonly scope: readonly TaskScopeRow[];
  readonly closedBy: TaskClosureView | null;
  /** What the change reaches through the graph: null when it could not be read, with the reason in `problem`. */
  readonly impact: { readonly pages: number; readonly statements: number } | null;
  /** Why the impact could not be read: a task whose impact is unknown says so, and never shows an empty list. */
  readonly problem?: string;
}

export interface TaskDetail extends Omit<TaskRow, 'impact'> {
  /** The complete impact through the graph: the pages and statements the change reaches. */
  readonly impact: TaskImpact | null;
  /** The product's pages a run would rewrite: exactly what the preview lists. */
  readonly writable: readonly string[];
  /** The sections, statements and entities this task marks as a planned change. */
  readonly marks: { readonly sections: number; readonly statements: number; readonly entities: number };
}

export interface TaskListing {
  readonly tasks: readonly TaskRow[];
  readonly open: number;
  readonly closed: number;
  /** Task files that could not be read, each with its file and line. */
  readonly problems: readonly string[];
  /** Why a closure or an impact could not be read: said, never hidden. */
  readonly notes: readonly string[];
}

export interface TaskReadInput {
  readonly productFolder: string;
  readonly owner: DatabaseOwner;
  /** The place a scope names, as the wiki words it (product.placeOf). */
  readonly placeOf: (scope: TaskScope) => Promise<PlaceView>;
  /** The repositories a commit may close a task in: the product's own, then each code repository. */
  readonly repositories: readonly RepositoryRef[];
  /** The file each page of the product is written in: what a statement scope names when a commit closes it. */
  readonly pageFiles: ReadonlyMap<string, string>;
}

function closureOf(task: PlannedTask, repositories: readonly RepositoryRef[], pageFiles: ReadonlyMap<string, string>, notes: string[]): TaskClosureView | null {
  if (task.closedBy !== null) return { person: true, at: task.closedAt };
  try {
    const closing: TaskClosure | undefined = closingCommit(task, repositories, { pageFiles });
    return closing === undefined ? null : { repository: closing.repository, commit: closing.commit, at: closing.at, subject: closing.subject };
  } catch (error) {
    notes.push((error as Error).message);
    return null;
  }
}

async function rowOfTask(task: PlannedTask, input: TaskReadInput, notes: string[]): Promise<TaskRow> {
  const closedBy = closureOf(task, input.repositories, input.pageFiles, notes);
  let impact: TaskImpact | null = null;
  let problem: string | undefined;
  try {
    impact = await impactOf(input.owner, input.productFolder, impactGroundsOf(task));
  } catch (error) {
    problem = (error as Error).message;
    notes.push(`${task.file}: ${problem}`);
  }
  return {
    id: task.id, slug: task.slug, title: task.title, status: closedBy === null ? 'open' : 'closed', file: task.file, question: task.question, answer: task.answer,
    ...(task.problem === undefined ? {} : { problemId: task.problem }),
    at: task.at, by: task.by, grounds: task.grounds, scope: await Promise.all(task.scope.map(async (scope) => ({ scope, words: scopeWords(scope), place: await input.placeOf(scope) }))), closedBy,
    impact: impact === null ? null : { pages: impact.counts.pages, statements: impact.counts.statements },
    ...(problem === undefined ? {} : { problem }),
  };
}

/** The product's tasks, open first, then closed; each in id order, with its impact counted through the graph. */
export async function listTasks(input: TaskReadInput): Promise<TaskListing> {
  const read = readTasks(input.productFolder);
  const notes: string[] = [];
  const rows: TaskRow[] = [];
  for (const task of read.tasks) rows.push(await rowOfTask(task, input, notes));
  rows.sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || byCodePoint(a.id, b.id));
  return { tasks: rows, open: rows.filter((row) => row.status === 'open').length, closed: rows.filter((row) => row.status === 'closed').length, problems: read.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`), notes };
}

/** One task with its complete, graph-computed impact: what a run would rewrite and where the planned change shows. */
export async function taskDetail(input: TaskReadInput, id: string, marks: PlannedMarks): Promise<TaskDetail | undefined> {
  const read = readTasks(input.productFolder);
  const task = read.tasks.find((candidate) => candidate.id === id || candidate.slug === id);
  if (task === undefined) return undefined;
  const notes: string[] = [];
  const row = await rowOfTask(task, input, notes);
  const impact = row.impact === null ? null : await impactOf(input.owner, input.productFolder, impactGroundsOf(task));
  return {
    ...row,
    impact,
    writable: impact === null ? [] : impact.writable,
    marks: {
      sections: marks.sections.filter((section) => section.task.id === task.id).length,
      statements: marks.statements.filter((statement) => statement.task.id === task.id).length,
      entities: marks.entities.filter((entity) => entity.task.id === task.id).length,
    },
  };
}
