// Tests for the document adapter and wrapper (.shady2k/documents.mjs), run
// against throwaway git repositories: real files, real git, a real tracker export.
//   node --test .shady2k/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, decided } from './checks/check-docs.mjs';
import { parseChange, buildInputs, runCheck, commitGate, isProduct, revisionOf } from './documents.mjs';

const VISION = `# Vision

## Audience
Architects of large systems.

## Problem
Their diagrams go stale.

## Outcome
A graph that stays current.

## Exclusions
Runtime observation.
`;
const MILESTONE = `# MVP

## Outcomes and acceptance
1. A person sees the graph.

## Exclusions
- Authentication.
`;
const capability = (id, reqs) => `# ${id} capability

Capability: ${id}

## Purpose
What ${id} is for.
${reqs.map(([rid, statement, scenario = true]) => `
## Requirement: ${rid} — Title of ${rid}
${statement}
${scenario ? `
### Scenario: ${rid}-s1
- Given: a state
- When: an event
- Then: a result
` : ''}`).join('')}`;

const change = ({ id = 'add-views', base, tasks = 'm-leaf', kind = 'behavior', extra = '', coverage, preserves = 'None.', rationale = '' }) => `# Add views

Change: ${id}
Base: ${base}
Tasks: ${tasks}
Kind: ${kind}

## Intent
Let a person see views.

## Out of scope
Everything else.
${rationale ? `\n## Rationale\n${rationale}\n` : ''}
## Changes to requirements
See the proposed capability files beside this record.

## Preserved contracts
${preserves}

## Coverage
${coverage ?? '- views/show: test-views'}

## Blocking questions
None.
${extra}`;

const row = (id, type = 'task', extra = {}) => ({ id, title: id, issue_type: type, status: 'open', labels: ['mvp', 'views'], created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z', ...extra });
const child = (id, parent, extra = {}) => row(id, 'task', { dependencies: [{ issue_id: id, depends_on_id: parent, type: 'parent-child' }], ...extra });
const comment = (text, at = '2026-09-24T01:00:00Z') => ({ text, created_at: at });

const DOC_CONFIG = { mode: 'new', approvalFor: ['behavior'], exempt: { adoptedAt: '2026-09-24', tasks: ['m-old'] } };
const POLICY = {
  schemaVersion: 1, requireApproval: true,
  requiredChecks: [
    { id: 'static', kind: 'static', appliesTo: ['behavior', 'no-behavior'] },
    { id: 'test', kind: 'test', appliesTo: ['behavior', 'no-behavior'] },
    { id: 'mutation', kind: 'mutation', appliesTo: ['behavior', 'no-behavior'] },
    { id: 'review', kind: 'review' },
  ],
};

const made = [];
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'madarch-docs-'));
  made.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  };
  const remove = (path) => rmSync(join(root, path), { recursive: true, force: true });
  const tracker = (rows) => write('.beads/issues.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const commit = (msg = 'c') => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };
  write('.shady2k/config.json', { currentMilestone: 'mvp' });
  write('.shady2k/documents.json', DOC_CONFIG);
  write('.shady2k/document-policy.json', POLICY);
  write('docs/vision.md', VISION);
  write('docs/milestones/mvp.md', MILESTONE);
  tracker([row('m-leaf'), row('m-epic', 'epic'), row('m-other'), row('m-old'), child('m-split', 'm-old')]);
  const base = commit('base');
  return { root, git, write, remove, tracker, commit, base };
}

const ids = (violations) => [...new Set(violations.map((v) => v.id))].sort();
const approval = (r, id) => {
  const { model } = buildInputs(r.root, { phase: 'feature', change: id, candidate: 'worktree' });
  return comment(`approval: ${JSON.stringify({ changeDigest: digest(decided(model.change)), reference: 'owner: "yes" in the preflight' })}`);
};

test('product code is everything outside docs, tooling, tracker, hooks and root notes', () => {
  for (const p of ['src/a.ts', 'package.json', 'test/x.test.ts', 'docs2/a.md']) assert.equal(isProduct(p), true, p);
  for (const p of ['docs/vision.md', '.shady2k/documents.mjs', '.beads/issues.jsonl', '.githooks/pre-commit', 'README.md', '.gitattributes'])
    assert.equal(isProduct(p), false, p);
});

test('a change record parses its header, sections and bullets', () => {
  const c = parseChange(change({ base: 'abc', tasks: 'm-leaf, m-other', preserves: '- views/show: unchanged', coverage: '- views/show: test-views, review' }), 'add-views');
  assert.equal(c.id, 'add-views');
  assert.equal(c.base, 'abc');
  assert.deepEqual(c.taskIds, ['m-leaf', 'm-other']);
  assert.equal(c.kind, 'behavior');
  assert.equal(c.intent, 'Let a person see views.');
  assert.deepEqual(c.preserves, [{ capability: 'views', requirement: 'show' }]);
  assert.deepEqual(c.coverage, [{ capability: 'views', requirement: 'show', checks: ['test-views', 'review'] }]);
  assert.deepEqual(c.openQuestions, []);
});

test('a change record that cannot be read exactly is refused, not guessed', () => {
  assert.throws(() => parseChange(change({ base: 'abc', extra: '\n## Notes\nx\n' }), 'add-views'), /unrecognized section: Notes/);
  assert.throws(() => parseChange(change({ base: 'abc', extra: '\n## Intent\nagain\n' }), 'add-views'), /duplicate section: Intent/);
  assert.throws(() => parseChange(change({ base: 'abc' }).replace('Kind: behavior\n', ''), 'add-views'), /Kind/);
  assert.throws(() => parseChange(change({ base: 'abc', kind: 'feature' }), 'add-views'), /Kind/);
  assert.throws(() => parseChange(change({ base: 'abc' }), 'other-dir'), /directory/);
  assert.throws(() => parseChange(change({ base: 'abc', coverage: 'views/show is covered' }), 'add-views'), /Coverage/);
  assert.throws(() => parseChange(change({ base: 'abc' }).replace('Base: abc\n', ''), 'add-views'), /Base/);
});

test('product phase: a complete vision and charter pass, a missing vision is refused', () => {
  const r = repo();
  assert.deepEqual(runCheck(r.root, { phase: 'product', candidate: 'worktree' }).violations, []);
  r.remove('docs/vision.md');
  assert.deepEqual(ids(runCheck(r.root, { phase: 'product', candidate: 'worktree' }).violations), ['unfinished-content']);
});

test('deltas are computed from the pinned base, and an absent baseline admits additions', () => {
  const r = repo();
  r.write('docs/changes/add-views/change.md', change({ base: r.base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  const { model } = buildInputs(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' });
  assert.equal(model.change.deltas.length, 1);
  assert.equal(model.change.deltas[0].before, null);
  assert.equal(model.change.deltas[0].after.statement, 'When asked, the server shall show views.');
  assert.deepEqual(model.baseline, []);
  assert.deepEqual(model.current, []);
});

test('feature phase: ready change passes; missing scenario, unknown task, epic and missing approval are refused', () => {
  const r = repo();
  r.write('docs/changes/add-views/change.md', change({ base: r.base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  r.tracker([row('m-leaf', 'task', { comments: [] }), row('m-epic', 'epic')]);
  assert.deepEqual(ids(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations), ['missing-approval']);
  r.tracker([row('m-leaf', 'task', { comments: [approval(r, 'add-views')] }), row('m-epic', 'epic')]);
  assert.deepEqual(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations, []);

  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.', false]]));
  assert.ok(ids(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations).includes('missing-scenario'));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));

  for (const tasks of ['m-nope', 'm-epic']) {
    r.write('docs/changes/add-views/change.md', change({ base: r.base, tasks }));
    assert.ok(ids(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations).includes('untracked-change'), tasks);
  }
});

test('a requirement the proposal keeps unchanged is no delta', () => {
  const r = repo();
  r.write('docs/system/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  const base = r.commit('views accepted');
  r.write('docs/changes/add-views/change.md', change({ base, coverage: '- views/group: test-views' }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [
    ['show', 'When asked, the server shall show views.'], ['group', 'When a domain is large, the server shall group it.']]));
  r.tracker([row('m-leaf', 'task', { comments: [approval(r, 'add-views')] })]);
  const { model } = buildInputs(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' });
  assert.deepEqual(model.change.deltas.map((d) => d.requirement), ['group']);
  assert.deepEqual(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations, []);
});

test('stale requirement: the target moved the requirement since the pinned base', () => {
  const r = repo();
  r.write('docs/system/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  const base = r.commit('views accepted');
  r.write('docs/changes/add-views/change.md', change({ base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show grouped views.']]));
  r.tracker([row('m-leaf', 'task', { comments: [approval(r, 'add-views')] })]);
  assert.deepEqual(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations, []);
  // Another change lands on the target and rewrites the same requirement.
  r.write('docs/system/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views within a second.']]));
  r.commit('another change landed');
  assert.ok(ids(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations).includes('stale-base'));
});

test('an unrelated parallel change landing on the target does not disturb this one', () => {
  const r = repo();
  r.write('docs/changes/add-views/change.md', change({ base: r.base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  r.tracker([row('m-leaf', 'task', { comments: [approval(r, 'add-views')] })]);
  r.write('docs/system/capabilities/ingest.md', capability('ingest', [['clone', 'When given an address, the server shall clone it.']]));
  r.commit('ingest accepted elsewhere');
  assert.deepEqual(runCheck(r.root, { phase: 'feature', change: 'add-views', candidate: 'worktree' }).violations, []);
});

test('acceptance: missing and stale receipts are refused, receipts for this revision pass', () => {
  const r = repo();
  r.write('docs/changes/add-views/change.md', change({ base: r.base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  r.write('src/views.ts', 'export const views = 1;\n');
  const appr = approval(r, 'add-views');
  r.tracker([row('m-leaf', 'task', { comments: [appr] })]);
  const head = r.commit('implemented');
  assert.ok(ids(runCheck(r.root, { phase: 'acceptance', change: 'add-views', candidate: head }).violations).includes('unproved-check'));

  const rev = revisionOf(r.root, head);
  const receipts = (revision) => ['static', 'test', 'mutation', 'review', 'test-views'].map((id) =>
    comment(`check: ${JSON.stringify({ id, status: 'passed', reference: `log:${id}`, revision })}`));
  r.tracker([row('m-leaf', 'task', { comments: [appr, ...receipts('content:old')] })]);
  assert.ok(ids(runCheck(r.root, { phase: 'acceptance', change: 'add-views', candidate: head }).violations).includes('stale-evidence'));
  r.tracker([row('m-leaf', 'task', { comments: [appr, ...receipts(rev)] })]);
  assert.deepEqual(runCheck(r.root, { phase: 'acceptance', change: 'add-views', candidate: head }).violations, []);
  // The tracker file is not part of the revision: recording evidence does not stale it.
  r.commit('evidence recorded');
  assert.equal(revisionOf(r.root, 'HEAD'), rev);
});

test('close: current specs must equal the replayed change', () => {
  const r = repo();
  r.write('docs/changes/add-views/change.md', change({ base: r.base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  const appr = approval(r, 'add-views');
  r.commit('proposed');
  const rev = revisionOf(r.root, 'HEAD');
  const receipts = ['static', 'test', 'mutation', 'review', 'test-views'].map((id) =>
    comment(`check: ${JSON.stringify({ id, status: 'passed', reference: `log:${id}`, revision: rev })}`));
  r.tracker([row('m-leaf', 'task', { comments: [appr, ...receipts] })]);
  assert.deepEqual(ids(runCheck(r.root, { phase: 'close', change: 'add-views', candidate: 'worktree' }).violations), ['unsynced-current']);
  r.write('docs/system/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  assert.deepEqual(runCheck(r.root, { phase: 'close', change: 'add-views', candidate: 'worktree' }).violations, []);
});

test('commit gate: product code needs a ready change; docs alone need only the product phase', () => {
  const r = repo();
  const message = (tasks) => `Do it\n\nTask: ${tasks}\n`;
  r.write('docs/vision.md', VISION + '\nMore.\n');
  r.git('add', '-A');
  assert.equal(commitGate(r.root, message('m-leaf')).ok, true);
  r.commit('docs');

  r.write('src/views.ts', 'export const views = 1;\n');
  r.git('add', '-A');
  let result = commitGate(r.root, message('m-leaf'));
  assert.equal(result.ok, false);
  assert.match(result.text, /docs\/changes\/<change>\/change\.md/);
  assert.match(result.text, /Tasks: m-leaf/);

  r.write('docs/changes/add-views/change.md', change({ base: r.base, kind: 'supporting', coverage: 'None.', rationale: 'Tooling only.' }));
  r.git('add', '-A');
  result = commitGate(r.root, message('m-leaf'));
  assert.equal(result.ok, false);
  assert.match(result.text, /supporting/);

  r.write('docs/changes/add-views/change.md', change({ base: r.base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  r.tracker([row('m-leaf', 'task', { comments: [approval(r, 'add-views')] }), row('m-old'), child('m-split', 'm-old')]);
  r.git('add', '-A');
  assert.equal(commitGate(r.root, message('m-leaf')).ok, true, commitGate(r.root, message('m-leaf')).text);
});

test('commit gate: a task split from an exempt one stays exempt', () => {
  const r = repo();
  r.write('src/legacy.ts', 'export const legacy = 1;\n');
  r.git('add', '-A');
  assert.equal(commitGate(r.root, 'Fix\n\nTask: m-split\n').ok, true);
  assert.equal(commitGate(r.root, 'Fix\n\nTask: m-other\n').ok, false);
});

test('commit gate: a current spec edited without a change that owns it is refused', () => {
  const r = repo();
  r.write('docs/system/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  r.git('add', '-A');
  const result = commitGate(r.root, 'Edit\n\nTask: m-leaf\n');
  assert.equal(result.ok, false);
  assert.match(result.text, /docs\/system\/capabilities\/views\.md/);
});

test('the refusal says what the change kind owes and how to record a check', () => {
  const r = repo();
  r.write('docs/changes/add-views/change.md', change({ base: r.base }));
  r.write('docs/changes/add-views/capabilities/views.md', capability('views', [['show', 'When asked, the server shall show views.']]));
  r.tracker([row('m-leaf', 'task', { comments: [approval(r, 'add-views')] })]);
  const head = r.commit('implemented');
  const { text } = runCheck(r.root, { phase: 'acceptance', change: 'add-views', candidate: head });
  assert.match(text, /kind behavior/);
  assert.match(text, /owes/);
  assert.match(text, /br comments add m-leaf 'check: \{"id":"static"/);
  assert.match(text, new RegExp(revisionOf(r.root, head)));
  assert.ok(!existsSync(join(r.root, 'docs/system/capabilities/views.md')));
  assert.match(text, /docs\/system\/capabilities\/views\.md \(absent on the target/);
});
