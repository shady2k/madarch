// Tests for the privacy guard (.githooks/privacy-guard.sh) and the connect
// command (.shady2k/connect.sh), run in throwaway clones of this repository with
// a scratch per-user config directory.
//   node --test .shady2k/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const cleanEnv = (extra) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(INDEX_FILE|DIR|WORK_TREE|PREFIX)$/.test(k))),
  ...extra,
});
const made = [];
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function clone() {
  const top = mkdtempSync(join(tmpdir(), 'madarch-hooks-'));
  made.push(top);
  const root = join(top, 'repo');
  const xdg = join(top, 'xdg');
  mkdirSync(join(xdg, 'madarch'), { recursive: true });
  const env = cleanEnv({ XDG_CONFIG_HOME: xdg });
  const run = (cmd, args) => {
    try { return { code: 0, out: execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }) }; }
    catch (e) { return { code: e.status ?? 2, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
  };
  mkdirSync(root);
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@example.com']);
  run('git', ['config', 'user.name', 'test']);
  run('git', ['config', 'commit.gpgsign', 'false']);
  // Every local file a hook reads: connect.sh refuses a clone missing one.
  for (const [from, to] of [
    ['../.githooks/privacy-guard.sh', '.githooks/privacy-guard.sh'], ['connect.sh', '.shady2k/connect.sh'],
    ['adapter.mjs', '.shady2k/adapter.mjs'], ['../.githooks/tracker-home.sh', '.githooks/tracker-home.sh'],
    ['../.githooks/post-checkout', '.githooks/post-checkout'], ['config.json', '.shady2k/config.json'],
    ['push.mjs', '.shady2k/push.mjs'], ['jsonl-clean.mjs', '.shady2k/jsonl-clean.mjs'],
    ['documents.mjs', '.shady2k/documents.mjs'], ['documents.json', '.shady2k/documents.json'],
    ['document-policy.json', '.shady2k/document-policy.json'],
    ['checks/check.mjs', '.shady2k/checks/check.mjs'], ['checks/time-format.mjs', '.shady2k/checks/time-format.mjs'],
    ['checks/check-commits.mjs', '.shady2k/checks/check-commits.mjs'], ['checks/check-present.mjs', '.shady2k/checks/check-present.mjs'],
    ['checks/document-format.mjs', '.shady2k/checks/document-format.mjs'], ['checks/check-product.mjs', '.shady2k/checks/check-product.mjs'],
    ['../.githooks/pre-commit', '.githooks/pre-commit'], ['../.githooks/commit-msg', '.githooks/commit-msg'],
    ['../.githooks/pre-push', '.githooks/pre-push'],
  ]) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    copyFileSync(join(HERE, from), join(root, to));
  }
  mkdirSync(join(root, '.beads'));
  writeFileSync(join(root, '.beads/issues.jsonl'), '');
  run('git', ['add', '-A']);
  run('git', ['commit', '-q', '-m', 'base']);
  const userList = (text) => writeFileSync(join(xdg, 'madarch/private-patterns'), text);
  const stage = (path, text) => { writeFileSync(join(root, path), text); run('git', ['add', path]); };
  const guard = () => run('sh', ['.githooks/privacy-guard.sh']);
  return { root, run, userList, stage, guard };
}

test('guard: refuses without a pattern list, and with only comments', () => {
  const c = clone();
  c.stage('a.md', 'hello\n');
  let r = c.guard();
  assert.equal(r.code, 1);
  assert.match(r.out, /no private pattern list[\s\S]*sh \.shady2k\/connect\.sh/);
  c.userList('# only a comment\n\n');
  assert.equal(c.guard().code, 1);
});

test('guard: a malformed pattern refuses instead of matching nothing', () => {
  const c = clone();
  c.userList('secret-xyz\n[\n');
  c.stage('a.md', 'secret-xyz\n');
  const r = c.guard();
  assert.equal(r.code, 1);
  assert.match(r.out, /not a valid extended regular expression/);
});

test('guard: an unreadable list refuses, even when the other list is fine', { skip: process.getuid?.() === 0 && 'root reads every file' }, () => {
  const c = clone();
  c.userList('from-user-list\n');
  const clonePath = join(c.root, '.git/info/private-patterns');
  writeFileSync(clonePath, 'from-clone-list\n');
  chmodSync(clonePath, 0o000);
  c.stage('a.md', 'from-clone-list\n');
  const r = c.guard();
  assert.equal(r.code, 1);
  assert.match(r.out, /cannot be read/);
});

test('guard: a textconv driver cannot hide staged content', () => {
  const c = clone();
  c.userList('secret-xyz\n');
  writeFileSync(join(c.root, '.gitattributes'), '*.txt diff=hide\n');
  c.run('git', ['config', 'diff.hide.textconv', 'true']);
  c.stage('.gitattributes', '*.txt diff=hide\n');
  c.stage('a.txt', 'secret-xyz\n');
  assert.equal(c.guard().code, 1);
});

test('guard: a dangling link in place of a list refuses', () => {
  const c = clone();
  c.userList('from-user-list\n');
  symlinkSync(join(c.root, 'nowhere'), join(c.root, '.git/info/private-patterns'));
  c.stage('a.md', 'x\n');
  assert.match(c.guard().out, /cannot be read/);
});

test('guard: content starting with "++" and binary files are scanned', () => {
  const c = clone();
  c.userList('secret-xyz\n');
  c.stage('a.js', '++counter; // secret-xyz\n');
  assert.equal(c.guard().code, 1);
  c.run('git', ['reset', '-q']);
  writeFileSync(join(c.root, 'b.bin'), Buffer.from('\0\0binary secret-xyz\0'));
  c.run('git', ['add', 'b.bin']);
  assert.equal(c.guard().code, 1);
});

test('guard: reads both lists; a match in content or in a file name refuses, clean content passes', () => {
  const c = clone();
  c.userList('from-user-list\n');
  writeFileSync(join(c.root, '.git/info/private-patterns'), 'from-clone-list\n');
  c.stage('a.md', 'nothing private\n');
  assert.equal(c.guard().code, 0);
  c.stage('b.md', 'mentions FROM-USER-LIST here\n');
  assert.equal(c.guard().code, 1);
  c.run('git', ['reset', '-q']);
  c.stage('c.md', 'from-clone-list\n');
  assert.equal(c.guard().code, 1);
  c.run('git', ['reset', '-q']);
  c.stage('from-clone-list.md', 'x\n');
  assert.equal(c.guard().code, 1);
});

const hasBr = (() => { try { execFileSync('br', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('connect: names what is missing and changes nothing', () => {
  const c = clone();
  writeFileSync(join(c.root, '.beads/issues.jsonl'), '{not json\n');
  const r = c.run('sh', ['.shady2k/connect.sh']);
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing was changed/);
  assert.match(r.out, /private pattern list/);
  assert.match(r.out, /readable tracker export/);
  assert.equal(c.run('git', ['config', '--get', 'core.hooksPath']).code, 1, 'core.hooksPath must stay unset');
  assert.equal(c.run('git', ['config', '--get', 'filter.br-portable-path.clean']).code, 1, 'the filter must stay unset');
});

test('connect: a file a hook reads is missing, so it names it and changes nothing', () => {
  const c = clone();
  c.userList('secret-xyz\n');
  rmSync(join(c.root, '.shady2k/checks/check-product.mjs'));
  const r = c.run('sh', ['.shady2k/connect.sh']);
  assert.equal(r.code, 1);
  assert.match(r.out, /check-product\.mjs is missing/);
  assert.equal(c.run('git', ['config', '--get', 'core.hooksPath']).code, 1, 'core.hooksPath must stay unset');
});

test('connect: connects, and a rerun is harmless', { skip: !hasBr && 'br is not installed' }, () => {
  const c = clone();
  c.userList('secret-xyz\n');
  c.run('br', ['init', '--prefix', 't', '--actor', 'test']);
  for (let i = 0; i < 2; i++) {
    const r = c.run('sh', ['.shady2k/connect.sh']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /this clone is connected/);
  }
  assert.equal(c.run('git', ['config', '--get', 'core.hooksPath']).out.trim(), '.githooks');
  assert.equal(c.run('git', ['config', '--get', 'filter.br-portable-path.required']).out.trim(), 'true');
});

test('connect: a worktree gets its own tracker database, and its br writes touch only its own export', { skip: !hasBr && 'br is not installed' }, () => {
  const c = clone();
  c.userList('secret-xyz\n');
  c.run('br', ['init', '--prefix', 't', '--actor', 'test']);
  c.run('br', ['create', '--title', 'one', '--type', 'task', '--actor', 'test']);
  c.run('git', ['add', '-A']);
  c.run('git', ['commit', '-q', '-m', 'tracker']);
  assert.equal(c.run('sh', ['.shady2k/connect.sh']).code, 0);
  const wt = join(c.root, '.claude/worktrees/w');
  // Added with the hooks off (post-checkout would connect it), as a worktree made before them was.
  c.run('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', wt, '-b', 'w']);
  const inWt = (cmd, args) => { try { return { code: 0, out: execFileSync(cmd, args, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv({ XDG_CONFIG_HOME: join(c.root, '../xdg') }) }) }; } catch (e) { return { code: e.status ?? 2, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; } };

  // Unconnected, br in the worktree resolves to the main checkout's database: the guard refuses.
  const before = inWt('sh', ['.githooks/tracker-home.sh']);
  assert.equal(before.code, 1, before.out);
  assert.match(before.out, /another checkout's tracker[\s\S]*sh \.shady2k\/connect\.sh/);

  const r = inWt('sh', ['.shady2k/connect.sh']);
  assert.equal(r.code, 0, r.out);
  assert.equal(inWt('br', ['where']).out.split('\n')[0].trim(), join(wt, '.beads'));
  assert.equal(inWt('sh', ['.githooks/tracker-home.sh']).code, 0);
  inWt('br', ['create', '--title', 'two', '--type', 'task', '--actor', 'test']);
  assert.equal(c.run('git', ['status', '--short', '.beads/issues.jsonl']).out.trim(), '', 'the main checkout\'s export must not change');
  assert.match(inWt('git', ['status', '--short', '.beads/issues.jsonl']).out, /M .beads\/issues.jsonl/);
  // The worktree's database was imported from its own export: its write keeps every earlier issue.
  const titles = readFileSync(join(wt, '.beads/issues.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).title).sort();
  assert.deepEqual(titles, ['one', 'two']);
  // The main checkout is its own home.
  assert.equal(c.run('sh', ['.githooks/tracker-home.sh']).code, 0);
});

test('post-checkout: a worktree added to a connected clone gets its own tracker database at once', { skip: !hasBr && 'br is not installed' }, () => {
  const c = clone();
  c.userList('secret-xyz\n');
  c.run('br', ['init', '--prefix', 't', '--actor', 'test']);
  c.run('br', ['create', '--title', 'one', '--type', 'task', '--actor', 'test']);
  c.run('git', ['add', '-A']);
  c.run('git', ['commit', '-q', '-m', 'tracker']);
  assert.equal(c.run('sh', ['.shady2k/connect.sh']).code, 0);
  const wt = join(c.root, '.claude/worktrees/w');
  const added = c.run('git', ['worktree', 'add', '-q', wt, '-b', 'w']);
  assert.equal(added.code, 0, added.out);
  const inWt = (cmd, args) => execFileSync(cmd, args, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv({ XDG_CONFIG_HOME: join(c.root, '../xdg') }) });
  assert.equal(inWt('br', ['where']).split('\n')[0].trim(), join(wt, '.beads'));
  inWt('br', ['create', '--title', 'two', '--type', 'task', '--actor', 'test']);
  assert.equal(c.run('git', ['status', '--short', '.beads/issues.jsonl']).out.trim(), '', 'the main checkout\'s export must not change');
  // A plain branch switch in a connected checkout changes nothing and says nothing.
  const sw = spawnSync('git', ['switch', '-q', '-c', 'other'], { cwd: c.root, encoding: 'utf8', env: cleanEnv({ XDG_CONFIG_HOME: join(c.root, '../xdg') }) });
  assert.equal(sw.status, 0);
  assert.equal(`${sw.stdout}${sw.stderr}`.trim(), '');
});
