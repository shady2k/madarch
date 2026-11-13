/**
 * What the wiki shows of the loop (madarch-m38l.7): the questions and their
 * answers, and the problems: corrections people recorded and what the engine
 * found itself (a ground that is gone, a link that names nothing, a file it
 * cannot read). The rows are plain data; the app words them, in both languages.
 * Every problem says who fixes it: the agent at the next refresh, or a person.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { changedGrounds, graphKnowledgePages, type IndexedPage } from '../knowledge/index/index.js';
import { pageOpinionKinds } from '../knowledge/markdown.js';
import { declaredKindReads } from '../fill/stages/plugin-contract.js';
import { KINDS_FILE, type FindingKind, type KindsManifest } from '../product/manifest/kinds.js';
import type { ProductFileSource } from '../plugin/product-files.js';
import { questionAddress } from '../knowledge/addresses.js';
import { entityAddress, sourceAddress, type Resolution } from '../knowledge/resolve.js';
import { DOMAINS_FOLDER, PRODUCT_PATH } from '../writer/units.js';
import type { Author } from './entities.js';
import type { LoopGraph } from './graph.js';
import { type PlaceView, type TaskScope } from './tasks.js';
import type { Unplaced } from './plan.js';
import { ruleForKind } from '../problems/rules.js';
import { problemId, type ProblemLink, type ProblemNote, type ProblemSection, type ProblemSeverity, type ProblemSettings, type ProblemScope, type SonarKind } from '../problems/types.js';

// ---- problems ---------------------------------------------------------------------------------

/** The kind of a wiki finding; the code and the documents carry kinds of their own. */
type ProblemKind = 'correction' | 'ground-removed' | 'broken-link' | 'unreadable-file' | 'unplaced' | 'manifest';
/** Who fixes it: the agent when the pages are refreshed, or a person. */
type Fixer = 'agent' | 'person';

export interface Problem {
  /** The problem's stable id: its rule and the place it names, never its position in the list. */
  readonly id: string;
  /** The original finding key used with the rule to form the stable id. */
  readonly identity: string;
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
  /**
   * The reason as a key and its values, when the engine wrote it in English words the interface words itself: the app
   * says `loop.problemText.<textKey>` with `textArgs`, and `reason` is the fallback (madarch-8bdc.2.5).
   */
  readonly textKey?: string;
  readonly textArgs?: Record<string, string | number>;
  readonly file: string;
  readonly line: number | null;
  /** The file's place on this machine, when the reader knows it: the identity above is what a reader navigates by. */
  readonly source?: string;
  readonly by: Author | null;
  readonly at: string | null;
}

export interface ProblemListing {
  readonly problems: readonly Problem[];
  /** One row per rule: the Problems page's first level (madarch-8bdc.2.5). */
  readonly categories: readonly ProblemCategory[];
  /** How many problems each section of the page holds, dismissals left out. */
  readonly sections: Readonly<Record<ProblemSection, number>>;
  readonly open: number;
  readonly closed: number;
  /** Problems a person marked «Не проблема»; their records are files in the product repository. */
  readonly dismissed: number;
  /** Why a check could not be made (no single repository, say): said, never skipped silently. */
  readonly notes: readonly ProblemNote[];
}

/** One rule of the Problems page's first level, with the count it holds. */
export interface ProblemCategory {
  readonly rule: string;
  readonly kind: string;
  readonly section: ProblemSection;
  readonly sonar: SonarKind;
  readonly severity: ProblemSeverity;
  readonly fixer: Fixer;
  /** Every problem of this rule, open and closed; dismissals are left out. */
  readonly count: number;
  readonly open: number;
  readonly closed: number;
  /** The rule's own name per interface language, from the manifest; the app prefers the locale's one-line meaning. */
  readonly label?: Readonly<Record<string, string>>;
}

export interface ProblemInput {
  readonly graph: LoopGraph;
  readonly productFolder: string;
  readonly owner: DatabaseOwner;
  /** The product repository's own files as the graph holds them, and the manifest they declare: the pages are read here. */
  readonly files: ProductFileSource;
  readonly manifest: KindsManifest;
  /** The single code repository the pages are written from, with the commit the graph describes; absent when there is not exactly one. */
  readonly repository?: { readonly name: string; readonly path: string; readonly commit: string };
  readonly resolve: (url: string) => Promise<Resolution>;
  /** Findings of the manifest and of the product's Markdown, already read. */
  readonly findings: readonly { readonly file: string; readonly line: number; readonly message: string; readonly kind?: FindingKind; readonly source?: string; readonly textKey?: string; readonly textArgs?: Record<string, string | number> }[];
  readonly unplaced?: readonly Unplaced[];
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
    textKey?: string; textArgs?: Record<string, string | number>;
  },
  settings: ProblemSettings,
  notes: ProblemNote[],
): Problem | undefined {
  const rule = ruleForKind(settings, kind);
  if (rule === undefined) {
    const note = `the manifest declares no wiki rule of the kind "${kind}": the findings it would name are not on the page`;
    if (!notes.some((held) => held.message === note)) notes.push({ message: note });
    return undefined;
  }
  const severity = rule.severity;
  const place = fields.place ?? placeOfWiki(fields.page, fields.file, fields.line);
  const entity = fields.entity ?? (fields.page === null ? null : { label: fields.pageTitle ?? fields.page, href: entityAddress(fields.page), key: fields.page });
  return {
    id: problemId(rule.id, identity), identity, section: rule.section, rule: rule.id, kind, sonar: rule.sonar, severity,
    fixer: fields.fixer, closed: fields.closed,
    page: fields.page, pageTitle: fields.pageTitle, statement: fields.statement, sentence: fields.sentence,
    target: fields.target, reason: fields.reason, ...(fields.textKey === undefined ? {} : { textKey: fields.textKey, textArgs: fields.textArgs }), file: fields.file, line: fields.line,
    ...(fields.source === undefined ? {} : { source: fields.source }),
    place, entity,
    evidence: fields.evidence ?? [],
    by: fields.by, at: fields.at,
    ...((fields.file === '' || rule.action === 'none') ? {} : { scope: { type: 'file', path: fields.file } }),
  };
}

export async function listProblems(input: ProblemInput): Promise<ProblemListing> {
  const out: Problem[] = [];
  const notes: ProblemNote[] = [];
  const add = (problem: Problem | undefined): void => { if (problem !== undefined) out.push(problem); };
  const read = await graphKnowledgePages(input.graph, pageOpinionKinds(input.manifest, declaredKindReads(input.manifest)));
  const pages = read.pages.filter(isPage);
  const byId = new Map(pages.map((page) => [page.id, page] as const));
  const none = { page: null, pageTitle: null, statement: null, sentence: null, target: null, by: null, at: null, line: null, closed: false } as const;
  // Every finding is kept: two passages of one table row stand on the same line, and one message would hide the other
  // (the twelfth review). Only an exact repeat — the same kind, message and place — is dropped.
  const seenFinding = new Set<string>();
  for (const finding of [...input.findings, ...read.findings]) {
    // A finding in the manifest is the manifest's own rule; every other finding keeps the kind it carries.
    const kind = (finding.kind ?? (finding.file === KINDS_FILE ? 'manifest' : 'unreadable-file')) as ProblemKind;
    const fixer = 'person';
    const key = `${finding.file}:${finding.line}:${kind}:${finding.message}`;
    if (seenFinding.has(key)) continue;
    seenFinding.add(key);
    add(wikiProblem(kind, key, {
      ...none, fixer, reason: finding.message, file: finding.file, line: finding.line, ...(finding.source === undefined ? {} : { source: finding.source }),
      ...(finding.textKey === undefined ? {} : { textKey: finding.textKey, textArgs: finding.textArgs }),
    }, input.settings, notes));
  }
  for (const miss of input.unplaced ?? []) {
    const file = miss.kind === 'question' ? `docs/questions/${miss.slug}.md` : `docs/corrections/${miss.slug}.md`;
    const entity = miss.kind === 'question' ? { label: miss.slug, href: questionAddress(miss.slug), key: `question:${miss.slug}` } : null;
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
    if (pages.length > 0) notes.push({ message: 'the pages name no single code repository, so grounds that disappeared from the code are not looked for' });
  } else if (pages.length > 0) {
    const changes = await changedGrounds(input.owner, { commit: input.repository.commit });
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
  const order: Record<string, number> = { correction: 0, 'ground-removed': 1, 'broken-link': 2, unplaced: 3, 'unreadable-file': 4, manifest: 5 };
  kept.sort((a, b) => Number(a.closed) - Number(b.closed) || (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || byCodePoint(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || byCodePoint(a.target ?? '', b.target ?? '') || byCodePoint(a.rule, b.rule));
  const sections = { code: 0, documents: 0, wiki: 0 } as Record<ProblemSection, number>;
  for (const problem of kept) sections[problem.section] += 1;
  const byRule = new Map<string, Problem[]>();
  for (const problem of kept) {
    const rows = byRule.get(problem.rule);
    if (rows === undefined) byRule.set(problem.rule, [problem]);
    else rows.push(problem);
  }
  const sectionOrder: readonly ProblemSection[] = ['code', 'documents', 'wiki'];
  const categories: ProblemCategory[] = [...byRule.entries()].map(([rule, rows]) => {
    const first = rows[0]!;
    const setting = declared[rule]!;
    return {
      rule, kind: first.kind, section: first.section, sonar: first.sonar, severity: first.severity, fixer: first.fixer,
      count: rows.length, open: rows.filter((problem) => !problem.closed).length, closed: rows.filter((problem) => problem.closed).length,
      label: { ...setting.label },
    };
  }).sort((a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section) || byCodePoint(a.rule, b.rule));
  return { problems: kept, categories, sections, open: kept.filter((p) => !p.closed).length, closed: kept.filter((p) => p.closed).length, dismissed: out.filter((problem) => dismissed.has(problem.id)).length, notes };
}

// ---- the scoped tasks of answers (madarch-m38l.14) ------------------------------------------

/** One scope of a task, as it is stored and as a reader says it. */
interface TaskScopeRow {
  readonly scope: TaskScope;
  readonly words: string;
  /** The place as a reader says it: a heading and a title, each a link. */
  readonly place: PlaceView;
}

/** How a task closed: by a commit of a repository, or by a person. */
type TaskClosureView =
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

