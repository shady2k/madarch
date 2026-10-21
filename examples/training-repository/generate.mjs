#!/usr/bin/env node
// Replays history.mjs over the files in template/ into a new git repository.
//
// template/ holds the final state of the generated repository as real files.
// Earlier states are produced from the same files: a line that is only a
// comment carrying "@@" is a directive, never written to the output.
//
//   <comment> @@ since <commit id> [until <commit id>]
//   ...lines present only while the first commit is in the history of the one
//   being built and the second is not...
//   <comment> @@ end
//
// A file named "<path>.template" is written as "<path>".
// <comment> is "//", "#", "--" or "<!--" (the last one closed by "-->"). Blocks
// may nest (a line is written when every open block admits it). A file exists from the commit whose plan entry adds it.
// Usage: node generate.mjs <destination-folder outside the checkout>
import {execFileSync} from 'node:child_process';
import {mkdir, rm, writeFile, readFile, readdir, lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AUTHORS, COMMITS, TAGGED_FILES} from './history.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, '../..');
const templateRoot = path.join(here, 'template');
const DIRECTIVE = /^\s*(?:\/\/|#|--|<!--)\s*@@\s*(.*?)\s*(?:-->)?\s*$/;

/** Every file under template/, as posix paths relative to it, sorted by code point. */
export async function templateFiles(dir = templateRoot, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await templateFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`${path.join(dir, entry.name)}: only regular files and folders are allowed in template/`);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The text of one template file as the history reads it when `reach` (a Set of
 * commit ids) is the set of commits already made. `name` is only for errors.
 */
export function render(text, reach, ids, name) {
  const lines = text.split('\n');
  const out = [];
  const open = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]);
    if (!m) {
      if (open.every((block) => block.on)) out.push(lines[i]);
      continue;
    }
    const where = `${name}:${i + 1}`;
    const words = m[1].split(/\s+/);
    if (words[0] === 'end' && words.length === 1) {
      if (!open.length) throw new Error(`${where}: "@@ end" with no open block`);
      open.pop();
      continue;
    }
    let on = true;
    if (words.length % 2) throw new Error(`${where}: directive "${m[1]}" is not "since <id> [until <id>]"`);
    for (let w = 0; w < words.length; w += 2) {
      const kind = words[w], id = words[w + 1];
      if (kind !== 'since' && kind !== 'until') throw new Error(`${where}: directive "${m[1]}" is not "since <id> [until <id>]"`);
      if (!ids.has(id)) throw new Error(`${where}: "${id}" is not a commit id of history.mjs`);
      if (kind === 'since' && !reach.has(id)) on = false;
      if (kind === 'until' && reach.has(id)) on = false;
    }
    open.push({line: i + 1, on});
  }
  if (open.length) throw new Error(`${name}:${open[open.length - 1].line}: block is never closed with "@@ end"`);
  return out.join('\n');
}

function gitRunner(dest) {
  const base = {
    PATH: process.env.PATH,
    HOME: dest,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
  };
  const config = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'core.fileMode=true', '-c', 'init.defaultBranch=main'];
  return (args, {env = {}, input, allowFail = false} = {}) => {
    try {
      return execFileSync('git', [...config, ...args], {cwd: dest, env: {...base, ...env}, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
    } catch (error) {
      if (allowFail) return null;
      throw new Error(`git ${args.join(' ')} failed in ${dest}: ${error.stderr || error.message}`);
    }
  };
}

export async function generate(destination) {
  if (!destination) throw new Error('Usage: node generate.mjs <destination-folder>');
  const dest = path.resolve(destination);
  if (dest === path.parse(dest).root || dest === checkout || dest.startsWith(checkout + path.sep) || checkout.startsWith(dest + path.sep)) {
    throw new Error(`Destination ${dest} must be outside and separate from the checkout ${checkout}`);
  }
  try {
    if ((await lstat(dest)).isSymbolicLink()) throw new Error(`Destination ${dest} must not be a symlink`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (let p = path.dirname(dest); p !== path.dirname(p); p = path.dirname(p)) {
    try {
      const real = await realpath(p);
      if (real === checkout || real.startsWith(checkout + path.sep)) throw new Error(`Destination parent ${p} resolves into the checkout`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  // A template file named "<path>.template" is written as "<path>": the suffix keeps test runners
  // that walk the checkout from picking up the generated repository's own *.test.ts files.
  const onDisk = new Map();
  for (const f of await templateFiles()) onDisk.set(f.endsWith('.template') ? f.slice(0, -'.template'.length) : f, f);
  const files = [...onDisk.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const sources = new Map();
  for (const f of files) sources.set(f, await readFile(path.join(templateRoot, onDisk.get(f)), 'utf8'));
  const named = COMMITS.filter((c) => c.id);
  const ids = new Set(named.map((c) => c.id));
  if (ids.size !== named.length) throw new Error('history.mjs: a commit id is used twice');

  await rm(dest, {recursive: true, force: true});
  await mkdir(dest, {recursive: true});
  const git = gitRunner(dest);
  git(['init', '--quiet']);

  // One context per branch: the commits already made on it, the files it holds
  // (output path -> template path) and what they rendered to.
  const contexts = new Map([['main', {reach: new Set(), state: new Map(), rendered: new Map()}]]);
  let current = 'main';
  const shas = {};

  const expand = (entry, label) => {
    if (!entry.endsWith('/')) {
      if (!sources.has(entry)) throw new Error(`history.mjs ${label}: ${entry} is not a file of template/`);
      return [entry];
    }
    const hits = files.filter((f) => f.startsWith(entry));
    if (!hits.length) throw new Error(`history.mjs ${label}: no file of template/ under ${entry}`);
    return hits;
  };

  for (const commit of COMMITS) {
    const branch = commit.branch ?? 'main';
    if (!contexts.has(branch)) {
      const from = contexts.get('main');
      contexts.set(branch, {reach: new Set(from.reach), state: new Map(from.state), rendered: new Map(from.rendered)});
      git(['checkout', '--quiet', '-b', branch]);
      current = branch;
    } else if (current !== branch) {
      git(['checkout', '--quiet', branch]);
      current = branch;
    }
    const ctx = contexts.get(branch);
    const author = AUTHORS[commit.author];
    const label = commit.id ?? `merge of ${commit.merge}`;
    if (!author) throw new Error(`history.mjs ${label}: unknown author "${commit.author}"`);
    const identity = {GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email};

    if (commit.merge) {
      if (branch !== 'main') throw new Error(`history.mjs ${label}: a merge happens on main`);
      const other = contexts.get(commit.merge);
      if (!other) throw new Error(`history.mjs ${label}: branch ${commit.merge} has no commits`);
      for (const id of other.reach) ctx.reach.add(id);
      for (const [outPath, tpl] of other.state) if (!ctx.state.has(outPath)) ctx.state.set(outPath, tpl);
      // Conflicts are not a failure here: the tree is overwritten with the plan's own reading below.
      git(['merge', '--no-ff', '--no-commit', commit.merge], {allowFail: true, env: identity});
    } else {
      for (const [from, to] of commit.move ?? []) {
        if (!ctx.state.has(from)) throw new Error(`history.mjs ${label}: cannot move ${from}, it does not exist yet`);
        if (!sources.has(to)) throw new Error(`history.mjs ${label}: ${to} is not a file of template/`);
        ctx.state.delete(from);
        ctx.state.set(to, to);
      }
      for (const entry of commit.add ?? []) {
        if (typeof entry === 'object') {
          // A file that first appears under another path than the one it ends at (later moved).
          if (!sources.has(entry.tpl)) throw new Error(`history.mjs ${label}: ${entry.tpl} is not a file of template/`);
          if (ctx.state.has(entry.as)) throw new Error(`history.mjs ${label}: ${entry.as} is added twice`);
          ctx.state.set(entry.as, entry.tpl);
          continue;
        }
        for (const f of expand(entry, label)) {
          if (ctx.state.has(f)) throw new Error(`history.mjs ${label}: ${f} is added twice`);
          ctx.state.set(f, f);
        }
      }
      for (const f of commit.remove ?? []) {
        if (!ctx.state.delete(f)) throw new Error(`history.mjs ${label}: cannot remove ${f}, it does not exist`);
      }
    }
    ctx.reach.add(commit.id ?? `merge:${commit.merge}`);

    const next = new Map();
    for (const [outPath, tpl] of ctx.state) next.set(outPath, render(sources.get(tpl), ctx.reach, ids, `template/${onDisk.get(tpl)}`));
    const previous = commit.merge ? contexts.get('main').rendered : ctx.rendered;
    const changed = new Set();
    for (const [p, text] of next) if (previous.get(p) !== text) changed.add(p);
    for (const p of previous.keys()) if (!next.has(p)) changed.add(p);

    if (!commit.merge) {
      if (!changed.size) throw new Error(`history.mjs ${label}: the commit changes no file (${commit.message})`);
      for (const [from, to] of commit.move ?? []) {
        if (previous.get(from) !== next.get(to)) throw new Error(`history.mjs ${label}: the move ${from} -> ${to} must keep the content, but template/${to} reads differently in the two commits`);
      }
      const touched = Object.entries(TAGGED_FILES).filter(([, p]) => changed.has(p)).map(([tag]) => tag).sort();
      const declared = [...(commit.touches ?? [])].sort();
      if (touched.join() !== declared.join()) {
        throw new Error(`history.mjs ${label}: declares touches [${declared}] but the commit changes [${touched}] among ${Object.values(TAGGED_FILES).join(', ')}`);
      }
    }

    for (const p of previous.keys()) if (!next.has(p)) await rm(path.join(dest, p), {force: true});
    for (const [p, text] of next) {
      const target = path.join(dest, p);
      await mkdir(path.dirname(target), {recursive: true});
      await writeFile(target, text);
    }
    ctx.rendered = next;
    if (commit.merge) contexts.get('main').rendered = next;

    git(['add', '-A']);
    const committed = commit.committerDate ?? commit.date;
    const message = commit.merge ? `${commit.message}\n` : `${commit.message}\n${commit.body ? `\n${commit.body.trim()}\n` : ''}`;
    git(['commit', '--quiet', '--no-verify', '--cleanup=verbatim', '-F', '-'], {
      input: message,
      env: {...identity, GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: committed},
    });
    const sha = git(['rev-parse', 'HEAD']).trim();
    shas[commit.id ?? commit.message] = sha;
    if (commit.merge) {
      git(['branch', '-D', commit.merge]);
      contexts.delete(commit.merge);
    }
  }

  const main = contexts.get('main');
  const missing = files.filter((f) => ![...main.state.values()].includes(f));
  if (missing.length) throw new Error(`history.mjs never adds: ${missing.join(', ')}`);
  const status = git(['status', '--porcelain']).trim();
  if (status) throw new Error(`the generated repository is not clean after the last commit:\n${status}`);
  return {dest, shas};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {dest} = await generate(process.argv[2]);
    console.log(dest);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
