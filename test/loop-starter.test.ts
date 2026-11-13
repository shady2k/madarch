import { starterManifestText } from './catalog-folder-fixture.js';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { renderPage } from '../src/knowledge/render.js';
import { Resolver } from '../src/knowledge/resolve.js';
import { FakeGraph } from './fake-graph.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { manifestContractOf } from '../src/fill/stages/plugin-contract.js';
import { createTestDatabaseOwner } from './test-database.js';
import type { RenderContext } from '../src/knowledge/blocks.js';

const folder = mkdtempSync(join(tmpdir(), 'madarch-loop-starter-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
for (const file of STARTER_FILES) {
  const path = join(folder, file.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.bytes ?? file.content);
}
const manifest = parseKinds(starterManifestText(), 'madarch/catalog.yaml', folder);

test('the loop kinds declare complete authored contracts and explicit import locations', () => {
  expect(manifest.findings).toEqual([]);
  for (const name of ['question', 'correction', 'task']) {
    const kind = manifest.kinds.get(name)!;
    expect(kind.source).toBe('graph');
    expect(kind.origin).toBe('person');
    expect(kind.folder).toBeUndefined();
    expect(kind.key).toBeUndefined();
    expect(manifestContractOf(manifest).vertex.find((vertex) => vertex.name === name)?.key).toEqual([]);
    expect(kind.importFolder).toBe(`docs/${name}s`);
    for (const field of kind.fields!) expect(field.line).toBeGreaterThan(0);
    expect(kind.fields!.map(({ line: _line, ...field }) => field)).toEqual([
      { name: 'legacy_id', type: 'text', nullable: true, producers: ['person'] },
      { name: 'title', type: 'text', producers: ['person'] },
      { name: 'body', type: 'text', nullable: true, producers: ['person'] },
      { name: 'front', type: 'json', nullable: true, producers: ['person'] },
    ]);
  }
  const dismissal = manifest.kinds.get('problem-dismissal')!;
  expect(dismissal.source).toBe('graph');
  expect(dismissal.origin).toBe('person');
  expect(dismissal.folder).toBeUndefined();
  expect(dismissal.key).toEqual(['rule', 'identity']);
  expect(dismissal.fields!.map((field) => field.name)).toEqual(['rule', 'identity', 'place', 'dismissal_reason', 'by', 'at', 'file']);
  for (const field of dismissal.fields!) {
    expect(field.binding?.kind).toBe('agent');
    if (field.binding?.kind === 'agent') expect(field.binding.description).toContain('docs/problems/**/*.md');
  }
});

test('document and template opinions declare complete structured content rather than a raw reader', () => {
  for (const [name, fields, source] of [
    ['source', ['repository', 'path', 'source_text', 'commit'], '**/*'],
    ['document', ['commit', 'path', 'repository', 'markdown', 'anchors', 'links'], '**/*.md'],
    ['template', ['path', 'template_parts'], 'templates/**/*.liquid'],
  ] as const) {
    const kind = manifest.kinds.get(name)!;
    expect(kind.source).toBe('graph');
    expect(kind.fields!.map((field) => field.name)).toEqual([...fields]);
    for (const field of kind.fields!) {
      if (name === 'template') expect(field.producers).toEqual(['manifest']);
      else expect(field.binding?.kind).toBe('agent');
      if (field.binding?.kind === 'agent') expect(field.binding.description).toContain(source);
    }
  }
  expect(manifest.kinds.get('document')!.fields!.find((field) => field.name === 'repository')).toMatchObject({ type: 'text', nullable: true });
  expect(manifest.kinds.get('template')!.key).toEqual(['path']);
  expect(manifest.kinds.get('template')!.fields!.find((field) => field.name === 'template_parts')).toMatchObject({ type: 'json' });
});

test('loop pages show structured graph opinions without reading loop Markdown files', async () => {
  const fake = new FakeGraph();
  fake.add('question:limit', 'question', 'Which limit?', {
    question: 'Which limit applies?', why: 'The two sources disagree.', status: 'answered',
    sides: [{ claim: 'The declared limit is ten.', grounds: ['question:limit'] }],
    answer: { text: 'Use twenty.', by: { name: 'Reader', email: 'reader@example.test', verified: 'local' }, at: '2026-11-11T00:00:00Z' },
  });
  fake.add('correction:limit', 'correction', 'Wrong limit', {
    statement: 'The limit is ten.', correction_reason: 'The limit was raised.', status: 'open',
    about: 'product:example#limit', by: { name: 'Reader', email: 'reader@example.test', verified: 'local' }, at: '2026-11-11T00:00:00Z',
  });
  for (const kind of ['question', 'correction']) {
    const template = manifest.kinds.get(kind)!.template;
    fake.add(`template:${template}`, 'template', template, {
      template_parts: [{ type: 'block', name: 'properties', params: { title: 'Details' }, line: 2 }],
    });
  }
  const graph = fake.reader();
  const markdown = new Map();
  const ctx: RenderContext = {
    productFolder: folder, manifest, graph, markdown,
    language: 'en', repositories: [], commitOf: () => null,
    repoOfScope: () => undefined, readSource: async () => undefined,
    resolver: new Resolver({ graph, markdown, declared: (kind) => manifest.kinds.has(kind), documentKinds: [], repositories: () => [], locate: () => undefined }),
  };
  for (const [id, expected] of [
    ['question:limit', ['Which limit applies?', 'The two sources disagree.', 'The declared limit is ten.', 'Use twenty.']],
    ['correction:limit', ['The limit is ten.', 'The limit was raised.']],
  ] as const) {
    const result = await renderPage(ctx, id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.page.findings).toEqual([]);
    const text = result.page.blocks.filter((block) => block.type === 'properties').flatMap((block) => block.rows.map((row) => row.value)).join('\n');
    for (const word of expected) expect(text).toContain(word);
    expect(result.page.blocks.find((block) => block.type === 'properties')).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ name: 'status' })]) });
  }
});


test('the starter opinion contract creates real PostgreSQL tables without reserved-column collisions', async () => {
  const contract = manifestContractOf(manifest);
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(contract) });
  try {
    await createOneGraphSchema(owner, withManifestContract(contract));
  } finally {
    await owner.close();
  }
}, 60_000);
