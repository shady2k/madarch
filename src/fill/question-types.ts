/**
 * The charter's eight kinds of open question (the self-filling milestone, outcome 5;
 * decision 0026, "Writing"), and the one order a page groups them in.
 *
 * The owner's words: «у нас неинтерактивная сессия, все вопросы должны идти в
 * открытые вопросы, разбитые по типам» — meaning, contradiction, undocumented
 * behaviour, assumption check, term, unverifiable, decision rationale, and access or
 * document needed. A question fact carries its type as one lower-case kebab token
 * (`QuestionValue.type`, `facts.ts`), which is the token this list names, so the
 * agent's words and the charter's vocabulary are one spelling and nothing is
 * translated between them.
 *
 * **A token outside the eight is grouped, never dropped.** The checked write accepts
 * any once-token type (an agent that invents a ninth kind of question is a finding
 * about the prompt, not a reason to lose the question), so a reader sees such a
 * question under its own type after the charter's eight, and the type it invented is
 * shown as written. The two lists together are the whole of every grouping: a page,
 * the product's question set and the wiki's own question documents read their order
 * from here.
 */
import { byCodePoint } from '../model/order.js';

/** The charter's eight types, in the charter's own order: the order a page groups them in. */
export const CHARTER_QUESTION_TYPES = [
  'meaning',
  'contradiction',
  'undocumented-behaviour',
  'assumption-check',
  'term',
  'unverifiable',
  'decision-rationale',
  'access-or-document-needed',
] as const;
export type CharterQuestionType = (typeof CHARTER_QUESTION_TYPES)[number];

/** Whether a question's type is one the charter names. */
export function isCharterQuestionType(type: string): type is CharterQuestionType {
  return (CHARTER_QUESTION_TYPES as readonly string[]).includes(type);
}

/**
 * The order of the groups a page shows: the charter's eight first, in the charter's
 * order, and then every other type the graph holds, in code point order. A group the
 * page holds no question of is left out by its reader, never shown empty.
 */
export function questionGroupOrder(types: Iterable<string>): readonly string[] {
  const seen = new Set<string>();
  for (const type of types) seen.add(type);
  const charter = CHARTER_QUESTION_TYPES.filter((type) => seen.has(type));
  const invented = [...seen].filter((type) => isCharterQuestionType(type) === false).sort(byCodePoint);
  return [...charter, ...invented];
}

/**
 * How questions of one group are ranked against each other, and every question of the
 * product against every other: by the rank the graph measures (how much depends on the
 * answer, `rankOfQuestion` in `graph-pages.ts`), the higher first, and then by the
 * question's own words and its id in code point order, so two questions of one rank
 * stand in the same order on every machine.
 */
export function byQuestionRank(
  left: { readonly rank: number; readonly prompt: string; readonly id: string },
  right: { readonly rank: number; readonly prompt: string; readonly id: string },
): number {
  return right.rank - left.rank || byCodePoint(left.prompt, right.prompt) || byCodePoint(left.id, right.id);
}
