import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProductDiscussions, writeProductDiscussion, writeProductDiscussionAction, writeProductPageDiscussion, restoreProductDiscussionAnchor, type DiscussionWriteInput } from '../src/product/discussion-writer.js';
import { gitEnv } from './git-env.js';

let root: string | undefined;
let remote: string | undefined;
const env = gitEnv({ GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.test' });
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(): { product: string; input: DiscussionWriteInput } {
  const base = mkdtempSync(join(tmpdir(), 'madarch-discussion-writer-'));
  root = join(base, 'product'); remote = join(base, 'remote.git');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(root, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: Fixture\n');
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\nSelected phrase here.\n');
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Fixture Author']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['add', '--', 'workspace.yaml', 'docs/guide.md']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  git(base, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '--quiet', '-u', 'origin', 'HEAD']);
  return { product: root, input: { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'A useful comment.' } };
}
afterEach(() => { if (root !== undefined) rmSync(join(root, '..'), { recursive: true, force: true }); root = undefined; remote = undefined; });

describe('writeProductDiscussion', () => {
  test('commits and pushes exactly the source page and one v1 message', () => {
    const { product } = fixture();
    const result = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'A useful comment.' }, new Date('2026-10-15T12:00:00.000Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(product, 'docs/guide.md'), 'utf8')).toContain(`<!--c:${result.thread}-->Selected phrase<!--/c:${result.thread}-->`);
    const files = git(product, ['show', '--pretty=format:', '--name-only', 'HEAD']).split('\n').filter(Boolean).sort();
    expect(files).toEqual([`comments/${result.thread}/${result.message}.md`, 'docs/guide.md'].sort());
    const metadata = readFileSync(join(product, 'comments', result.thread, `${result.message}.md`), 'utf8');
    expect(metadata).toContain('contract: 1');
    expect(metadata).toContain('quote: "Selected phrase"');
    expect(git(remote!, ['log', '--format=%s', '-1'])).toBe('Add product discussion comment');
    expect(git(product, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  test('refuses a dirty product before writing or committing', () => {
    const { product } = fixture();
    writeFileSync(join(product, 'unrelated.txt'), 'leave me');
    const before = git(product, ['rev-parse', 'HEAD']);
    const result = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: '', paragraph: 0, from: 0, to: 15 }, body: 'A comment' });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(join(product, 'unrelated.txt'), 'utf8')).toBe('leave me');
    expect(git(product, ['rev-parse', 'HEAD'])).toBe(before);
  });

  test('refuses ignored files too and leaves them unchanged', () => {
    const { product } = fixture();
    writeFileSync(join(product, '.gitignore'), 'private\n');
    git(product, ['add', '.gitignore']);
    git(product, ['commit', '--quiet', '-m', 'ignore private']);
    writeFileSync(join(product, 'private'), 'do not overwrite');
    const before = git(product, ['rev-parse', 'HEAD']);
    const result = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: '', paragraph: 0, from: 0, to: 15 }, body: 'A comment' });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(join(product, 'private'), 'utf8')).toBe('do not overwrite');
    expect(git(product, ['rev-parse', 'HEAD'])).toBe(before);
  });

  test('readback returns the message only when its marker wraps the saved quote and context', () => {
    const { product } = fixture();
    const written = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Anchor this.' });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = readProductDiscussions(product, 'docs/guide.md');
    if (!read.ok) throw new Error(read.message);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ thread: written.thread, message: written.message, document: 'docs/guide.md', author: 'Fixture Author', status: 'open', anchor: { kind: 'selection', quote: 'Selected phrase', before: '', after: ' here.' } });
    expect(read.entries[0]?.body.trim()).toBe('Anchor this.');
  });

  test('readback uses marker source position when identical quote and context repeat', () => {
    const { product } = fixture();
    const input = { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Anchor this.' };
    const written = writeProductDiscussion(product, input);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const markdown = readFileSync(join(product, 'docs/guide.md'), 'utf8');
    writeFileSync(join(product, 'docs/guide.md'), `${markdown}\nSelected phrase here.\n`);
    const read = readProductDiscussions(product, 'docs/guide.md');
    expect(read).toMatchObject({ ok: true });
    if (read.ok) expect(read.entries.map((entry) => entry.thread)).toEqual([written.thread]);
  });

  test('readback rejects a message stored under a different thread id', () => {
    const { product } = fixture();
    const written = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Anchor this.' });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const file = join(product, 'comments', written.thread, `${written.message}.md`);
    const content = readFileSync(file, 'utf8').replace(`thread: ${written.thread}`, `thread: 01ARZ3NDEKTSV4RRFFQ69G5FAV`);
    writeFileSync(file, content);
    const read = readProductDiscussions(product, 'docs/guide.md');
    expect(read).toMatchObject({ ok: false, status: 409 });
    if (!read.ok) expect(read.message).toContain('must match the thread ULID in the path');
  });

  test('readback treats both missing markers as a lost anchor with the saved quote', () => {
    const { product } = fixture();
    const written = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Anchor this.' });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    writeFileSync(join(product, 'docs/guide.md'), '# Guide\n\nSelected phrase here.\n');
    const read = readProductDiscussions(product, 'docs/guide.md');
    expect(read).toMatchObject({ ok: true, entries: [{ thread: written.thread, anchor: { kind: 'selection', lost: true, quote: 'Selected phrase' } }] });
  });

  test('edits inside a marker retain the selection range and its saved quote', () => {
    const { product } = fixture();
    const written = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Anchor this.' });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    writeFileSync(join(product, 'docs/guide.md'), `# Guide\n\n<!--c:${written.thread}-->Revised phrase<!--/c:${written.thread}--> here.\n`);
    const read = readProductDiscussions(product, 'docs/guide.md');
    expect(read).toMatchObject({ ok: true, entries: [{ thread: written.thread, anchor: { quote: 'Selected phrase' } }] });
  });

  test('an edit through one marker is refused with the page path and line', () => {
    const { product } = fixture();
    const written = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Anchor this.' });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    writeFileSync(join(product, 'docs/guide.md'), `# Guide\n\n<!--c:${written.thread}-->Revised phrase\n`);
    const read = readProductDiscussions(product, 'docs/guide.md');
    expect(read).toMatchObject({ ok: false, status: 409 });
    if (!read.ok) expect(read.message).toContain('docs/guide.md:3');
  });

  test('refuses a stale rendered selection after page text changes', () => {
    const { product } = fixture();
    writeFileSync(join(product, 'docs/guide.md'), '# Guide\n\nChanged phrase now.\n');
    git(product, ['add', 'docs/guide.md']); git(product, ['commit', '--quiet', '-m', 'advance page']);
    const before = git(product, ['rev-parse', 'HEAD']);
    const result = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Stale.' });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(git(product, ['rev-parse', 'HEAD'])).toBe(before);
    expect(readdirSync(join(product, 'docs'))).toEqual(['guide.md']);
    expect(existsSync(join(product, 'comments'))).toBe(false);
  });

  test('refuses path traversal and a symlinked page without writing', () => {
    const { product } = fixture();
    const input = { document: '../workspace.yaml', range: { start: 1, end: 2, quote: 'x', before: '', after: '', paragraph: 0, from: 0, to: 1 }, body: 'No' };
    expect(writeProductDiscussion(product, input).ok).toBe(false);
    const outside = join(product, 'outside.md');
    writeFileSync(outside, '# Outside\n');
    rmSync(join(product, 'docs', 'guide.md'));
    symlinkSync(outside, join(product, 'docs', 'guide.md'));
    expect(writeProductDiscussion(product, { ...input, document: 'docs/guide.md' })).toMatchObject({ ok: false, status: 400 });
    expect(readFileSync(outside, 'utf8')).toBe('# Outside\n');
  });

  test('reconciles a fast-forward remote change and retries once when the source range still matches', () => {
    const { product } = fixture();
    const clone = join(product, '..', 'remote-writer');
    git(product, ['clone', remote!, clone]);
    writeFileSync(join(clone, 'unrelated.md'), '# Remote change\n');
    git(clone, ['add', 'unrelated.md']); git(clone, ['commit', '--quiet', '-m', 'remote change']); git(clone, ['push', '--quiet', 'origin', 'HEAD']);
    const result = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Retry after fast-forward.' }, new Date('2026-10-15T12:00:00.000Z'));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(product, 'unrelated.md'), 'utf8')).toBe('# Remote change\n');
    expect(git(remote!, ['rev-parse', 'refs/heads/main'])).toBe(git(product, ['rev-parse', 'HEAD']));
    expect(git(product, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  test('reports rejected push as not sent and rolls back its exact local action', () => {
    const { product } = fixture();
    git(product, ['remote', 'remove', 'origin']);
    git(product, ['remote', 'add', 'origin', '/missing/remote.git']);
    const before = git(product, ['rev-parse', 'HEAD']);
    const result = writeProductDiscussion(product, { document: 'docs/guide.md', range: { start: 9, end: 24, quote: 'Selected phrase', before: '', after: ' here.', paragraph: 0, from: 0, to: 15 }, body: 'Retry me.' }, new Date('2026-10-15T12:00:00.000Z'));
    expect(result).toMatchObject({ ok: false, status: 409 });
    if (result.ok) return;
    expect(result.message).toContain('outcome could not be confirmed');
    expect(git(product, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(product, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  test('page-level comments have a page anchor and no source marker', () => {
    const { product } = fixture();
    const written = writeProductPageDiscussion(product, { document: 'docs/guide.md', body: 'A page note.' }, new Date('2026-10-15T12:00:00.000Z'));
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(readFileSync(join(product, 'docs/guide.md'), 'utf8')).not.toContain(`<!--c:${written.thread}-->`);
    const read = readProductDiscussions(product, 'docs/guide.md');
    expect(read).toMatchObject({ ok: true, entries: [{ thread: written.thread, anchor: { kind: 'page' }, status: 'open', body: expect.stringContaining('A page note.') }] });
  });

  test('replies append to the same thread and resolution is visible as the latest state', () => {
    const { product, input } = fixture();
    const first = writeProductDiscussion(product, input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const reply = writeProductDiscussionAction(product, { document: input.document, thread: first.thread, action: 'reply', body: 'A reply.' });
    expect(reply.ok).toBe(true);
    const resolved = writeProductDiscussionAction(product, { document: input.document, thread: first.thread, action: 'resolve' });
    expect(resolved.ok).toBe(true);
    expect(writeProductDiscussionAction(product, { document: input.document, thread: first.thread, action: 'reply', body: 'after resolve' })).toMatchObject({ ok: false, status: 409 });
    const read = readProductDiscussions(product, input.document);
    expect(read).toMatchObject({ ok: true, entries: [{ thread: first.thread, status: 'resolved', messages: [{ body: expect.stringContaining('A useful comment.') }, { body: expect.stringContaining('A reply.') }, { body: expect.stringContaining('\n\n') }] }] });
  });

  test('a reader-selected exact range restores a lost anchor', () => {
    const { product, input } = fixture();
    const first = writeProductDiscussion(product, input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(join(product, 'docs/guide.md'), '# Guide\n\nSelected phrase here.\n');
    git(product, ['add', 'docs/guide.md']); git(product, ['commit', '--quiet', '-m', 'remove selected phrase marker']); git(product, ['push', '--quiet', 'origin', 'HEAD']);
    const wrongContext = restoreProductDiscussionAnchor(product, { document: input.document, thread: first.thread, range: { ...input.range, before: 'different context' } });
    expect(wrongContext).toMatchObject({ ok: false, status: 409 });
    expect(readProductDiscussions(product, input.document)).toMatchObject({ ok: true, entries: [{ thread: first.thread, anchor: { lost: true } }] });
    const recovered = restoreProductDiscussionAnchor(product, { document: input.document, thread: first.thread, range: input.range });
    expect(recovered.ok).toBe(true);
    const read = readProductDiscussions(product, input.document);
    expect(read).toMatchObject({ ok: true, entries: [{ thread: first.thread, anchor: { kind: 'selection', quote: 'Selected phrase' } }] });
    if (read.ok) expect(read.entries[0]?.anchor.lost).toBeUndefined();
  });

});
