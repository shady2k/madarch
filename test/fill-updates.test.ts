/**
 * The update after commits to a default branch (madarch-tzte.26.2; decision 0026,
 * "Updates"). The watcher reads each product's repositories' default branches from
 * their refs' files and starts one debounced run of a product whose branch moved.
 *
 * Every expected value below comes from the requirement: two quick commits are one
 * run (the debounced update), a commit on another branch is none ("after commits to
 * the default branch"), a commit that stood before the watcher looked is none (the
 * first fill is the person's own), and a commit whose product already fills waits
 * for that fill to end ("within the limits", never over a fill in progress).
 *
 * The repositories are the test's own: a temporary products home with a product
 * repository and one linked code repository, each a Git checkout the test commits
 * to. Nothing here runs the fill: what a run does is the orchestrator's own suite's
 * subject, and this one holds the watcher to the runs it asks for.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/product/git.js';
import {
  createUpdateWatch,
  headOf,
  readSeenHeads,
  repositoriesOf,
  seenKey,
  updateRunId,
  UPDATE_STATE_FILE,
  type UpdateRunAnswer,
  type UpdateRunRequest,
} from '../src/product/fill-updates.js';

const IDENTITY = ['-c', 'user.name=Updates', '-c', 'user.email=updates@example.com', '-c', 'commit.gpgsign=false'];

function git(folder: string, ...args: readonly string[]): string {
  const answer = runGit(folder, [...IDENTITY, ...args]);
  if (!answer.ok) throw new Error(`git ${args.join(' ')} failed in ${folder}: ${answer.output}`);
  return answer.output;
}

interface Fixture {
  readonly home: string;
  readonly product: string;
  readonly productRepo: string;
  readonly codeRepo: string;
  /** Commits one file into a checkout and answers the commit. */
  commit(folder: string, file: string, text: string, message: string): string;
  remove(): void;
}

/** A products home with one product whose manifest declares one code repository, both of them Git checkouts. */
function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'madarch-update-watch-'));
  const product = join(home, 'shop');
  const codeRepo = join(product, 'repos', 'library');
  mkdirSync(codeRepo, { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 6f1d0a54-7c2b-4e18-9b6d-2f0c4a8e1b73',
    'name: shop',
    'repos:',
    '  - name: library',
    '    linked: true',
    '    branch: main',
    '',
  ].join('\n'));
  // The code repository's own files never enter the product repository: it is a checkout of this machine, linked
  // into the product the way `madarch repo add` links one, and the product's history holds no copy of it.
  writeFileSync(join(product, '.gitignore'), 'repos/\n');
  for (const folder of [product, codeRepo]) {
    git(folder, 'init', '--initial-branch=main', '--quiet');
  }
  const commit = (folder: string, file: string, text: string, message: string): string => {
    writeFileSync(join(folder, file), text);
    git(folder, 'add', '-A');
    git(folder, 'commit', '--quiet', '-m', message);
    return git(folder, 'rev-parse', 'HEAD');
  };
  commit(product, 'README.md', '# shop\n', 'the product is created');
  commit(codeRepo, 'index.ts', 'export const one = 1;\n', 'the library is created');
  return {
    home,
    product,
    productRepo: product,
    codeRepo,
    commit,
    remove: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** What a test's watcher asked for, in order. */
function recorder(answer: (request: UpdateRunRequest) => UpdateRunAnswer = () => ({ started: true })) {
  const asked: UpdateRunRequest[] = [];
  return {
    asked,
    start: async (request: UpdateRunRequest): Promise<UpdateRunAnswer> => {
      asked.push(request);
      return answer(request);
    },
  };
}

/** A watcher over the fixture that no timer or file watcher drives: the test calls its passes itself. */
function watcherOf(world: Fixture, start: (request: UpdateRunRequest) => Promise<UpdateRunAnswer>, options: { debounceMs?: number; enabled?: () => boolean } = {}) {
  return createUpdateWatch({
    home: world.home,
    start,
    debounceMs: options.debounceMs ?? 20,
    intervalMs: 0,
    enabled: options.enabled ?? (() => true),
    watchPath: () => () => undefined,
  });
}

const pause = (ms: number): Promise<void> => new Promise((answer) => setTimeout(answer, ms));

describe('the update after commits to a default branch', () => {
  test('two quick commits give one run, and the run is named after the newest of them', async () => {
    const world = fixture();
    try {
      const run = recorder();
      const watch = watcherOf(world, run.start);
      // The first pass reads the heads as the baseline: nothing stood before it that an update owes.
      expect((await watch.outset()).asked).toEqual([]);
      expect(run.asked).toEqual([]);

      const first = world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const two = 2;\n', 'two exports');
      const second = world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n', 'three exports');
      // Both commits land inside one debounce window: the pass after it sees the branch at its newest commit.
      const waiting = await watch.pass();
      expect(waiting.asked).toEqual([]);
      expect(waiting.waiting.map((entry) => entry.commit)).toEqual([second]);
      await pause(30);
      const started = await watch.pass();
      expect(started.asked.map((entry) => entry.request.runId)).toEqual([updateRunId('shop', second)]);
      expect(run.asked).toEqual([{
        product: { name: 'shop', folder: world.product },
        runId: updateRunId('shop', second),
        commit: second,
        repository: 'library',
        branch: 'main',
      }]);
      expect(run.asked[0]!.runId).not.toBe(updateRunId('shop', first));

      // A pass after the run started asks for nothing: the commit it covered stands handled.
      expect((await watch.pass()).asked).toEqual([]);
      expect(run.asked.length).toBe(1);
      watch.stop();
    } finally {
      world.remove();
    }
  });

  test('a commit on another branch gives no run, and neither does standing on that branch', async () => {
    const world = fixture();
    try {
      const run = recorder();
      const watch = watcherOf(world, run.start);
      await watch.outset();

      git(world.codeRepo, 'checkout', '--quiet', '-b', 'feature/two');
      world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const branch = 2;\n', 'a feature commit');
      await pause(30);
      expect((await watch.pass()).asked).toEqual([]);
      expect(run.asked).toEqual([]);

      // The checkout now stands on the feature branch, and the watched branch is still the default one: a commit
      // the branch it came from receives while the checkout stands elsewhere is not one this watcher sees.
      expect(headOf(world.codeRepo, 'main').ok).toBe(true);
      git(world.codeRepo, 'checkout', '--quiet', 'main');
      await pause(30);
      expect((await watch.pass()).asked).toEqual([]);

      // The default branch itself moving is the one that starts the update.
      const moved = world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const main = 3;\n', 'a default-branch commit');
      await pause(30);
      expect((await watch.pass()).asked.map((entry) => entry.request.commit)).toEqual([moved]);
      watch.stop();
    } finally {
      world.remove();
    }
  });

  test('the product repository is watched beside its code repositories', async () => {
    const world = fixture();
    try {
      const run = recorder();
      const watch = watcherOf(world, run.start);
      await watch.outset();
      const edited = world.commit(world.productRepo, 'README.md', '# shop\n\nA shop for orders and payments.\n', 'the documents say what the product is');
      await pause(30);
      const started = await watch.pass();
      expect(started.asked.map((entry) => entry.request)).toEqual([{
        product: { name: 'shop', folder: world.product },
        runId: updateRunId('shop', edited),
        commit: edited,
        repository: 'shop',
        branch: 'main',
      }]);
      expect(repositoriesOf({ name: 'shop', folder: world.product, repos: [{ name: 'library', branch: 'main' }] }).map((repo) => repo.repository)).toEqual(['shop', 'library']);
      watch.stop();
    } finally {
      world.remove();
    }
  });

  test('a commit whose product fills now waits for the fill to end, then starts', async () => {
    const world = fixture();
    try {
      let filling = true;
      const answers: UpdateRunAnswer[] = [];
      const run = recorder(() => (filling
        ? { started: false, deferred: true, reason: 'the product "shop" already runs run-1, which stands running' }
        : { started: true }));
      const watch = watcherOf(world, async (request) => {
        const answer = await run.start(request);
        answers.push(answer);
        return answer;
      });
      await watch.outset();
      const commit = world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const four = 4;\n', 'a commit while a fill runs');
      await pause(30);
      const first = await watch.pass();
      expect(first.asked.map((entry) => entry.answer)).toEqual([{ started: false, deferred: true, reason: 'the product "shop" already runs run-1, which stands running' }]);
      // The commit is still waiting: a deferral drops nothing.
      expect(watch.pending().map((entry) => entry.commit)).toEqual([commit]);
      await pause(30);
      filling = false;
      const second = await watch.pass();
      expect(second.asked.map((entry) => entry.answer)).toEqual([{ started: true }]);
      expect(answers.length).toBe(2);
      expect(watch.pending()).toEqual([]);
      // The run covers the commit it was asked for, and both answers name the same run: one commit is one run.
      expect(new Set(second.asked.map((entry) => entry.request.runId))).toEqual(new Set([updateRunId('shop', commit)]));
      watch.stop();
    } finally {
      world.remove();
    }
  });

  test('no run before the wizard chose an agent, and the reason names the home', async () => {
    const world = fixture();
    try {
      const lines: string[] = [];
      const run = recorder();
      const watch = createUpdateWatch({
        home: world.home,
        start: run.start,
        debounceMs: 20,
        intervalMs: 0,
        enabled: () => false,
        log: (line) => lines.push(line),
        watchPath: () => () => undefined,
      });
      await watch.outset();
      world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const five = 5;\n', 'a commit nobody asked madarch to handle');
      await pause(30);
      expect((await watch.pass()).asked).toEqual([]);
      expect(run.asked).toEqual([]);
      expect(lines.filter((line) => line.includes('the wizard was not run')).length).toBe(1);
      expect(lines.some((line) => line.includes('the wizard was not run') && line.includes(world.home))).toBe(true);
      watch.stop();
    } finally {
      world.remove();
    }
  });

  test('a restarted watcher asks for a handled commit never again, and asks for a waiting one once', async () => {
    const world = fixture();
    try {
      const first = recorder();
      const watch = watcherOf(world, first.start);
      await watch.outset();
      const handled = world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const six = 6;\n', 'a commit a run covers');
      await pause(30);
      expect((await watch.pass()).asked.map((entry) => entry.request.commit)).toEqual([handled]);
      watch.stop();
      expect(readSeenHeads(world.home)[seenKey('shop', 'library')]).toEqual({ branch: 'main', commit: handled });
      expect(JSON.parse(readFileSync(join(world.home, UPDATE_STATE_FILE), 'utf8')).repositories[seenKey('shop', 'library')].commit).toBe(handled);

      // A second watcher over the same home reads the kept heads: the commit it started a run for is not asked for twice.
      const second = recorder(() => ({ started: false, deferred: true, reason: 'the product "shop" already runs a fill' }));
      const next = watcherOf(world, second.start);
      await next.outset();
      expect(second.asked).toEqual([]);
      const waiting = world.commit(world.codeRepo, 'index.ts', 'export const one = 1;\nexport const seven = 7;\n', 'a commit whose run is deferred');
      await pause(30);
      expect((await next.pass()).asked.map((entry) => entry.request.commit)).toEqual([waiting]);
      next.stop();

      // A third watcher finds the deferred commit still waiting: a deferral is not a handling.
      const third = recorder();
      const restarted = watcherOf(world, third.start);
      await restarted.outset();
      expect(third.asked).toEqual([]);
      await pause(30);
      expect((await restarted.pass()).asked.map((entry) => entry.request.commit)).toEqual([waiting]);
      restarted.stop();
    } finally {
      world.remove();
    }
  });

  test('a declared repository that is no checkout is not watched, and the line names its path', async () => {
    const world = fixture();
    try {
      // A second product whose manifest declares a repository nothing stands in: the watcher names the folder it
      // looked at and starts no run for that product.
      const missing = join(world.home, 'kiosk');
      mkdirSync(missing, { recursive: true });
      writeFileSync(join(missing, 'workspace.yaml'), [
        'schemaVersion: 1',
        'id: 3a9c5b21-0f4d-4c8e-9a76-1b2c3d4e5f60',
        'name: kiosk',
        'repos:',
        '  - name: terminal',
        '    linked: true',
        '',
      ].join('\n'));
      git(missing, 'init', '--initial-branch=main', '--quiet');
      world.commit(missing, 'README.md', '# kiosk\n', 'the product is created');
      const lines: string[] = [];
      const run = recorder();
      const watch = createUpdateWatch({
        home: world.home,
        start: run.start,
        debounceMs: 20,
        intervalMs: 0,
        enabled: () => true,
        log: (line) => lines.push(line),
        watchPath: () => () => undefined,
      });
      const pass = await watch.outset();
      const absence = join(missing, 'repos', 'terminal', '.git');
      expect(pass.unreadable.filter((line) => line.includes(absence)).length).toBe(1);
      expect(lines.some((line) => line.includes(absence))).toBe(true);
      expect(run.asked).toEqual([]);
      // The product that is whole is watched in the same pass: one unreadable repository hides no other.
      expect(pass.unreadable.length).toBe(1);
      expect(readSeenHeads(world.home)[seenKey('shop', 'library')]).toEqual({ branch: 'main', commit: git(world.codeRepo, 'rev-parse', 'HEAD') });
      watch.stop();
    } finally {
      world.remove();
    }
  });
});
