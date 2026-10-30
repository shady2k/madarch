import { describe, expect, test } from 'bun:test';
import en from './locales/en.json';
import ru from './locales/ru.json';
import i18n, { languageStorageKey, normalizeLanguage, relativeTime, setWikiLanguage } from './i18n.js';
import { pluralForm } from '../../../src/knowledge/plural.js';
import { COUNTED_FIGURES, historyFigureText } from '../../../src/knowledge/history-figures.js';
import { historyNoteText } from './knowledge/history-note.js';
import { unitLimitWords } from './knowledge/unit-bounds.js';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix === '' ? key : prefix + '.' + key),
  );
}

/** Every reader-facing count, and the four numerals a reader meets: one, few, many and none. */
const COUNT_MESSAGES: {
  key: string;
  args?: (count: number) => Record<string, string | number>;
  en: readonly [string, string, string, string];
  ru: readonly [string, string, string, string];
}[] = [
  { key: 'knowledge.historyFigure.commits', ru: ['1 коммит', '2 коммита', '5 коммитов', '0 коммитов'], en: ['1 commit', '2 commits', '5 commits', '0 commits'] },
  { key: 'knowledge.historyFigure.files', ru: ['1 файл', '2 файла', '5 файлов', '0 файлов'], en: ['1 file', '2 files', '5 files', '0 files'] },
  { key: 'knowledge.historyFigure.symbols', ru: ['1 символ', '2 символа', '5 символов', '0 символов'], en: ['1 symbol', '2 symbols', '5 symbols', '0 symbols'] },
  { key: 'knowledge.historyFigure.authors', ru: ['1 автор', '2 автора', '5 авторов', '0 авторов'], en: ['1 author', '2 authors', '5 authors', '0 authors'] },
  { key: 'knowledge.historyFigure.merges', ru: ['1 слияние', '2 слияния', '5 слияний', '0 слияний'], en: ['1 merge', '2 merges', '5 merges', '0 merges'] },
  { key: 'knowledge.historyFigure.reachable', ru: ['1 достижимый коммит', '2 достижимых коммита', '5 достижимых коммитов', '0 достижимых коммитов'], en: ['1 reachable commit', '2 reachable commits', '5 reachable commits', '0 reachable commits'] },
  { key: 'knowledge.historyFigure.firstParent', ru: ['1 коммит основной линии', '2 коммита основной линии', '5 коммитов основной линии', '0 коммитов основной линии'], en: ['1 first-parent commit', '2 first-parent commits', '5 first-parent commits', '0 first-parent commits'] },
  { key: 'knowledge.historyFigure.nonMerge', ru: ['1 коммит без слияний', '2 коммита без слияний', '5 коммитов без слияний', '0 коммитов без слияний'], en: ['1 non-merge commit', '2 non-merge commits', '5 non-merge commits', '0 non-merge commits'] },
  { key: 'knowledge.historyFigure.both', ru: ['1 совместное изменение', '2 совместных изменения', '5 совместных изменений', '0 совместных изменений'], en: ['1 shared change', '2 shared changes', '5 shared changes', '0 shared changes'] },
  { key: 'knowledge.historyFigure.onlyThis', ru: ['1 изменение только этого файла', '2 изменения только этого файла', '5 изменений только этого файла', '0 изменений только этого файла'], en: ['1 change to this file alone', '2 changes to this file alone', '5 changes to this file alone', '0 changes to this file alone'] },
  { key: 'knowledge.historyFigure.onlyOther', ru: ['1 изменение только другого файла', '2 изменения только другого файла', '5 изменений только другого файла', '0 изменений только другого файла'], en: ['1 change to the other file alone', '2 changes to the other file alone', '5 changes to the other file alone', '0 changes to the other file alone'] },
  { key: 'knowledge.historyCommits', ru: ['1 коммит', '2 коммита', '5 коммитов', '0 коммитов'], en: ['1 commit', '2 commits', '5 commits', '0 commits'] },
  { key: 'knowledge.historyFiles', ru: ['1 файл', '2 файла', '5 файлов', '0 файлов'], en: ['1 file', '2 files', '5 files', '0 files'] },
  { key: 'knowledge.historySymbols', ru: ['1 символ', '2 символа', '5 символов', '0 символов'], en: ['1 symbol', '2 symbols', '5 symbols', '0 symbols'] },
  { key: 'knowledge.historyAdded', ru: ['+1 строка', '+2 строки', '+5 строк', '+0 строк'], en: ['+1 line', '+2 lines', '+5 lines', '+0 lines'] },
  { key: 'knowledge.historyRemoved', ru: ['−1 строка', '−2 строки', '−5 строк', '−0 строк'], en: ['−1 line', '−2 lines', '−5 lines', '−0 lines'] },
  { key: 'knowledge.historyNote.noCounts', ru: ['У 1 файла нет числа строк: двоичный файл или путь, оставшийся от переименования.', 'У 2 файлов нет числа строк: двоичный файл или путь, оставшийся от переименования.', 'У 5 файлов нет числа строк: двоичный файл или путь, оставшийся от переименования.', 'У 0 файлов нет числа строк: двоичный файл или путь, оставшийся от переименования.'], en: ['1 of the files reports no line count: a binary file, or a path a rename left behind.', '2 of the files report no line count: a binary file, or a path a rename left behind.', '5 of the files report no line count: a binary file, or a path a rename left behind.', '0 of the files report no line count: a binary file, or a path a rename left behind.'] },
  { key: 'knowledge.catalogueEntities', ru: ['1 сущность', '2 сущности', '5 сущностей', '0 сущностей'], en: ['1 entity', '2 entities', '5 entities', '0 entities'] },
  { key: 'knowledge.catalogueKinds', ru: ['в 1 виде', 'в 2 видах', 'в 5 видах', 'в 0 видах'], en: ['in 1 kind', 'in 2 kinds', 'in 5 kinds', 'in 0 kinds'] },
  { key: 'knowledge.diagram.depthN', ru: ['1 шаг от этой страницы', '2 шага от этой страницы', '5 шагов от этой страницы', '0 шагов от этой страницы'], en: ['1 hop from this page', '2 hops from this page', '5 hops from this page', '0 hops from this page'] },
  { key: 'knowledge.diagram.heatIsChurn', ru: ['Теплее — файл меняли чаще (до 1 коммита).', 'Теплее — файл меняли чаще (до 2 коммитов).', 'Теплее — файл меняли чаще (до 5 коммитов).', 'Теплее — файл меняли чаще (до 0 коммитов).'], en: ['Warmer is more often changed (up to 1 commit).', 'Warmer is more often changed (up to 2 commits).', 'Warmer is more often changed (up to 5 commits).', 'Warmer is more often changed (up to 0 commits).'] },
  { key: 'journal.size', ru: ['1 байт', '2 байта', '5 байт', '0 байт'], en: ['1 byte', '2 bytes', '5 bytes', '0 bytes'] },
  { key: 'journal.cut', ru: ['Ответ обрезан: всего 1 байт, сохранено начало.', 'Ответ обрезан: всего 2 байта, сохранено начало.', 'Ответ обрезан: всего 5 байт, сохранено начало.', 'Ответ обрезан: всего 0 байт, сохранено начало.'], en: ['The response was cut: 1 byte in all, the first part is kept.', 'The response was cut: 2 bytes in all, the first part is kept.', 'The response was cut: 5 bytes in all, the first part is kept.', 'The response was cut: 0 bytes in all, the first part is kept.'] },
  { key: 'settings.danger.fresh.starter', ru: ['1 стартовый файл (манифест madarch/kinds.yaml и шаблоны) приводится к текущему стартовому набору;', '2 стартовых файла (манифест madarch/kinds.yaml и шаблоны) приводятся к текущему стартовому набору;', '5 стартовых файлов (манифест madarch/kinds.yaml и шаблоны) приводятся к текущему стартовому набору;', '0 стартовых файлов (манифест madarch/kinds.yaml и шаблоны) приводятся к текущему стартовому набору;'], en: ['the 1 starter file (the manifest madarch/kinds.yaml and the templates) is put at the current starter set;', 'the 2 starter files (the manifest madarch/kinds.yaml and the templates) are put at the current starter set;', 'the 5 starter files (the manifest madarch/kinds.yaml and the templates) are put at the current starter set;', 'the 0 starter files (the manifest madarch/kinds.yaml and the templates) are put at the current starter set;'] },
  { key: 'knowledge.lines', ru: ['Строк: 1', 'Строк: 2', 'Строк: 5', 'Строк: 0'], en: ['1 line', '2 lines', '5 lines', '0 lines'] },
  { key: 'knowledge.fillDone', args: (count) => ({ count, date: '2026-01-02' }), ru: ['Заполнено 2026-01-02, страниц: 1', 'Заполнено 2026-01-02, страниц: 2', 'Заполнено 2026-01-02, страниц: 5', 'Заполнено 2026-01-02, страниц: 0'], en: ['Filled 2026-01-02, 1 page', 'Filled 2026-01-02, 2 pages', 'Filled 2026-01-02, 5 pages', 'Filled 2026-01-02, 0 pages'] },
  { key: 'knowledge.fillDoneNoDate', ru: ['Заполнено, страниц: 1', 'Заполнено, страниц: 2', 'Заполнено, страниц: 5', 'Заполнено, страниц: 0'], en: ['Filled, 1 page', 'Filled, 2 pages', 'Filled, 5 pages', 'Filled, 0 pages'] },
  { key: 'knowledge.reset.pages', args: (count) => ({ count, list: 'docs/a.md' }), ru: ['страницы, которые написал агент (1): docs/a.md.', 'страницы, которые написал агент (2): docs/a.md.', 'страницы, которые написал агент (5): docs/a.md.', 'страницы, которые написал агент (0): docs/a.md.'], en: ['the 1 page the agent wrote: docs/a.md.', 'the 2 pages the agent wrote: docs/a.md.', 'the 5 pages the agent wrote: docs/a.md.', 'the 0 pages the agent wrote: docs/a.md.'] },
  { key: 'knowledge.catalogueStatements', ru: ['утверждений: 1', 'утверждений: 2', 'утверждений: 5', 'утверждений: 0'], en: ['1 statement', '2 statements', '5 statements', '0 statements'] },
  { key: 'knowledge.diagram.linesN', ru: ['строк: 1', 'строк: 2', 'строк: 5', 'строк: 0'], en: ['1 line', '2 lines', '5 lines', '0 lines'] },
  { key: 'knowledge.diagram.commitsN', ru: ['коммитов: 1', 'коммитов: 2', 'коммитов: 5', 'коммитов: 0'], en: ['1 commit', '2 commits', '5 commits', '0 commits'] },
  { key: 'knowledge.views.fullList', ru: ['Все элементы (1) и связи', 'Все элементы (2) и связи', 'Все элементы (5) и связи', 'Все элементы (0) и связи'], en: ['All 1 element and relationships', 'All 2 elements and relationships', 'All 5 elements and relationships', 'All 0 elements and relationships'] },
  { key: 'loop.starter.summary', ru: ['В стартовом наборе есть 1 вид, группа и правило, которых нет в вашем манифесте.', 'В стартовом наборе есть 2 вида, группы и правила, которых нет в вашем манифесте.', 'В стартовом наборе есть 5 видов, групп и правил, которых нет в вашем манифесте.', 'В стартовом наборе есть 0 видов, групп и правил, которых нет в вашем манифесте.'], en: ['The starter set has 1 kind, group and rule this manifest lacks.', 'The starter set has 2 kinds, groups and rules this manifest lacks.', 'The starter set has 5 kinds, groups and rules this manifest lacks.', 'The starter set has 0 kinds, groups and rules this manifest lacks.'] },
  { key: 'loop.taskImpactPages', ru: ['Затронет 1 страницу', 'Затронет 2 страницы', 'Затронет 5 страниц', 'Затронет 0 страниц'], en: ['Will affect 1 page', 'Will affect 2 pages', 'Will affect 5 pages', 'Will affect 0 pages'] },
  { key: 'loop.taskImpactStatements', ru: ['и 1 утверждение.', 'и 2 утверждения.', 'и 5 утверждений.', 'и 0 утверждений.'], en: ['and 1 statement.', 'and 2 statements.', 'and 5 statements.', 'and 0 statements.'] },
  { key: 'loop.taskMarksSections', ru: ['Отмечено как запланированное изменение: 1 раздел', 'Отмечено как запланированное изменение: 2 раздела', 'Отмечено как запланированное изменение: 5 разделов', 'Отмечено как запланированное изменение: 0 разделов'], en: ['Marked as a planned change: 1 section', 'Marked as a planned change: 2 sections', 'Marked as a planned change: 5 sections', 'Marked as a planned change: 0 sections'] },
  { key: 'loop.taskMarksStatements', ru: [', 1 утверждение', ', 2 утверждения', ', 5 утверждений', ', 0 утверждений'], en: [', 1 statement', ', 2 statements', ', 5 statements', ', 0 statements'] },
  { key: 'loop.taskMarksEntities', ru: [', 1 страница кода или документов.', ', 2 страницы кода или документов.', ', 5 страниц кода или документов.', ', 0 страниц кода или документов.'], en: [', 1 page of code or documents.', ', 2 pages of code or documents.', ', 5 pages of code or documents.', ', 0 pages of code or documents.'] },
  { key: 'knowledge.historyLandmarkCovered', ru: ['Прочитано деревьев: 1', 'Прочитано деревьев: 2', 'Прочитано деревьев: 5', 'Прочитано деревьев: 0'], en: ['1 distinct tree covered', '2 distinct trees covered', '5 distinct trees covered', '0 distinct trees covered'] },
  { key: 'knowledge.historyLandmarkOffered', ru: ['; доступно корректных ориентиров: 1', '; доступно корректных ориентиров: 2', '; доступно корректных ориентиров: 5', '; доступно корректных ориентиров: 0'], en: ['; 1 valid landmark tree offered', '; 2 valid landmark trees offered', '; 5 valid landmark trees offered', '; 0 valid landmark trees offered'] },
];

/** Every plural family of the catalogue, as its base key: the messages a numeral picks a form of. */
const FAMILIES = [...new Set(leafKeys(en).filter((key) => key.endsWith('_one')).map((key) => key.slice(0, -4)))].sort();
const COUNTS = [1, 2, 5, 0] as const;
const FORM_NAMES = ['one', 'few', 'many', 'none'] as const;

describe('wiki internationalization', () => {
  test('English and Russian catalogues have the same message keys', () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(ru).sort());
  });

  test('landmark plurals select correct English and Russian forms while catalogues keep matching keys', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    await setWikiLanguage('en');
    expect(i18n.t('knowledge.historyLandmarkOmitted', { count: 1 })).toBe('1 earlier landmark tree was not indexed because of the limit.');
    expect(i18n.t('knowledge.historyLandmarkOmitted', { count: 2 })).toBe('2 earlier landmark trees were not indexed because of the limit.');
    expect(i18n.t('knowledge.historyLandmarkUnsupported', { count: 5 })).toBe('5 unsupported Git landmarks');
    await setWikiLanguage('ru');
    expect(i18n.t('knowledge.historyLandmarkOmitted', { count: 1 })).toBe('Из-за лимита не прочитан 1 ранний ориентир.');
    expect(i18n.t('knowledge.historyLandmarkOmitted', { count: 2 })).toBe('Из-за лимита не прочитаны 2 ранних ориентира.');
    expect(i18n.t('knowledge.historyLandmarkOmitted', { count: 5 })).toBe('Из-за лимита не прочитано 5 ранних ориентиров.');
    await setWikiLanguage(normalizeLanguage(previous));
  });

  for (const message of COUNT_MESSAGES) {
    test(`the count ${message.key} reads each numeral's own form in English and in Russian`, async () => {
      const previous = i18n.resolvedLanguage ?? 'en';
      for (const [at, count] of COUNTS.entries()) {
        const args = message.args?.(count) ?? { count };
        await setWikiLanguage('en');
        expect(`${message.key} at ${count} in English reads ${i18n.t(message.key, args)}`).toBe(`${message.key} at ${count} in English reads ${message.en[at]}`);
        await setWikiLanguage('ru');
        expect(`${message.key} at ${count} in Russian reads ${i18n.t(message.key, args)}`).toBe(`${message.key} at ${count} in Russian reads ${message.ru[at]}`);
      }
      await setWikiLanguage(normalizeLanguage(previous));
    });
  }

  test('every numeral of every count reads the form the catalogue holds for it, in both languages', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    const numerals = [0, 1, 2, 3, 4, 5, 11, 12, 13, 14, 21, 22, 25, 101, 1.5, 2.5];
    const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);
    try {
      for (const language of ['en', 'ru'] as const) {
        await setWikiLanguage(language);
        for (const family of FAMILIES) for (const count of numerals) {
          const form = pluralForm(language, count);
          expect(`${family} at ${count} in ${language}: ${t(family, { count })}`).toBe(`${family} at ${count} in ${language}: ${t(`${family}_${form}`, { count })}`);
        }
      }
    } finally {
      await setWikiLanguage(normalizeLanguage(previous));
    }
  });

  test('a Russian count in fractions takes the genitive singular, and 11 to 14 the many form', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    try {
      await setWikiLanguage('ru');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 1.5 })).toBe('1.5 коммита');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 2.5 })).toBe('2.5 коммита');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 11 })).toBe('11 коммитов');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 12 })).toBe('12 коммитов');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 13 })).toBe('13 коммитов');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 14 })).toBe('14 коммитов');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 21 })).toBe('21 коммит');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 0 })).toBe('0 коммитов');
      await setWikiLanguage('en');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 1.5 })).toBe('1.5 commits');
      expect(i18n.t('knowledge.historyFigure.commits', { count: 21 })).toBe('21 commits');
    } finally {
      await setWikiLanguage(normalizeLanguage(previous));
    }
  });

  test('a page file writes a figure with the words the app draws, kind for kind and numeral for numeral', () => {
    for (const language of ['en', 'ru'] as const) for (const kind of COUNTED_FIGURES) for (const count of [0, 1, 2, 5, 11, 21, 1.5]) {
      expect(`${kind} at ${count} in ${language}: ${historyFigureText({ kind, value: String(count) }, language)}`)
        .toBe(`${kind} at ${count} in ${language}: ${i18n.t(`knowledge.historyFigure.${kind}`, { count, lng: language })}`);
    }
  });

  test('a cut list says how much of it is shown, and the shown count agrees with its numeral', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);
    try {
      await setWikiLanguage('en');
      expect(historyNoteText({ key: 'manyCommits', args: { total: 30, shown: 5 } }, t)).toBe('The list names 30 commits; the first 5 are shown.');
      expect(historyNoteText({ key: 'manyCommits', args: { total: 30, shown: 1 } }, t)).toBe('The list names 30 commits; the first 1 is shown.');
      expect(historyNoteText({ key: 'manyCommits', args: { total: 1, shown: 1 } }, t)).toBe('The list names 1 commit; the first 1 is shown.');
      expect(historyNoteText({ key: 'manyFiles', args: { total: 30, shown: 1 } }, t)).toBe('The commit changed 30 files; the first 1 is shown.');
      expect(historyNoteText({ key: 'manyCommits', args: { total: 30, shown: 21 } }, t)).toBe('The list names 30 commits; the first 21 are shown.');
      // A note that names only one number keeps it as one, and is not given the shown phrase.
      expect(historyNoteText({ key: 'symbolsCut', args: { path: 'src/a.ts', shown: 7 } }, t)).toBe('The file src/a.ts holds more entities than this page counts; its symbol figure covers the first 7.');
      await setWikiLanguage('ru');
      expect(historyNoteText({ key: 'manyCommits', args: { total: 30, shown: 1 } }, t)).toBe('В списке 30 коммитов; показан первый.');
      expect(historyNoteText({ key: 'manyCommits', args: { total: 30, shown: 5 } }, t)).toBe('В списке 30 коммитов; показаны первые 5.');
      expect(historyNoteText({ key: 'manyCommits', args: { total: 1, shown: 1 } }, t)).toBe('В списке 1 коммит; показан первый.');
      expect(historyNoteText({ key: 'manyFiles', args: { total: 1, shown: 1 } }, t)).toBe('Коммит изменил 1 файл; показан первый.');
      // 21 takes the plural «первые», not the singular the noun's own class would give it.
      expect(historyNoteText({ key: 'manyCommits', args: { total: 30, shown: 21 } }, t)).toBe('В списке 30 коммитов; показаны первые 21.');
    } finally {
      await setWikiLanguage(normalizeLanguage(previous));
    }
  });

  test('the bound of one unit is a phrase for each numeral, never a bare number after a fixed word', () => {
    const bounds = (turns: number): { turns: number; minutes: number; toolCalls: number; writeAttempts: number; maxDomains: number; editorialRequestsPerPage: number } => ({ turns, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12, editorialRequestsPerPage: 2 });
    const words = (language: 'en' | 'ru', turns: number): string => i18n.t('knowledge.writer.bound', { ...unitLimitWords(bounds(turns), (key, options) => i18n.t(key, { ...options, lng: language })), domains: 12, lng: language });
    expect(words('en', 1)).toContain('bound by 1 turn, 10 minutes, 80 tool calls and 5 refused writes');
    expect(words('en', 30)).toContain('bound by 30 turns, 10 minutes, 80 tool calls and 5 refused writes');
    expect(words('ru', 1)).toContain('ограничен: 1 ход, 10 минут, 80 вызовов инструментов и 5 отклонённых записей');
    expect(words('ru', 2)).toContain('ограничен: 2 хода, 10 минут, 80 вызовов инструментов и 5 отклонённых записей');
    expect(words('ru', 5)).toContain('ограничен: 5 ходов, 10 минут, 80 вызовов инструментов и 5 отклонённых записей');
    expect(i18n.t('knowledge.refreshNote', { ...unitLimitWords(bounds(1), (key, options) => i18n.t(key, { ...options, lng: 'en' })), lng: 'en' }))
      .toContain('Each unit is bound by 1 turn and 10 minutes.');
    expect(i18n.t('knowledge.refreshNote', { ...unitLimitWords(bounds(1), (key, options) => i18n.t(key, { ...options, lng: 'ru' })), lng: 'ru' }))
      .toContain('Каждый юнит ограничен: 1 ход и 10 минут.');
    expect(i18n.t('knowledge.reset.answers', { count: 1, lng: 'en' })).toBe('1 answer stays. People’s corrections stay too.');
    expect(i18n.t('knowledge.reset.answers', { count: 2, lng: 'en' })).toBe('2 answers stay. People’s corrections stay too.');
    expect(i18n.t('knowledge.reset.answers', { count: 1, lng: 'ru' })).toBe('Сохранится 1 ответ. Поправки и исправления сохранятся тоже.');
    expect(i18n.t('knowledge.reset.answers', { count: 2, lng: 'ru' })).toBe('Сохранятся 2 ответа. Поправки и исправления сохранятся тоже.');
  });

  test('browser language tags select Russian only for ru and otherwise English', () => {
    expect(normalizeLanguage('ru-RU')).toBe('ru');
    expect(normalizeLanguage('ru')).toBe('ru');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
  });

  test('the language choice changes chrome messages and persists when storage is available', async () => {
    const previous = i18n.resolvedLanguage ?? 'en';
    await setWikiLanguage('ru');
    expect(i18n.t('navigation.overview')).toBe('Обзор продукта');
    if (typeof globalThis.localStorage !== 'undefined') {
      expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('ru');
    }
    await setWikiLanguage('en');
    expect(i18n.t('navigation.overview')).toBe('Product overview');
    if (typeof globalThis.localStorage !== 'undefined') {
      expect(globalThis.localStorage.getItem(languageStorageKey)).toBe('en');
    }
    await setWikiLanguage(normalizeLanguage(previous));
  });

  test('relative times use the selected locale formatter', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), 'en', now)).toContain('5 min');
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), 'ru', now)).toContain('5 мин');
  });
});
