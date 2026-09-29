#!/usr/bin/env node
// The checks of a push (see .shady2k/integration.md, "Local entry points"):
// for each ref git is about to push, the commits it introduces, that is the
// commits of its tip (a tag peeled to its commit) that no ref the remote
// already has reaches. Every one of them must name a task, resolved against the
// tracker export at the tip; the present-documents check then compares the
// documents at the tip with the revision just before the first of them.
//
//   node .shady2k/push.mjs <remote>   < git's pre-push lines
//
// A ref that introduces nothing (a tag or a new branch on a commit the remote
// holds) passes, saying so. Refused: no ref lines, a tip or a range git cannot
// compute. Exit 0 clean, 1 refused, 2 unreadable input (never a pass).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitLinks } from './adapter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = /^0+$/;

class Unreadable extends Error {}

function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function lines(text) {
  return text.split('\n').filter((l) => l.trim());
}

// What `local` introduces on `remote`: its commits, oldest first, and the
// revision the documents are compared with (null for a repository's first commit).
export function introduced(remote, localSha, remoteSha) {
  const tip = git('rev-parse', '--verify', '--quiet', `${localSha}^{commit}`);
  if (!tip.ok) throw new Unreadable(`${localSha} is not a commit, and no tag of one, in this clone`);
  const not = [];
  if (remote && git('config', '--get', `remote.${remote}.url`).ok) not.push(`--remotes=${remote}`);
  if (!ZERO.test(remoteSha)) {
    if (!git('cat-file', '-e', `${remoteSha}^{commit}`).ok) {
      throw new Unreadable(`the remote is at ${remoteSha.slice(0, 12)}, which this clone does not have: fetch, then push again`);
    }
    not.push(remoteSha);
  }
  const all = git('rev-list', '--reverse', tip.out, '--not', ...not);
  const chain = git('rev-list', '--first-parent', tip.out, '--not', ...not);
  if (!all.ok || !chain.ok) throw new Unreadable(`git cannot list the commits of ${tip.out.slice(0, 12)}: ${all.err || chain.err}`);
  const shas = lines(all.out);
  if (!shas.length) return { tip: tip.out, shas, base: null };
  const oldest = lines(chain.out).at(-1);
  const parent = git('rev-parse', '--verify', '--quiet', `${oldest}^1`);
  return { tip: tip.out, shas, base: parent.ok ? parent.out : null };
}

function node(args, stdio) {
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: stdio ?? 'inherit' }).status ?? 2;
}

function checkRef(remote, [localRef, localSha, remoteRef, remoteSha]) {
  const name = `${localRef} -> ${remoteRef}`;
  if (ZERO.test(localSha)) {
    console.log(`push: ${name} deletes a ref: nothing to check`);
    return 0;
  }
  const { tip, shas, base } = introduced(remote, localSha, remoteSha);
  if (!shas.length) {
    console.log(`push: ${name} introduces no commits: nothing to check`);
    return 0;
  }
  console.log(`push: ${name} introduces ${shas.length} commit(s)`);
  const dir = mkdtempSync(join(tmpdir(), 'madarch-push-'));
  try {
    const input = join(dir, 'commits.json');
    writeFileSync(input, JSON.stringify(commitLinks(shas, tip)));
    let status = node(['.shady2k/checks/check-commits.mjs', input]);
    if (status === 1) {
      console.log(`\nPush refused: every commit ${name} introduces must name an existing task on its own line,`);
      console.log('for example "Task: madarch-ge3". Reword the commits above (git rebase -i, then reword), then push again.');
    }
    if (base === null) {
      console.log(`push: ${name} carries the repository's first commit: no earlier revision to compare the documents with`);
      return status;
    }
    const present = node(['.shady2k/checks/check-present.mjs', '--config', '.shady2k/config.json', '--base', base, '--head', tip]);
    if (present === 1) {
      console.log(`\nPush refused: a document that describes the present names a path ${name} removes (listed above).`);
      console.log('Point it at what replaced the path, or remove the statement, in a commit of this push, then push again.');
    }
    return Math.max(status, present);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function main(remote, text) {
  const refs = lines(text).map((l) => l.trim().split(/\s+/));
  if (!refs.length) throw new Unreadable('git gave the pre-push hook no ref lines, so there is nothing it could check; run it only as git\'s pre-push hook');
  const bad = refs.find((r) => r.length !== 4);
  if (bad) throw new Unreadable(`a pre-push line is not "<local ref> <local sha> <remote ref> <remote sha>": ${bad.join(' ')}`);
  let worst = 0;
  for (const ref of refs) {
    const status = checkRef(remote, ref);
    worst = worst === 2 || status === 2 ? 2 : Math.max(worst, status);
  }
  return worst;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv[2], readFileSync(0, 'utf8')));
  } catch (e) {
    if (!(e instanceof Unreadable)) throw e;
    console.error(`push: ${e.message}`);
    console.error('Push refused: the checks could not read what this push introduces. Nothing was judged; fix the input and push again.');
    process.exit(2);
  }
}
