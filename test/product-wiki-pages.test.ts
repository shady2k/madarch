import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { openProductWiki } from '../src/product-wiki/pages.js';

/**
 * A product's pages read from the working tree (docs/changes/draft-product/
 * capabilities/product-wiki.md, requirements `pages`, `live` and `result`):
 * every Markdown file under `docs/` and `README.md` at the root, in code point
 * order of their paths, each with a title, read fresh on every call, with a
 * revision digesting the pages' paths and contents. Nothing else in the
 * product is read, and serving changes nothing.
 */

let folder: string | undefined;
const backtick: string = String.fromCharCode(96);

function draft(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-wiki-pages-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  return folder;
}

function write(path: string, content: string): void {
  const full = join(folder!, path);
  const dir = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

function requireProduct(wiki: ReturnType<typeof openProductWiki>): import('../src/product-wiki/pages.js').ProductWiki {
  if (!wiki.ok) throw new Error(wiki.message);
  return wiki.wiki;
}

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the pages a product holds', () => {
  test('a draft with no docs and no README holds no pages', () => {
    const product = requireProduct(openProductWiki(draft()));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages).toEqual([]);
  });

  test('README.md at the root and every Markdown under docs, in code point order, each with an address', () => {
    draft();
    write('docs/vision.md', '# Vision\n\nWhat it is for.\n');
    write('docs/a-notes.md', 'no heading here\n');
    write('docs/deep/z.md', 'nothing to name\n');
    write('README.md', '# Demo\n\nThe readme.\n');
    write('docs/drawing.svg', '<svg/>');
    write('docs/notes.txt', 'not a page');
    write('skills/own.md', '# not a page');
    write('.beads/issues.jsonl', '{}\n');
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages.map((page) => page.path)).toEqual([
      'README.md',
      'docs/a-notes.md',
      'docs/deep/z.md',
      'docs/vision.md',
    ]);
    expect(pages.pages.map((page) => page.address)).toEqual([
      '/p/README.md',
      '/p/docs/a-notes.md',
      '/p/docs/deep/z.md',
      '/p/docs/vision.md',
    ]);
    expect(pages.pages.map((page) => page.title)).toEqual(['Demo', 'a-notes', 'z', 'Vision']);
  });

  test('a title inside a code fence is not the heading', () => {
    draft();
    write('docs/vision.md', `${backtick}${backtick}${backtick}\n# not a heading\n${backtick}${backtick}${backtick}\n\n# Real.\n`);
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    const page = pages.pages.find((each) => each.path === 'docs/vision.md');
    if (page === undefined) throw new Error('the page is not listed');
    expect(page.title).toBe('Real.');
  });

  test('an unchanged wiki gives the same revision; a changed file gives a new one', () => {
    draft();
    write('docs/vision.md', '# Vision\none\n');
    const product = requireProduct(openProductWiki(folder!));
    const first = product.pages();
    if (!first.ok) throw new Error(first.message);
    const second = product.pages();
    if (!second.ok) throw new Error(second.message);
    expect(second.revision).toBe(first.revision);
    expect(first.revision).not.toBe('');
    write('docs/vision.md', '# Vision\ntwo\n');
    const third = product.pages();
    if (!third.ok) throw new Error(third.message);
    expect(third.revision).not.toBe(first.revision);
  });

  test('a page is read fresh from disk, byte for byte', () => {
    draft();
    write('docs/vision.md', '# Vision\n\none\n');
    const product = requireProduct(openProductWiki(folder!));
    const first = product.page('docs/vision.md');
    if (!first.ok) throw new Error(first.message);
    expect(first.page.markdown).toBe('# Vision\n\none\n');
    write('docs/vision.md', '# Vision\n\ntwo\n');
    const second = product.page('docs/vision.md');
    if (!second.ok) throw new Error(second.message);
    expect(second.page.markdown).toBe('# Vision\n\ntwo\n');
  });

  test('a page missing from the wiki, and a path that climbs out, are refused naming the path', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    const product = requireProduct(openProductWiki(folder!));
    const missing = product.page('docs/other.md');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.message).toContain('docs/other.md');
    }
    const climbing = product.page('../AGENTS.md');
    expect(climbing.ok).toBe(false);
    if (!climbing.ok) expect(climbing.message).toContain('../AGENTS.md');
    const outside = product.page('README.txt');
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.message).toContain('README.txt');
    const rooted = product.page('/');
    expect(rooted.ok).toBe(false);
    if (!rooted.ok) expect(rooted.message).toContain('/');
  });

  test('a product whose manifest cannot be read is refused', () => {
    const bad = mkdtempSync(join(tmpdir(), 'madarch-wiki-pages-'));
    try {
      const refused = openProductWiki(bad);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.message).toContain('workspace.yaml');
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  test('the pages are named by code point order of their paths, not the locale', () => {
    draft();
    write('docs/vision.md', '# X\n');
    write('docs/B.md', '# B\n');
    write('docs/_a.md', '# a\n');
    const product = requireProduct(openProductWiki(folder!));
    const pages = product.pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages.map((page) => page.path)).toEqual(['docs/B.md', 'docs/_a.md', 'docs/vision.md']);
  });

  test('asking reads the product without changing it', () => {
    draft();
    write('docs/vision.md', '# Vision\n');
    const before = readFileSync(join(folder!, 'docs', 'vision.md'), 'utf8');
    const product = requireProduct(openProductWiki(folder!));
    product.pages();
    product.page('docs/vision.md');
    expect(readFileSync(join(folder!, 'docs', 'vision.md'), 'utf8')).toBe(before);
  });
});
