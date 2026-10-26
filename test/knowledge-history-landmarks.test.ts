import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryLandmarks, planLandmarks, MAX_HISTORY_LANDMARK_TAGS } from '../src/knowledge/history-landmarks.js';
import type { CommitFact } from '../src/extract/driver/git.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const walk = (count: number): CommitFact[] => Array.from({ length: count }, (_, index) => ({ hash: String(index).padStart(40, '0'), firstParent: index === 0 ? '' : String(index - 1).padStart(40, '0'), tree: 'tree', committerTime: '2026-01-01T00:00:00Z', authorTime: '2026-01-01T00:00:00Z', authorName: 'Fixture Author', subject: 'change', effectiveTime: `2026-01-01T00:00:00.${String(index).padStart(6, '0')}Z`, generation: index + 1, renames: [] }));

test('tree budget always keeps first, then newest ancestry, deduplicates aliases and exposes omitted points', () => {
  for (const earlier of [64, 65]) {
    const line = walk(earlier + 1);
    const tags = line.map((commit, index) => ({ ref: `refs/tags/arbitrary-${index}`, object: commit.hash, commit: commit.hash }));
    tags.push({ ref: 'refs/tags/alias', object: line[1]!.hash, commit: line[1]!.hash });
    const plan = planLandmarks(line, tags.reverse());
    expect(plan.points).toHaveLength(64);
    expect(plan.points[0]).toBe(line[0]!.hash);
    expect(plan.omitted).toBe(earlier - 64);
    expect(plan.snapshots['refs/tags/alias']).toBe(line[1]!.hash);
    expect(new Set(plan.points).size).toBe(plan.points.length);
    if (earlier === 65) { expect(plan.points).not.toContain(line[1]!.hash); expect(plan.points).toContain(line[64]!.hash); }
  }
});

test('unsupported landmarks retain valid first/tip and exact diagnostic identity', () => {
  const line = walk(3);
  const plan = planLandmarks(line, [{ ref: 'refs/tags/branch', object: 'off-line', commit: 'off-line' }, { ref: 'refs/tags/blob', object: 'blob', reason: 'not a commit' }]);
  expect(plan.snapshots).toEqual({ first: line[0]!.hash, last: line[2]!.hash });
  expect(plan.diagnostics).toEqual([{ ref: 'refs/tags/blob', object: 'blob', reason: 'not a commit' }, { ref: 'refs/tags/branch', object: 'off-line', reason: `commit is outside the pinned first-parent ancestry of ${line[2]!.hash}` }]);
});

function fixture(): { folder: string; git: (...args: string[]) => string; first: string } {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-landmark-')); folders.push(folder);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: folder, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main'); writeFileSync(join(folder, 'index.ts'), 'export const value = 1;\n');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial library');
  return { folder, git, first: git('rev-parse', 'HEAD') };
}

test('Git NUL records handle no tags, lightweight and annotated aliases without release-name heuristics', async () => {
  const { folder, git, first } = fixture();
  expect((await repositoryLandmarks(folder, 'HEAD')).snapshots).toEqual({ first, last: first });
  git('tag', 'strange-point'); git('-c', 'tag.gpgsign=false', 'tag', '-a', 'arbitrary-note', '-m', 'Annotated point');
  const plan = await repositoryLandmarks(folder, 'HEAD');
  expect(plan.snapshots).toEqual({ first, last: first, 'refs/tags/arbitrary-note': first, 'refs/tags/strange-point': first });
  expect(plan.points).toEqual([]); expect(plan.diagnostics).toEqual([]);
});

test('blob and off-first-parent tags are diagnostics, not a failed valid-tip fill', async () => {
  const { folder, git, first } = fixture();
  const blob = git('rev-parse', 'HEAD:index.ts'); git('tag', 'blob-point', blob);
  git('switch', '--quiet', '-c', 'side'); git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Side work');
  const side = git('rev-parse', 'HEAD'); git('tag', 'side-point'); git('switch', '--quiet', 'main');
  const plan = await repositoryLandmarks(folder, 'HEAD');
  expect(plan.snapshots).toEqual({ first, last: first });
  expect(plan.diagnostics.map((one) => [one.ref, one.object])).toEqual([['refs/tags/blob-point', blob], ['refs/tags/side-point', side]]);
});

test('discovery bounds tag peel work and diagnostics visibly instead of accepting a partial plan', async () => {
  const { folder, git, first } = fixture();
  const input = Array.from({ length: MAX_HISTORY_LANDMARK_TAGS + 1 }, (_, index) => `create refs/tags/budget-${index} ${first}\n`).join('');
  execFileSync('git', ['update-ref', '--stdin'], { cwd: folder, input, env: gitEnv(SAMPLE_IDENTITY), stdio: ['pipe', 'pipe', 'pipe'] });
  await expect(repositoryLandmarks(folder, 'HEAD')).rejects.toThrow(`${folder}: more than ${MAX_HISTORY_LANDMARK_TAGS} Git tags`);
});

test('repository/process failures name their path and command instead of becoming unsupported-tag success', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-landmark-not-git-')); folders.push(folder);
  await expect(repositoryLandmarks(folder, 'HEAD')).rejects.toThrow(folder);
  await expect(repositoryLandmarks(folder, 'HEAD')).rejects.toThrow('git log');
});
