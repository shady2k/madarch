/**
 * The task an answer proposes (madarch-m38l.14). The reader chooses «Прав код,
 * документ устарел» or «Прав документ, код нужно исправить»; the engine turns
 * the answer's grounds into a scope a person edits and confirms:
 *
 * - a document section becomes that section, never its whole file (the owner,
 *   2026-10-23: "Зачем помечать весь файл, если исправить нужно одну строчку?");
 * - a whole file or folder becomes the file, because the ground names nothing
 *   narrower; a statement or a symbol keeps its own name;
 * - the grounds that name no place of the product stay the task's grounds, and
 *   a proposal that could derive no scope at all is refused with its grounds.
 *
 * The proposal carries the impact computed through the graph, so the reader sees
 * the pages and statements the change reaches before confirming anything.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { readQuestions, type Question } from './entities.js';
import { impactOf, type TaskImpact } from './impact.js';
import { groundsOfScope } from './planned.js';
import type { PlaceView, TaskScope } from './tasks.js';

/** The reader's choice: the code is right and the documents are old, or the documents are right and the code must change. */
export type TaskChoice = 'code' | 'docs';

export interface TaskProposal {
  readonly choice: TaskChoice;
  readonly title: string;
  readonly grounds: readonly string[];
  readonly scope: readonly TaskScope[];
  /** The places of the scope as a reader says them, one for each scope in the same order (the server adds them). */
  readonly places?: readonly PlaceView[];
  /** What the change reaches, computed through the graph before anything is confirmed. */
  readonly impact: TaskImpact;
  readonly question: { readonly slug: string; readonly title: string; readonly file: string };
  readonly answer: { readonly text: string; readonly by: string; readonly at: string };
}

/** A proposal that cannot be made: it says which grounds name no place, and the file it read. */
export class ProposalRefusal extends Error {}

// The task's title is a product artifact and follows the product's language (the manifest's `language:`).
const TITLE_PREFIX: Record<TaskChoice, Record<'en' | 'ru', string>> = {
  code: { en: 'Update the documents', ru: 'Обновить документы' },
  docs: { en: 'Fix the code', ru: 'Исправить код' },
};

/** The scope a ground names, when it names one of the product's places; undefined when it names no place. */
export function scopeOfGround(ground: string): TaskScope | undefined {
  const doc = /^doc:([^#]+)(?:#(.+))?$/.exec(ground);
  if (doc !== null) return doc[2] === undefined || doc[2] === '' ? { type: 'file', path: doc[1]! } : { type: 'section', path: doc[1]!, anchor: doc[2].toLowerCase() };
  const symbol = /^code\.symbol:(.+)$/.exec(ground);
  if (symbol !== null) return { type: 'symbol', key: ground };
  const file = /^code\.(?:file|directory):(.+)$/.exec(ground);
  if (file !== null) return { type: 'file', path: file[1]! };
  // A statement of a page keeps its own name; a page of the product becomes its file, so the scope names where it is written.
  const statement = /^((?:product|domain):[a-z][a-z0-9-]*)#([^#]+)$/.exec(ground);
  if (statement !== null) return { type: 'statement', key: ground };
  // A bare page id names where the question was asked, not a place to change: it becomes no scope.
  return undefined;
}

const scopeKey = (scope: TaskScope): string => JSON.stringify(scope);

/** The proposal for one answer: its grounds as a scope, its impact read through the graph. */
export async function proposeTask(input: { readonly owner: DatabaseOwner; readonly productFolder: string; readonly question: string; readonly choice: TaskChoice; readonly language?: 'en' | 'ru' }): Promise<TaskProposal> {
  const read = readQuestions(input.productFolder);
  const question: Question | undefined = read.items.find((candidate) => candidate.slug === input.question);
  if (question === undefined) {
    const broken = read.problems.find((problem) => problem.file.endsWith(`/${input.question}.md`));
    throw new ProposalRefusal(broken === undefined ? `there is no question ${input.question}: docs/questions/${input.question}.md is not in the product repository` : broken.message);
  }
  if (question.answer === null) throw new ProposalRefusal(`${question.file}:1: the question ${question.slug} has no answer yet, so it proposes no task: answer it first`);
  // The answer's evidence, not where the question was asked: a bare page id names a place, not a change.
  const grounds = [...new Set([...question.about, ...question.sides.flatMap((side) => side.grounds)])]
    .filter((ground) => /^(code\.|doc:)/.test(ground) || ground.includes('#'))
    .sort(byCodePoint);
  if (grounds.length === 0) throw new ProposalRefusal(`${question.file}:1: the question ${question.slug} names no ground, so a task from it would change nothing`);
  // Which side the task changes decides the scope: «Прав код, документ устарел» changes the documents the answer names,
  // «Прав документ, код нужно исправить» changes the code it names. The whole grounds stay the task's evidence either way.
  const side = grounds.filter((ground) => (input.choice === 'docs' ? ground.startsWith('code.') : !ground.startsWith('code.')));
  const mine = side.length > 0 ? side : grounds;
  const scopes = new Map<string, TaskScope>();
  for (const ground of mine) {
    const scope = scopeOfGround(ground);
    if (scope !== undefined) scopes.set(scopeKey(scope), scope);
  }
  if (scopes.size === 0) throw new ProposalRefusal(`${question.file}:1: none of the grounds of ${question.slug} names a place of the product, so a task from it would mark nothing: ${grounds.join(', ')}`);
  const scope = [...scopes.values()].sort((a, b) => byCodePoint(JSON.stringify(a), JSON.stringify(b)));
  // The preview is what the scope reaches: the sections the task changes, not the evidence of the whole answer.
  const keys = [...new Set([...scopes.values()].flatMap((scope) => groundsOfScope(scope)))].sort(byCodePoint);
  const impact = await impactOf(input.owner, input.productFolder, keys.length === 0 ? grounds : keys);
  const language = input.language === 'ru' ? 'ru' : 'en';
  const title = `${TITLE_PREFIX[input.choice][language]}: ${question.title}`;
  return {
    choice: input.choice,
    title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
    grounds,
    scope,
    impact,
    question: { slug: question.slug, title: question.title, file: question.file },
    answer: { text: question.answer.text, by: `${question.answer.by.name} <${question.answer.by.email}>`, at: question.answer.at },
  };
}
