import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStagesIndex } from '../src/wiki/stages.js';

let root: string | undefined;
function product(): string {
  root = mkdtempSync(join(tmpdir(), 'madarch-completeness-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'kinds.yaml'), [
    'contract: 1', 'stages:', '  - id: custom-build', '    name: Build', '    expected:', '      - user story', 'kinds: []', '',
  ].join('\n'));
  return root;
}
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('product completeness snapshots', () => {
  test('renders the committed findings and source metadata, without inspecting current documents', () => {
    const folder = product();
    writeFileSync(join(folder, 'docs', 'completeness.json'), JSON.stringify({
      contract: 1, computedAt: '2026-10-13', sourceRevision: 'abc1234',
      findings: [{ stage: 'custom-build', message: 'A user story is missing.' }],
    }));
    // Changes to current documents do not affect the snapshot result.
    writeFileSync(join(folder, 'docs', 'story.md'), '# Current story\n');
    const index = readStagesIndex(folder);
    expect(index.stages.map((stage) => stage.id)).toEqual(['custom-build']);
    expect(index.stages[0]?.findings).toEqual(['A user story is missing.']);
    expect(index.completeness).toEqual({ computedAt: '2026-10-13', sourceRevision: 'abc1234' });
  });

  test('a snapshot symlink cannot read completeness data from outside the product', () => {
    const folder = product();
    const outside = mkdtempSync(join(tmpdir(), 'madarch-completeness-outside-'));
    try {
      const external = join(outside, 'completeness.json');
      writeFileSync(external, JSON.stringify({ contract: 1, computedAt: '2026-10-13', sourceRevision: 'abc1234', findings: [{ stage: 'custom-build', message: 'external' }] }));
      symlinkSync(external, join(folder, 'docs', 'completeness.json'));
      const index = readStagesIndex(folder);
      expect(index.stages[0]?.findings).toEqual([]);
      expect(index.completeness).toBeUndefined();
      expect(index.problems[0]?.message).toContain('not a regular file under the product docs folder');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test('a product without a registry has no built-in stage list', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-no-registry-'));
    try { expect(readStagesIndex(folder).stages).toEqual([]); } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test('absence of the snapshot yields no completeness findings or completeness metadata', () => {
    const index = readStagesIndex(product());
    expect(index.stages[0]?.findings).toEqual([]);
    expect(index.completeness).toBeUndefined();
    expect(index.problems).toEqual([]);
  });
});
