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
import { readQuestionsIn } from '../loop/entities.js';
import type { ProductFileSource } from '../knowledge/product-files.js';
import type { KindsManifest } from '../knowledge/kinds.js';
import type { Problem, ProblemInput } from '../loop/views.js';
import { listProblems } from '../loop/views.js';
import type { Unplaced } from '../loop/plan.js';
import { readCodeSnapshot, evaluateCode } from './code.js';
import { evaluateDocuments } from './documents.js';
import { problemId, type ProblemDraft, type ProblemNote, type ProblemSettings } from './types.js';
import { unimplementedRuleNotes } from './rules.js';
import { entityAddress } from '../knowledge/addresses.js';

export interface CollectInput {
  readonly productFolder: string;
  readonly owner: DatabaseOwner;
  /** The product repository's own files as the graph holds them, and the manifest they declare: the questions are read here. */
  readonly files: ProductFileSource;
  readonly manifest: KindsManifest;
  readonly graph: GraphReader;
  /** The kinds the product's manifest declares as its findings kinds (`findings: true`): the engine names none. */
  readonly findingKinds?: readonly string[];
  readonly settings: ProblemSettings;
  readonly resolve: (url: string) => Promise<Resolution>;
  readonly findings: readonly Finding[];
  readonly repository?: ProblemInput['repository'];
  readonly unplaced?: readonly Unplaced[];
  readonly dismissed?: ReadonlySet<string>;
}

/** One draft as the page's row, with its stable id. */
function problemOf(draft: ProblemDraft): Problem {
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
  const notes: ProblemNote[] = [];
  const drafts: ProblemDraft[] = [];
  try {
    const snapshot = await readCodeSnapshot(input.graph);
    const judged = evaluateCode(snapshot, input.settings);
    drafts.push(...judged.problems);
    notes.push(...judged.notes);
  } catch (error) {
    notes.push({ message: `the code section could not be judged: ${(error as Error).message}` });
  }
  try {
    const judged = await evaluateDocuments({ questions: (await readQuestionsIn(input.files)).items, resolve: input.resolve, settings: input.settings });
    drafts.push(...judged.problems);
    notes.push(...judged.notes);
  } catch (error) {
    notes.push({ message: `the documents section could not be judged: ${(error as Error).message}` });
  }
  // What a producer stated about the graph's own consistency: the product's findings kinds hold one entity a finding
  // (madarch-stm0.7.1). The engine reads the kind's declared fields, and a kind that declares nothing is no findings kind.
  try {
    for (const kind of input.findingKinds ?? []) {
      const found = await input.graph.byPrefix(kind, `${kind}:`, 5_000);
      for (const entity of found.rows) {
        const rule = typeof entity.properties['rule'] === 'string' ? entity.properties['rule'] : 'consistency';
        const subject = typeof entity.properties['subject'] === 'string' ? entity.properties['subject'] : '';
        const cause = typeof entity.properties['cause'] === 'string' ? entity.properties['cause'] : entity.label;
        drafts.push({
          section: 'code', rule, kind: 'bug', sonar: 'bug',
          severity: entity.properties['severity'] === 'blocker' || entity.properties['severity'] === 'critical' || entity.properties['severity'] === 'major' || entity.properties['severity'] === 'minor' || entity.properties['severity'] === 'info' ? entity.properties['severity'] : 'major',
          fixer: 'person', closed: false, reason: cause, file: '', line: null, page: null, pageTitle: null,
          statement: null, sentence: null, target: subject === '' ? null : subject,
          place: { label: kind, href: null, key: entity.key },
          entity: subject === '' ? null : { label: subject, href: entityAddress(subject), key: subject },
          evidence: [], by: null, at: null, identity: entity.key,
        });
      }
      if (found.total > found.rows.length) notes.push({ message: `the consistency section reads the first ${String(found.rows.length)} of ${String(found.total)} findings: the rest are not shown` });
    }
  } catch (error) {
    notes.push({ message: `the consistency section could not be read: ${(error as Error).message}` });
  }
  // A rule whose predicate no section implements is said once, whatever section it names (madarch-8bdc.13).
  notes.push(...unimplementedRuleNotes(input.settings));
  const listing = await listProblems({
    productFolder: input.productFolder, owner: input.owner, files: input.files, manifest: input.manifest, resolve: input.resolve, findings: input.findings,
    settings: input.settings,
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.unplaced === undefined ? {} : { unplaced: input.unplaced }),
    ...(input.dismissed === undefined ? {} : { dismissed: input.dismissed }),
    extraProblems: drafts.map(problemOf),
  });
  return { ...listing, notes: [...notes, ...listing.notes] };
}

;
export * from './types.js';
