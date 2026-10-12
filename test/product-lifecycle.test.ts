/**
 * The lifecycle operations madarch's own code carries (decision 0021):
 * renameProduct, addRemote, addCodeRepository, bootstrapProduct, whereAmI —
 * each driven in-process against real git, with the product surfaces and
 * refusal words the guide records (docs/guides/start-a-product.md). The
 * command layer's parsing and printing is test/product-cli's; this file is
 * the operations' own, the way a mutant is asked by one fast run.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  addCodeRepository,
  addRemote,
  bootstrapProduct,
  cloneLife,
  renameProduct,
  whereAmI,
} from '../src/product/lifecycle.js';
import { ownRepository, runGit } from '../src/product/git.js';
import { readProduct } from '../src/product/manifest.js';
import { createDraft } from '../src/product/draft.js';
import { type DraftEnv } from '../src/product/draft.js';
import { gitEnv } from './git-env.js';
import { GIT_ENV } from './model-check-repo.js';
import { ISOLATED_HOME, noStrayDrafts } from './scratch-home.js';

process.env.MADARCH_HOME = ISOLATED_HOME;

/** Children a test started live, killed again so none outlives its test. */
const running: { kill(): void }[] = [];

const made: string[] = [];
const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const path of running.splice(0)) { try { path.kill(); } catch { /* gone */ } }
  const strays = noStrayDrafts();
  if (strays.newEntries.length) throw new Error(`the real products home gained entries: ${strays.newEntries.join(', ')}`);
};
afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);

const EXAMPLE_DAY = new Date(2026, 9, 9);

function tempFolder(prefix = 'madarch-lifecycle-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A draft the test itself created, git sealed to a fixed identity. */
function draftIn(home: string): Extract<ReturnType<typeof createDraft>, { outcome: 'created' }> {
  const made0 = createDraft({ home, today: EXAMPLE_DAY, gitEnv: gitEnv(GIT_ENV) });
  if (made0.outcome !== 'created') throw new Error(`fixture: ${JSON.stringify(made0)}`);
  return made0;
}

/** The machine's real git, so a stub passes through to it. */
function realGit(): string {
  const path = Bun.which('git');
  if (!path) throw new Error('git is not on PATH; these tests need it');
  return path;
}

const shQuote = (word: string): string => "'" + word.split("'").join("'\\''") + "'";

/** Names a git stub: commands tonight's list refuses with the given words, the rest passes to real git. */
function gitStubs(base: string, refusing: Record<string, string>): string {
  const stubs = join(base, 'stubs');
  mkdirSync(stubs, { recursive: true });
  const script = ['#!/bin/sh', 'if [ "$1" = "commit" ]; then', "  echo 'stub: refusing to commit' >&2; exit 1; fi", `exec ${shQuote(realGit())} "$@"`, ''].join('\n');
  void refusing;
  const file = join(stubs, 'git');
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return stubs;
}

/** A small code repository the tests clone from: one commit, one README. */
function sourceRepo(base: string, name: string): string {
  const origin = join(base, `${name}-origin`);
  const work = join(base, `${name}-work`);
  mkdirSync(work, { recursive: true });
  const git = (args: string[], cwd?: string): void => {
    const step = spawnSync(realGit(), args, { cwd, encoding: 'utf8', env: gitEnv(GIT_ENV) });
    if (step.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${step.stderr}`);
  };
  git(['init', '--quiet', '--initial-branch=main'], work);
  writeFileSync(join(work, 'README.md'), 'a repository the tests clone from\n');
  git(['add', '--', 'README.md'], work);
  git(['commit', '--quiet', '-m', 'The source'], work);
  git(['clone', '--quiet', '--bare', work, origin]);
  return origin;
}

/** Narrows a refused outcome to its message: the words the guide records. */
function refusal(result: { outcome: string; message?: string }): string {
  expect(result.outcome).toBe('refused');
  return result.message ?? '';
}

describe("renameProduct, madarch own operation", () => {
  test('names a draft in place: folder, manifest, one commit, id kept', () => {
    const home = join(tempFolder(), 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    const done = renameProduct({ folder: draft.folder, name: 'gadgets', gitEnv: gitEnv(GIT_ENV) });
    expect(done).toMatchObject({ outcome: 'renamed', folder: join(home, 'gadgets'), id: draft.id, name: 'gadgets' });
    const read = readProduct(join(home, 'gadgets'));
    expect(read).toMatchObject({ ok: true, product: { id: draft.id, name: 'gadgets' } });
    const log = spawnSync(realGit(), ['log', '--oneline'], { cwd: join(home, 'gadgets'), encoding: 'utf8', env: gitEnv(GIT_ENV) });
    expect(log.stdout).toContain('Name the product gadgets');
  });

  test('refuses the name the home holds, the name it has, and a name a folder cannot take', () => {
    const home = join(tempFolder(), 'home');
    mkdirSync(home, { recursive: true });
    const first = draftIn(home);
    draftIn(home);
    expect(renameProduct({ folder: first.folder, name: 'idea-2026-10-09-2', gitEnv: gitEnv(GIT_ENV) }))
      .toMatchObject({ outcome: 'refused' });
    if (renameProduct({ folder: first.folder, name: 'idea-2026-10-09-2', gitEnv: gitEnv(GIT_ENV) }).outcome !== 'refused') throw new Error('unreachable');
    expect(renameProduct({ folder: first.folder, name: 'idea-2026-10-09-2', gitEnv: gitEnv(GIT_ENV) }).outcome).toBe('refused');
    expect((renameProduct({ folder: first.folder, name: 'idea-2026-10-09-2', gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message).toContain('is in the way');
    // The name the product already has: no commit at all.
    expect((renameProduct({ folder: first.folder, name: 'idea-2026-10-09', gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message)
      .toContain('already named');
    // A name a folder cannot take.
    expect((renameProduct({ folder: first.folder, name: '../escape', gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message).toContain("cannot be a product's: a folder name is one path segment");
    // A word the folder name rules refuse at its edges, and a control character.
    expect((renameProduct({ folder: first.folder, name: ' gadgets', gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message).toContain('does not begin or end with a space');
    expect((renameProduct({ folder: first.folder, name: 'a\tb', gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message).toContain('holds no control character');
    expect((renameProduct({ folder: first.folder, name: 'a/b', gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message).toContain('holds a separator');
  });

  test('refuses an uncommitted change, exit words unchanged', () => {
    const home = join(tempFolder(), 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    writeFileSync(join(draft.folder, 'docs', 'vision.md'), 'not committed\n');
    expect((renameProduct({ folder: draft.folder, name: 'gadgets', gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message)
      .toContain('holds changes that are not committed');
  });

  test('a git that refuses the commit fails and leaves the folder as it was', () => {
    const base = tempFolder();
    const stubs = gitStubs(base, { commit: 'refusing to commit' });
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    const saved = process.env.PATH;
    process.env.PATH = `${stubs}:${process.env.PATH ?? ''}`;
    try {
      const done = renameProduct({ folder: draft.folder, name: 'gadgets', gitEnv: gitEnv(GIT_ENV) });
      expect(done.outcome).toBe('failed');
      if (done.outcome === 'failed') expect(done.message).toContain('refusing to commit');
      expect(readProduct(draft.folder).ok).toBe(true);
      expect(readProduct(join(home, 'gadgets')).ok).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('addRemote, madarch\u2019s own operation', () => {
  test('adds origin and never pushes; an origin standing there is refused', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    expect(addRemote({ folder: draft.folder, url: join(base, 'one.git'), gitEnv: gitEnv(GIT_ENV) }))
      .toMatchObject({ outcome: 'added', folder: draft.folder, remote: 'origin' });
    const got = spawnSync(realGit(), ['remote', 'get-url', 'origin'], { cwd: draft.folder, encoding: 'utf8', env: gitEnv(GIT_ENV) });
    expect(got.stdout.trim()).toBe(join(base, 'one.git'));
    expect((addRemote({ folder: draft.folder, url: join(base, 'two.git'), gitEnv: gitEnv(GIT_ENV) }) as { message: string }).message)
      .toContain('already has the remote "origin"');
  });

  test('an empty url and an option-shaped url are refused', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    expect(refusal(addRemote({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) }))).toContain('no url was given');
    expect(refusal(addRemote({ folder: draft.folder, url: '--flag', gitEnv: gitEnv(GIT_ENV) }))).toContain('begins with "-"');
  });
});

describe('addCodeRepository and bootstrapProduct, madarch\u2019s own operations', () => {
  test('enters the repository in the manifest and bootstraps clones it; the declared branch goes in', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    const url = sourceRepo(base, 'library');
    const entered = addCodeRepository({ folder: draft.folder, name: 'library', url, branch: 'main', gitEnv: gitEnv(GIT_ENV) });
    expect(entered).toMatchObject({ outcome: 'entered', folder: draft.folder, name: 'library', url, branch: 'main' });
    const read = readProduct(draft.folder);
    expect(read).toMatchObject({ ok: true, product: { repos: [{ name: 'library', branch: 'main' }] } });
    const bootstrapped = bootstrapProduct({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) });
    if (bootstrapped.outcome !== 'bootstrapped') throw new Error(`bootstrap: ${JSON.stringify(bootstrapped)}`);
    expect(bootstrapped.repos).toHaveLength(1);
    expect(bootstrapped.repos[0]).toMatchObject({ name: 'library', state: 'cloned', url });
    expect(readFileSync(join(draft.folder, 'repos', 'library', 'README.md'), 'utf8')).toContain('a repository the tests clone from');
    // A checkout standing there is left as it is and named present.
    const again = bootstrapProduct({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) });
    if (again.outcome !== 'bootstrapped') throw new Error('bootstrap again refused');
    expect(again.repos[0]).toMatchObject({ state: 'present' });
  });

  test('a name the manifest already declares is refused at the manifest\u2019s own place', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    const url = sourceRepo(base, 'library');
    expect(addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) }).outcome).toBe('entered');
    const refused = addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) });
    expect(refused).toMatchObject({ outcome: 'refused', file: join(draft.folder, 'workspace.yaml') });
    if (refused.outcome !== 'refused') return;
    expect(refused.message).toContain('already declares the code repository "library"');
    expect(refused.line).toBe(5);
  });

  test('uncommitted changes in the product are refused, before anything is written', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    writeFileSync(join(draft.folder, 'docs', 'vision.md'), 'hold it back\n');
    const url = sourceRepo(base, 'library');
    expect(refusal(addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) })))
      .toContain('holds changes that are not committed');
  });

  test('a name that is no folder name and an empty url are refused with the command\u2019s words', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    expect(refusal(addCodeRepository({ folder: draft.folder, name: '../escape', url: 'u', gitEnv: gitEnv(GIT_ENV) })))
      .toContain("cannot be a code repository's");
    expect(refusal(addCodeRepository({ folder: draft.folder, name: 'lib', gitEnv: gitEnv(GIT_ENV) })))
      .toContain('no url was given');
    expect(refusal(addCodeRepository({ folder: draft.folder, name: 'lib', url: '--flag', gitEnv: gitEnv(GIT_ENV) })))
      .toContain('begins with "-"');
    expect(refusal(addCodeRepository({ folder: draft.folder, name: 'lib', url: 'u', branch: ' ', gitEnv: gitEnv(GIT_ENV) })))
      .toContain('the branch was given empty');
  });

  test('a declared name standing in the way of the clone is a failed report; the manifest close ends the entry road', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    const url = sourceRepo(base, 'library');
    addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) });
    writeFileSync(join(draft.folder, 'repos', 'library'), 'not a folder\n');
    const bootstrapped = bootstrapProduct({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) });
    if (bootstrapped.outcome !== 'bootstrapped') throw new Error('refused');
    expect(bootstrapped.repos[0]).toMatchObject({ name: 'library', state: 'failed' });
  });
});

describe('whereAmI walking up', () => {
  test('from the product, from a checkout under repos/, and from neither', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    const url = sourceRepo(base, 'library');
    addCodeRepository({ folder: draft.folder, name: 'library', url, gitEnv: gitEnv(GIT_ENV) });
    bootstrapProduct({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) });
    expect(whereAmI({ folder: draft.folder, gitEnv: gitEnv(GIT_ENV) }))
      .toMatchObject({ outcome: 'product', product: draft.folder });
    expect(whereAmI({ folder: join(draft.folder, 'repos', 'library'), gitEnv: gitEnv(GIT_ENV) }))
      .toMatchObject({ outcome: 'code', product: draft.folder, repo: 'library' });
    expect(whereAmI({ folder: join(draft.folder, 'docs'), gitEnv: gitEnv(GIT_ENV) }))
      .toMatchObject({ outcome: 'product', product: draft.folder });
    expect(whereAmI({ folder: base, gitEnv: gitEnv(GIT_ENV) }).outcome).toBe('none');
    expect(whereAmI({ folder: join(base, 'no-such-folder') }).outcome).toBe('refused');
  });
});

describe("the git runs keep the caller's environment to themselves", () => {
  test('a loader variable the caller carries never redirects a git call made here', () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    const draft = draftIn(home);
    // The repository-targeting variables of `git rev-parse
    // --local-env-vars`, each pointed at a path that is no repository: a git
    // call that inherited any of them would answer that path or fail, and
    // the product's own repository is the one that must answer.
    const leaks = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
    const before = new Map(leaks.map((name) => [name, process.env[name]]));
    try {
      for (const name of leaks) process.env[name] = join(base, 'not-a-repo');
      expect(ownRepository(draft.folder, gitEnv(GIT_ENV))).toBe(true);
      expect(renameProduct({ folder: draft.folder, name: 'gadgets', gitEnv: gitEnv(GIT_ENV) }))
        .toMatchObject({ outcome: 'renamed', folder: join(home, 'gadgets') });
      expect(addRemote({ folder: join(home, 'gadgets'), url: join(base, 'origin.git'), gitEnv: gitEnv(GIT_ENV) }))
        .toMatchObject({ outcome: 'added', url: join(base, 'origin.git') });
      // The shallow pointer a re-indexed checkout's caller carries must not
      // make the product's own history read shallow: the history is the
      // product's, whoever runs the command beside it.
      writeFileSync(join(base, 'shallow'), '0000000000000000000000000000000000000000\n');
      const shallow = runGit(join(home, 'gadgets'), ['rev-parse', '--is-shallow-repository']);
      expect(shallow).toMatchObject({ ok: true, output: 'false' });
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("the clone a url makes runs as this module's own git run, the loader variables stripped", () => {
    const base = tempFolder();
    const home = join(base, 'home');
    mkdirSync(home, { recursive: true });
    // The url names a product repository of its own: a draft the helper made
    // and committed. Cloning it without the loader variables' isolation would
    // let GIT_COMMON_DIR point the child git somewhere else entirely.
    const origin = draftIn(base);
    const before = process.env.GIT_COMMON_DIR;
    try {
      process.env.GIT_COMMON_DIR = join(base, 'not-a-repo');
      const outcome = cloneLife({ url: origin.folder, home, env: process.env as unknown as DraftEnv });
      expect(outcome).toMatchObject({ exit: 0 });
      const read = readProduct(join(home, 'idea-2026-10-09'));
      expect(read).toMatchObject({ ok: true, product: { name: 'idea-2026-10-09' } });
    } finally {
      if (before === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = before;
    }
  });
});
