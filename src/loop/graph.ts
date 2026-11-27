/** Questions and corrections are opinions of ordinary manifest kinds, never parsed product files. */
import type { GraphEntity, GraphReader } from '../knowledge/graph-read.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { semanticEntities, type SemanticGraph } from '../knowledge/semantic-bindings.js';
import { SYSTEM_PROBLEM } from '../graph/system-contract.js';
import type { Author, Correction, Question } from './entities.js';

import type { ProblemDismissal } from './problem-files.js';
import { problemId, type ProblemTaskLink } from '../problems/types.js';
import { entityPageAddress } from '../knowledge/addresses.js';

export type LoopGraph = Pick<GraphReader, 'list'>;

async function entities(graph: LoopGraph, kind: string): Promise<GraphEntity[]> {
  const rows: GraphEntity[] = [];
  let after: string | undefined;
  do {
    const page = await graph.list(kind, { limit: 500, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return rows;
}

/** The producer's structured fields are checked before a loop view can use them. */
function invalid(entity: GraphEntity, name: string, expected: string): never {
  const path = entity.properties['file'];
  const place = typeof path === 'string' ? path : entity.scope || entity.key;
  throw new Error(`${place}:1: ${entity.key}: graph opinion "${name}" ${expected}`);
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const author = (value: unknown): boolean => object(value) && ['name', 'email', 'verified'].every((key) => typeof value[key] === 'string');

function field<T>(entity: GraphEntity, name: string): T {
  if (!Object.hasOwn(entity.properties, name)) return invalid(entity, name, 'is absent (required)');
  const value = entity.properties[name];
  let valid: boolean;
  let expected = 'must be text';
  if (name === 'by') {
    valid = author(value); expected = 'must name an author with name, email and verified';
  } else {
    valid = typeof value === 'string';
  }
  if (!valid) return invalid(entity, name, expected);
  return value as T;
}

type LineageOpinion = NonNullable<GraphEntity['opinions']>[number];
function assertionAuthor(entity: GraphEntity, opinion: LineageOpinion): import('./entities.js').AssertionAuthor {
  if (opinion.authorUid === undefined || opinion.authorUid === '') return invalid(entity, opinion.field, 'has no assertion author identity');
  return { uid: opinion.authorUid };
}
function assertionTime(entity: GraphEntity, opinion: LineageOpinion): string {
  if (opinion.recordedAt === undefined) return invalid(entity, opinion.field, 'has no assertion recorded time');
  return opinion.recordedAt;
}

function requiredText(entity: GraphEntity, property: string): string {
  const value = entity.properties[property];
  if (typeof value !== 'string') return invalid(entity, property, 'must be text');
  return value;
}

function optionalText(entity: GraphEntity, property: string): string | null {
  const value = entity.properties[property];
  if (value === null) return null;
  return requiredText(entity, property);
}

function keys(entity: GraphEntity, property: string): string[] {
  const value = entity.properties[property];
  if (!strings(value)) return invalid(entity, property, 'must be an array of graph identities');
  return value;
}

function selectedOpinion(entity: GraphEntity, field: string) {
  const found = entity.opinions?.filter((opinion) => opinion.field === field) ?? [];
  if (found.length !== 1) return invalid(entity, field, `requires exactly one selected assertion, found ${found.length}`);
  return found[0]!;
}

export async function graphQuestions(graph: SemanticGraph, manifest: Pick<KindsManifest, 'file' | 'semanticBindings'>): Promise<Question[]> {
  const questionBinding = manifest.semanticBindings?.get('question');
  const sideBinding = manifest.semanticBindings?.get('question-claim');
  const questions = await semanticEntities(graph, manifest, 'question');
  const sides = await semanticEntities(graph, manifest, 'question-claim');
  return questions.map((entity): Question => {
    const body = selectedOpinion(entity, questionBinding!.fields['questionText']!);
    const answerText = optionalText(entity, 'answerText');
    const answer = answerText === null ? null : selectedOpinion(entity, questionBinding!.fields['answerText']!);
    const status = requiredText(entity, 'status');
    if (status !== 'open' && status !== 'answered') return invalid(entity, 'status', 'must be open or answered');
    const language = requiredText(entity, 'language');
    if (language !== 'en' && language !== 'ru') return invalid(entity, 'language', 'must be en or ru');
    const type = requiredText(entity, 'questionType');
    if (!['contradiction', 'ambiguous-term', 'undocumented', 'gap'].includes(type)) return invalid(entity, 'questionType', 'is not a supported question classification');
    return {
      id: entity.key, title: entity.label, producer: body.producer, slug: requiredText(entity, 'presentationSlug'), file: requiredText(entity, 'file'), language,
      type: type as Question['type'], status, about: keys(entity, 'about'), askedIn: null, askedAt: optionalText(entity, 'askedAt'),
      question: requiredText(entity, 'questionText'), why: requiredText(entity, 'why'),
      sides: sides.filter((side) => entity.uid !== undefined && keys(side, 'parentKeys').includes(entity.uid)).sort((a, b) => Number(a.properties['ordinal']) - Number(b.properties['ordinal'])).map((side) => ({
        claim: requiredText(side, 'claimText'), grounds: selectedOpinion(side, sideBinding!.fields['claimText']!).evidence.map((evidence) => {
          if (evidence.id === undefined) return invalid(side, 'claimText', 'has evidence without a target identity');
          return evidence.id;
        }),
      })),
      answer: answer === null ? null : { text: answerText!, by: assertionAuthor(entity, answer), at: assertionTime(entity, answer) },
      resolvedBy: keys(entity, 'resolvedBy'), resolvedAt: optionalText(entity, 'resolvedAt'),
      writtenAt: body.evidence.filter((evidence) => evidence.repository !== null && evidence.commit !== null).map((evidence) => ({ repository: evidence.repository!, commit: evidence.commit! })),
    };
  });
}

export async function graphCorrections(graph: SemanticGraph, manifest: Pick<KindsManifest, 'file' | 'semanticBindings'>): Promise<Correction[]> {
  const binding = manifest.semanticBindings?.get('correction');
  return (await semanticEntities(graph, manifest, 'correction')).map((entity): Correction => {
    const statement = selectedOpinion(entity, binding!.fields['statementText']!);
    const targets = keys(entity, 'about');
    if (targets.length !== 1) return invalid(entity, 'about', 'must identify exactly one corrected graph target');
    const status = requiredText(entity, 'status');
    if (status !== 'open' && status !== 'applied') return invalid(entity, 'status', 'must be open or applied');
    return { id: entity.key, title: entity.label, slug: requiredText(entity, 'presentationSlug'), file: requiredText(entity, 'file'), status,
      about: targets[0]!, statement: requiredText(entity, 'statementText'), reason: requiredText(entity, 'reason'), by: assertionAuthor(entity, statement), at: assertionTime(entity, statement),
      resolvedBy: keys(entity, 'resolvedBy'), resolvedAt: optionalText(entity, 'resolvedAt') };
  });
}

/**
 * The tasks a person opened from the Problems page, by the problem each was opened from (madarch-64o5.104): a task of
 * the product's own task kind whose record names the problem's stable id. The page links to the task it finds, so a
 * second press opens that task instead of writing another.
 */
export async function graphProblemTasks(
  graph: SemanticGraph & Pick<GraphReader, 'find'>,
  manifest: Pick<KindsManifest, 'file' | 'semanticBindings'>,
  listed: readonly { readonly id: string; readonly rule: string; readonly fingerprint: string }[],
): Promise<Map<string, ProblemTaskLink>> {
  const found = new Map<string, ProblemTaskLink>();
  const tasks = await semanticEntities(graph, manifest, 'problem-task');
  const wanted = new Map(listed.map((problem) => [`${problem.rule}\0${problem.fingerprint}`, problem.id]));
  for (const task of tasks) {
    if (task.uid === undefined) return invalid(task, 'problems', 'requires the task graph UID');
    for (const uid of keys(task, 'problems')) {
      const problems = (await graph.find(`${SYSTEM_PROBLEM}:${uid}`)).filter((problem) => problem.uid === uid);
      if (problems.length !== 1) return invalid(task, 'problems', `requires exactly one protected problem for UID ${uid}, found ${problems.length}`);
      const problem = problems[0]!;
      const rule = requiredText(problem, 'rule');
      const fingerprint = requiredText(problem, 'fingerprint');
      const id = wanted.get(`${rule}\0${fingerprint}`);
      if (id === undefined) continue;
      const prior = found.get(id);
      if (prior !== undefined && prior.uid !== task.uid) return invalid(task, 'problems', `problem ${uid} is linked to more than one task`);
      found.set(id, { problem: id, uid: task.uid, title: requiredText(task, 'title'), href: entityPageAddress(task.kind, task.uid) });
    }
  }
  return found;
}

export async function graphProblemDismissals(graph: LoopGraph): Promise<ProblemDismissal[]> {
  return (await entities(graph, 'problem-dismissal')).map((entity): ProblemDismissal => {
    const rule = field<string>(entity, 'rule'), identity = field<string>(entity, 'identity');
    return { id: problemId(rule, identity), rule, identity, place: field<string>(entity, 'place'), reason: field<string>(entity, 'dismissal_reason'),
      by: field<Author>(entity, 'by'), at: field<string>(entity, 'at'), file: field<string>(entity, 'file') };
  });
}
