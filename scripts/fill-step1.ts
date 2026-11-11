#!/usr/bin/env bun
/**
 * Step 1's proof run (madarch-8bdc.2.5): the two passes over one repository, into one store,
 * measured against git itself.
 *
 *   bun scripts/fill-step1.ts --repository <checkout> --commit <rev> --store <folder> --out <file.json> [--run <id>]
 *
 * It creates the record tables, reads the tree and the history, publishes both, runs each pass a
 * second time (which must write nothing), and answers the numbers the report states: counts against
 * git's own, the sum of sizes, the created and last-modified dates of sampled files against
 * `git log --follow`, bytes per table, wall clock and peak memory of each pass.
 *
 * The run is instrumented like every other fill: its trace is `<store>/traces/<run>.jsonl`, and
 * `madarch trace --store <folder>` reads it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRepositoryHistory, readRepositoryTree, type RepositoryAt } from '../src/fill/stages/repository-facts.js';
import { log } from '../src/obs/log.js';
import { GIT_CONTRACT } from '../src/fill/stages/git-contract.js';
import { requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';
import { closeTrace, openTrace, runInTrace, withSpan, withSpanSync } from '../src/obs/trace.js';

const engine = join(import.meta.dir, '..');
const load = async (path: string) => await import(pathToFileURL(join(engine, path)).href);
const graph = await load('src/graph/index.ts') as typeof import('../src/graph/index.js');
const { createDatabaseOwner } = await load('src/adapters/database-owner.ts') as typeof import('../src/adapters/database-owner.js');
/** git's own answer for the checks against git: a child process of the run, so a span of its own. */
function gitTextOf(root: string, args: readonly string[]): string {
  return withSpanSync('process.git', { 'process.command': 'git', 'process.args': [...args], 'process.cwd': root, 'madarch.check': 'against-git' }, (span) => {
    const answer = Bun.spawnSync(['git', ...args], { cwd: root, env: { ...process.env, LC_ALL: 'C' } });
    span.setAttribute('process.outputBytes', answer.stdout.length);
    span.setAttribute('process.exitCode', answer.exitCode ?? 1);
    if (answer.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${root}: ${answer.stderr.toString()}`);
    return answer.stdout.toString();
  });
}

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
const runId = process.argv.includes('--run') ? argument('run') : `step1-${String(Date.now())}`;

await withStorePreparationOwner(async () => {
const pin: RepositoryAt = { repository: 'madarch', root: repository, commit, url: `file://${repository}` };
mkdirSync(store, { recursive: true });
await requestStorePreparation(join(store, 'graph'), GIT_CONTRACT);
const owner = await createDatabaseOwner({ store: join(store, 'graph'), connectOnly: true });
await graph.createRecordSchema(owner);

const peak = { tree: 0, history: 0 };
const watchOf = (key: 'tree' | 'history') => setInterval(() => { const rss = Math.round(process.memoryUsage().rss / 1024 / 1024); if (rss > peak[key]) peak[key] = rss; }, 20);

const traced = openTrace({ store, runId, console: true });
const answer = await runInTrace(traced, async () => await withSpan('fill.run', { 'madarch.run': runId, 'madarch.repository': repository, 'madarch.commit': commit, 'madarch.entry': 'fill-step1' }, async () => {
  log.info('step 1 fill started', { runId, repository, commit, store });

  const treeWatch = watchOf('tree');
  const treeStarted = performance.now();
  const tree = await withSpan('fill.step', { 'madarch.step': 'repository-tree' }, async (span) => {
    const read = await readRepositoryTree(pin);
    span.setAttribute('madarch.files', read.files.length);
    span.setAttribute('madarch.gitlinks', read.gitlinks.length);
    return read;
  });
  const treeReadMs = performance.now() - treeStarted;
  const treePublished = await withSpan('store.publishTree', { 'madarch.files': tree.files.length }, async (span) => {
    const counts = await graph.publishTree(owner, tree);
    span.setAttribute('madarch.rows', counts.inserted + counts.updated);
    return counts;
  });
  const treeMs = performance.now() - treeStarted;
  clearInterval(treeWatch);

  const historyWatch = watchOf('history');
  const historyStarted = performance.now();
  const history = await withSpan('fill.step', { 'madarch.step': 'repository-history' }, async (span) => {
    const read = await readRepositoryHistory(pin);
    span.setAttribute('madarch.commits', read.commits.length);
    span.setAttribute('madarch.touched', read.commits.reduce((sum, one) => sum + one.touched.length, 0));
    return read;
  });
  const historyReadMs = performance.now() - historyStarted;
  const historyPublished = await withSpan('store.publishHistory', { 'madarch.commits': history.commits.length }, async (span) => {
    const counts = await graph.publishHistory(owner, history);
    span.setAttribute('madarch.rows', counts.inserted + counts.updated);
    return counts;
  });
  const historyMs = performance.now() - historyStarted;
  clearInterval(historyWatch);

  // A second run at the same commit: the same reads, the same publishes.
  const secondTree = await graph.publishTree(owner, tree);
  const secondHistory = await graph.publishHistory(owner, history);

  // Against git itself.
  const lsTreeLines = gitTextOf(repository, ['ls-tree', '-r', commit]).split('\n').filter((line) => line !== '');
  const gitFiles = lsTreeLines.filter((line) => line.startsWith('100') || line.startsWith('120')).length;
  const gitLinks = lsTreeLines.length - gitFiles;
  const sizes = gitTextOf(repository, ['ls-tree', '-r', '-l', commit]).split('\n').filter((line) => line !== '').map((line) => Number(line.split(/\s+/)[3]));
  const gitBytes = sizes.reduce((sum, size) => sum + (Number.isFinite(size) ? size : 0), 0);
  const gitCommits = Number(gitTextOf(repository, ['rev-list', '--count', commit]).trim());
  const gitDirectories = gitTextOf(repository, ['ls-tree', '-r', '-d', commit]).split('\n').filter((line) => line !== '').length;
  const repositoryFacts = await graph.repositoryFacts(owner, 'madarch');
  const files = await graph.listFiles(owner, { repository: 'madarch', limit: 200_000 });
  const sumFiles = files.rows.reduce((sum, row) => sum + row.bytes, 0);

  // Twenty files spread over the tree, and the dates `git log --follow` gives them.
  const spread = files.rows.filter((_, index) => index % Math.max(1, Math.floor(files.rows.length / 20)) === 0).slice(0, 20);
  const dates: { path: string; graphCreated: string | null; gitCreated: string | null; graphModified: string | null; gitModified: string | null; gitModifiedFirstParent: string | null }[] = [];
  for (const file of spread) {
    const facts = await graph.fileFacts(owner, 'madarch', file.path);
    // The committer dates: the store's created and last-modified are the commits that touched the
    // path (following renames), and a commit "landed" at its committer date, not its author date.
    // Every history question is asked of the commit the fill read, never of the checkout's HEAD.
    const first = gitTextOf(repository, ['log', '--follow', '--format=%cI%x09%H', '--diff-filter=A', commit, '--', file.path]).split('\n').filter((line) => line !== '').at(-1) ?? '';
    const last = gitTextOf(repository, ['log', '--follow', '--format=%cI', '-1', commit, '--', file.path]).trim();
    // The same question asked the way the store records a touched row: git's default `git log -- path`
    // does not diff a merge at all, so a merge that brings a change never answers it; the agreed model
    // records `touched` from each commit's own change against its first parent, merge or not.
    // `--no-patch`: `--diff-merges=first-parent` alone prints a merge's own diff, which is not a date.
    const lastFirstParent = gitTextOf(repository, ['log', '--diff-merges=first-parent', '--no-patch', '--format=%cI', '-1', commit, '--', file.path]).trim();
    dates.push({
      path: file.path,
      graphCreated: facts?.created?.date ?? null,
      gitCreated: first === '' ? null : first.split('\t')[0] ?? null,
      graphModified: facts?.modified?.date ?? null,
      gitModified: last === '' ? null : last,
      gitModifiedFirstParent: lastFirstParent === '' ? null : lastFirstParent,
    });
  }

  const sizesPerTable = await graph.recordSizes(owner);
  const filesRows = repositoryFacts?.fileCount ?? 0;
  return {
    repository, commit, runId,
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
      // The graph's answer against git's own answer under the same definition of "touched": the
      // store records a commit's change against its first parent, and so does this comparison.
      datesEqual: dates.every((entry) => (entry.graphModified === null ? entry.gitModifiedFirstParent === null : entry.gitModifiedFirstParent !== null && Date.parse(entry.graphModified) === Date.parse(entry.gitModifiedFirstParent))
        && (entry.graphCreated === null ? entry.gitCreated === null : entry.gitCreated !== null && Date.parse(entry.graphCreated) === Date.parse(entry.gitCreated))),
      datesEqualPlainFollow: dates.every((entry) => (entry.graphModified === null ? entry.gitModified === null : entry.gitModified !== null && Date.parse(entry.graphModified) === Date.parse(entry.gitModified))),
      datesChecked: dates.length,
    },
    bytesPerTable: sizesPerTable,
    bytesPerRow: { files: filesRows === 0 ? 0 : Object.values(sizesPerTable).reduce((sum, held) => sum + held.bytes, 0) / filesRows, commits: gitCommits === 0 ? 0 : Object.values(sizesPerTable).reduce((sum, held) => sum + held.bytes, 0) / gitCommits },
  };
}));
log.info('step 1 fill ended', {
  runId,
  files: answer.againstGit.files.graph,
  filesEqual: answer.againstGit.files.equal,
  directories: answer.againstGit.directories.graph,
  directoriesEqual: answer.againstGit.directories.equal,
  commits: answer.againstGit.commits.graph,
  commitsEqual: answer.againstGit.commits.equal,
  treeMs: Math.round(answer.pass.tree.wallMs),
  historyMs: Math.round(answer.pass.history.wallMs),
  peakRssMb: Math.max(peak.tree, peak.history),
  datesEqual: answer.againstGit.datesEqual,
});
closeTrace(traced);
writeFileSync(out, `${JSON.stringify(answer, null, 2)}\n`);
await owner.close();
});
