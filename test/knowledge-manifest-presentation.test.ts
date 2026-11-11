/**
 * Entity cards and history pages follow the kinds manifest, not kind names in the engine (decision 0033, the owner's
 * rule that the engine holds no product data). A kind whose declaration says `card: true` shows its card where a
 * statement is grounded on it; a kind whose declaration names a `history` shape gets a history page; removing the line
 * from the manifest takes the presentation away, and restoring it brings the presentation back.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds, type KindsManifest } from '../src/product/manifest/kinds.js';
import { historyBlock } from '../src/knowledge/history.js';
import { starterKinds } from './knowledge-fixture.js';
import { buildStatement } from '../src/knowledge/statement.js';
import type { RenderContext, Subject } from '../src/knowledge/blocks.js';
import type { GraphEntity, HistoryEvidence } from '../src/knowledge/graph-read.js';

const work = mkdtempSync(join(tmpdir(), 'madarch-manifest-presentation-'));
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

/**
 * The fixture product's declarations: the Markdown page a statement is written on, two graph kinds, and a task whose
 * story the history block reads. Each list is the extra lines a test gives that kind.
 */
function manifestLines(service: readonly string[], file: readonly string[], domain: readonly string[] = [], task: readonly string[] = []): string[] {
  return [
    'kinds:',
    '  domain:',
    '    template: templates/domain.liquid',
    '    source: markdown',
    '    file: docs/domain.md',
    ...domain,
    '  code.service:',
    '    template: templates/service.liquid',
    '    source: graph',
    ...service,
    '  code.file:',
    '    template: templates/file.liquid',
    '    source: graph',
    ...file,
    '  code.task:',
    '    template: templates/task.liquid',
    '    source: graph',
    '    origin: history',
    ...task,
  ];
}

/** Writes the fixture manifest into a product folder of its own and reads it the way the wiki does. */
function readFixture(lines: readonly string[], name: string): KindsManifest {
  const folder = join(work, name);
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  for (const template of ['domain', 'service', 'file', 'task']) writeFileSync(join(folder, 'templates', `${template}.liquid`), '{% layout "./entity.liquid" %}\n');
  writeFileSync(join(folder, 'madarch', 'kinds.yaml'), `${lines.join('\n')}\n`);
  const read = readKinds(folder);
  if (!read.present) throw new Error(`the fixture manifest of ${folder} was not read`);
  if (read.manifest.findings.length > 0) throw new Error(`the fixture manifest of ${folder} has findings: ${read.manifest.findings.map((one) => `${one.file}:${one.line}: ${one.message}`).join('; ')}`);
  return read.manifest;
}

const SERVICE: GraphEntity = { key: 'code.service:payments', kind: 'code.service', label: 'payments', properties: { path: 'src/pay.ts', language: 'TypeScript' }, scope: '1', nodeIds: [] };
const FILE: GraphEntity = { key: 'code.file:src/pay.ts', kind: 'code.file', label: 'src/pay.ts', properties: { path: 'src/pay.ts' }, scope: '1', nodeIds: [] };
const AUTHOR: GraphEntity = { key: 'code.author:fixture', kind: 'code.author', label: 'Fixture Author', properties: {}, scope: '1', nodeIds: [] };
const COMMIT: GraphEntity = { key: 'code.commit:abc123', kind: 'code.commit', label: 'Charge the card', properties: { effectiveAt: '2026-01-02T00:00:00Z', merge: false }, scope: '1', nodeIds: [] };
const TASK: GraphEntity = { key: 'code.task:PAY-1', kind: 'code.task', label: 'PAY-1', properties: {}, scope: '1', nodeIds: [] };
const UNDECLARED: GraphEntity = { key: 'code.deployment:payments', kind: 'code.deployment', label: 'payments', properties: {}, scope: '1', nodeIds: [] };

const PAGE = {
  id: 'domain:payment', kind: 'domain', title: 'Payment', relates: [] as string[], producer: 'agent', sources: [] as string[], bodyLine: 1,
  file: 'docs/domains/payment.md', front: {},
  body: 'Checkout charges the card through the payments service.[^1]\n\n[^1]: [payments](madarch:code.service:payments)\n',
};
const SENTENCE = 'Checkout charges the card through the payments service.';

/** The context a page is drawn in: the fixture manifest, one Markdown page, the graph's two entities and a file's bytes. */
function context(manifest: KindsManifest, folder: string): RenderContext {
  return {
    productFolder: folder,
    manifest,
    language: 'en',
    markdown: new Map([[PAGE.id, PAGE]]),
    
    
    
    repositories: [],
    commitOf: () => null,
    repoOfScope: () => undefined,
    readSource: async (_repo: string | null, path: string) => (path === 'src/pay.ts' ? 'export class Pay {}\n' : undefined),
    resolver: {
      resolve: async (url: string) => (url === 'madarch:code.service:payments'
        ? { state: 'ok' as const, target: url, kind: 'code.service', label: 'payments', href: null, entity: SERVICE.key }
        : { state: 'broken' as const, target: url, reason: 'the fixture resolves no other address' }),
    },
    graph: {
      find: async (key: string) => ([SERVICE, FILE, AUTHOR, COMMIT, TASK, UNDECLARED].filter((one) => one.key === key)),
      // A task's commits name it in their messages, and a commit's author is the one who made it.
      neighbors: async (_entity: GraphEntity, options: { relations?: readonly string[] }) => (options.relations?.[0] === 'code.authored'
        ? [{ relation: 'code.authored', direction: 'in', total: 1, rows: [{ entity: AUTHOR, edges: 1 }] }]
        : []),
      edgesOf: async (entity: GraphEntity, relation: string, direction: string) => (entity.key === TASK.key && relation === 'code.tasks' && direction === 'in'
        ? { rows: [{ other: COMMIT, properties: {} }], total: 1 }
        : { rows: [], total: 0 }),
      reach: async () => ({ rows: [], total: 0 }),
      repositories: async () => [{ nodeId: '1', path: 'training' }],
      historyEvidence: async (): Promise<HistoryEvidence> => ({
        entities: [COMMIT, AUTHOR, FILE],
        edges: [
          { relation: 'code.authored', from: AUTHOR.key, to: COMMIT.key, properties: {} },
          { relation: 'code.touched', from: COMMIT.key, to: FILE.key, properties: { additions: 3, deletions: 1 } },
        ],
      }),
    },
  } as unknown as RenderContext;
}

describe('an entity card follows the kind declaration', () => {
  test('removing card from the kind takes the card away, and restoring it brings the card back', async () => {
    const withCard = readFixture(manifestLines(['    card: true'], []), 'with-card');
    const card = await buildStatement(context(withCard, join(work, 'with-card')), PAGE.id, SENTENCE);
    if (!card.ok) throw new Error(card.message);
    expect(card.statement.grounds[0]!.excerpt).toMatchObject({ type: 'entity', entity: { id: SERVICE.key, kind: 'code.service', label: 'payments' } });

    const withoutCard = readFixture(manifestLines([], []), 'without-card');
    const code = await buildStatement(context(withoutCard, join(work, 'without-card')), PAGE.id, SENTENCE);
    if (!code.ok) throw new Error(code.message);
    expect(code.statement.grounds[0]!.excerpt).toMatchObject({ type: 'code', location: { path: 'src/pay.ts' } });

    const restored = readFixture(manifestLines(['    card: true'], []), 'restored-card');
    const again = await buildStatement(context(restored, join(work, 'restored-card')), PAGE.id, SENTENCE);
    if (!again.ok) throw new Error(again.message);
    expect(again.statement.grounds[0]!.excerpt).toMatchObject({ type: 'entity' });
  });
});

describe('a ground on a kind the manifest does not declare', () => {
  test('shows the code, and a kind that declares card still shows the card', async () => {
    // The graph holds the service and the ground resolves to it, and the manifest shows no page for its kind.
    const undeclared = readFixture(['kinds:', '  domain:', '    template: templates/domain.liquid', '    source: markdown', '    file: docs/domain.md'], 'card-undeclared');
    const reading = await buildStatement(context(undeclared, join(work, 'card-undeclared')), PAGE.id, SENTENCE);
    if (!reading.ok) throw new Error(reading.message);
    expect(reading.statement.grounds[0]!.excerpt).toMatchObject({ type: 'code', location: { path: 'src/pay.ts' } });
  });
});

describe('a history page follows the kind declaration', () => {
  const subject: Subject = { source: 'graph', entity: FILE };

  test('removing history from the kind takes the story away, and restoring it brings the story back', async () => {
    const withStory = readFixture(manifestLines([], ['    history: path']), 'with-story');
    const told = await historyBlock(context(withStory, join(work, 'with-story')), subject, {}, 'templates/file.liquid', 1);
    if (told.type !== 'history') throw new Error(`not a history block: ${told.type}`);
    expect(told.sections.map((section) => section.role)).toContain('commits');

    const withoutStory = readFixture(manifestLines([], []), 'without-story');
    const refused = await historyBlock(context(withoutStory, join(work, 'without-story')), subject, {}, 'templates/file.liquid', 1);
    expect(refused).toMatchObject({ type: 'problem', block: 'history', message: expect.stringContaining('declares none for the kind code.file') });

    const restored = readFixture(manifestLines([], ['    history: path']), 'restored-story');
    const again = await historyBlock(context(restored, join(work, 'restored-story')), subject, {}, 'templates/file.liquid', 1);
    expect(again.type).toBe('history');
  });

  test('a kind the manifest does not declare at all has no history page, and the problem names the manifest', async () => {
    const manifest = readFixture(manifestLines([], ['    history: path']), 'undeclared');
    const refused = await historyBlock(context(manifest, join(work, 'undeclared')), { source: 'graph', entity: UNDECLARED }, {}, 'templates/file.liquid', 7);
    expect(refused).toMatchObject({
      type: 'problem', block: 'history', file: 'templates/file.liquid', line: 7,
      message: expect.stringContaining(`the manifest ${join(work, 'undeclared', 'madarch', 'kinds.yaml')} declares none for the kind code.deployment`),
    });
  });

  test('a task tells its story as the commits that name it, and a commit as the files it changed', async () => {
    const manifest = readFixture(manifestLines([], [], [], ['    history: task']), 'task-story');
    const story = await historyBlock(context(manifest, join(work, 'task-story')), { source: 'graph', entity: TASK }, {}, 'templates/history-task.liquid', 1);
    if (story.type !== 'history') throw new Error(`not a history block: ${story.type}`);
    expect(story.sections.map((section) => section.role)).toEqual(['commits']);
    expect(story.sections[0]!.rows.map((row) => row.text)).toEqual(['Charge the card']);
    expect(story.sections[0]!.rows[0]!.who).toBe('Fixture Author');
  });

  test('a Markdown page tells the repositories story of the product, and a kind that declares none is refused', async () => {
    const withStory = readFixture(manifestLines([], [], ['    history: repositories']), 'markdown-story');
    const page = { source: 'markdown' as const, entity: { kind: 'domain', id: 'domain:payment', title: 'Payment', relates: [], file: 'docs/domain.md' } } as unknown as Subject;
    const told = await historyBlock(context(withStory, join(work, 'markdown-story')), page, {}, 'templates/domain.liquid', 1);
    expect(told.type).toBe('history');

    const withoutStory = readFixture(manifestLines([], []), 'markdown-refused');
    const refused = await historyBlock(context(withoutStory, join(work, 'markdown-refused')), page, {}, 'templates/domain.liquid', 3);
    expect(refused).toMatchObject({ type: 'problem', message: expect.stringContaining('declares no "history: repositories" for the kind domain') });
  });
});

describe('the manifest reader refuses a presentation field it cannot read', () => {
  test('a history shape the block cannot tell is a finding at its line, and a card that is not true is one too', () => {
    const folder = join(work, 'broken-fields');
    mkdirSync(join(folder, 'madarch'), { recursive: true });
    mkdirSync(join(folder, 'templates'), { recursive: true });
    for (const template of ['domain', 'service', 'file', 'task']) writeFileSync(join(folder, 'templates', `${template}.liquid`), '{% layout "./entity.liquid" %}\n');
    const lines = manifestLines(['    card: yes'], ['    history: sideways']);
    writeFileSync(join(folder, 'madarch', 'kinds.yaml'), `${lines.join('\n')}\n`);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`the fixture manifest of ${folder} was not read`);
    const messages = read.manifest.findings.map((one) => `${one.file}:${one.line}: ${one.message}`);
    expect(messages).toEqual([
      `${join(folder, 'madarch', 'kinds.yaml')}:9: kind "code.service": "card" is true or absent: a ground on one of the kind's entities shows its card, and the entity's code is shown when it is absent`,
      `${join(folder, 'madarch', 'kinds.yaml')}:13: kind "code.file": "history" is the shape of the story the history block tells of the kind: repositories, author, path, membership, commit, task, got "sideways"`,
    ]);
  });
});

describe('the starter set keeps the pages it showed', () => {
  test('the kinds the starter set gives a card and a history page are the ones the engine named before', () => {
    const cards = starterKinds().filter((kind) => kind.card === true).map((kind) => kind.name);
    expect(cards).toEqual(['code.service', 'code.package', 'code.operation', 'code.contract', 'code.channel', 'code.message', 'code.database', 'code.table']);
    const stories = starterKinds().filter((kind) => kind.history !== undefined).map((kind) => `${kind.name}: ${kind.history}`);
    expect(stories).toEqual([
      'product: repositories',
      'code.service: membership',
      'code.package: membership',
      'code.module: membership',
      'code.file: path',
      'code.commit: commit',
      'code.author: author',
      'code.task: task',
      'code.repository: repositories',
    ]);
  });
});
