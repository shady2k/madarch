import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MERMAID_FOLDER } from '../scripts/render-views.js';
import { checkMermaidPages } from '../scripts/mermaid-check.js';
import { renderMermaidPages, type View } from '../src/index.js';

/**
 * The views capability's mermaid requirement, "every flowchart shall be
 * accepted by Mermaid's parser" (docs/changes/readable-views/capabilities/
 * views.md), checked by `bun run views:check` (design.md, "Checks"). The
 * pages below are written by hand; the parser is the real Mermaid one.
 */
function folderWith(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'madarch-views-check-'));
  for (const [file, content] of Object.entries(pages)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

const GOOD = ['# Shop (domain)', '', '```mermaid', 'flowchart LR', '  shop["Shop"]', '  shop -->|"charges the card"| payments["Payments"]', '```', ''].join('\n');

describe('views:check mermaid', () => {
  test('a page whose every flowchart parses passes, counting its pages and blocks', async () => {
    const dir = folderWith({ 'shop.md': GOOD, 'two.md': `${GOOD}\n${GOOD}` });

    expect(await checkMermaidPages([dir])).toEqual({ pages: 2, blocks: 3, errors: [] });
  });

  test('a broken flowchart fails naming the page, the line of its block and Mermaid\'s error', async () => {
    const dir = folderWith({ 'broken.md': ['# Broken', '', 'Some text.', '', '```mermaid', 'flowchart LR', '  end["End"]', '```', ''].join('\n') });

    const result = await checkMermaidPages([dir]);

    expect(result.pages).toBe(1);
    expect(result.blocks).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe(join(dir, 'broken.md'));
    expect(result.errors[0]!.line).toBe(5);
    expect(result.errors[0]!.message).toContain("got 'end'");
  });

  test('every broken block is reported, not only the first, in page then line order', async () => {
    const broken = (label: string) => ['```mermaid', 'flowchart LR', `  a -->|"${label}| b[`, '```'].join('\n');
    const dir = folderWith({
      'b.md': [broken('one'), '', broken('two')].join('\n'),
      'a.md': ['# A', GOOD, broken('three')].join('\n'),
    });

    const result = await checkMermaidPages([dir]);

    expect(result.blocks).toBe(4);
    expect(result.errors.map((e) => [e.file, e.line])).toEqual([
      [join(dir, 'a.md'), 10],
      [join(dir, 'b.md'), 1],
      [join(dir, 'b.md'), 6],
    ]);
    for (const error of result.errors) expect(error.message).toContain('Parse error');
  });

  test('pages in nested folders are checked too, and only Markdown pages', async () => {
    const dir = folderWith({ 'deep/er/page.md': GOOD, 'notes.txt': 'not a page', 'page.md': GOOD });

    expect(await checkMermaidPages([dir])).toEqual({ pages: 2, blocks: 2, errors: [] });
  });

  test('a block that is not a diagram Mermaid knows fails', async () => {
    const dir = folderWith({ 'odd.md': ['```mermaid', 'hello', '```', ''].join('\n') });

    const result = await checkMermaidPages([dir]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(1);
    expect(result.errors[0]!.message).toContain('No diagram type detected');
  });

  test('a folder with no pages fails: a check that checks nothing does not pass', async () => {
    const dir = folderWith({ 'notes.txt': 'not a page' });

    expect(await checkMermaidPages([dir])).toEqual({
      pages: 0,
      blocks: 0,
      errors: [{ file: dir, line: 0, message: 'no Markdown pages to check' }],
    });
  });

  test('a folder that does not exist fails', async () => {
    const dir = join(folderWith({}), 'missing');

    const result = await checkMermaidPages([dir]);

    expect(result.pages).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe(dir);
    expect(result.errors[0]!.line).toBe(0);
    expect(result.errors[0]!.message).toContain('cannot read the folder');
  });

  test('no folder at all fails', async () => {
    expect(await checkMermaidPages([])).toEqual({ pages: 0, blocks: 0, errors: [{ file: '', line: 0, message: 'no folders to check' }] });
  });

  test('a page with no mermaid block fails, and the other pages are still checked', async () => {
    const dir = folderWith({ 'plain.md': '# Plain\n\n```text\nflowchart LR\n```\n', 'shop.md': GOOD });

    expect(await checkMermaidPages([dir])).toEqual({
      pages: 2,
      blocks: 1,
      errors: [{ file: join(dir, 'plain.md'), line: 0, message: 'the page has no mermaid block' }],
    });
  });

  test('a mermaid block that is never closed fails naming its line', async () => {
    const dir = folderWith({ 'open.md': ['# Open', '```mermaid', 'flowchart LR', '  a --> b', ''].join('\n') });

    expect(await checkMermaidPages([dir])).toEqual({
      pages: 1,
      blocks: 1,
      errors: [{ file: join(dir, 'open.md'), line: 2, message: 'the mermaid block is never closed' }],
    });
  });

  test('several folders are checked together, each one needing pages', async () => {
    const one = folderWith({ 'shop.md': GOOD });
    const two = folderWith({});

    expect(await checkMermaidPages([one, two])).toEqual({
      pages: 1,
      blocks: 1,
      errors: [{ file: two, line: 0, message: 'no Markdown pages to check' }],
    });
  });

  test('the check can run again in the same process and leaves no DOM globals behind', async () => {
    const dir = folderWith({ 'shop.md': GOOD });
    const before = typeof (globalThis as { document?: unknown }).document;

    expect((await checkMermaidPages([dir])).errors).toEqual([]);
    expect((await checkMermaidPages([dir])).errors).toEqual([]);
    expect(typeof (globalThis as { document?: unknown }).document).toBe(before);
  });

  test("the reference system's committed pages all parse", async () => {
    const result = await checkMermaidPages([MERMAID_FOLDER]);

    expect(result.errors).toEqual([]);
    expect(result.pages).toBeGreaterThan(1);
    expect(result.blocks).toBe(result.pages);
  });

  test("an element whose id is a Mermaid keyword renders into a page Mermaid's parser accepts", async () => {
    const view: View = {
      elements: [
        { id: 'end', kind: 'service', name: 'End', place: 'inside', hasView: false },
        { id: 'subgraph', kind: 'service', name: 'Subgraph', place: 'inside', hasView: false },
      ],
      arrows: [{ from: 'end', to: 'subgraph', relationIds: ['end-calls-subgraph'], label: 'calls' }],
    };
    const { pages, errors } = renderMermaidPages([view]);
    expect(errors).toEqual([]);
    const dir = folderWith(Object.fromEntries(pages!.map((page) => [page.file, page.content])));

    expect(await checkMermaidPages([dir])).toEqual({ pages: 1, blocks: 1, errors: [] });
  });
});
