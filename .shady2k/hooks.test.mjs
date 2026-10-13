// Tests for the privacy guard (.githooks/privacy-guard.sh) and the connect
// command (.shady2k/connect.sh), run in throwaway clones of this repository with
// a scratch per-user config directory.
//   node --test .shady2k/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, symlinkSync, existsSync, lstatSync, realpathSync } from 'node:fs';
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

// The files connect.sh refuses a checkout without: read from the command itself,
// so a file added to one is added to the other.
function connectList() {
  const text = readFileSync(join(HERE, 'connect.sh'), 'utf8');
  const from = text.indexOf('# Every local file a hook reads');
  const block = text.slice(from, text.indexOf('; do', from));
  return block.split('\n').flatMap((line) => line.replace(/\\$/, '').trim().split(/\s+/))
    .filter((word) => /^\.(shady2k|githooks|beads)\//.test(word));
}

function clone() {
  const top = mkdtempSync(join(tmpdir(), 'madarch-hooks-'));
  made.push(top);
  const root = join(top, 'repo');
  const xdg = join(top, 'xdg');
  const state = join(top, 'state');
  const remote = join(top, 'remote.git');
  mkdirSync(join(xdg, 'madarch'), { recursive: true });
  const env = cleanEnv({ XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: state });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
  const run = (cmd, args) => {
    try { return { code: 0, out: execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }) }; }
    catch (e) { return { code: e.status ?? 2, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
  };
  mkdirSync(root);
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@example.com']);
  run('git', ['config', 'user.name', 'test']);
  run('git', ['config', 'commit.gpgsign', 'false']);
  run('git', ['remote', 'add', 'origin', remote]);
  // Every local file a hook reads, taken from the connect command's own list so
  // the two cannot drift: connect.sh refuses a clone missing one of them. The
  // tracker export is not on that list here; the test writes its own below.
  const listed = connectList();
  if (listed.length < 15) throw new Error(`the connect command's file list could not be read (${listed.length} entries)`);
  for (const path of listed) {
    if (!path.startsWith('.shady2k/') && !path.startsWith('.githooks/')) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(HERE, path.startsWith('.githooks/') ? `../${path}` : path.slice('.shady2k/'.length)), join(root, path));
  }
  writeFileSync(join(root, '.gitignore'), '/.beads\n');
  run('git', ['add', '-A']);
  run('git', ['commit', '-q', '-m', 'base']);
  run('git', ['push', '-q', 'origin', 'main']);
  const userList = (text) => writeFileSync(join(xdg, 'madarch/private-patterns'), text);
  const stage = (path, text) => { writeFileSync(join(root, path), text); run('git', ['add', path]); };
  const guard = () => run('sh', ['.githooks/privacy-guard.sh']);
  const inDir = (dir, cmd, args) => { try { return { code: 0, out: execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }) }; } catch (e) { return { code: e.status ?? 2, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; } };
  return { root, run, userList, stage, guard, env, inDir, store: join(state, 'madarch', 'tracker') };
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
  const r = c.run('sh', ['.shady2k/connect.sh']);
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing was changed/);
  assert.match(r.out, /private pattern list/);
  assert.equal(c.run('git', ['config', '--get', 'core.hooksPath']).code, 1, 'core.hooksPath must stay unset');
  assert.equal(existsSync(c.store), false, 'no store is made');
  assert.equal(existsSync(join(c.root, '.beads')), false, 'no .beads link is made');
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

test('connect: a real .beads folder is a second tracker, refused and left alone', { skip: !hasBr && 'br is not installed' }, () => {
  const c = clone();
  c.userList('secret-xyz\n');
  mkdirSync(join(c.root, '.beads'));
  writeFileSync(join(c.root, '.beads/issues.jsonl'), '');
  const r = c.run('sh', ['.shady2k/connect.sh']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a real \.beads folder/);
  assert.equal(lstatSync(join(c.root, '.beads')).isDirectory(), true);
});

test('connect: makes the machine store off the branches, links .beads to it, and a rerun is harmless', { skip: !hasBr && 'br is not installed' }, () => {
  const c = clone();
  c.userList('secret-xyz\n');
  for (let i = 0; i < 2; i++) {
    const r = c.run('sh', ['.shady2k/connect.sh']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /this clone is connected/);
  }
  assert.equal(c.run('git', ['config', '--get', 'core.hooksPath']).out.trim(), '.githooks');
  assert.equal(c.run('git', ['config', '--get', 'filter.br-portable-path.required']).code, 1, 'the old path filter is gone');
  assert.equal(lstatSync(join(c.root, '.beads')).isSymbolicLink(), true);
  assert.equal(realpathSync(join(c.root, '.beads')), realpathSync(join(c.store, '.beads')));
  assert.match(c.run('git', ['ls-remote', 'origin', 'refs/tracker/state']).out, /refs\/tracker\/state/, 'the store is on its ref');
  assert.equal(c.run('git', ['branch', '-a', '--contains', 'refs/tracker/state']).out.trim(), '', 'no branch contains the ref');
  assert.equal(c.run('sh', ['.githooks/tracker-home.sh']).code, 0);
});

test('connect: a worktree links to the one store, and its br writes are the main checkout\'s too', { skip: !hasBr && 'br is not installed' }, () => {
  const c = clone();
  c.userList('secret-xyz\n');
  assert.equal(c.run('sh', ['.shady2k/connect.sh']).code, 0);
  const wt = join(dirname(c.root), 'elsewhere', 'w');
  // Added with the hooks off (post-checkout would link it), as a worktree made before them was.
  c.run('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', wt, '-b', 'w']);
  const before = c.inDir(wt, 'sh', ['.githooks/tracker-home.sh']);
  assert.equal(before.code, 1, before.out);
  assert.match(before.out, /does not link to the machine's tracker store[\s\S]*sh \.shady2k\/connect\.sh/);
  const r = c.inDir(wt, 'sh', ['.shady2k/connect.sh']);
  assert.equal(r.code, 0, r.out);
  assert.equal(c.inDir(wt, 'sh', ['.githooks/tracker-home.sh']).code, 0);
  c.inDir(wt, 'br', ['create', '--title', 'two', '--type', 'task', '--actor', 'test']);
  const titles = readFileSync(join(c.root, '.beads/issues.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).title);
  assert.deepEqual(titles, ['two']);
});

test('post-checkout: a worktree added to a connected clone is linked to the store at once', { skip: !hasBr && 'br is not installed' }, () => {
  const c = clone();
  c.userList('secret-xyz\n');
  assert.equal(c.run('sh', ['.shady2k/connect.sh']).code, 0);
  const wt = join(dirname(c.root), 'elsewhere', 'w');
  const added = c.run('git', ['worktree', 'add', '-q', wt, '-b', 'w']);
  assert.equal(added.code, 0, added.out);
  assert.equal(realpathSync(join(wt, '.beads')), realpathSync(join(c.store, '.beads')));
  assert.equal(c.inDir(wt, 'sh', ['.githooks/tracker-home.sh']).code, 0);
  // A plain branch switch in a connected checkout changes nothing and says nothing.
  const sw = spawnSync('git', ['switch', '-q', '-c', 'other'], { cwd: c.root, encoding: 'utf8', env: c.env });
  assert.equal(sw.status, 0);
  assert.equal(`${sw.stdout}${sw.stderr}`.trim(), '');
});
