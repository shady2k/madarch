// Tests for the tracker adapter's claim operation (.shady2k/adapter.mjs): the
// judgement on pure data, then a real claim through br in a throwaway repository.
//   node --test .shady2k/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { claimPlan, normalize } from './adapter.mjs';

const leaf = (id, extra = {}) => ({ id, type: 'task', status: 'open', parent: 'stage', blockedBy: [], holder: null, ...extra });
const done = (id, extra = {}) => leaf(id, { status: 'implemented', integration: { revision: 'r1', evidence: 'x' }, ...extra });
const merged = (rev) => rev === 'r1';
const stage = { id: 'stage', type: 'epic', status: 'open', parent: null, blockedBy: [], holder: null };

test('work records: every [shady2k-time comment goes out raw, with its tracker id, time and author; others stay out', () => {
  const body = '[shady2k-time v1] claim\nat: 2026-09-27T10:00:00Z\n  trailing space kept  \n';
  const row = { id: 'm-1', title: 't', issue_type: 'task', status: 'open', labels: [], created_at: '2026-09-27T09:00:00Z', updated_at: '2026-09-27T09:00:00Z',
    comments: [
      { id: 7, issue_id: 'm-1', author: 'claude-coordinator:x@y:main#1', text: body, created_at: '2026-09-27T10:00:01Z' },
      { id: 8, issue_id: 'm-1', author: 'someone', text: 'implemented: {}', created_at: '2026-09-27T10:05:00Z' },
      { id: 9, issue_id: 'm-1', author: 'someone', text: ' [shady2k-time v1] not at the start', created_at: '2026-09-27T10:06:00Z' },
    ] };
  const [issue] = normalize(JSON.stringify(row) + '\n', 'test').issues;
  assert.deepEqual(issue.comments, [{ id: '7', at: '2026-09-27T10:00:01Z', author: 'claude-coordinator:x@y:main#1', body }]);
  const [plain] = normalize(JSON.stringify({ ...row, comments: undefined }) + '\n', 'test').issues;
  assert.deepEqual(plain.comments, []);
});

test('claim: a leaf with no open blocker is claimed without force', () => {
  assert.deepEqual(claimPlan([stage, leaf('a')], 'a', merged), { force: false });
  assert.deepEqual(claimPlan([stage, leaf('p', { status: 'closed' }), leaf('a', { blockedBy: ['p'] })], 'a', merged), { force: false });
});

test('claim: an implemented, merged prerequisite in the same stage is claimed past br\'s blocker check', () => {
  assert.deepEqual(claimPlan([stage, done('p'), leaf('a', { blockedBy: ['p'] })], 'a', merged), { force: true });
});

test('claim: every other prerequisite refuses, and says why', () => {
  const cases = [
    [[done('p', { integration: { revision: 'r2' } })], /does not contain; merge it first/],
    [[done('p', { integration: undefined })], /no recorded revision/],
    [[done('p', { parent: 'other' })], /another stage \(other\)/],
    [[leaf('p')], /is open; it must be closed, or implemented/],
    [[leaf('p', { status: 'submitted' })], /is submitted/],
    [[leaf('p', { status: 'active' })], /is active/],
    [[], /not in the tracker export/],
  ];
  for (const [pre, reason] of cases) {
    const plan = claimPlan([stage, ...pre, leaf('a', { blockedBy: ['p'] })], 'a', merged);
    assert.match(plan.refuse ?? '', reason);
  }
  // One good prerequisite does not excuse a bad one.
  const mixed = claimPlan([stage, done('p'), leaf('q'), leaf('a', { blockedBy: ['p', 'q'] })], 'a', merged);
  assert.match(mixed.refuse, /prerequisite q is open/);
});

test('claim: a same-stage prerequisite needs a real stage as the shared parent', () => {
  const task = { ...stage, type: 'task' };
  assert.match(claimPlan([task, done('p'), leaf('a', { blockedBy: ['p'] })], 'a', merged).refuse, /another stage/);
  assert.match(claimPlan([done('p'), leaf('a', { blockedBy: ['p'] })], 'a', merged).refuse, /another stage/);
});

test('claim: a prerequisite in an accepted, still open stage of the same feature counts once the accepted revision is here', () => {
  const feature = { id: 'feat', type: 'epic', status: 'open', parent: null, blockedBy: [], holder: null };
  const s1 = { id: 's1', type: 'epic', status: 'open', parent: 'feat', blockedBy: [], holder: null, acceptance: { revision: 'r1' } };
  const s2 = { id: 's2', type: 'epic', status: 'open', parent: 'feat', blockedBy: [], holder: null };
  const pre = done('p', { parent: 's1', integration: { revision: 'r0' } });
  const a = leaf('a', { parent: 's2', blockedBy: ['p'] });
  assert.deepEqual(claimPlan([feature, s1, s2, pre, a], 'a', merged), { force: true });
  // Not accepted yet, or accepted at a revision this checkout lacks: refused.
  assert.match(claimPlan([feature, { ...s1, acceptance: undefined }, s2, pre, a], 'a', merged).refuse, /stage s1 is not accepted/);
  assert.match(claimPlan([feature, { ...s1, acceptance: { revision: 'r2' } }, s2, pre, a], 'a', merged).refuse, /accepted at r2, which this checkout does not contain/);
  // Another feature's stage: it must close first, accepted or not.
  const other = { ...s1, parent: 'other-feature' };
  assert.match(claimPlan([feature, other, s2, pre, a], 'a', merged).refuse, /another feature/);
  // A prerequisite that is not implemented is still refused, whatever its stage.
  assert.match(claimPlan([feature, s1, s2, leaf('p', { parent: 's1' }), a], 'a', merged).refuse, /prerequisite p is open/);
});

test('acceptance: a stage carries the final revision of its latest accepted: record', () => {
  const row = (comments) => ({ id: 's', title: 't', issue_type: 'epic', status: 'open', labels: [], comments });
  const c = (id, text) => ({ id, text, author: 'x', created_at: `2026-10-0${id}T00:00:00Z` });
  const one = (comments) => normalize(JSON.stringify(row(comments)) + '\n', 'test').issues[0].acceptance;
  assert.deepEqual(one([c(1, 'accepted: {"base": "b1", "final": "f1"}\nmore')]), { revision: 'f1' });
  assert.deepEqual(one([c(1, 'accepted: stage s — title\n\nBase: aaa1111\nFinal: bbb2222cc')]), { revision: 'bbb2222cc' });
  assert.deepEqual(one([c(1, 'accepted: x\nBase revision: aaa1111. Final revision: ccc3333 (documents).')]), { revision: 'ccc3333' });
  assert.deepEqual(one([c(1, 'accepted: {"final": "f1"}'), c(2, 'accepted: {"final": "f2"}')]), { revision: 'f2' });
  assert.equal(one([c(1, 'accepted: owner said yes')]), undefined);
  assert.equal(one([c(1, 'note: accepted: {"final": "f1"}')]), undefined);
});

test('claim: the recheck after claiming wants the claim held by this actor and the blockers still good', () => {
  const held = leaf('a', { status: 'active', holder: 'w1', blockedBy: ['p'] });
  assert.deepEqual(claimPlan([stage, done('p'), held], 'a', merged, 'w1'), { force: true });
  assert.match(claimPlan([stage, done('p'), held], 'a', merged, 'w2').refuse, /held by w1, not by w2/);
  assert.match(claimPlan([stage, leaf('p'), held], 'a', merged, 'w1').refuse, /prerequisite p is open/);
});

test('claim: only an open, unheld leaf is claimed', () => {
  assert.match(claimPlan([stage, leaf('a')], 'stage', merged).refuse, /not a leaf/);
  assert.match(claimPlan([{ ...stage, id: 'lone' }], 'lone', merged).refuse, /not a leaf/);
  assert.match(claimPlan([stage, leaf('a', { holder: 'w1' })], 'a', merged).refuse, /already held by w1/);
  assert.match(claimPlan([stage, leaf('a', { status: 'active' })], 'a', merged).refuse, /is active, not open/);
  assert.match(claimPlan([stage, leaf('a', { status: 'implemented' })], 'a', merged).refuse, /is implemented, not open/);
  assert.match(claimPlan([stage], 'missing', merged).refuse, /not in the tracker export/);
});

// A real tracker: br must be on PATH. The claim runs through the adapter's own
// command line, as a worker would call it.
const hasBr = (() => { try { execFileSync('br', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(INDEX_FILE|DIR|WORK_TREE|PREFIX)$/.test(k)));

test('claim: through br, atomic and exclusive, keeping the edge', { skip: !hasBr && 'br is not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-claim-'));
  try {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() }).trim();
    const tryRun = (cmd, args) => { try { return { ok: true, out: run(cmd, args) }; } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; } };
    run('git', ['init', '-q', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@example.com']);
    run('git', ['config', 'user.name', 'test']);
    run('git', ['config', 'commit.gpgsign', 'false']);
    run('git', ['commit', '-q', '--allow-empty', '-m', 'base']);
    const head = run('git', ['rev-parse', 'HEAD']);
    mkdirSync(join(root, '.shady2k'));
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'adapter.mjs'), join(root, '.shady2k/adapter.mjs'));
    run('br', ['init', '--prefix', 't', '--actor', 'test']);
    const make = (args) => run('br', ['create', '--json', '--actor', 'test', ...args]);
    const idOf = (json) => JSON.parse(json).id;
    const s = idOf(make(['--type', 'epic', '--title', 'Stage', '--description', '## Done when\nx']));
    const p = idOf(make(['--type', 'task', '--title', 'Pre', '--parent', s]));
    const a = idOf(make(['--type', 'task', '--title', 'Dep', '--parent', s]));
    const b = idOf(make(['--type', 'task', '--title', 'Early', '--parent', s]));
    run('br', ['dep', 'add', a, p, '--actor', 'test']);
    run('br', ['dep', 'add', b, p, '--actor', 'test']);
    const claim = (id, actor) => tryRun('node', ['.shady2k/adapter.mjs', 'claim', id, '--actor', actor]);

    // Before the prerequisite is implemented, the dependant is refused.
    const early = claim(b, 'w2');
    assert.equal(early.ok, false);
    assert.match(early.out, /is open; it must be closed, or implemented/);

    run('br', ['update', p, '--add-label', 'implemented', '--actor', 'test']);
    run('br', ['comments', 'add', p, `implemented: {"revision":"${head}","evidence":"test"}`, '--actor', 'test']);

    const first = claim(a, 'w1');
    assert.equal(first.ok, true, first.out);
    const second = claim(a, 'w2');
    assert.equal(second.ok, false);
    assert.match(second.out, /is active, not open/);
    // A worker that read the export before w1's claim still loses: br's own
    // claim, forced past the blocker check, stays exclusive.
    const raced = tryRun('br', ['update', a, '--claim', '--force', '--actor', 'w2']);
    assert.equal(raced.ok, false);
    assert.match(raced.out, /already assigned to w1/);

    const shown = JSON.parse(run('br', ['show', a, '--json']));
    const issue = Array.isArray(shown) ? shown[0] : shown;
    assert.equal(issue.status, 'in_progress');
    assert.equal(issue.assignee, 'w1');
    assert.ok((issue.dependencies ?? []).some((d) => (d.depends_on_id ?? d.id) === p && (d.type ?? d.dependency_type) === 'blocks'), 'the blocking edge is kept');

    // A later stage of the same feature: claimed once the earlier stage is
    // accepted at a revision this checkout holds, while that stage stays open.
    const f = idOf(make(['--type', 'epic', '--title', 'Feature', '--description', '## Done when\nx']));
    const s1 = idOf(make(['--type', 'epic', '--title', 'Stage 1', '--parent', f, '--description', '## Done when\nx']));
    const s2 = idOf(make(['--type', 'epic', '--title', 'Stage 2', '--parent', f, '--description', '## Done when\nx']));
    const p1 = idOf(make(['--type', 'task', '--title', 'Pre 1', '--parent', s1]));
    const a2 = idOf(make(['--type', 'task', '--title', 'Dep 2', '--parent', s2]));
    run('br', ['dep', 'add', a2, p1, '--actor', 'test']);
    run('br', ['update', p1, '--add-label', 'implemented', '--actor', 'test']);
    run('br', ['comments', 'add', p1, `implemented: {"revision":"${head}","evidence":"test"}`, '--actor', 'test']);
    const before = claim(a2, 'w3');
    assert.equal(before.ok, false);
    assert.match(before.out, /is not accepted yet/);
    run('br', ['comments', 'add', s1, `accepted: {"base":"${head}","final":"${head}"}`, '--actor', 'test']);
    const after = claim(a2, 'w3');
    assert.equal(after.ok, true, after.out);
    const stage1 = JSON.parse(run('br', ['show', s1, '--json']));
    assert.equal((Array.isArray(stage1) ? stage1[0] : stage1).status, 'open', 'the accepted stage stays open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
