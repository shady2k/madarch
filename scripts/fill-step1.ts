#!/usr/bin/env bun
/**
 * Step 1's proof run (madarch-8bdc.2.5): the two passes over one repository, into one store,
 * measured against git itself.
 *
 *   bun scripts/fill-step1.ts --repository <checkout> --commit <rev> --store <folder> --out <file.json>
 *
 * It creates the record tables, reads the tree and the history, publishes both, runs each pass a
 * second time (which must write nothing), and answers the numbers the report states: counts against
 * git's own, the sum of sizes, the created and last-modified dates of sampled files against
 * `git log --follow`, bytes per table, wall clock and peak memory of each pass.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRepositoryHistory, readRepositoryTree, type RepositoryAt } from '../src/fill/stages/repository-facts.js';

const engine = join(import.meta.dir, '..');
const load = async (path: string) => await import(pathToFileURL(join(engine, path)).href);
const graph = await load('src/graph/index.ts') as typeof import('../src/graph/index.js');
const { createPGliteDatabaseOwner } = await load('src/adapters/database-owner.ts') as typeof import('../src/adapters/database-owner.js');

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (value === undefined || value === '') throw new Error(`scripts/fill-step1.ts: --${name} requires a value`);
  return value;
}

const repository = resolve(argument('repository'));
const commit = argument('commit');
const store = resolve(argument('store'));
const out = resolve(argument('out'));

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repository, maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
}

const pin: RepositoryAt = { repository: 'madarch', root: repository, commit, url: 'file:///work/madarch' };
mkdirSync(store, { recursive: true });
const owner = createPGliteDatabaseOwner({ path: join(store, 'graph'), btreeGist: true });
await graph.createRecordSchema(owner);

const peak = { tree: 0, history: 0 };
const sample = () => { const rss = Math.round(process.memoryUsage().rss / 1024 / 1024); return rss; };
const watch = setInterval(() => { const rss = sample(); if (rss > peak.tree) peak.tree = rss; }, 20);

const treeStarted = performance.now();
const tree = await readRepositoryTree(pin);
const treeReadMs = performance.now() - treeStarted;
const treePublished = await graph.publishTree(owner, tree);
const treeMs = performance.now() - treeStarted;
clearInterval(watch);

const historyWatch = setInterval(() => { const rss = sample(); if (rss > peak.history) peak.history = rss; }, 20);
const historyStarted = performance.now();
const history = await readRepositoryHistory(pin);
const historyReadMs = performance.now() - historyStarted;
const historyPublished = await graph.publishHistory(owner, history);
const historyMs = performance.now() - historyStarted;
clearInterval(historyWatch);

// A second run at the same commit: the same reads, the same publishes.
const secondTree = await graph.publishTree(owner, tree);
const secondHistory = await graph.publishHistory(owner, history);

// Against git itself.
const lsTreeLines = git(['ls-tree', '-r', commit]).split('\n').filter((line) => line !== '');
const gitFiles = lsTreeLines.filter((line) => line.startsWith('100') || line.startsWith('120')).length;
const gitLinks = lsTreeLines.length - gitFiles;
const sizes = git(['ls-tree', '-r', '-l', commit]).split('\n').filter((line) => line !== '').map((line) => Number(line.split(/\s+/)[3]));
const gitBytes = sizes.reduce((sum, size) => sum + (Number.isFinite(size) ? size : 0), 0);
const gitCommits = Number(git(['rev-list', '--count', commit]).trim());
const gitDirectories = git(['ls-tree', '-r', '-d', commit]).split('\n').filter((line) => line !== '').length;
const repositoryFacts = await graph.repositoryFacts(owner, 'madarch');
const files = await graph.listFiles(owner, { repository: 'madarch', limit: 200_000 });
const sumFiles = files.rows.reduce((sum, row) => sum + row.bytes, 0);

// Twenty files spread over the tree, and the dates `git log --follow` gives them.
const spread = files.rows.filter((row, index) => index % Math.max(1, Math.floor(files.rows.length / 20)) === 0).slice(0, 20);
const dates: { path: string; graphCreated: string | null; gitCreated: string | null; graphModified: string | null; gitModified: string | null }[] = [];
for (const file of spread) {
  const facts = await graph.fileFacts(owner, 'madarch', file.path);
  // The committer dates: the store's created and last-modified are the commits that touched the
  // path (following renames), and a commit "landed" at its committer date, not its author date.
  // Every history question is asked of the commit the fill read, never of the checkout's HEAD.
  const first = git(['log', '--follow', '--format=%cI%x09%H', '--diff-filter=A', commit, '--', file.path]).split('\n').filter((line) => line !== '').at(-1) ?? '';
  const last = git(['log', '--follow', '--format=%cI', '-1', commit, '--', file.path]).trim();
  dates.push({
    path: file.path,
    graphCreated: facts?.created?.date ?? null,
    gitCreated: first === '' ? null : first.split('\t')[0] ?? null,
    graphModified: facts?.modified?.date ?? null,
    gitModified: last === '' ? null : last,
  });
}

const sizesPerTable = await graph.recordSizes(owner);
const filesRows = repositoryFacts?.fileCount ?? 0;
const answer = {
  repository, commit,
  pass: {
    tree: { wallMs: treeMs, readMs: treeReadMs, peakRssMb: peak.tree, published: treePublished, secondRun: secondTree },
    history: { wallMs: historyMs, readMs: historyReadMs, peakRssMb: peak.history, published: historyPublished, secondRun: secondHistory },
  },
  againstGit: {
    files: { graph: filesRows, git: gitFiles, equal: filesRows === gitFiles },
    gitlinks: { graph: tree.gitlinks.length, git: gitLinks, equal: tree.gitlinks.length === gitLinks },
    bytes: { graph: sumFiles, git: gitBytes, equal: sumFiles === gitBytes },
    commits: { graph: repositoryFacts?.commitCount ?? 0, git: gitCommits, equal: (repositoryFacts?.commitCount ?? 0) === gitCommits },
    directories: { graph: repositoryFacts?.directoryCount ?? 0, git: gitDirectories, equal: (repositoryFacts?.directoryCount ?? 0) === gitDirectories },
    gaps: repositoryFacts?.gaps ?? [],
    dates,
    // The two instants written the same way before they are compared: one UTC text, one ISO with
    // its offset, and the comparison is between the instants they denote.
    datesEqual: dates.every((entry) => (entry.graphModified === null ? entry.gitModified === null : entry.gitModified !== null && Date.parse(entry.graphModified) === Date.parse(entry.gitModified))
      && (entry.graphCreated === null ? entry.gitCreated === null : entry.gitCreated !== null && Date.parse(entry.graphCreated) === Date.parse(entry.gitCreated))),
    datesChecked: dates.length,
  },
  bytesPerTable: sizesPerTable,
  bytesPerRow: { files: filesRows === 0 ? 0 : Object.values(sizesPerTable).reduce((sum, held) => sum + held.bytes, 0) / filesRows, commits: gitCommits === 0 ? 0 : Object.values(sizesPerTable).reduce((sum, held) => sum + held.bytes, 0) / gitCommits },
};
writeFileSync(out, `${JSON.stringify(answer, null, 2)}\n`);
console.log(JSON.stringify(answer, null, 2).slice(0, 4000));
await owner.close();
