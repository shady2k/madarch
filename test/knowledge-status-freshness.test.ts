/**
 * The menu's status answer stays fresh (madarch-u3vw.8): what it caches is keyed by content, not by a file's timestamp,
 * and every input the answer reads is in that key — the product's manifest, the declared template paths (even a
 * declaration whose template is missing), the commits a task closure reads, and the Problems listing once it lands.
 * Each case warms the status answer, makes one change, and reads the new value from the next answer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct, type FillWorkerHandle } from '../src/knowledge/product.js';
import { renderCorrection } from '../src/loop/entities.js';
import { writeTask } from '../src/loop/tasks.js';
import { gitEnv } from './git-env.js';
import { makeProduct, SAMPLE_IDENTITY } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, args: string[], extra: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' }).trim();

let root: string | undefined;
const open: KnowledgeProduct[] = [];
afterEach(async () => {
  for (const product of open.splice(0)) await product.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

interface Fixture {
  readonly folder: string;
  readonly repository: string;
  readonly store: string;
}

/** A draft product, a tiny code repository and a store of its own; the starter set comes with the draft. */
function fixture(): Fixture {
  root = mkdtempSync(join(tmpdir(), 'madarch-status-freshness-'));
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const price = 10;\n');
  git(repository, ['add', '.']);
  git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first']);
  const home = join(root, 'home');
  mkdirSync(home);
  const folder = makeProduct(home, 'shop', repository, 'code');
  git(folder, ['config', 'user.name', 'Ada Reader']);
  git(folder, ['config', 'user.email', 'ada@example.test']);
  return { folder, repository, store: join(root, 'store') };
}

function productOf({ folder, store }: Fixture, options: { workerFactory?: () => FillWorkerHandle } = {}): KnowledgeProduct {
  const held = new KnowledgeProduct({ productFolder: folder, storeRoot: store, ...options });
  open.push(held);
  return held;
}

/** A fill that starts and says nothing until the test lets it go, so the product stays in the fill's state. */
function heldFill(): { worker: () => FillWorkerHandle; release: () => void } {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  return {
    worker: () => ({ send: () => undefined, lines: (async function* () { await hold; })(), exited: hold.then(() => 0), stderr: () => '', kill: () => undefined }),
    release: () => release(),
  };
}

/** A page of a Markdown folder kind whose one ground names nothing: the Problems page counts it. */
// A page of the kind whose template appeared later: it names no kind, so reading it is a finding — and the count of
// open problems moves by one when the folder of that kind is stamped at all.
const GHOST_PAGE = ['---', 'id: ghost:a', '---', 'The ghost stands here.', ''].join('\n');

/** A whole-second timestamp, so a restored mtime is byte for byte the one the warm answer saw. */
const FIXED = 1_700_000_000;
const fixMtime = (file: string): void => utimesSync(file, FIXED, FIXED);

const kind = (status: Awaited<ReturnType<KnowledgeProduct['status']>>, name: string) => status.kinds.find((entry) => entry.kind === name);

describe('the status answer reads what its inputs say now', () => {
  test('a renamed product is the next answer\'s name', async () => {
    const fixtureSet = fixture();
    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    expect(before.product.name).toBe('shop');

    const manifest = join(fixtureSet.folder, 'workspace.yaml');
    const text = readFileSync(manifest, 'utf8');
    expect(text).toContain('\nname: shop\n');
    writeFileSync(manifest, text.replace('\nname: shop\n', '\nname: shoo\n'));

    const after = await held.status();
    expect(after.product.name).toBe('shoo');
  }, 60_000);

  test('a correction that became applied is not counted open once its listing lands', async () => {
    const fixtureSet = fixture();
    mkdirSync(join(fixtureSet.folder, 'docs', 'corrections'), { recursive: true });
    const correction = join(fixtureSet.folder, 'docs', 'corrections', 'price.md');
    const write = (status: 'open' | 'applied'): void => writeFileSync(correction, renderCorrection({
      slug: 'price', title: 'The price', status, about: 'product:shop#price', statement: 'The price is ten.',
      reason: 'The price is eleven.', by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' },
      at: '2026-10-24T09:00:00.000Z', resolvedBy: [], resolvedAt: null,
    }));
    write('open');
    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    const openBefore = before.loop.problemsOpen ?? -1;
    expect(openBefore).toBeGreaterThan(0);

    write('applied');
    // The first answer after the edit sees a new key and, while the listing is still collecting, may answer with the
    // previous count. The next answer must not keep that count once the listing for these inputs is there.
    await held.status();
    const listed = await held.problems();
    expect(listed.open).toBe(openBefore - 1);
    const after = await held.status();
    expect(after.loop.problemsOpen).toBe(openBefore - 1);
  }, 60_000);

  test('a template written for a declaration that named it missing makes the kind appear', async () => {
    const fixtureSet = fixture();
    const manifest = join(fixtureSet.folder, 'madarch', 'kinds.yaml');
    const text = readFileSync(manifest, 'utf8');
    expect(text).toContain('kinds:\n');
    writeFileSync(manifest, text.replace('kinds:\n', 'kinds:\n  ghost:\n    template: templates/ghost.md\n    source: markdown\n    folder: docs/ghost\n'));

    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    expect(kind(before, 'ghost')).toBeUndefined();
    expect(before.findings.some((finding) => finding.message.includes('templates/ghost.md') && finding.message.includes('does not exist'))).toBe(true);

    writeFileSync(join(fixtureSet.folder, 'templates', 'ghost.md'), '# Ghost\n');
    const after = await held.status();
    expect(kind(after, 'ghost')).toBeDefined();
    expect(after.findings.some((finding) => finding.message.includes('templates/ghost.md'))).toBe(false);
  }, 60_000);

  test('a commit on the default branch that closes a task closes it in the next answer', async () => {
    const fixtureSet = fixture();
    writeTask(fixtureSet.folder, 'docs/tasks/fix-price.md', {
      slug: 'fix-price', title: 'Fix the price', status: 'open', question: 'question:price', answer: 'answer:price',
      grounds: ['code.file\u003asrc/a.ts'], scope: [{ type: 'file', path: 'src/a.ts' }],
      by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' },
      at: '2026-10-24T09:00:00.000Z', closedBy: null, closedAt: null,
    });
    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    expect(before.loop.tasksOpen).toBe(1);

    writeFileSync(join(fixtureSet.repository, 'src', 'a.ts'), 'export const price = 11;\n');
    const dated = { GIT_AUTHOR_DATE: '2026-10-24T09:01:00.000Z', GIT_COMMITTER_DATE: '2026-10-24T09:01:00.000Z' };
    git(fixtureSet.repository, ['add', '.']);
    git(fixtureSet.repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fix the price\n\nTask: fix-price'], dated);

    // No fill, no edit of the product: only the default branch moved, which is what the closure reads.
    const after = await held.status();
    expect(after.loop.tasksOpen).toBe(0);
    expect(after.loop.problemsOpen).toBe(before.loop.problemsOpen);
  }, 60_000);
});

describe('a change whose size and mtime are unchanged', () => {
  test('the kinds manifest is read by its content, so a label that changed is the next answer\'s label', async () => {
    const fixtureSet = fixture();
    const manifest = join(fixtureSet.folder, 'madarch', 'kinds.yaml');
    fixMtime(manifest);
    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    expect(kind(before, 'domain')?.labels?.en?.one).toBe('Domain');

    const observed = statSync(manifest).mtimeMs;
    const text = readFileSync(manifest, 'utf8');
    const edited = text.replace('one: "Domain", many: "Domains"', 'one: "DomaiX", many: "Domains"');
    expect(edited.length).toBe(text.length);
    writeFileSync(manifest, edited);
    fixMtime(manifest);
    expect(statSync(manifest).mtimeMs).toBe(observed);

    const after = await held.status();
    expect(kind(after, 'domain')?.labels?.en?.one).toBe('DomaiX');
  }, 60_000);

  test('the product manifest is read by its content, so a name that changed is the next answer\'s name', async () => {
    const fixtureSet = fixture();
    const manifest = join(fixtureSet.folder, 'workspace.yaml');
    fixMtime(manifest);
    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    expect(before.product.name).toBe('shop');

    const text = readFileSync(manifest, 'utf8');
    const edited = text.replace('\nname: shop\n', '\nname: shoo\n');
    expect(edited.length).toBe(text.length);
    writeFileSync(manifest, edited);
    fixMtime(manifest);

    const after = await held.status();
    expect(after.product.name).toBe('shoo');
  }, 60_000);
});

describe('a count the answer cannot have collected is pending, not a count for other inputs', () => {
  test('a correction applied while a fill runs never leaves the previous count in the menu', async () => {
    const fixtureSet = fixture();
    mkdirSync(join(fixtureSet.folder, 'docs', 'corrections'), { recursive: true });
    const correction = join(fixtureSet.folder, 'docs', 'corrections', 'price.md');
    const write = (status: 'open' | 'applied'): void => writeFileSync(correction, renderCorrection({
      slug: 'price', title: 'The price', status, about: 'product:shop#price', statement: 'The price is ten.',
      reason: 'The price is eleven.', by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' },
      at: '2026-10-24T09:00:00.000Z', resolvedBy: [], resolvedAt: null,
    }));
    write('open');
    const fill = heldFill();
    const held = productOf(fixtureSet, { workerFactory: fill.worker });
    await held.status();
    const before = await held.status();
    const openBefore = before.loop.problemsOpen ?? -1;
    expect(openBefore).toBeGreaterThan(0);
    expect((await held.startFill()).started).toBe(true);

    write('applied');
    // The fill suppresses the collection of the listing for these inputs: the answer must not carry the count that was
    // collected for the previous ones, nor keep it through the memo on the next poll.
    try {
      const during = await held.status();
      expect(during.loop.problemsOpen).not.toBe(openBefore);
      const again = await held.status();
      expect(again.loop.problemsOpen).not.toBe(openBefore);
    } finally {
      fill.release();
      await held.settled();
    }
    const listed = await held.problems();
    expect(listed.open).toBe(openBefore - 1);
    const after = await held.status();
    expect(after.loop.problemsOpen).toBe(openBefore - 1);
  }, 90_000);
});

describe('a kind whose template appears after the answer was warmed', () => {
  test('a Markdown kind accepted when its template is written stamps its folder from then on', async () => {
    const fixtureSet = fixture();
    const manifest = join(fixtureSet.folder, 'madarch', 'kinds.yaml');
    const text = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, text.replace('kinds:\n', 'kinds:\n  ghost:\n    template: templates/ghost.md\n    source: markdown\n    folder: pages/ghost\n'));

    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    expect(kind(before, 'ghost')).toBeUndefined();

    writeFileSync(join(fixtureSet.folder, 'templates', 'ghost.md'), '# Ghost\n');
    const made = await held.status();
    expect(kind(made, 'ghost')).toBeDefined();
    // The count with the kind accepted and no page of it yet: the baseline the next page is read against.
    const base = await held.problems();

    mkdirSync(join(fixtureSet.folder, 'pages', 'ghost'), { recursive: true });
    writeFileSync(join(fixtureSet.folder, 'pages', 'ghost', 'a.md'), GHOST_PAGE);
    const listed = await held.problems();
    expect(listed.open).toBe(base.open + 1);
    const after = await held.status();
    expect(after.loop.problemsOpen).toBe(base.open + 1);
  }, 90_000);

  test('a template written as the fallback of a missing one is stamped before either exists', async () => {
    const fixtureSet = fixture();
    const manifest = join(fixtureSet.folder, 'madarch', 'kinds.yaml');
    const text = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, text.replace('kinds:\n', 'kinds:\n  ghost:\n    template: templates/ghost.md\n    source: markdown\n    folder: pages/ghost\n'));

    const held = productOf(fixtureSet);
    await held.status();
    const before = await held.status();
    expect(kind(before, 'ghost')).toBeUndefined();
    expect(before.findings.some((finding) => finding.message.includes('templates/ghost.md') && finding.message.includes('does not exist'))).toBe(true);

    // Neither template exists when the answer is warmed: the parser takes the Liquid fallback once it is written.
    writeFileSync(join(fixtureSet.folder, 'templates', 'ghost.liquid'), '# Ghost\n');
    const made = await held.status();
    expect(kind(made, 'ghost')).toBeDefined();
    expect(made.findings.some((finding) => finding.message.includes('templates/ghost.md'))).toBe(false);
    const base = await held.problems();

    mkdirSync(join(fixtureSet.folder, 'pages', 'ghost'), { recursive: true });
    writeFileSync(join(fixtureSet.folder, 'pages', 'ghost', 'a.md'), GHOST_PAGE);
    const listed = await held.problems();
    expect(listed.open).toBe(base.open + 1);
    const after = await held.status();
    expect(after.loop.problemsOpen).toBe(base.open + 1);
  }, 90_000);
});
