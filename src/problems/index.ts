/**
 * The Problems page over the whole product (madarch-m38l.19): one listing of
 * what is wrong in the code, in the documents and in the wiki. The three
 * sections judge facts already in the graph and in the loop's own files; the
 * page shows one shape for all of them, and each problem says the rule that
 * found it, its Sonar kind and severity, the place and the entity it is
 * about, one plain reason, the evidence path, and what a person can do.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphReader } from '../knowledge/graph-read.js';
import type { Finding } from '../knowledge/kinds.js';
import type { Resolution } from '../knowledge/resolve.js';
import { readQuestions } from '../loop/entities.js';
import type { Problem, ProblemInput } from '../loop/views.js';
import { listProblems } from '../loop/views.js';
import type { Unplaced } from '../loop/plan.js';
import type { StarterOffer } from '../knowledge/starter-upgrade.js';
import { readCodeSnapshot, evaluateCode } from './code.js';
import { evaluateDocuments } from './documents.js';
import { problemId, type ProblemDraft, type ProblemSettings } from './types.js';

export interface CollectInput {
  readonly productFolder: string;
  readonly owner: DatabaseOwner;
  readonly graph: GraphReader;
  readonly settings: ProblemSettings;
  readonly resolve: (url: string) => Promise<Resolution>;
  readonly findings: readonly Finding[];
  readonly repository?: ProblemInput['repository'];
  readonly unplaced?: readonly Unplaced[];
  readonly starter?: readonly StarterOffer[];
  readonly dismissed?: ReadonlySet<string>;
}

/** One draft as the page's row, with its stable id. */
export function problemOf(draft: ProblemDraft): Problem {
  return {
    id: problemId(draft.rule, draft.identity),
    section: draft.section, rule: draft.rule, kind: draft.kind, sonar: draft.sonar, severity: draft.severity,
    fixer: draft.fixer, closed: draft.closed,
    page: draft.page, pageTitle: draft.pageTitle, statement: draft.statement, sentence: draft.sentence,
    target: draft.target, reason: draft.reason, file: draft.file, line: draft.line,
    ...(draft.source === undefined ? {} : { source: draft.source }),
    place: draft.place, entity: draft.entity, evidence: draft.evidence,
    by: draft.by, at: draft.at,
    ...(draft.scope === undefined ? {} : { scope: draft.scope }),
  };
}

/** A page's badge counts the work still open: a closed problem is history (madarch-m38l.19, the review's seventh finding). */
export function openProblemsOf(problems: readonly Pick<Problem, 'entity' | 'closed'>[], key: string): number {
  return problems.filter((problem) => problem.entity?.key === key && !problem.closed).length;
}

/** Collects the three sections: code rules over the graph, document rules over the questions, the wiki's own findings. */
export async function collectProblems(input: CollectInput): Promise<Awaited<ReturnType<typeof listProblems>>> {
  const notes: string[] = [];
  const drafts: ProblemDraft[] = [];
  try {
    const snapshot = await readCodeSnapshot(input.graph);
    const judged = evaluateCode(snapshot, input.settings);
    drafts.push(...judged.problems);
    notes.push(...judged.notes);
  } catch (error) {
    notes.push(`the code section could not be judged: ${(error as Error).message}`);
  }
  try {
    const judged = await evaluateDocuments({ questions: readQuestions(input.productFolder).items, resolve: input.resolve, settings: input.settings });
    drafts.push(...judged.problems);
    notes.push(...judged.notes);
  } catch (error) {
    notes.push(`the documents section could not be judged: ${(error as Error).message}`);
  }
  const listing = await listProblems({
    productFolder: input.productFolder, owner: input.owner, resolve: input.resolve, findings: input.findings,
    settings: input.settings,
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.unplaced === undefined ? {} : { unplaced: input.unplaced }),
    ...(input.starter === undefined ? {} : { starter: input.starter }),
    ...(input.dismissed === undefined ? {} : { dismissed: input.dismissed }),
    extraProblems: drafts.map(problemOf),
  });
  return { ...listing, notes: [...notes, ...listing.notes] };
}

export { CODE_PREDICATES, DOCUMENT_PREDICATES, PREDICATES, WIKI_PREDICATE, ruleForKind, ruleSpecs, rulesOf } from './rules.js';
export * from './types.js';
