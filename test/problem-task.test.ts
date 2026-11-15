/**
 * «Создать задачу» on the Problems page (madarch-64o5.104, the owner's rule of 2026-11-13): the problem becomes a task
 * entity of the starter catalogue's task kind through the one write path MCP and the agent use, and the write's source is
 * the person who pressed. The task names its problem, its place and its statement; the page links to it, and a second
 * press answers that task instead of writing another.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { withStorePreparationOwner } from '../src/product/store-preparation.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf } from '../src/product/store.js';
import { generatedTableName } from '../src/graph/contract.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { LoopRefusal } from '../src/loop/answer.js';
import { problemTaskRecord } from '../src/loop/problem-task.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-problem-task-'));
const env = gitEnv(SAMPLE_IDENTITY);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A product of the starter set with one file over the large-file threshold, as a fill would leave it in the graph. */
async function fixture(): Promise<{ folder: string; home: string }> {
  const home = join(root, `products-${String(Date.now())}`);
  const draft = createDraft({ home, name: 'problem-task', gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  return { folder: draft.folder, home };
}

/** One conversation the fixture's writes rest on: a write names its evidence, whoever makes it. */
const evidence = [{ type: 'conversation', id: 'fixture', words: 'A file of 731 lines stands in the fixture graph.' }];

test('a problem becomes one task with the person as its source and the page links to it', async () => {
  const { folder, home } = await fixture();
  await withStorePreparationOwner(async () => {
    const product = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home), env });
    try {
      // The store and the published manifest stand before the facts: the fixtures write through the same path the page does.
      await product.problems();
      await product.putEntity({ producer: 'fixture', version: '1' }, {
        kind: 'code.repository', key: { name: 'product' }, values: { url: 'https://example.test/product' }, evidence,
      });
      await product.putEntity({ producer: 'fixture', version: '1' }, {
        kind: 'code.file', key: { repository: 'product', path: 'src/big.ts' }, values: { lines: 731 }, evidence,
      });
      await product.putEdge({ producer: 'fixture', version: '1' }, {
        kind: 'code.contains', from: { kind: 'code.repository', key: { name: 'product' } }, to: { kind: 'code.file', key: { repository: 'product', path: 'src/big.ts' } }, evidence,
      });
      const listing = await product.problems();
      const problem = listing.problems.find((candidate) => candidate.rule === 'large-file');
      expect(problem).toBeDefined();
      if (problem === undefined) return;

      const first = await product.createProblemTask(problem.id);
      expect(first.state).toBe('created');
      expect(first.task.href).toMatch(/^\/e\/task\/[0-9a-f-]+$/);
      expect(first.task.label).toBe('Fix: Large file — src/big.ts:1');

      // The write is the person's, the journal keeps it, and the task carries the problem, its place and its statement.
      const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))), connectOnly: true });
      try {
        const opinions = await owner.run((tx) => tx.query<{ said_by: string; title: string; body: string; front: Record<string, unknown> }>(
          `SELECT said_by, title, body, front FROM "${generatedTableName('task', 'vertex')}" WHERE state = 'open'`,
        ));
        expect(opinions.rows).toHaveLength(1);
        expect(opinions.rows[0]!.said_by.split('@')[0]).toBe('person');
        expect(opinions.rows[0]!.title).toBe('Fix: Large file — src/big.ts:1');
        expect(opinions.rows[0]!.front).toEqual({
          rule: 'large-file', identity: 'code.file:product/src/big.ts', file: 'src/big.ts', line: 1,
          statement: '731 lines, over the 600-line threshold.', scope: { type: 'file', path: 'src/big.ts' },
        });
        const journal = await owner.run((tx) => tx.query<{ author: string; words: string }>('SELECT author, words FROM operation ORDER BY seq DESC LIMIT 1'));
        expect(journal.rows[0]!.author).toBe('person@Fixture <fixture@example.test>');
        expect(journal.rows[0]!.words).toBe('Create a task');

        // The listing the page draws links the problem to its task, and a second press opens that same task.
        const after = await product.problems();
        expect(after.problems.find((candidate) => candidate.id === problem.id)?.task).toEqual({
          label: 'Fix: Large file — src/big.ts:1', href: first.task.href, key: first.task.key,
        });
        const second = await product.createProblemTask(problem.id);
        expect(second).toEqual({ task: first.task, state: 'existing' });
        const count = await owner.run((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${generatedTableName('task', 'vertex')}"`));
        expect(count.rows[0]!.n).toBe('1');
      } finally {
        await owner.close();
      }
    } finally {
      await product.close();
    }
  });

  // A problem the page no longer lists is refused in the reader's words, and no file of this machine is named.
  await withStorePreparationOwner(async () => {
    const product = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home), env });
    try {
      const refused = await product.createProblemTask('large-file\u0000gone').catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LoopRefusal);
      expect((refused as LoopRefusal).message).toBe('The problem is no longer on the page: its rule, its place or its inputs changed. Reload the page.');
      expect((refused as LoopRefusal).message).not.toContain(folder);
    } finally {
      await product.close();
    }
  });
}, 120_000);

test('the task says what has to change in the product\'s own language', () => {
  const problem = {
    id: 'large-file\u0000code.file:product/src/big.ts', identity: 'code.file:product/src/big.ts', section: 'code' as const,
    rule: 'large-file', kind: 'large-file', sonar: 'code-smell' as const, severity: 'minor' as const,
    fixer: 'person' as const, closed: false,
    place: { label: 'src/big.ts:1', href: '/src?path=src%2Fbig.ts&line=1', key: null }, entity: null, evidence: [],
    page: null, pageTitle: null, statement: null, sentence: null, target: null,
    reason: 'src/big.ts is 731 lines long, over the product\'s 600-line threshold: one module holds too much to change safely.',
    words: { en: '731 lines, over the 600-line threshold.', ru: '731 строка при пороге 600.' },
    file: 'src/big.ts', line: 1, by: null, at: null, scope: { type: 'file' as const, path: 'src/big.ts' },
  };
  const ru = problemTaskRecord(problem, { language: 'ru', label: { en: 'Large file', ru: 'Большой файл' } });
  expect(ru.title).toBe('Исправить: Большой файл — src/big.ts:1');
  expect(ru.body).toBe('Правило: Большой файл\nМесто: src/big.ts:1\nЧто не так: 731 строка при пороге 600.');
  expect(ru.front['statement']).toBe('731 строка при пороге 600.');
  const en = problemTaskRecord(problem, { language: 'en', label: { en: 'Large file' } });
  expect(en.title).toBe('Fix: Large file — src/big.ts:1');
  expect(en.body).toBe('Rule: Large file\nPlace: src/big.ts:1\nWhat is wrong: 731 lines, over the 600-line threshold.');
});
