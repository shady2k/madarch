#!/usr/bin/env node
// The tracker store's one entry point for this repository (see
// .shady2k/integration.md, "Tracker synchronization"). It runs the installed
// copy of the set's mechanism (.shady2k/tracker-sync.mjs) with the br recipe
// (.shady2k/trackers/br.mjs) and always names the same machine store, so every
// checkout and git worktree of this repository, wherever it stands, reaches one
// store: the mechanism alone would name the store after the checkout's folder,
// and a worktree in ~/.herdr/worktrees/... would get a store of its own.
//
//   node .shady2k/tracker.mjs <tracker-sync command> [its options]
//   node .shady2k/tracker.mjs store        prints the store folder
//
// The store is ${XDG_STATE_HOME:-~/.local/state}/madarch/tracker, a worktree
// of this repository detached at refs/tracker/state; the repository it belongs
// to is the main checkout (the parent of git's common directory).
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MECHANISM = join(HERE, 'tracker-sync.mjs');
const RECIPE = join(HERE, 'trackers', 'br.mjs');

function mainCheckout() {
  let common;
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: HERE, encoding: 'utf8' }).trim();
  } catch (e) {
    process.stderr.write(`tracker: ${HERE} is not inside a clone of the repository: ${e.message}\n`);
    process.exit(2);
  }
  return dirname(resolve(common));
}

export const STATE = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'madarch');
export const STORE = join(STATE, 'tracker');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'store') {
    process.stdout.write(`${STORE}\n`);
    process.exit(0);
  }
  if (!command) {
    process.stderr.write('usage: node .shady2k/tracker.mjs <connect|publish|sync|claim|transition|record|export|status|watch|version> [options] | store\n');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [MECHANISM, command, ...rest, '--recipe', RECIPE, '--state', STATE, '--repo', mainCheckout()], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tracker: could not run ${MECHANISM}: ${r.error.message}\n`);
    process.exit(2);
  }
  process.exit(r.status ?? 1);
}
