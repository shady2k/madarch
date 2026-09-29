// Tests for the push checks (.githooks/pre-push, .shady2k/push.mjs), through
// real `git push` from a throwaway clone to a scratch bare remote.
//   node --test .shady2k/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(INDEX_FILE|DIR|WORK_TREE|PREFIX)$/.test(k)));
const made = [];
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const row = (id) => JSON.stringify({ id, title: 't', issue_type: 'task', status: 'open', labels: [], created_at: '2026-09-29T09:00:00Z', updated_at: '2026-09-29T09:00:00Z' });

function setup() {
  const top = mkdtempSync(join(tmpdir(), 'madarch-push-'));
  made.push(top);
  const root = join(top, 'repo');
  const remote = join(top, 'remote.git');
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env, input });
    return { code: r.status ?? 2, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  execFileSync('git', ['init', '-q', '--bare', remote], { env });
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'test'],
    ['config', 'commit.gpgsign', 'false'], ['config', 'tag.gpgsign', 'false'], ['remote', 'add', 'origin', remote]]) run('git', args);
  const files = [['adapter.mjs', '.shady2k/adapter.mjs'], ['push.mjs', '.shady2k/push.mjs'], ['config.json', '.shady2k/config.json'],
    ['checks/check-commits.mjs', '.shady2k/checks/check-commits.mjs'], ['checks/check-present.mjs', '.shady2k/checks/check-present.mjs'],
    ['checks/document-format.mjs', '.shady2k/checks/document-format.mjs'], ['../.githooks/pre-push', '.githooks/pre-push']];
  for (const [from, to] of files) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    copyFileSync(join(HERE, from), join(root, to));
  }
  mkdirSync(join(root, '.beads'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.beads/issues.jsonl'), `${row('madarch-t1')}\n`);
  writeFileSync(join(root, 'src/tool.ts'), 'export {};\n');
  writeFileSync(join(root, 'AGENTS.md'), '# agents\n\nThe tool lives in `src/tool.ts`.\n');
  const commit = (message) => { run('git', ['add', '-A']); return run('git', ['commit', '-q', '-m', message]); };
  commit('base\n\nTask: madarch-t1');
  run('git', ['push', '-q', 'origin', 'main']);
  run('git', ['config', 'core.hooksPath', '.githooks']);
  const push = (...args) => run('git', ['push', 'origin', ...args]);
  const hook = (input) => run('sh', ['.githooks/pre-push', 'origin', remote], input);
  return { root, run, commit, push, hook };
}

test('a tag and a new branch on a commit the remote holds introduce nothing and pass', () => {
  const s = setup();
  s.run('git', ['tag', '-a', 'v0', '-m', 'v0']);
  let r = s.push('v0');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /refs\/tags\/v0 -> refs\/tags\/v0 introduces no commits: nothing to check/);
  s.run('git', ['branch', 'held']);
  r = s.push('held');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /refs\/heads\/held introduces no commits: nothing to check/);
});

test('a branch or a tag carrying a commit without a task link is refused, naming the commit', () => {
  const s = setup();
  s.run('git', ['switch', '-q', '-c', 'work']);
  writeFileSync(join(s.root, 'note.md'), 'x\n');
  s.commit('no link here');
  let r = s.push('work');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Push refused: every commit refs\/heads\/work -> refs\/heads\/work introduces must name an existing task/);
  s.run('git', ['tag', 'unlinked']);
  r = s.push('unlinked');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /refs\/tags\/unlinked introduces 1 commit/);
  const ls = s.run('git', ['ls-remote', 'origin']);
  assert.doesNotMatch(ls.out, /work|unlinked/);
});

test('a linked commit passes; an unknown task is refused', () => {
  const s = setup();
  writeFileSync(join(s.root, 'note.md'), 'x\n');
  s.commit('note\n\nTask: madarch-nope');
  assert.equal(s.push('main').code, 1);
  s.run('git', ['commit', '-q', '--amend', '-m', 'note\n\nTask: madarch-t1']);
  const r = s.push('main');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /introduces 1 commit/);
});

test('a hook given no ref lines, a bad line, or a remote head this clone lacks is refused as unreadable', () => {
  const s = setup();
  let r = s.hook('');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no ref lines/);
  r = s.hook('refs/heads/main abc\n');
  assert.equal(r.code, 2, r.out);
  const head = s.run('git', ['rev-parse', 'HEAD']).out.trim();
  r = s.hook(`refs/heads/main ${head} refs/heads/main ${'1'.repeat(40)}\n`);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /this clone does not have: fetch, then push again/);
});

test('a deletion passes', () => {
  const s = setup();
  const r = s.hook(`(delete) ${'0'.repeat(40)} refs/heads/gone ${'0'.repeat(40)}\n`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /deletes a ref: nothing to check/);
});

test('a push removing a path a present document names is refused with that path; restoring it passes', () => {
  const s = setup();
  s.run('git', ['switch', '-q', '-c', 'move']);
  renameSync(join(s.root, 'src/tool.ts'), join(s.root, 'src/moved.ts'));
  s.commit('move\n\nTask: madarch-t1');
  let r = s.push('move');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/tool\.ts/);
  assert.match(r.out, /Push refused: a document that describes the present names a path/);
  renameSync(join(s.root, 'src/moved.ts'), join(s.root, 'src/tool.ts'));
  s.commit('move back\n\nTask: madarch-t1');
  r = s.push('move');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /new errors: 0/);
});

test('links resolve against the tracker at the pushed tip, not the checked-out one', () => {
  const s = setup();
  s.run('git', ['switch', '-q', '-c', 'side']);
  writeFileSync(join(s.root, '.beads/issues.jsonl'), `${row('madarch-t1')}\n${row('madarch-t2')}\n`);
  s.commit('file a task\n\nTask: madarch-t2');
  s.run('git', ['switch', '-q', 'main']);
  const r = s.push('side');
  assert.equal(r.code, 0, r.out);
});

test('documents are compared with the revision before the first commit pushed, not the last', () => {
  const s = setup();
  s.run('git', ['switch', '-q', '-c', 'two']);
  renameSync(join(s.root, 'src/tool.ts'), join(s.root, 'src/moved.ts'));
  s.commit('move\n\nTask: madarch-t1');
  writeFileSync(join(s.root, 'note.md'), 'x\n');
  s.commit('note\n\nTask: madarch-t1');
  const r = s.push('two');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/tool\.ts/);
});
