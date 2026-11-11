import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closingCommit, graphScopeLines, scopeLineKey } from '../src/loop/closure.js';
import type { PlannedTask } from '../src/loop/tasks.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('section closure uses opinion extents, not the text at the closing commit', () => {
  const path = mkdtempSync(join(tmpdir(), 'madarch-closure-opinions-'));
  folders.push(path);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: path, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' });
  git('init', '-b', 'main');
  writeFileSync(join(path, 'README.md'), 'not Markdown section syntax\nfirst\nsecond\n');
  git('add', '.'); git('commit', '-m', 'Initial');
  writeFileSync(join(path, 'README.md'), 'not Markdown section syntax\nchanged\nsecond\n');
  git('add', '.'); git('commit', '-m', 'Update\n\nTask: change');
  const task: PlannedTask = {
    slug: 'change', id: 'task:change', file: 'docs/tasks/change.md', title: 'Change', status: 'open', question: '', answer: '',
    grounds: [], scope: [{ type: 'section', path: 'README.md', anchor: 'producer-section' }],
    by: { name: 'Ada', email: 'ada@example.test', verified: 'local' }, at: '2020-01-01T00:00:00Z', closedBy: null, closedAt: null,
  };
  const repositories = [{ name: 'example', path }];
  const notes: string[] = [];
  expect(closingCommit(task, repositories, { notes, scopeLines: new Map([[scopeLineKey('other-repository', git('rev-parse', 'HEAD').trim(), 'README.md', 'producer-section'), { start: 2, end: 2 }]]) })).toBeUndefined();
  expect(notes.join('\n')).toContain('no section extent opinion');
  expect(closingCommit(task, repositories, { scopeLines: new Map([[scopeLineKey('example', 'old-revision', 'README.md', 'producer-section'), { start: 2, end: 2 }]]) })).toBeUndefined();
  expect(closingCommit(task, repositories)).toBeUndefined();
  expect(closingCommit(task, repositories, { scopeLines: new Map([[scopeLineKey('example', git('rev-parse', 'HEAD').trim(), 'README.md', 'producer-section'), { start: 3, end: 3 }]]) })).toBeUndefined();
  expect(closingCommit(task, repositories, { scopeLines: new Map([[scopeLineKey('example', git('rev-parse', 'HEAD').trim(), 'README.md', 'producer-section'), { start: 2, end: 2 }]]) })?.commit).toBe(git('rev-parse', 'HEAD').trim());
});

test('section extent opinions are paginated and keep exact spans', async () => {
  const calls: (string | undefined)[] = [];
  const ranges = await graphScopeLines({ list: async (kind, options) => {
    expect(kind).toBe('document');
    calls.push(options?.after);
    return options?.after === undefined ? { rows: [{ key: 'document:first', kind, label: 'First', evidence: [{ field: 'anchors', repository: 'example', path: 'README.md', commit: 'revision', lineStart: 2, lineEnd: 4 }], properties: { repository: 'example', path: 'README.md', anchors: { first: { title: 'First', markdown: 'First', start: 2, end: 4 } } }, nodeIds: [], scope: '', span: { path: 'README.md', lineStart: 2, lineEnd: 4, byteStart: 0, byteEnd: 20 } }], total: 1, next: 'next' }
      : { rows: [], total: 0, next: null };
  } }, { kinds: new Map([['document', { name: 'document', fields: [{ name: 'markdown' }] }]]) } as unknown as Pick<import('../src/product/manifest/kinds.js').KindsManifest, 'kinds'>);
  expect(calls).toEqual([undefined, 'next']);
  expect(ranges.get(scopeLineKey('example', 'revision', 'README.md', 'first'))).toEqual({ start: 2, end: 4 });
});

test('product document revision uses null repository identity despite transport evidence repository name', async () => {
  const ranges = await graphScopeLines({ list: async () => ({ rows: [{
    key: 'document:product', kind: 'document', label: 'Product', nodeIds: [], scope: '',
    properties: { repository: null, path: 'README.md', commit: 'product-revision', anchors: { usage: { title: 'Usage', markdown: 'Use it', start: 3, end: 5 } } },
    evidence: [{ field: 'anchors', repository: 'product-transport', path: 'README.md', commit: 'transport-revision', lineStart: 3, lineEnd: 5 }],
  }], total: 1, next: null }) }, { kinds: new Map([['document', { name: 'document', fields: [{ name: 'markdown' }] }]]) } as unknown as Pick<import('../src/product/manifest/kinds.js').KindsManifest, 'kinds'>);
  expect(ranges.get(scopeLineKey(null, 'product-revision', 'README.md', 'usage'))).toEqual({ start: 3, end: 5 });
  expect(ranges.has(scopeLineKey(null, 'transport-revision', 'README.md', 'usage'))).toBe(false);
});
