/** Questions and corrections are opinions of ordinary manifest kinds, never parsed product files. */
import type { GraphEntity, GraphReader } from '../knowledge/graph-read.js';
import type { Author, Correction, Question } from './entities.js';

import type { ProblemDismissal } from './problem-files.js';
import { problemId } from '../problems/types.js';

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
  if (value === null && ['producer', 'asked_in', 'asked_at', 'answer', 'resolved_at', 'closed_by', 'closed_at'].includes(name)) return value as T;
  let valid: boolean;
  let expected = 'must be text';
  if (['grounds', 'resolved_by'].includes(name) || (name === 'about' && entity.kind === 'question')) {
    valid = strings(value); expected = 'must be an array of text';
  } else if (name === 'by') {
    valid = author(value); expected = 'must name an author with name, email and verified';
  } else if (name === 'sides') {
    valid = Array.isArray(value) && value.every((side) => object(side) && typeof side['claim'] === 'string' && strings(side['grounds']));
    expected = 'must be an array of {claim, grounds: text[]}';
  } else if (name === 'answer' && entity.kind === 'question') {
    valid = object(value) && typeof value['text'] === 'string' && author(value['by']) && typeof value['at'] === 'string';
    expected = 'must be {text, by: author, at} or null';
  } else if (name === 'written_at') {
    valid = Array.isArray(value) && value.every((at) => object(at) && typeof at['repository'] === 'string' && typeof at['commit'] === 'string' && ['branch', 'origin'].every((key) => at[key] === undefined || typeof at[key] === 'string'));
    expected = 'must be an array of {repository, commit, branch?, origin?}';
  } else {
    valid = typeof value === 'string';
    const choices = name === 'status' ? entity.kind === 'question' ? ['open', 'answered'] : entity.kind === 'correction' ? ['open', 'applied'] : ['open', 'closed']
      : name === 'language' ? ['en', 'ru'] : name === 'type' ? ['contradiction', 'ambiguous-term', 'undocumented', 'gap'] : undefined;
    if (choices !== undefined) { valid = typeof value === 'string' && choices.includes(value); expected = `must be one of ${choices.join(', ')}`; }
  }
  if (!valid) return invalid(entity, name, expected);
  return value as T;
}

export async function graphQuestions(graph: LoopGraph): Promise<Question[]> {
  return (await entities(graph, 'question')).map((entity): Question => ({
    id: entity.key, title: entity.label,
    producer: field<Question['producer']>(entity, 'producer'),
    slug: field<string>(entity, 'slug'), file: field<string>(entity, 'file'), language: field<Question['language']>(entity, 'language'),
    type: field<Question['type']>(entity, 'type'), status: field<Question['status']>(entity, 'status'),
    about: field<Question['about']>(entity, 'about'), askedIn: field<string | null>(entity, 'asked_in'), askedAt: field<string | null>(entity, 'asked_at'),
    question: field<string>(entity, 'question'), why: field<string>(entity, 'why'), sides: field<Question['sides']>(entity, 'sides'),
    answer: field<Question['answer']>(entity, 'answer'), resolvedBy: field<Question['resolvedBy']>(entity, 'resolved_by'),
    resolvedAt: field<string | null>(entity, 'resolved_at'), writtenAt: field<Question['writtenAt']>(entity, 'written_at'),
  }));
}

export async function graphCorrections(graph: LoopGraph): Promise<Correction[]> {
  return (await entities(graph, 'correction')).map((entity): Correction => ({
    id: entity.key, title: entity.label, slug: field<string>(entity, 'slug'), file: field<string>(entity, 'file'),
    status: field<Correction['status']>(entity, 'status'), about: field<string>(entity, 'about'), statement: field<string>(entity, 'statement'),
    reason: field<string>(entity, 'correction_reason'), by: field<Author>(entity, 'by'), at: field<string>(entity, 'at'),
    resolvedBy: field<Correction['resolvedBy']>(entity, 'resolved_by'), resolvedAt: field<string | null>(entity, 'resolved_at'),
  }));
}

export async function graphProblemDismissals(graph: LoopGraph): Promise<ProblemDismissal[]> {
  return (await entities(graph, 'problem-dismissal')).map((entity): ProblemDismissal => {
    const rule = field<string>(entity, 'rule'), identity = field<string>(entity, 'identity');
    return { id: problemId(rule, identity), rule, identity, place: field<string>(entity, 'place'), reason: field<string>(entity, 'dismissal_reason'),
      by: field<Author>(entity, 'by'), at: field<string>(entity, 'at'), file: field<string>(entity, 'file') };
  });
}
