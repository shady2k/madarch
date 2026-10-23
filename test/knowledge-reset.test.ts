/**
 * Starting a product's knowledge over (madarch-m38l.4, remark 12): what goes and what stays, the same words from the
 * command and the wiki, and nothing of a person's removed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(plan).toEqual({ store: [], agentPages: [], keptPages: [] });
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
    expect(() => planReset(product, store)).toThrow(`${join(product, 'docs')} is a link to a place outside the product`);
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
