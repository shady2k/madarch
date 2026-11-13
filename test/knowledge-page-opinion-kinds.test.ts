import { expect, test } from 'bun:test';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import { declaredKindReads } from '../src/fill/stages/plugin-contract.js';
import { pageOpinionKinds } from '../src/knowledge/markdown.js';
import { listProblems, type ProblemInput } from '../src/loop/views.js';

const manifest = {
  file: 'madarch/catalog.yaml',
  kinds: new Map([
    ['code.file', { name: 'code.file', fields: [{ name: 'path', type: 'text', binding: { kind: 'agent' } }] }],
    ['page', { name: 'page', fields: [{ name: 'body', type: 'text', binding: { kind: 'agent' } }] }],
    ['key-body', { name: 'key-body', key: ['body'], fields: [{ name: 'body', type: 'text', binding: { kind: 'agent' } }] }],
    ['unbound', { name: 'unbound', fields: [{ name: 'body', type: 'text' }] }],
    ['administrator-guide', { name: 'administrator-guide', fields: [{ name: 'body', type: 'text', binding: { kind: 'agent' } }] }],
  ]),
} as unknown as KindsManifest;

test('page opinion kinds require a generated body contract, excluding native and guide kinds', () => {
  expect([...pageOpinionKinds(manifest, declaredKindReads(manifest)).kinds.keys()]).toEqual(['page', 'key-body']);
});

test('problem page materialization reads only body contracts and still refuses malformed declared bodies', async () => {
  const requested: string[] = [];
  let body: unknown = 'A page';
  const input = {
    manifest,
    graph: { list: async (kind: string) => {
      requested.push(kind);
      if (kind !== 'page' && kind !== 'key-body') throw new Error(`unexpected non-page read: ${kind}`);
      return { rows: kind === 'key-body' ? [] : [{ key: 'page:one', kind, label: 'One', nodeIds: [], scope: '', properties: { body, file: 'docs/domains/one.md' } }], next: null, total: kind === 'page' ? 1 : 0 };
    } },
    findings: [], settings: { rules: {} },
  } as unknown as ProblemInput;
  expect((await listProblems(input)).problems).toEqual([]);
  expect(requested).toEqual(['page', 'key-body']);
  body = 7;
  await expect(listProblems(input)).rejects.toThrow('page:one.body');
});
