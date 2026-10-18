#!/usr/bin/env node
/**
 * What a whole test run may leave behind, checked at its ends (madarch-1xq):
 * CI takes a snapshot before the run and compares it with one taken after, so
 * a suite that writes into the account's home or the system temporary folder
 * fails the build instead of filling the disk. The run's own scratch folder is
 * not watched here: `bunfig.toml`'s preload removes it, and a leftover of it is
 * a `madarch-` entry in the temporary folder like any other.
 *
 * Usage:
 *   node .shady2k/run-scratch-check.mjs snapshot <file> [--home <dir>] [--tmp <dir>]
 *   node .shady2k/run-scratch-check.mjs compare <before> <after>
 *
 * `snapshot` writes one line per watched entry, `<label> <full path>`, sorted;
 * `compare` names every entry that appeared or disappeared, with its full path,
 * and exits 1 when there is one. Two entries are not watched: the package
 * manager's own caches (`.bun`, `.npm`) and `.cache`, which hold the browser and
 * package downloads a run reads and the installs it makes share with the person.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The home's top-level names the check does not report by themselves: the
 * tools' own caches, which a run reads and shares, and the three folders whose
 * madarch contents it watches under their own labels — an empty `.config/` a
 * run made is not a leak, an entry inside `.config/madarch/` is.
 */
const TOLERATED_HOME_ENTRIES = new Set(['.bun', '.npm', '.cache', '.config', '.local', 'madarch']);

/** The folders a run must leave as it found them, each with how much of it is watched. */
export function watchedFolders(home = homedir(), temporary = tmpdir()) {
  return [
    // The system temporary folder: only madarch's own folders are watched, as
    // other programs share it and their business is not this check's.
    { label: 'temporary', path: temporary, prefix: 'madarch-' },
    { label: 'home', path: home, skip: TOLERATED_HOME_ENTRIES },
    { label: 'products', path: join(home, 'madarch', 'products') },
    { label: 'home-config', path: join(home, '.config', 'madarch') },
    { label: 'home-state', path: join(home, '.local', 'state', 'madarch') },
  ];
}

/** Every watched entry as one line, sorted: what a snapshot holds. */
export function snapshot(home = homedir(), temporary = tmpdir()) {
  const lines = [];
  for (const folder of watchedFolders(home, temporary)) {
    let names;
    try {
      names = readdirSync(folder.path);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // a folder the run does not have yet cannot gain anything
      throw new Error(`${folder.path}: the watched folder could not be listed: ${error.message}`);
    }
    for (const name of names) {
      if (folder.prefix !== undefined && !name.startsWith(folder.prefix)) continue;
      if (folder.skip !== undefined && folder.skip.has(name)) continue;
      lines.push(`${folder.label} ${join(folder.path, name)}`);
    }
  }
  return lines.sort();
}

/** The entries a run left or took away, each with its full path. */
export function compare(before, after) {
  const had = new Set(before);
  const has = new Set(after);
  return {
    appeared: after.filter((line) => !had.has(line)),
    disappeared: before.filter((line) => !has.has(line)),
  };
}

/** The refusals a comparison stands for: one line per entry, naming its full path. */
export function refusals(found) {
  return [
    ...found.appeared.map((line) => `a test run left ${line.split(' ').slice(1).join(' ')} behind`),
    ...found.disappeared.map((line) => `a test run removed ${line.split(' ').slice(1).join(' ')}`),
  ];
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word === '--home' || word === '--tmp') {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${word} needs a folder`);
      options.set(word, value);
    } else {
      words.push(word);
    }
  }
  const home = options.get('--home') ?? homedir();
  const temporary = options.get('--tmp') ?? tmpdir();
  if (command === 'snapshot') {
    const [file] = words;
    if (file === undefined) throw new Error('snapshot needs the file to write');
    const lines = snapshot(home, temporary);
    writeFileSync(file, lines.map((line) => `${line}\n`).join(''));
    console.log(`${resolve(file)}: ${lines.length} watched entries`);
    return 0;
  }
  if (command === 'compare') {
    const [beforeFile, afterFile] = words;
    if (beforeFile === undefined || afterFile === undefined) throw new Error('compare needs the before and the after file');
    const linesOf = (file) => readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
    const found = compare(linesOf(beforeFile), linesOf(afterFile));
    const problems = refusals(found);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) {
      console.error(`the temporary folder ${temporary} and the home ${home} must hold what they held before the run`);
      return 1;
    }
    console.log('the run left the home and the temporary folder as it found them');
    return 0;
  }
  throw new Error(`unknown command ${command ?? '(none)'}: use snapshot or compare`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`run-scratch-check: ${error.message}`);
    process.exitCode = 2;
  }
}
