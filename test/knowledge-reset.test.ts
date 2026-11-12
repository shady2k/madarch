import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReset, planReset } from '../src/knowledge/reset.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { FakeGraph } from './fake-graph.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-reset-')); folders.push(folder);
  const product = join(folder, 'product'); const store = join(folder, 'store');
  mkdirSync(product); mkdirSync(store); seedStarterSet(product);
  const graph = new FakeGraph();
  const file = 'docs/product.md'; mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, file), 'arbitrary bytes, never parsed');
  graph.add('product:sample', 'product', 'Sample', { title: 'Sample', slug: 'sample', file, body: '', body_line: 1, producer: 'agent', relates: [], sources: [], statements: [], mentions: [], digest: 'fixture-digest', links: [], findings: [], ungrounded: [] });
  const read = await readKinds(product);
  if (!read.present) throw new Error('fixture manifest is absent');
  return { product, store, graph, manifest: read.manifest, file };
}

test('reset selects agent pages from graph opinions, not file contents', async () => {
  const f = await fixture();
  const plan = await planReset(f.product, f.store, f.graph.reader(), f.manifest);
  expect(plan.agentPages).toEqual([f.file]);
  await applyReset(f.product, plan);
  expect(existsSync(join(f.product, f.file))).toBe(false);
});

test('a changed file invalidates the preview before any removal', async () => {
  const f = await fixture();
  const storePart = join(f.store, 'graph'); mkdirSync(storePart);
  const plan = await planReset(f.product, f.store, f.graph.reader(), f.manifest);
  const changed = 'a person changed this after the preview';
  writeFileSync(join(f.product, f.file), changed);
  await expect(applyReset(f.product, plan)).rejects.toThrow('changed since');
  expect(readFileSync(join(f.product, f.file), 'utf8')).toBe(changed);
  expect(existsSync(storePart)).toBe(true);
});

test('a modified preview cannot authorize deletion', async () => {
  const f = await fixture();
  const storePart = join(f.store, 'graph'); mkdirSync(storePart);
  const keptFile = 'docs/vision.md'; writeFileSync(join(f.product, keptFile), 'a person wrote this');
  const plan = await planReset(f.product, f.store, f.graph.reader(), f.manifest);
  plan.agentPages.push(keptFile);
  await expect(applyReset(f.product, plan)).rejects.toThrow(`${f.product}:1:`);
  expect(existsSync(join(f.product, keptFile))).toBe(true);
  expect(existsSync(join(f.product, f.file))).toBe(true);
  expect(existsSync(storePart)).toBe(true);
});

test('a copied plan cannot delete a page', async () => {
  const f = await fixture();
  const storePart = join(f.store, 'graph'); mkdirSync(storePart);
  const plan = await planReset(f.product, f.store, f.graph.reader(), f.manifest);
  await expect(applyReset(f.product, { ...plan })).rejects.toThrow('not a validated local plan');
  expect(existsSync(join(f.product, f.file))).toBe(true);
  expect(existsSync(storePart)).toBe(true);
});

test('an answered question is kept and an explicit agent open question is removed', async () => {
  const f = await fixture();
  for (const status of ['open', 'answered']) {
    const slug = status; const file = `docs/questions/${slug}.md`;
    mkdirSync(join(f.product, 'docs/questions'), { recursive: true }); writeFileSync(join(f.product, file), 'not parsed');
    f.graph.add(`question:${slug}`, 'question', slug, { slug, file, status, language: 'en', type: 'gap', producer: 'agent', about: [], asked_in: null, asked_at: null, question: 'Unknown?', why: 'Needed.', sides: [], resolved_by: [], resolved_at: null, written_at: [], answer: status === 'open' ? null : { text: 'yes', by: { name: 'Ada', email: 'ada@example.test', verified: 'local' }, at: '2026-10-23T11:00:00Z' } });
  }
  const plan = await planReset(f.product, f.store, f.graph.reader(), f.manifest);
  expect(plan.keptAnswers).toEqual(['docs/questions/answered.md']);
  expect(plan.unansweredQuestions).toEqual(['docs/questions/open.md']);
  await applyReset(f.product, plan);
  expect(existsSync(join(f.product, 'docs/questions/answered.md'))).toBe(true);
  expect(existsSync(join(f.product, 'docs/questions/open.md'))).toBe(false);
});

test('a graph page linked outside the product is refused before deletion', async () => {
  const f = await fixture();
  const outside = join(f.store, 'outside.md'); writeFileSync(outside, 'outside');
  rmSync(join(f.product, f.file)); symlinkSync(outside, join(f.product, f.file));
  await expect(planReset(f.product, f.store, f.graph.reader(), f.manifest)).rejects.toThrow('outside the product');
  expect(existsSync(outside)).toBe(true);
});

test('store paths outside the expected root are refused', async () => {
  const f = await fixture();
  await expect(planReset(f.product, f.store, f.graph.reader(), f.manifest, join(f.product, 'knowledge'))).rejects.toThrow('not inside the knowledge root');
});

test('keepQuestions and keepStore preserve those paths while resetting agent pages', async () => {
  const f = await fixture(); const storePart = join(f.store, 'graph'); mkdirSync(storePart);
  const file = 'docs/questions/open.md'; mkdirSync(join(f.product, 'docs/questions'), { recursive: true });
  writeFileSync(join(f.product, file), 'question bytes');
  f.graph.add('question:open', 'question', 'Open?', { slug: 'open', file, status: 'open', language: 'en', type: 'gap', producer: 'agent', about: [], asked_in: null, asked_at: null, question: 'Unknown?', why: 'Needed.', sides: [], resolved_by: [], resolved_at: null, written_at: [], answer: null });
  const plan = await planReset(f.product, f.store, f.graph.reader(), f.manifest);
  await applyReset(f.product, plan, { keepQuestions: true, keepStore: true });
  expect(existsSync(join(f.product, file))).toBe(true);
  expect(existsSync(storePart)).toBe(true);
  expect(existsSync(join(f.product, f.file))).toBe(false);
});

test('a file changed while the store resets is kept rather than deleted', async () => {
  const f = await fixture();
  const plan = await planReset(f.product, f.store, f.graph.reader(), f.manifest);
  const changed = 'a person changed this while the store reset';
  await expect(applyReset(f.product, plan, { resetStore: async () => {
    writeFileSync(join(f.product, f.file), changed);
  } })).rejects.toThrow(`${join(f.product, f.file)}:1:`);
  expect(readFileSync(join(f.product, f.file), 'utf8')).toBe(changed);
});
