// Tests for the privacy guard (.githooks/privacy-guard.sh) and the connect
// command (.shady2k/connect.sh), run in throwaway clones of this repository with
// a scratch per-user config directory.
//   node --test .shady2k/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
  for (const [from, to] of [['../.githooks/privacy-guard.sh', '.githooks/privacy-guard.sh'], ['connect.sh', '.shady2k/connect.sh'], ['adapter.mjs', '.shady2k/adapter.mjs']]) {
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
