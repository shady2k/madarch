/** The sentence reader: a Markdown tree and a language-aware segmenter (madarch-ztyq.11). */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFrontMatter } from '../src/knowledge/markdown.js';
import { maskInline, sentencesOf, statementsOf, unmask } from '../src/writer/sentences.js';
import fixture from './fixtures/sentence-keys-migration.json';
import { generateTrainingRepository, makeProduct, writeSamplePages } from './knowledge-fixture.js';

describe('the shared sentence reader', () => {
  test('a dotted abbreviation the language knows is not a sentence end', () => {
    const text = 'The U.S. market is large.[^market] It stays open.';
    expect(sentencesOf(maskInline(text), 'en').map((sentence) => unmask(sentence.text))).toEqual([
      'The U.S. market is large.[^market]',
      'It stays open.',
    ]);
  });

  test('a question link after a grounded sentence is its suffix, and the next fact is separate', () => {
    const question = '[→ question: Which market?](madarch:question:market)';
    const text = `The U.S. market is large.[^market] ${question} It stays open.`;
    expect(sentencesOf(maskInline(text), 'en').map((sentence) => unmask(sentence.text))).toEqual([
      `The U.S. market is large.[^market] ${question}`,
      'It stays open.',
    ]);
    const adjacent = `The U.S. market is large.[^market]${question} It stays open.`;
    expect(sentencesOf(maskInline(adjacent), 'en').map((sentence) => unmask(sentence.text))).toEqual([
      `The U.S. market is large.[^market]${question}`,
      'It stays open.',
    ]);
  });

  test('the tree gives the same statements from a list, a quote and a paragraph', () => {
    const body = [
      'The first fact stands.[^a]',
      '',
      '- A listed fact stands.[^b]',
      '',
      '> A quoted fact stands.[^c]',
      '',
      '[^a]: [A](madarch:code.symbol:src/a.ts#a)',
      '[^b]: [B](madarch:code.symbol:src/b.ts#b)',
      '[^c]: [C](madarch:code.symbol:src/c.ts#c)',
    ].join('\n');
    expect(statementsOf(body, 10, 'en').map((statement) => [statement.text, statement.line, statement.grounds])).toEqual([
      ['The first fact stands.', 10, ['code.symbol:src/a.ts#a']],
      ['A listed fact stands.', 12, ['code.symbol:src/b.ts#b']],
      ['A quoted fact stands.', 14, ['code.symbol:src/c.ts#c']],
    ]);
  });
});


describe('sentence keys on the generated training product', () => {
  test('the pages the writer wrote keep their sentence keys, text and grounds', () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-sentence-migration-'));
    try {
      const repository = generateTrainingRepository(join(work, 'repo'));
      const home = join(work, 'home');
      mkdirSync(home);
      const product = makeProduct(home, 'shop', repository);
      writeSamplePages(product);
      for (const page of fixture.pages) {
        const text = readFileSync(join(product, page.file), 'utf8');
        const { body, bodyLine } = splitFrontMatter(text);
        expect(body).toBe(page.body);
        expect(bodyLine).toBe(page.bodyLine);
        expect(statementsOf(body, bodyLine, 'en')).toEqual(page.statements);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
