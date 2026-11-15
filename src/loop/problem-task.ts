/**
 * «Создать задачу» (madarch-64o5.104, the owner's rule of 2026-11-13): a person's problem becomes a task entity of the
 * product's own task kind, written through the one write path MCP and the agent use and with the person as its source.
 * The task carries the problem it came from, its place and its statement; the Problems page finds it by that record and
 * links to it, so a second press opens the task instead of writing another.
 *
 * The kind is the starter catalogue's work task, and nothing about its wording belongs to the engine: the title and the
 * body are said in the language the product's pages are written in, and the record itself is data a later reader joins on.
 */
import type { Problem } from './views.js';
import { contentLanguage } from '../knowledge/plural.js';

/** The kind a problem's task is an entity of: the product's own task kind, which the starter catalogue declares. */
export const PROBLEM_TASK_KIND = 'task';

/** The language a task's words are written in: the product's, Russian only when it is asked for by name. */
export const problemTaskLanguage = (language: string | undefined): 'en' | 'ru' => contentLanguage(language);

/** One task to write, in the product's words: its title, its body and the record that links it to its problem. */
export interface ProblemTaskRecord {
  readonly title: string;
  readonly body: string;
  /** What is wrong, in the reader's language: the same words the body carries, and the write's evidence. */
  readonly statement: string;
  /** The task record's own fields: the problem, its place and its statement, as the page reads them back. */
  readonly front: Readonly<Record<string, unknown>>;
}

/** What a reader can do about a problem the page no longer lists, or a write it cannot make: said in both languages. */
export type ProblemTaskRefusal = 'not-listed' | 'no-identity' | 'write-refused';

const REFUSALS: Readonly<Record<ProblemTaskRefusal, Readonly<Record<'en' | 'ru', string>>>> = {
  'not-listed': {
    en: 'The problem is no longer on the page: its rule, its place or its inputs changed. Reload the page.',
    ru: 'Проблемы больше нет на странице: изменилось её правило, место или данные. Обновите страницу.',
  },
  'no-identity': {
    en: 'The wiki cannot tell who is pressing: set git user.name and user.email, then try again.',
    ru: 'Вики не знает, кто нажал: задайте в git user.name и user.email и повторите.',
  },
  'write-refused': {
    en: 'The task could not be written: the graph refused it. Nothing was created; try again, and if it repeats, the product catalogue needs a look.',
    ru: 'Задачу не удалось записать: граф её отклонил. Ничего не создано; повторите, и если это повторится, стоит проверить каталог продукта.',
  },
};

/** The sentence a reader sees for a refusal of «Создать задачу», in the language the pages are written in. */
export const problemTaskRefusal = (language: 'en' | 'ru', refusal: ProblemTaskRefusal): string => REFUSALS[refusal][language];

/** The rule's own name in the reader's language, when the product's manifest declares one. */
export type RuleName = Readonly<Partial<Record<'en' | 'ru', string>>>;

/** The place of a problem as a reader says it: its file and line, or the place the finding named. */
function placeOf(problem: Problem): string {
  if (problem.file === '') return problem.place.label;
  return problem.line === null ? problem.file : `${problem.file}:${problem.line}`;
}

/** The finding in the reader's words: the rule's own sentence, or the finding's own words when the rule states none. */
function statementOf(problem: Problem, language: 'en' | 'ru'): string {
  const words = problem.words?.[language];
  if (words !== undefined && words !== '') return words;
  return problem.sentence ?? problem.statement ?? problem.reason;
}

/**
 * One task's words and record. The title says what has to change and where, in the reader's language; the body says
 * the same in a sentence a person reads, with the finding's own words; the record names the problem's stable id, its
 * place and its statement, which is how a page of the same problem finds its task again.
 */
export function problemTaskRecord(problem: Problem, options: { readonly language: 'en' | 'ru'; readonly label?: RuleName }): ProblemTaskRecord {
  const { language } = options;
  const name = options.label?.[language] ?? options.label?.en ?? problem.rule;
  const place = placeOf(problem);
  const statement = statementOf(problem, language);
  const title = language === 'ru' ? `Исправить: ${name} — ${place}` : `Fix: ${name} — ${place}`;
  const body = language === 'ru'
    ? [`Правило: ${name}`, `Место: ${place}`, `Что не так: ${statement}`].join('\n')
    : [`Rule: ${name}`, `Place: ${place}`, `What is wrong: ${statement}`].join('\n');
  return {
    title, body, statement,
    // The problem's stable id, as its rule and identity rather than as one string: the separator of a stable id is not a
    // character a person's graph stores (a stored text holds no NUL), and this is how the dismissal kind names its problem.
    front: {
      rule: problem.rule,
      identity: problem.identity,
      file: problem.file,
      line: problem.line,
      statement,
      // The place a change reaches, in the retired task format's own words, kept for a reader that looks for it.
      ...(problem.scope === undefined ? {} : { scope: problem.scope }),
    },
  };
}
