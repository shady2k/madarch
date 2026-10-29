/**
 * The documents section of the Problems page (madarch-m38l.19): what the
 * questions people and the agent already asked say about the documents — two
 * sources contradicting each other, a statement whose ground no longer
 * resolves, behaviour no document describes, a term with two meanings. The
 * rules read the questions the loop wrote (`docs/questions/*.md`); they never
 * read a document's text themselves and never keep a word list.
 */
import { byCodePoint } from '../model/order.js';
import { entityAddress, sourceAddress, type Resolution } from '../knowledge/resolve.js';
import type { Question } from '../loop/entities.js';
import { ruleSpecs, rulesOf } from './rules.js';
import type { ProblemDraft, ProblemLink, ProblemSettings, ProblemSeverity, RuleSpec } from './types.js';

type Rule = RuleSpec;

export interface DocumentInput {
  readonly questions: readonly Question[];
  /** How a `madarch:` target resolves now; a side or an about whose target is broken is a stale statement. */
  readonly resolve: (url: string) => Promise<Resolution>;
  readonly settings: ProblemSettings;
}

const questionLink = (question: Question): ProblemLink => ({
  label: question.title, href: `/k/questions/${encodeURIComponent(question.slug)}`, key: question.id,
});
const questionFileLink = (question: Question): ProblemLink => ({ label: `${question.file}:1`, href: sourceAddress(null, question.file, 1), key: null });
const targetLink = (target: string): ProblemLink => ({ label: target, href: target.includes(':') && !target.startsWith('doc:') ? entityAddress(target) : null, key: target });

const draft = (rule: Rule, severity: ProblemSeverity, question: Question, fields: Pick<ProblemDraft, 'reason' | 'evidence' | 'identity' | 'entity'>): ProblemDraft => ({
  section: 'documents', rule: rule.id, kind: rule.kind, sonar: rule.sonar, severity,
  fixer: 'person', closed: false,
  reason: fields.reason, file: question.file, line: 1,
  page: null, pageTitle: null, statement: null, sentence: null, target: question.id,
  place: questionFileLink(question),
  entity: fields.entity,
  evidence: fields.evidence,
  by: question.answer?.by ?? null, at: question.askedAt,
  source: question.file,
  identity: fields.identity,
  ...(rule.action === 'none' ? {} : { scope: { type: 'file' as const, path: question.file } }),
});

/**
 * The predicates one question type feeds, as data; a resolved question is no longer a problem. The
 * engine names what it read, the manifest's rules choose which findings the page shows.
 */
const PREDICATE_OF_TYPE: Readonly<Record<Question['type'], readonly string[]>> = {
  contradiction: ['document-contradiction'],
  'ambiguous-term': ['document-ambiguous'],
  undocumented: ['document-undocumented'],
  gap: ['document-undocumented'],
};

/** One engine finding of the documents section, before the rules of the manifest name it. */
type Finding = { readonly predicate: string; readonly reason: string; readonly evidence: readonly ProblemLink[] };

/**
 * Runs the documents section over the questions: the engine reads what each question says, and
 * every rule of the manifest whose predicate is one of the findings names it. A predicate no rule
 * declares is a note, so a product's silence about a rule never looks like a clean page.
 */
export async function evaluateDocuments(input: DocumentInput): Promise<{ problems: readonly ProblemDraft[]; notes: readonly string[] }> {
  const notes: string[] = [];
  const problems: ProblemDraft[] = [];
  const declared = new Set(ruleSpecs(input.settings).map((rule) => rule.predicate));
  for (const predicate of ['document-contradiction', 'document-stale', 'document-undocumented', 'document-ambiguous']) {
    if (!declared.has(predicate)) notes.push(`the manifest declares no rule with the predicate "${predicate}": the findings it would name are not on the page`);
  }
  for (const question of [...input.questions].sort((a, b) => byCodePoint(a.slug, b.slug))) {
    if (question.resolvedBy.length > 0) continue; // a refresh used the answer: the documents moved past this question
    let stale: { target: string; reason: string } | undefined;
    for (const target of [...question.about, ...question.sides.flatMap((side) => side.grounds)].sort(byCodePoint)) {
      if (/^(question|correction):/.test(target)) continue;
      let resolution: Resolution;
      try {
        resolution = await input.resolve(`madarch:${target}`);
      } catch (error) {
        notes.push(`the question ${question.slug} names ${target}, and it could not be resolved: ${(error as Error).message}`);
        continue;
      }
      if (resolution.state === 'broken') { stale = { target, reason: resolution.reason }; break; }
    }
    const evidence: ProblemLink[] = [questionLink(question), ...question.sides.flatMap((side) => side.grounds.map(targetLink)), ...question.about.map(targetLink)];
    const findings: Finding[] = [];
    if (stale !== undefined) findings.push({
      predicate: 'document-stale',
      reason: `${stale.target} no longer resolves: ${stale.reason}`,
      evidence,
    });
    for (const predicate of PREDICATE_OF_TYPE[question.type]) {
      findings.push({
        predicate,
        reason: question.type === 'contradiction'
          ? `${question.title}: the sources disagree — ${question.sides.map((side) => side.claim).join(' / ')}`
          : question.type === 'ambiguous-term'
            ? `${question.title}: the term has more than one meaning in the product and no glossary fixes one.`
            : `${question.title}: ${question.why === '' ? 'behaviour the documents do not describe' : question.why}`,
        evidence,
      });
    }
    for (const finding of findings) {
      for (const rule of rulesOf(input.settings, finding.predicate)) {
        problems.push(draft(rule, rule.severity, question, {
          reason: finding.reason, evidence: finding.evidence,
          // The identity keeps the rule's id, so a dismissal written before the rules moved to the manifest still names this finding.
          identity: `${question.id}\u0000${rule.id}`, entity: questionLink(question),
        }));
      }
    }
  }
  return { problems, notes };
}
