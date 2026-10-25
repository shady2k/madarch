/**
 * Starting a product's knowledge over (madarch-m38l.4, remark 12): what goes and what stays, the same words from the
 * command and the wiki, and nothing of a person's removed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCorrection, parseQuestion, renderCorrection, renderQuestion } from '../src/loop/entities.js';
import { applyReset, planReset } from '../src/knowledge/reset.js';
import { storeFolderOf } from '../src/knowledge/product.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { setKindsLanguage } from '../src/knowledge/kinds.js';
import { describeReset } from '../src/product/cli.js';

let root: string | undefined;
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined; });

const page = (producer: string): string => `---\nid: x\nkind: domain\ntitle: X\nrelates: []\nproducer: ${producer}\nsources: []\n---\n\nText.[^1]\n`;

function fixture(): { product: string; store: string } {
  root = mkdtempSync(join(tmpdir(), 'madarch-reset-'));
  const product = join(root, 'product');
  const store = join(root, 'store');
  mkdirSync(join(product, 'docs', 'domains'), { recursive: true });
  mkdirSync(join(product, 'repos', 'code'), { recursive: true });
  writeFileSync(join(product, 'docs', 'product.md'), page('agent'));
  writeFileSync(join(product, 'docs', 'domains', 'payments.md'), page('agent'));
  writeFileSync(join(product, 'docs', 'domains', 'mine.md'), page('person'));
  writeFileSync(join(product, 'docs', 'vision.md'), '# My vision\n');
  writeFileSync(join(product, 'repos', 'code', 'a.ts'), 'export {};\n');
  for (const folder of ['graph', 'read/3']) { mkdirSync(join(store, folder), { recursive: true }); writeFileSync(join(store, folder, 'f'), 'x'); }
  writeFileSync(join(store, 'last-fill.json'), '{}');
  writeFileSync(join(store, 'writer.json'), '{"agent":"codex"}');
  return { product, store };
}

describe('starting over', () => {
  test('removes the graph store and the pages the agent wrote, and keeps a person\'s pages, the vision, the code and the agent choice', () => {
    const { product, store } = fixture();
    const plan = planReset(product, store);
    expect(plan.agentPages).toEqual(['docs/product.md', 'docs/domains/payments.md']);
    expect(plan.keptPages).toEqual(['docs/domains/mine.md']);
    applyReset(product, plan);
    expect(existsSync(join(store, 'graph'))).toBe(false);
    expect(existsSync(join(store, 'read'))).toBe(false);
    expect(existsSync(join(store, 'last-fill.json'))).toBe(false);
    expect(existsSync(join(store, 'writer.json'))).toBe(true);
    expect(existsSync(join(product, 'docs', 'product.md'))).toBe(false);
    expect(existsSync(join(product, 'docs', 'domains', 'payments.md'))).toBe(false);
    expect(readFileSync(join(product, 'docs', 'domains', 'mine.md'), 'utf8')).toContain('producer: person');
    expect(readFileSync(join(product, 'docs', 'vision.md'), 'utf8')).toBe('# My vision\n');
    expect(readFileSync(join(product, 'repos', 'code', 'a.ts'), 'utf8')).toBe('export {};\n');
  });

  test('the words say what goes and what stays, with the pages by name', () => {
    const { product, store } = fixture();
    const words = describeReset('shop', planReset(product, store)).join('\n');
    expect(words).toContain("Starting shop over removes");
    expect(words).toContain('the 2 pages the agent wrote: docs/product.md, docs/domains/payments.md');
    expect(words).toContain('code repositories under repos/');
    expect(words).toContain('docs/domains/mine.md');
  });

  test('a product with nothing to remove says so and removes nothing', () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-reset-'));
    const plan = planReset(join(root, 'product'), join(root, 'store'));
    expect(plan).toEqual({ store: [], agentPages: [], keptPages: [], unansweredQuestions: [], keptAnswers: [] });
    expect(describeReset('shop', plan).join('\n')).toContain('no page: the agent has written none');
  });
});

describe('what a reset and the wiki\'s own writes never touch', () => {
  test('a product id that climbs out of the knowledge root names no folder, and a reset refuses a store folder outside the root', () => {
    expect(() => storeFolderOf('/srv/knowledge', '../../home', '/p/workspace.yaml')).toThrow('cannot name a folder');
    expect(() => storeFolderOf('/srv/knowledge', 'a/b', '/p/workspace.yaml')).toThrow('/p/workspace.yaml');
    expect(storeFolderOf('/srv/knowledge', 'shop-1.2', '/p/workspace.yaml')).toBe('/srv/knowledge/shop-1.2');
    const { product } = fixture();
    expect(() => planReset(product, join(root!, '..', 'elsewhere'), join(root!, 'store'))).toThrow('not inside the knowledge root');
  });

  test('a docs folder that is a link out of the product is not read and not removed: the reset refuses and names it', () => {
    const { product, store } = fixture();
    const other = join(root!, 'other-repository');
    mkdirSync(join(other, 'domains'), { recursive: true });
    writeFileSync(join(other, 'product.md'), page('agent'));
    writeFileSync(join(other, 'domains', 'x.md'), page('agent'));
    rmSync(join(product, 'docs'), { recursive: true });
    symlinkSync(other, join(product, 'docs'));
    expect(() => planReset(product, store)).toThrow(`${join(product, 'docs')}:1: the path is a link to a place outside the product`);
    expect(existsSync(join(other, 'product.md'))).toBe(true);
  });

  test('the starter set is not written through a folder that links out of the product, and a manifest that links out keeps its language', () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-writes-'));
    const product = join(root, 'product');
    const outside = join(root, 'outside');
    mkdirSync(product); mkdirSync(outside);
    symlinkSync(outside, join(product, 'templates'));
    expect(() => seedStarterSet(product)).toThrow(`${join(product, 'templates')} is a link to`);
    expect(existsSync(join(outside, 'product.md'))).toBe(false);
    // The manifest as a link out of the product is somebody else's file.
    const folder = join(root, 'p2');
    mkdirSync(join(folder, 'madarch'), { recursive: true });
    writeFileSync(join(outside, 'kinds.yaml'), 'kinds: {}\n');
    symlinkSync(join(outside, 'kinds.yaml'), join(folder, 'madarch', 'kinds.yaml'));
    expect(setKindsLanguage(folder, 'ru')).toContain('is a link to');
    expect(readFileSync(join(outside, 'kinds.yaml'), 'utf8')).toBe('kinds: {}\n');
  });
});

const person = { name: 'A Person', email: 'person@example.test', verified: 'local, not verified' };
const at = '2026-10-24T10:00:00Z';
function loopFixture(product: string): void {
  mkdirSync(join(product, 'docs/questions'), { recursive: true });
  mkdirSync(join(product, 'docs/corrections'), { recursive: true });
  const question = (slug: string, answered: boolean, resolvedBy: string[] = []): string => renderQuestion({
    slug, title: 'Which policy?', type: 'gap', status: answered ? 'answered' : 'open',
    about: ['product:sample'], askedIn: 'product:sample', askedAt: at,
    question: 'Which policy should apply?', why: 'The policy is not specified.',
    sides: [{ claim: 'A policy is needed.', grounds: ['doc:docs/vision.md#policy'] }],
    answer: answered ? { text: 'Keep this answer.\nIts second line stays too.', by: person, at } : null,
    resolvedBy, resolvedAt: resolvedBy.length ? at : null, writtenAt: [],
  });
  writeFileSync(join(product, 'docs/product.md'), page('agent').replace('id: x', 'id: product:sample'));
  writeFileSync(join(product, 'docs/domains/payments.md'), page('agent').replace('id: x', 'id: domain:payments'));
  writeFileSync(join(product, 'docs/domains/mine.md'), page('person').replace('id: x', 'id: domain:mine'));
  writeFileSync(join(product, 'docs/questions/open.md'), question('open', false));
  writeFileSync(join(product, 'docs/questions/answered.md'), question('answered', true, ['product:sample', 'domain:mine']));
  writeFileSync(join(product, 'docs/questions/removed-only.md'), question('removed-only', true, ['domain:payments']));
  writeFileSync(join(product, 'docs/questions/human.md'), question('human', false).replace('producer: agent', 'producer: person'));
  for (const [slug, resolvedBy] of [['mixed', ['product:sample', 'domain:mine']], ['gone', ['domain:payments']], ['kept', ['domain:mine']]] as const) {
    writeFileSync(join(product, `docs/corrections/${slug}.md`), renderCorrection({
      slug, title: 'A correction', status: 'applied', about: 'product:sample#policy', statement: 'The old policy applies.',
      reason: 'Keep my correction.\nAnd its second line.', by: person, at, resolvedBy, resolvedAt: at,
    }));
  }
}

describe('reset keeps human input (madarch-m38l.22)', () => {
  test('preview and application remove only unanswered agent questions and keep answers and human questions byte for byte except obsolete resolution metadata', () => {
    const { product, store } = fixture(); loopFixture(product);
    const humanPath = join(product, 'docs/questions/human.md'); const human = readFileSync(humanPath, 'utf8');
    const before = parseQuestion(join(product, 'docs/questions/answered.md'), readFileSync(join(product, 'docs/questions/answered.md'), 'utf8'));
    const plan = planReset(product, store);
    expect(plan.unansweredQuestions).toEqual(['docs/questions/open.md']);
    expect(plan.keptAnswers).toEqual(['docs/questions/answered.md', 'docs/questions/removed-only.md']);
    const words = describeReset('sample', plan).join('\n');
    expect(words).toContain('1 unanswered agent question'); expect(words).toContain('2 answers stay');
    applyReset(product, plan);
    expect(existsSync(join(product, 'docs/questions/open.md'))).toBe(false);
    expect(readFileSync(humanPath, 'utf8')).toBe(human);
    const kept = parseQuestion(join(product, 'docs/questions/answered.md'), readFileSync(join(product, 'docs/questions/answered.md'), 'utf8'));
    expect(kept.answer).toEqual(before.answer); expect(kept.resolvedBy).toEqual(['domain:mine']); expect(kept.resolvedAt).toBe(at);
    const only = parseQuestion(join(product, 'docs/questions/removed-only.md'), readFileSync(join(product, 'docs/questions/removed-only.md'), 'utf8'));
    expect(only.resolvedBy).toEqual([]); expect(only.resolvedAt).toBeNull();
    for (const [slug, surviving, state] of [['mixed', ['domain:mine'], 'open'], ['gone', [], 'open'], ['kept', ['domain:mine'], 'applied']] as const) {
      const correction = parseCorrection(join(product, `docs/corrections/${slug}.md`), readFileSync(join(product, `docs/corrections/${slug}.md`), 'utf8'));
      expect(correction.resolvedBy).toEqual([...surviving]); expect(correction.status).toBe(state);
      expect(correction.resolvedAt).toBe(surviving.length ? at : null);
      expect(correction.reason).toBe('Keep my correction.\nAnd its second line.'); expect(correction.by).toEqual(person); expect(correction.at).toBe(at);
    }
    expect(existsSync(join(product, 'docs/domains/mine.md'))).toBe(true); expect(existsSync(join(product, 'repos/code/a.ts'))).toBe(true);
  });

  test('a human correction stays even when an extra producer field says agent', () => {
    const { product, store } = fixture(); loopFixture(product);
    const relative = 'docs/corrections/agent-tagged.md'; const file = join(product, relative);
    const source = renderCorrection({ slug: 'agent-tagged', title: 'Keep the correction', status: 'open', about: 'product:sample#policy', statement: 'The old policy applies.', reason: 'A person corrected this policy.', by: person, at, resolvedBy: [], resolvedAt: null }).replace('producer: person', 'producer: agent');
    writeFileSync(file, source); expect(parseCorrection(file, source).by).toEqual(person);
    const plan = planReset(product, store); expect(plan.unansweredQuestions).not.toContain(relative);
    applyReset(product, plan); expect(readFileSync(file, 'utf8')).toBe(source);
  });

  test('zero question and answer counts are explicit', () => {
    const { product, store } = fixture(); const words = describeReset('sample', planReset(product, store)).join('\n');
    expect(words).toContain('0 unanswered agent questions'); expect(words).toContain('0 answers stay');
  });

  for (const folder of ['questions', 'corrections']) {
    test(`a malformed ${folder} file refuses before deleting anything, with its full path and line`, () => {
      const { product, store } = fixture(); loopFixture(product);
      const file = join(product, `docs/${folder}/broken.md`); writeFileSync(file, '---\nid: [broken\n---\n');
      expect(() => planReset(product, store)).toThrow(new RegExp(`${file}:\\d+:`));
      expect(existsSync(join(product, 'docs/product.md'))).toBe(true); expect(existsSync(join(store, 'graph'))).toBe(true);
      expect(existsSync(join(product, 'docs/questions/open.md'))).toBe(true);
    });
    test(`a linked ${folder} folder outside the product refuses before deletion`, () => {
      const { product, store } = fixture(); const outside = join(root!, 'outside'); mkdirSync(outside);
      const folderPath = join(product, `docs/${folder}`); symlinkSync(outside, folderPath);
      expect(() => planReset(product, store)).toThrow(`${folderPath}:1:`);
      expect(existsSync(join(product, 'docs/product.md'))).toBe(true); expect(existsSync(join(store, 'graph'))).toBe(true);
    });
  }

  for (const relative of ['docs/product.md', 'docs/domains/payments.md', 'docs/questions/answered.md', 'docs/corrections/mixed.md']) {
    test(`an affected file link outside the product is refused: ${relative}`, () => {
      const { product, store } = fixture(); loopFixture(product);
      const file = join(product, relative); const outside = join(root!, 'outside.md');
      writeFileSync(outside, readFileSync(file, 'utf8')); rmSync(file); symlinkSync(outside, file);
      expect(() => planReset(product, store)).toThrow(`${file}:1:`);
      expect(existsSync(join(store, 'graph'))).toBe(true); expect(existsSync(outside)).toBe(true);
    });
  }

  test('a file that becomes malformed after preview refuses before the first removal', () => {
    const { product, store } = fixture(); loopFixture(product); const plan = planReset(product, store);
    const file = join(product, 'docs/corrections/mixed.md'); writeFileSync(file, 'broken');
    expect(() => applyReset(product, plan)).toThrow(`${file}:1:`);
    expect(existsSync(join(store, 'graph'))).toBe(true); expect(existsSync(join(product, 'docs/product.md'))).toBe(true);
  });

  test('a copied or modified reset preview cannot authorize deletion', () => {
    const { product, store } = fixture(); loopFixture(product);
    const plan = planReset(product, store);
    expect(() => applyReset(product, { ...plan })).toThrow('not a validated local plan');
    plan.unansweredQuestions.push('docs/questions/human.md');
    expect(() => applyReset(product, plan)).toThrow('not a validated local plan');
    expect(existsSync(join(product, 'docs/questions/human.md'))).toBe(true);
    expect(existsSync(join(store, 'graph'))).toBe(true);
  });

  test('a newly answered question cannot be deleted using an old preview', () => {
    const { product, store } = fixture(); loopFixture(product); const plan = planReset(product, store);
    const file = join(product, 'docs/questions/open.md'); const open = parseQuestion(file, readFileSync(file, 'utf8'));
    writeFileSync(file, renderQuestion({ ...open, status: 'answered', answer: { text: 'A new human answer', by: person, at } }));
    expect(() => applyReset(product, plan)).toThrow('changed since');
    expect(readFileSync(file, 'utf8')).toContain('A new human answer'); expect(existsSync(join(store, 'graph'))).toBe(true);
  });

  test('rewrite can keep unanswered questions and the graph while clearing resolutions of removed pages', () => {
    const { product, store } = fixture(); loopFixture(product); const plan = planReset(product, store);
    applyReset(product, plan, { keepQuestions: true, keepStore: true });
    expect(existsSync(join(product, 'docs/questions/open.md'))).toBe(true); expect(existsSync(join(store, 'graph'))).toBe(true);
    const file = join(product, 'docs/corrections/mixed.md'); expect(parseCorrection(file, readFileSync(file, 'utf8')).status).toBe('open');
  });
});
