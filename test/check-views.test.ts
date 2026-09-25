import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIKEC4_FOLDER, MERMAID_FOLDER } from '../scripts/render-views.js';
import { checkLikeC4Workspaces } from '../scripts/likec4-check.js';
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

  test('fences may carry trailing spaces', async () => {
    const dir = folderWith({ 'spaced.md': ['```mermaid  ', 'flowchart LR', '  a --> b', '``` ', ''].join('\n') });

    expect(await checkMermaidPages([dir])).toEqual({ pages: 1, blocks: 1, errors: [] });
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

const GOOD_C4 = ['specification {', '  element domain', '}', 'model {', '  shop = domain "Shop"', '}', 'views {', '  view index {', '    include *', '  }', '}', ''].join('\n');
// Line 5 names a kind the specification does not have; line 6 a target that does not exist.
const BROKEN_C4 = ['specification {', '  element domain', '}', 'model {', '  shop = system "Shop"', '  shop -> nowhere "calls"', '}', ''].join('\n');

describe('views:check likec4', () => {
  test('a workspace likec4 accepts passes, counting its files', () => {
    expect(checkLikeC4Workspaces([folderWith({ 'model.c4': GOOD_C4 })])).toEqual({ files: 1, errors: [] });
  });

  test("a broken workspace fails naming each file, the 1-based line and LikeC4's error, in file then line order", () => {
    const dir = folderWith({ 'model.c4': BROKEN_C4, 'deep/other.c4': 'model {\n  q = domain "Q" {\n' });

    const result = checkLikeC4Workspaces([dir]);

    expect(result.files).toBe(2);
    expect(result.errors.map((e) => [e.file, e.line])).toEqual([
      [join(dir, 'deep/other.c4'), 2],
      [join(dir, 'model.c4'), 5],
      [join(dir, 'model.c4'), 6],
      [join(dir, 'model.c4'), 6],
    ]);
    expect(result.errors[1]!.message).toBe("Could not resolve reference to ElementKind named 'system'.");
    expect(result.errors[2]!.message).toBe("Could not resolve reference to Referenceable named 'nowhere'.");
  });

  test('a folder without LikeC4 files fails: a check that checks nothing does not pass', () => {
    const dir = folderWith({ 'notes.txt': 'not a workspace' });

    expect(checkLikeC4Workspaces([dir])).toEqual({ files: 0, errors: [{ file: dir, line: 0, message: 'no LikeC4 files to check' }] });
  });

  test('a folder that does not exist fails', () => {
    const dir = join(folderWith({}), 'missing');

    const result = checkLikeC4Workspaces([dir]);

    expect(result.files).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe(dir);
    expect(result.errors[0]!.line).toBe(0);
    expect(result.errors[0]!.message).toContain('cannot read the folder');
  });

  test('no folder at all fails', () => {
    expect(checkLikeC4Workspaces([])).toEqual({ files: 0, errors: [{ file: '', line: 0, message: 'no folders to check' }] });
  });

  test('several folders are validated each as a workspace of its own, their files counted together', () => {
    const one = folderWith({ 'model.c4': GOOD_C4 });
    const two = folderWith({ 'model.c4': GOOD_C4 });

    expect(checkLikeC4Workspaces([one, two])).toEqual({ files: 2, errors: [] });
  });

  test('a likec4 that cannot be run, or answers what is not its report, fails naming the folder', () => {
    const dir = folderWith({ 'model.c4': GOOD_C4 });

    const missing = checkLikeC4Workspaces([dir], join(dir, 'no-such-likec4'));
    expect(missing.files).toBe(0);
    expect(missing.errors).toHaveLength(1);
    expect(missing.errors[0]!.file).toBe(dir);
    expect(missing.errors[0]!.message).toStartWith('cannot run likec4 validate: ');

    const talker = join(dir, 'talker.sh');
    writeFileSync(talker, '#!/bin/sh\necho not json\necho "it broke" >&2\nexit 3\n', { mode: 0o755 });
    expect(checkLikeC4Workspaces([dir], talker)).toEqual({
      files: 0,
      errors: [{ file: dir, line: 0, message: 'likec4 validate exited with 3 without a report: it broke' }],
    });
  });

  test('errors are put in file then line order whatever order likec4 reports them in', () => {
    const dir = folderWith({ 'model.c4': GOOD_C4 });
    const errors = [
      { message: 'b late', file: '/w/b.c4', line: 8 },
      { message: 'a late', file: '/w/a.c4', line: 9 },
      { message: 'b early', file: '/w/b.c4', line: 1 },
      { message: 'a early', file: '/w/a.c4', line: 0 },
    ];
    const fake = join(dir, 'unordered.sh');
    writeFileSync(fake, `#!/bin/sh\necho '${JSON.stringify({ valid: false, errors, stats: { totalFiles: 2 } })}'\nexit 1\n`, { mode: 0o755 });

    expect(checkLikeC4Workspaces([dir], fake)).toEqual({
      files: 2,
      errors: [
        { file: '/w/a.c4', line: 1, message: 'a early' },
        { file: '/w/a.c4', line: 10, message: 'a late' },
        { file: '/w/b.c4', line: 2, message: 'b early' },
        { file: '/w/b.c4', line: 9, message: 'b late' },
      ],
    });
  });

  test('a likec4 that fails, or finds the workspace invalid, while naming no error still fails the check', () => {
    const dir = folderWith({ 'model.c4': GOOD_C4 });
    const fake = (name: string, valid: boolean, status: number): string => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\necho '{"valid": ${valid}, "errors": [], "stats": {"totalFiles": 1}}'\nexit ${status}\n`, { mode: 0o755 });
      return path;
    };

    expect(checkLikeC4Workspaces([dir], fake('exits.sh', true, 1))).toEqual({
      files: 1,
      errors: [{ file: dir, line: 0, message: 'likec4 validate exited with 1 and found the workspace valid, naming no error' }],
    });
    expect(checkLikeC4Workspaces([dir], fake('invalid.sh', false, 0))).toEqual({
      files: 1,
      errors: [{ file: dir, line: 0, message: 'likec4 validate exited with 0 and found the workspace invalid, naming no error' }],
    });
  });

  test("the reference system's committed workspace validates", () => {
    expect(checkLikeC4Workspaces([LIKEC4_FOLDER])).toEqual({ files: 1, errors: [] });
  });
});

describe('views:check the command', () => {
  const script = fileURLToPath(new URL('../scripts/check-views.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  test("with no folder it checks the reference system's pages and workspace and exits 0", () => {
    const result = run();

    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^mermaid: checked (\d+) blocks in \1 pages, 0 errors\nlikec4: checked 1 files, 0 errors\n$/);
    expect(result.status).toBe(0);
  });

  test('with --mermaid it checks that folder alone, printing every error and exiting 1', () => {
    const dir = folderWith({ 'broken.md': ['# Broken', '```mermaid', 'hello', '```', ''].join('\n'), 'plain.md': '# Plain\n' });

    const result = run('--mermaid', dir);

    expect(result.stderr).toStartWith(`error: ${join(dir, 'broken.md')}:2: No diagram type detected`);
    expect(result.stderr).toEndWith(`\nerror: ${join(dir, 'plain.md')}:0: the page has no mermaid block\n`);
    expect(result.stdout).toBe('mermaid: checked 1 blocks in 2 pages, 2 errors\n');
    expect(result.status).toBe(1);
  });

  test('with --likec4 it validates that folder alone, printing every error and exiting 1', () => {
    const dir = folderWith({ 'model.c4': BROKEN_C4 });

    const result = run('--likec4', dir);

    expect(result.stderr).toStartWith(`error: ${join(dir, 'model.c4')}:5: Could not resolve reference to ElementKind named 'system'.\n`);
    expect(result.stderr.split('\n')).toHaveLength(4);
    expect(result.stdout).toBe('likec4: checked 1 files, 3 errors\n');
    expect(result.status).toBe(1);
  });

  test('the exit status combines both checks: good pages and a broken workspace exit 1, both good exit 0', () => {
    const pages = folderWith({ 'shop.md': GOOD });
    const broken = folderWith({ 'model.c4': BROKEN_C4 });
    const good = folderWith({ 'model.c4': GOOD_C4 });

    const failing = run('--mermaid', pages, '--likec4', broken);
    expect(failing.stdout).toBe('mermaid: checked 1 blocks in 1 pages, 0 errors\nlikec4: checked 1 files, 3 errors\n');
    expect(failing.status).toBe(1);

    const passing = run('--likec4', good, '--mermaid', pages);
    expect(passing.stderr).toBe('');
    expect(passing.stdout).toBe('mermaid: checked 1 blocks in 1 pages, 0 errors\nlikec4: checked 1 files, 0 errors\n');
    expect(passing.status).toBe(0);
  });

  test('an argument that is not a check with its folder is refused with exit 2, checking nothing', () => {
    for (const args of [['somewhere'], ['--mermaid'], ['--likec4', '--mermaid'], ['--likec4', '--mermaid', 'x'], ['--svg', 'x']]) {
      const result = run(...args);
      expect(result.stdout).toBe('');
      expect(result.stderr).toStartWith('error: usage: bun run views:check [--mermaid <folder>]... [--likec4 <folder>]...');
      expect(result.status).toBe(2);
    }
  });
});
