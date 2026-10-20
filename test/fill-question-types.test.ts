/**
 * The charter's eight kinds of open question (the self-filling milestone, outcome 5),
 * and the order a page groups them in.
 *
 * The expectations are the charter's own words: meaning, contradiction, undocumented
 * behaviour, assumption check, term, unverifiable, decision rationale, access or
 * document needed — «все вопросы должны идти в открытые вопросы, разбитые по типам».
 * A type an agent invented is grouped after the eight and never dropped, so the list is
 * a grouping and not a filter.
 */
import { describe, expect, test } from 'bun:test';
import { byQuestionRank, CHARTER_QUESTION_TYPES, isCharterQuestionType, questionGroupOrder } from '../src/fill/question-types.js';

describe('the charter\'s question types', () => {
  test('the eight are the charter\'s, in the charter\'s order', () => {
    expect([...CHARTER_QUESTION_TYPES]).toEqual([
      'meaning',
      'contradiction',
      'undocumented-behaviour',
      'assumption-check',
      'term',
      'unverifiable',
      'decision-rationale',
      'access-or-document-needed',
    ]);
    for (const type of CHARTER_QUESTION_TYPES) expect(isCharterQuestionType(type)).toBe(true);
    expect(isCharterQuestionType('other')).toBe(false);
    expect(isCharterQuestionType('assumption check')).toBe(false);
  });

  test('a grouping names the charter\'s types first, then a type an agent invented, in code point order', () => {
    // A product that asks two kinds the charter names and one it does not: the two come first, in the charter's order
    // and not the alphabet's (`contrast` sorts before `meaning` and is a type nobody named), and nothing is dropped.
    expect(questionGroupOrder(['meaning', 'contrast', 'contradiction'])).toEqual(['meaning', 'contradiction', 'contrast']);
    expect(questionGroupOrder(['zzz-token', 'access-or-document-needed', 'aaa-token'])).toEqual(['access-or-document-needed', 'aaa-token', 'zzz-token']);
    expect(questionGroupOrder([])).toEqual([]);
    // A group of one type is one entry however often the type stands in the input.
    expect(questionGroupOrder(['term', 'term'])).toEqual(['term']);
  });

  test('questions are ranked by what depends on the answer, and one rank orders by the question\'s own words', () => {
    const question = (rank: number, prompt: string, id: string) => ({ rank, prompt, id });
    // The question ten pages depend on stands above the one page's, whatever the alphabet says.
    expect([question(1, 'Why?', 'question:b'), question(10, 'What?', 'question:a')].sort(byQuestionRank)).toEqual([
      question(10, 'What?', 'question:a'),
      question(1, 'Why?', 'question:b'),
    ]);
    // Two questions of one rank stand in the same order on every machine: by their words, then by their ids.
    expect([question(2, 'b', 'question:1'), question(2, 'a', 'question:2'), question(2, 'a', 'question:1')].sort(byQuestionRank)).toEqual([
      question(2, 'a', 'question:1'),
      question(2, 'a', 'question:2'),
      question(2, 'b', 'question:1'),
    ]);
  });
});
