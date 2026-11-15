/**
 * «Создать задачу» on the Problems page (madarch-64o5.104, the owner's rule of 2026-11-13): the problem becomes a task
 * entity of the starter catalogue's task kind through the one write path MCP and the agent use, and the write's source is
 * the person who pressed. The task names its problem, its place and its statement; the page links to it, and a second
 * press answers that task instead of writing another — one task per problem, even when two presses run at once, and a
 * problem whose identity holds a separator the store cannot carry still gets its task.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createDraft } from '../src/product/draft.js';
import { retainTestStorePreparationOwner } from './prepared-server.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { generatedTableName } from '../src/graph/contract.js';
import { LoopRefusal } from '../src/loop/answer.js';
import { problemTaskRecord, problemTaskUid } from '../src/loop/problem-task.js';
import type { Problem } from '../src/loop/views.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { testAgentBinding } from './host-binding-fixture.js';
import { readPublishedManifest } from '../src/graph/manifest-publication.js';
import { writeContractOf } from '../src/graph/graph-writes.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-problem-task-'));
const env = gitEnv(SAMPLE_IDENTITY);
let folder = '';
let home = '';
let closePreparationOwner: (() => Promise<void>) | undefined;
let largeFile: Problem;
let otherLargeFile: Problem;
let thirdLargeFile: Problem;
let sqlInput: Problem;

/** One conversation the fixture's writes rest on: a write names its evidence, whoever makes it. */
const evidence = [{ type: 'conversation', id: 'fixture', words: 'A file of 731 lines stands in the fixture graph.' }];
/** Where the fixture's SQL facts stand: an opinion names the file line it was read at. */
const place = { type: 'file', path: 'src/checkout.ts', commit: 'deadbeef', lineStart: 12 };

/** One fixture kind: a graph-kind declaration with the fields it is written through. */
const kind = (fields: readonly Record<string, unknown>[], key?: readonly string[]): Record<string, unknown> => ({
  source: 'graph', ...(key === undefined ? {} : { key }), fields,
});

/**
 * The product's own catalogue, as a fixture: the six kinds these cases write and the two rules they read, instead of the
 * starter set's 526 kinds. The store's schema is the manifest's, so a small manifest is a store opened in seconds.
 */
function fixtureCatalogue(product: string): void {
  const text = stringify({
    problems: {
      thresholds: { largeFileLines: 600, hotspotLines: 200, hotspotCommits: 10, hotspotScore: 10000 },
      rules: {
        'large-file': { predicate: 'large-file', kind: 'large-file', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', label: { en: 'Large file', ru: 'Большой файл' } },
        'security.sql-input': { predicate: 'sql-input', kind: 'sql-input', sonar: 'vulnerability', severity: 'blocker', section: 'code', action: 'task', label: { en: 'Untrusted input reaches SQL', ru: 'Внешние данные попадают в SQL' } },
      },
    },
    edges: [
      { name: 'code.contains', from: ['code.repository'], to: ['code.file'], capability: 'disk', labels: { en: { out: 'contains', in: 'is in' }, ru: { out: 'содержит', in: 'входит в' } } },
      { name: 'code.flows-into', from: ['code.input', 'code.sql-build'], to: ['code.sql-build', 'code.sql-sink'], capability: 'analysis', labels: { en: { out: 'flows into', in: 'receives' }, ru: { out: 'передаёт', in: 'получает' } } },
    ],
    kinds: {
      task: kind([
        { name: 'title', type: 'text', producers: ['person'] },
        { name: 'body', type: 'text', nullable: true, producers: ['person'] },
        { name: 'front', type: 'json', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: true }, nullable: true, producers: ['person'] },
      ]),
      'code.repository': kind([
        { name: 'name', type: 'text', producers: ['disk'] },
        { name: 'url', type: 'text', nullable: true, producers: ['disk'] },
      ], ['name']),
      // A file is declared with the columns the engine's records layer reads (its opinions, its bytes and its form), so
      // the fixture is a product whose file kind is the starter one's shape, without the rest of the catalogue.
      'code.file': kind([
        { name: 'repository', type: 'text', producers: ['disk'] },
        { name: 'path', type: 'text', producers: ['disk'] },
        { name: 'mode', type: 'text', nullable: true, producers: ['disk'] },
        { name: 'blob', type: 'text', nullable: true, producers: ['disk'] },
        { name: 'bytes', type: 'bigint', nullable: true, producers: ['disk'] },
        { name: 'form', type: 'text', nullable: true, producers: ['disk'] },
        { name: 'lines', type: 'bigint', nullable: true, producers: ['disk'] },
        { name: 'content', type: 'text', nullable: true, producers: ['disk'] },
        { name: 'language', type: 'text', nullable: true, producers: ['disk'] },
        { name: 'languages', type: 'json', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: true }, nullable: true, producers: ['disk'] },
        { name: 'class', type: 'text', nullable: true, producers: ['disk'] },
      ], ['repository', 'path']),
      'code.input': kind([
        { name: 'name', type: 'text', producers: ['analysis'] },
        { name: 'source_text', type: 'text', nullable: true, producers: ['analysis'] },
      ], ['name']),
      'code.sql-build': kind([
        { name: 'name', type: 'text', producers: ['analysis'] },
        { name: 'source_text', type: 'text', nullable: true, producers: ['analysis'] },
      ], ['name']),
      'code.sql-sink': kind([
        { name: 'name', type: 'text', producers: ['analysis'] },
        { name: 'source_text', type: 'text', nullable: true, producers: ['analysis'] },
      ], ['name']),
    },
  });
  writeFolderManifest(product, text);
}

beforeAll(async () => {
  home = join(root, 'products');
  const draft = createDraft({ home, name: 'problem-task', gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  folder = draft.folder;
  fixtureCatalogue(folder);
  closePreparationOwner = await retainTestStorePreparationOwner();
  const product = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home), env });
  try {
    // One 731-line file in the graph, as a fill would leave it: the large-file problem stands on the page.
    await product.problems();
    const fixtureOwner = await (product as unknown as { open(): ReturnType<typeof storeOf> }).open();
    const published = await fixtureOwner.transaction('snapshot', readPublishedManifest);
    if (published === undefined) throw new Error('fixture manifest missing');
    const source = await testAgentBinding(fixtureOwner, writeContractOf(published), 'problem-fixture');
    await product.putEntity(source, {
      kind: 'code.repository', key: { name: 'product' }, values: { url: 'https://example.test/product' }, evidence,
    });
    await product.putEntity(source, {
      kind: 'code.file', key: { repository: 'product', path: 'src/big.ts' }, values: { lines: 731 }, evidence,
    });
    for (const [path, lines] of [['src/huge.ts', 700], ['src/third.ts', 640]] as const) {
      await product.putEntity(source, { kind: 'code.file', key: { repository: 'product', path }, values: { lines }, evidence });
    }
    for (const path of ['src/big.ts', 'src/huge.ts', 'src/third.ts']) {
      await product.putEdge(source, {
        kind: 'code.contains', from: { kind: 'code.repository', key: { name: 'product' } }, to: { kind: 'code.file', key: { repository: 'product', path } }, evidence,
      });
    }
    // An input reaching a builder reaching a sink: the finding whose identity names two of them.
    const write = async (kind: string, name: string) => await product.putEntity(source, {
      kind, key: { name }, values: { source_text: `${name} text` }, evidence: [place],
    });
    const input = await write('code.input', 'search text');
    const build = await write('code.sql-build', 'checkout query');
    const sink = await write('code.sql-sink', 'checkout execute');
    for (const [from, to] of [[input, build], [build, sink]] as const) {
      await product.putEdge(source, { kind: 'code.flows-into', from: { kind: from.kind, id: from.uid }, to: { kind: to.kind, id: to.uid }, evidence: [place] });
    }
    const listing = await product.problems();
    const large = listing.problems.filter((candidate) => candidate.rule === 'large-file');
    const sql = listing.problems.find((candidate) => candidate.rule === 'security.sql-input');
    if (large.length !== 3 || sql === undefined) throw new Error(`the fixture's problems did not stand: ${JSON.stringify(listing.problems.map((one) => [one.rule, one.file]))}`);
    largeFile = large.find((candidate) => candidate.file === 'src/big.ts')!;
    otherLargeFile = large.find((candidate) => candidate.file === 'src/huge.ts')!;
    thirdLargeFile = large.find((candidate) => candidate.file === 'src/third.ts')!;
    sqlInput = sql;
  } finally {
    await product.close();
  }
}, 180_000);

afterAll(async () => {
  try { await closePreparationOwner?.(); } finally { rmSync(root, { recursive: true, force: true }); }
});

/** The store's own connection, for the rows the page's answers are read back from. */
async function storeOf(): Promise<Awaited<ReturnType<typeof createDatabaseOwner>>> {
  return await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))), connectOnly: true });
}

/** The product, opened for one test. */
function open(): KnowledgeProduct {
  return new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home), env });
}

test('a problem becomes one task with the person as its source and the page links to it', async () => {
  const product = open();
  let owner: Awaited<ReturnType<typeof storeOf>> | undefined;
  try {
    owner = await storeOf();
    const first = await product.createProblemTask(largeFile.id);
    expect(first.state).toBe('created');
    expect(first.task.href).toMatch(/^\/e\/task\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(first.task.label).toBe('Fix: Large file — src/big.ts:1');

    // The write is the person's, the journal keeps it, and the task carries the problem, its place and its statement.
    const opinions = await owner.run((tx) => tx.query<{ said_by: string; title: string; body: string; front: Record<string, unknown> }>(
      `SELECT said_by, title, body, front FROM "${generatedTableName('task', 'vertex')}" WHERE state = 'open' AND front->>'file' = 'src/big.ts'`,
    ));
    expect(opinions.rows).toHaveLength(1);
    expect(opinions.rows[0]!.said_by).toMatch(/^person:[0-9a-f-]+@1$/u);
    expect(opinions.rows[0]!.title).toBe('Fix: Large file — src/big.ts:1');
    expect(opinions.rows[0]!.front).toEqual({
      rule: 'large-file', identity: ['code.file:product/src/big.ts'], file: 'src/big.ts', line: 1,
      statement: '731 lines, over the 600-line threshold.', scope: { type: 'file', path: 'src/big.ts' },
    });
    const journal = await owner.run((tx) => tx.query<{ author: string; words: string }>("SELECT author, words FROM operation WHERE words = 'Create a task' ORDER BY seq DESC LIMIT 1"));
    expect(journal.rows[0]!.author).toBe(opinions.rows[0]!.said_by);
    expect(journal.rows[0]!.words).toBe('Create a task');

    // The listing the page draws links the problem to its task, and a second press opens that same task.
    const after = await product.problems();
    expect(after.problems.find((candidate) => candidate.id === largeFile.id)?.task).toEqual({
      label: 'Fix: Large file — src/big.ts:1', href: first.task.href, key: first.task.key,
    });
    expect(await product.createProblemTask(largeFile.id)).toEqual({ task: first.task, state: 'existing' });
    const count = await owner.run((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${generatedTableName('task', 'vertex')}" WHERE front->>'file' = 'src/big.ts'`));
    expect(count.rows[0]!.n).toBe('1');
  } finally {
    await owner?.close();
    await product.close();
  }
}, 30_000);

test('two presses of one problem at once write one task and one journal entry', async () => {
  const product = open();
  let owner: Awaited<ReturnType<typeof storeOf>> | undefined;
  try {
    owner = await storeOf();
    const before = await owner.run((tx) => tx.query<{ n: string }>("SELECT count(*)::text AS n FROM operation WHERE words = 'Create a task'"));
    // Both presses read no task, as two tabs of the page do: the write names the task's uid, so they meet on one entity.
    const answers = await Promise.all([product.createProblemTask(otherLargeFile.id), product.createProblemTask(otherLargeFile.id)]);
    expect(new Set(answers.map((answer) => answer.task.href)).size).toBe(1);
    expect(answers.map((answer) => answer.state).sort()).toEqual(['created', 'existing']);
    const tasks = await owner.run((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${generatedTableName('task', 'vertex')}" WHERE state = 'open' AND front->>'file' = 'src/huge.ts'`));
    expect(tasks.rows[0]!.n).toBe('1');
    const after = await owner.run((tx) => tx.query<{ n: string }>("SELECT count(*)::text AS n FROM operation WHERE words = 'Create a task'"));
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(1);
    const linked = (await product.problems()).problems.find((candidate) => candidate.id === otherLargeFile.id)?.task;
    expect(linked?.href).toBe(answers[0]!.task.href);
  } finally {
    await owner?.close();
    await product.close();
  }
}, 30_000);

test('a problem whose identity holds the store\'s separator still gets its task, naming the identity back', async () => {
  const product = open();
  let owner: Awaited<ReturnType<typeof storeOf>> | undefined;
  try {
    owner = await storeOf();
    // The identity names the sink and the builder, joined by the separator a stored text cannot hold.
    expect(sqlInput.identity).toContain('\u0000');
    expect(sqlInput.identity.split('\u0000')).toHaveLength(2);
    const made = await product.createProblemTask(sqlInput.id);
    expect(made.state).toBe('created');
    const rows = await owner.run((tx) => tx.query<{ front: Record<string, unknown> }>(`SELECT front FROM "${generatedTableName('task', 'vertex')}" WHERE state = 'open' AND front->>'rule' = 'security.sql-input'`));
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows[0]!.front)).not.toContain('\u0000');
    const parts = rows.rows[0]!.front['identity'] as string[];
    expect(parts).toHaveLength(2);
    expect(parts.join('\u0000')).toBe(sqlInput.identity);
    expect((await product.problems()).problems.find((candidate) => candidate.id === sqlInput.id)?.task?.href).toBe(made.task.href);
  } finally {
    await owner?.close();
    await product.close();
  }
}, 30_000);

test('a descriptive git name does not become the host person identity, and two presses write once', async () => {
  const product = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home), env: gitEnv({ ...SAMPLE_IDENTITY, GIT_AUTHOR_NAME: 'Alice@work' }) });
  let owner: Awaited<ReturnType<typeof storeOf>> | undefined;
  try {
    owner = await storeOf();
    const before = await owner.run((tx) => tx.query<{ n: string }>("SELECT count(*)::text AS n FROM operation WHERE words = 'Create a task'"));
    const answers = await Promise.all([product.createProblemTask(thirdLargeFile.id), product.createProblemTask(thirdLargeFile.id)]);
    expect(new Set(answers.map((answer) => answer.task.href)).size).toBe(1);
    const rows = await owner.run((tx) => tx.query<{ said_by: string }>(`SELECT said_by FROM "${generatedTableName('task', 'vertex')}" WHERE state = 'open' AND front->>'file' = 'src/third.ts'`));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.said_by).toMatch(/^person:[0-9a-f-]+@1$/u);
    const after = await owner.run((tx) => tx.query<{ n: string }>("SELECT count(*)::text AS n FROM operation WHERE words = 'Create a task'"));
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(1);
  } finally {
    await owner?.close();
    await product.close();
  }
}, 30_000);

test('a problem the page no longer lists is refused in the reader\'s words, naming no path of this machine', async () => {
  const product = open();
  try {
    for (const language of ['en', 'ru'] as const) {
      const refused = await product.createProblemTask(`large-file\u0000gone${language}`).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LoopRefusal);
      expect((refused as LoopRefusal).message).not.toContain(folder);
    }
  } finally {
    await product.close();
  }
}, 30_000);

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
  expect(ru.front['identity']).toEqual(['code.file:product/src/big.ts']);
  const en = problemTaskRecord(problem, { language: 'en', label: { en: 'Large file' } });
  expect(en.title).toBe('Fix: Large file — src/big.ts:1');
  expect(en.body).toBe('Rule: Large file\nPlace: src/big.ts:1\nWhat is wrong: 731 lines, over the 600-line threshold.');
  // The uid is the problem's own: the same problem names the same task, and another problem names another.
  expect(problemTaskUid(problem)).toBe(problemTaskUid({ ...problem }));
  expect(problemTaskUid(problem)).not.toBe(problemTaskUid({ ...problem, identity: 'code.file:product/src/other.ts' }));
  expect(problemTaskUid(problem)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
