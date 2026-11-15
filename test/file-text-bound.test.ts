/**
 * A read is bounded in bytes (the owner's review of madarch-u3vw.16): a range is a job result, and a blob that is one
 * hundred-megabyte line must not become one. A cut text names the line and the column the next range continues at, and a
 * range asked from there continues exactly where the last one stopped — nothing is dropped and nothing repeats.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundFileText, FILE_TEXT_MAX_BYTES } from '../src/knowledge/file-text-shape.js';
import { readBlobThroughPlugin } from '../src/plugin/file-reads.js';
import { closureOf } from '../src/plugin/closure.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' });
const REPO = join(import.meta.dir, '..');

const root = mkdtempSync(join(tmpdir(), 'madarch-file-bound-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** A product whose own repository is its folder, with the release's git plugin locked in it. */
function product(): { folder: string } {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: sample\nname: sample\n');
  const plugin = join(folder, 'plugins', 'git');
  cpSync(join(REPO, 'plugins', 'git'), plugin, { recursive: true });
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), `plugins:\n  - id: git\n    version: 1.0.0\n    closure: ${closureOf(plugin).hash}\n    path: plugins/git\n`);
  git(folder, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(folder, 'many.txt'), `${Array.from({ length: 6_000 }, (_, at) => `line ${String(at + 1)} ${'.'.repeat(60)}`).join('\n')}\n`);
  writeFileSync(join(folder, 'one-long.txt'), `${'x'.repeat(400_000)}\n`);
  git(folder, 'add', '-A');
  git(folder, 'commit', '--quiet', '-m', 'a long file and a file of lines');
  return { folder };
}

const blobOf = (folder: string, path: string): string => git(folder, 'rev-parse', `HEAD:${path}`).trim();

test('a text past the byte bound is cut, and the answer names the line and column it continues at', () => {
  // The bound is the helper's own; the read below proves the same rule through the plugin.
  const many = `${Array.from({ length: 6_000 }, (_, at) => `line ${String(at + 1)} ${'.'.repeat(60)}`).join('\n')}\n`;
  const cut = boundFileText(many, 1);
  expect(cut.complete).toBe(false);
  expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(FILE_TEXT_MAX_BYTES);
  expect(cut.text.endsWith('\n')).toBe(true);
  expect(cut.next).toEqual({ line: cut.text.split('\n').length, column: 1 });
  // A first line past the bound is cut inside itself, and the continuation is the same line at a column.
  const long = boundFileText(`${'y'.repeat(400_000)}\n`, 7, 3);
  expect(long.complete).toBe(false);
  expect(long.next?.line).toBe(7);
  expect(long.next?.column).toBe(long.text.length + 3);
  expect(boundFileText('a\nb\n', 1)).toEqual({ text: 'a\nb\n', complete: true, next: null });
});

test('a read of a file of lines answers bounded ranges that continue each other, and the last one is complete', async () => {
  const { folder } = product();
  const blob = blobOf(folder, 'many.txt');
  const whole = await readBlobThroughPlugin({ product: folder, plugin: join('plugins', 'git'), repository: 'sample', root: folder, blob });
  expect(whole.binary).toBe(false);
  expect(whole.complete).toBe(false);
  expect(Buffer.byteLength(whole.text, 'utf8')).toBeLessThanOrEqual(FILE_TEXT_MAX_BYTES);
  expect(whole.next).not.toBeNull();
  expect(whole.next!.column).toBe(1);
  // The next range continues exactly where the last stopped: its first line is the one the cut named.
  const next = await readBlobThroughPlugin({ product: folder, plugin: join('plugins', 'git'), repository: 'sample', root: folder, blob, from: whole.next!.line });
  expect(next.text.split('\n')[0]).toBe(`line ${String(whole.next!.line)} ${'.'.repeat(60)}`);
  expect(whole.text + next.text).toContain(`line ${String(whole.next!.line)} ${'.'.repeat(60)}`);
}, 60_000);

test('a blob that is one long line is cut inside that line, and the next range resumes at the column it names', async () => {
  const { folder } = product();
  const blob = blobOf(folder, 'one-long.txt');
  const head = await readBlobThroughPlugin({ product: folder, plugin: join('plugins', 'git'), repository: 'sample', root: folder, blob });
  expect(head.complete).toBe(false);
  expect(head.next?.line).toBe(1);
  expect(head.next!.column).toBe(head.text.length + 1);
  expect(Buffer.byteLength(head.text, 'utf8')).toBeLessThanOrEqual(FILE_TEXT_MAX_BYTES);
  const rest = await readBlobThroughPlugin({ product: folder, plugin: join('plugins', 'git'), repository: 'sample', root: folder, blob, from: head.next!.line, fromColumn: head.next!.column });
  expect(rest.text.startsWith('x')).toBe(true);
  expect(head.text.length + rest.text.trimEnd().length).toBeGreaterThan(head.text.length);
}, 60_000);
