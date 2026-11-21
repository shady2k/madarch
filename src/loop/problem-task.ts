/**
 * «Создать задачу» (madarch-64o5.104, the owner's rule of 2026-11-13): a person's problem becomes a task entity of the
 * product's own task kind, written through the one write path MCP and the agent use and with the person as its source.
 * The task carries the problem it came from, its place and its statement; the Problems page finds it by that record and
 * links to it, so a second press opens the task instead of writing another.
 *
 * The kind is the starter catalogue's work task, and nothing about its wording belongs to the engine: the title and the
 * body are said in the language the product's pages are written in, and the record itself is data a later reader joins on.
 */
import { canonicalJsonDigest } from '../model/canonical.js';
import type { Problem } from './views.js';
import { contentLanguage, pluralForm } from '../knowledge/plural.js';
import en from '../../wiki/app/src/locales/en.json';
import ru from '../../wiki/app/src/locales/ru.json';

/** The kind a problem's task is an entity of: the product's own task kind, which the starter catalogue declares. */

export const problemFingerprint = (problem: Pick<Problem, 'rule' | 'text' | 'file' | 'line'>, aboutUid: string | null): string => canonicalJsonDigest({ rule: problem.rule, text: problem.text, file: problem.file, line: problem.line, aboutUid });

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

/** A part of a write's source with the '@' that joins a producer and its version escaped: that one stays the joiner. */
const escapeSourcePart = (text: string): string => text.replaceAll('@', '%40');

/**
 * The write's source: the person, whose producer starts with `person:` — so the product knows a person wrote in it and its
 * start-over is refused — and whose name and address carry no '@' of their own, since that one joins them in `said_by`.
 */
export const problemTaskSource = (person: { readonly name: string; readonly email: string }): { readonly producer: string; readonly version: string; readonly principal: { readonly kind: 'person'; readonly identity: string } } => ({
  producer: `person:${escapeSourcePart(person.name)}`,
  version: escapeSourcePart(person.email),
  principal: { kind: 'person', identity: person.email },
});

/** The rule's own name in the reader's language, when the product's manifest declares one. */
export type RuleName = Readonly<Partial<Record<'en' | 'ru', string>>>;

/** A problem's identity as the parts a record stores: its own parts, since a stored text holds no NUL. */
export const problemIdentityParts = (identity: string): readonly string[] => identity.split('\u0000');

/** The place of a problem as a reader says it: its file and line, or the place the finding named. */
function placeOf(problem: Problem): string {
  if (problem.file === '') return problem.place.label;
  return problem.line === null ? problem.file : `${problem.file}:${problem.line}`;
}

/** A task uses the same localized sentence as the page, from the same locale data. */
function statementOf(problem: Problem, language: 'en' | 'ru'): string {
  const words = (language === 'ru' ? ru : en).loop.problemText;
  const code = problem.text.code;
  let template: string;
  if (code === 'largeFile') {
    const count = problem.text.args?.['count'];
    if (typeof count !== 'number' || !Number.isFinite(count)) throw new Error('src/loop/problem-task.ts:86: largeFile requires a finite numeric count');
    template = words[`largeFile_${pluralForm(language, count)}`];
  } else {
    template = words[code];
  }
  let statement = '';
  let offset = 0;
  while (offset < template.length) {
    const start = template.indexOf('{{', offset);
    if (start === -1) return statement + template.slice(offset);
    statement += template.slice(offset, start);
    const end = template.indexOf('}}', start + 2);
    if (end === -1) throw new Error(`src/loop/problem-task.ts:89: invalid locale template for ${problem.text.code}`);
    const name = template.slice(start + 2, end);
    const value = problem.text.args?.[name];
    if (value === undefined) throw new Error(`src/loop/problem-task.ts:92: missing locale argument ${name} for ${problem.text.code}`);
    statement += String(value);
    offset = end + 2;
  }
  return statement;
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
  const lines = language === 'ru'
    ? [`Правило: ${name}`, `Место: ${place}`]
    : [`Rule: ${name}`, `Place: ${place}`];
  if (statement !== '') lines.push(language === 'ru' ? `Что не так: ${statement}` : `What is wrong: ${statement}`);
  const body = lines.join('\n');
  return {
    title, body, statement,
    // The problem's stable id, as its rule and identity rather than as one string, and the identity as its parts: a
    // stored text holds no NUL, and a rule's identity is its parts joined by one (an SQL input's is the sink and the
    // builder), so the parts are what a record keeps and the reader joins them back (madarch-64o5.104).
    front: {
      rule: problem.rule,
      identity: problemIdentityParts(problem.identity),
      file: problem.file,
      line: problem.line,
      statement,
      // The place a change reaches, in the retired task format's own words, kept for a reader that looks for it.
      ...(problem.scope === undefined ? {} : { scope: problem.scope }),
    },
  };
}
