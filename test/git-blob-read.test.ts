/**
 * A file's text by its blob id (madarch-u3vw.16, decision 0037): the git plugin reads git's object store, never a working
 * copy, so the text is the file at the revision the graph's facts were read from. A range answers the lines asked for, a
 * blob that is no UTF-8 text has no text, and the whole file is available with no size cap.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBlobText } from '../plugins/git/reader.js';

/** The host hands the plugin the git tool it resolved; the test does the same. */
process.env['MADARCH_TOOL_GIT'] = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' });

const root = mkdtempSync(join(tmpdir(), 'madarch-blob-read-'));
git(root, 'init', '--quiet', '--initial-branch=main');
writeFileSync(join(root, 'notes.md'), '# Notes\n\nThe first line.\nThe second line.\n');
writeFileSync(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
git(root, 'add', '-A');
git(root, 'commit', '--quiet', '-m', 'A note and an image');
const blobOf = (path: string): string => git(root, 'rev-parse', `HEAD:${path}`).trim();

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('the whole text of a blob is the file at the pinned revision, and a range is cut from its lines', async () => {
  const blob = blobOf('notes.md');
  const whole = await readBlobText(root, blob);
  expect(whole.binary).toBe(false);
  expect(whole.text).toBe('# Notes\n\nThe first line.\nThe second line.\n');
  expect(whole.lines).toBe(4);
  const range = await readBlobText(root, blob, { from: 3, to: 3 });
  expect(range.text).toBe('The first line.\n');
  expect(range.lines).toBe(4);
  // The text is the blob's, not the working copy's: a later edit on disk changes nothing.
  writeFileSync(join(root, 'notes.md'), '# Notes\n\nEdited on disk.\n');
  expect((await readBlobText(root, blob)).text).toContain('The first line.');
  expect((await readBlobText(root, blob)).text).not.toContain('Edited on disk.');
});

test('a binary blob has no text, and an id that is no object id is refused by name', async () => {
  const binary = await readBlobText(root, blobOf('image.bin'));
  expect(binary).toMatchObject({ binary: true, text: '' });
  await expect(readBlobText(root, 'not-a-blob')).rejects.toThrow('is no git object id');
});
