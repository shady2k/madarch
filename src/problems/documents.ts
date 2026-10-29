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
import { PROBLEM_RULES, severityOf } from './rules.js';
import type { ProblemDraft, ProblemLink, ProblemSettings, ProblemSeverity } from './types.js';

type Rule = typeof PROBLEM_RULES[number];

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

/** The rules one question type feeds, as data; a resolved question is no longer a problem. */
const RULE_OF_TYPE: Readonly<Record<Question['type'], readonly string[]>> = {
  contradiction: ['document.contradiction'],
  'ambiguous-term': ['document.ambiguous-term'],
  undocumented: ['document.undocumented'],
  gap: ['document.undocumented'],
};

/** Runs the documents section over the questions. */
export async function evaluateDocuments(input: DocumentInput): Promise<{ problems: readonly ProblemDraft[]; notes: readonly string[] }> {
  const notes: string[] = [];
  const problems: ProblemDraft[] = [];
  const rules = new Map(PROBLEM_RULES.map((rule) => [rule.id, rule] as const));
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
    const ids = [...(stale === undefined ? [] : ['document.stale']), ...RULE_OF_TYPE[question.type]];
    for (const id of ids) {
      const rule = rules.get(id);
      if (rule === undefined) continue;
      if (input.settings.rules[id]?.enabled === false) continue;
      const severity = severityOf(rule, input.settings);
      const evidence: ProblemLink[] = [questionLink(question), ...question.sides.flatMap((side) => side.grounds.map(targetLink)), ...question.about.map(targetLink)];
      const reason = id === 'document.stale'
        ? (stale === undefined ? 'a ground of this question no longer resolves' : `${stale.target} no longer resolves: ${stale.reason}`)
        : question.type === 'contradiction'
          ? `${question.title}: the sources disagree — ${question.sides.map((side) => side.claim).join(' / ')}`
          : question.type === 'ambiguous-term'
            ? `${question.title}: the term has more than one meaning in the product and no glossary fixes one.`
            : `${question.title}: ${question.why === '' ? 'behaviour the documents do not describe' : question.why}`;
      problems.push(draft(rule, severity, question, { reason, evidence, identity: `${question.id}\u0000${id}`, entity: questionLink(question) }));
    }
  }
  return { problems, notes };
}
