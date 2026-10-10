import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createDraft, productsHome } from '../src/product/draft.js';

/**
 * The machine's real git, resolved once: a stub placed on PATH in a test
 * passes every command it does not itself answer to this file, so the test
 * depends only on git being installed, never on where it is.
 */
function realGit(): string {
  const path = Bun.which('git');
  if (!path) throw new Error('git is not on PATH; these tests need it');
  return path;
}

/** A word quoted shell-safely: even a path holding a dollar, a backtick or a quote stands as itself. */
const shQuote = (word: string): string => "'" + word.split("'").join("'\\''") + "'";
import { readProduct } from '../src/product/manifest.js';
import { gitEnv } from './git-env.js';
import { GIT_IDENTITY, GIT_ENV } from './model-check-repo.js';
import { refuseNonScratchHome, noStrayDrafts, ISOLATED_HOME } from './scratch-home.js';

// The library tests here create drafts in-process: with MADARCH_HOME at a
// scratch home, a mutated productsHome that ignores the `home` its caller
// gave still lands beside the scratch, never in the account's real home —
// the command tests seal their children's HOME besides this (scratch-home).
process.env.MADARCH_HOME = process.env.MADARCH_HOME ?? ISOLATED_HOME;

/**
 * The draft product repository (docs/changes/draft-product/capabilities/
 * product-repository.md, requirements draft and manifest): what `madarch
 * new` gives a person with only an idea — a real git repository under the
 * products home, one commit holding the skeleton and an untracked repos/,
 * and a manifest that reads the product's identity back. Every expected
 * value below comes from the capability, never from the implementation.
 */

/**
 * Every temporary folder this file makes, removed after each test and on
 * exit with whatever is left, pass or fail: a run of the suite leaves the
 * system temporary folder as it found it.
 */
const made: string[] = [];

function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  const strays = noStrayDrafts();
  if (strays.leftAlone.length) throw new Error(`the tests left what they cannot own in the real products home, untouched: ${strays.leftAlone.join(', ')}`);
  if (strays.removed.length) throw new Error(`the tests left stray drafts in the real products home (removed): ${strays.removed.join(', ')}`);
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);

/** The ninth of October 2026, the capability's example day, as a local date. */
const EXAMPLE_DAY = new Date(2026, 9, 9);

const git = (args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } => {
  const run = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', env: gitEnv(GIT_ENV) });
  return { ok: run.status === 0, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
};

/** Creates a draft on the capability's example day, with git sealed to a fixed identity. */
const draftIn = (home: string) => createDraft({ home: refuseNonScratchHome(home, 'draftIn'), today: EXAMPLE_DAY, gitEnv: gitEnv(GIT_ENV) });

/** The files git tracks at the draft's HEAD, in code-point order. */
const tracked = (folder: string): string[] =>
  git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], folder).stdout.split('\0').filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe('productsHome', () => {
  test('MADARCH_HOME moves the madarch home, so the products home is products under it', () => {
    expect(productsHome({ MADARCH_HOME: '/data/madarch' })).toBe(join('/data/madarch', 'products'));
  });

  test('the folder --home names is the products home of this one command, over MADARCH_HOME', () => {
    expect(productsHome({ MADARCH_HOME: '/data/madarch' }, '/elsewhere')).toBe('/elsewhere');
  });

  test('without either, the products home is ~/madarch/products', () => {
    expect(productsHome({})).toBe(join(homedir(), 'madarch', 'products'));
  });

  test('an override of only spaces counts as unset', () => {
    expect(productsHome({ MADARCH_HOME: '   ' }, ' /scratch ')).toBe('/scratch');
    expect(productsHome({ MADARCH_HOME: '   ' })).toBe(join(homedir(), 'madarch', 'products'));
  });

  test('a --home of nothing or only spaces counts as unset, and MADARCH_HOME takes over', () => {
    expect(productsHome({}, '')).toBe(join(homedir(), 'madarch', 'products'));
    expect(productsHome({ MADARCH_HOME: '/data/madarch' }, '')).toBe(join('/data/madarch', 'products'));
    expect(productsHome({ MADARCH_HOME: '/data/madarch' }, '   ')).toBe(join('/data/madarch', 'products'));
  });
});

describe('createDraft', () => {
  test('one draft a day sits at idea-YYYY-MM-DD of the local date, a git repository with one skeleton commit', () => {
    const home = tempFolder('madarch-products-');
    const draft = draftIn(home);
    expect(draft).toMatchObject({ outcome: 'created' });
    if (draft.outcome !== 'created') return;
    expect(draft.folder).toBe(join(home, 'idea-2026-10-09'));
    const folder = draft.folder;

    const listed = tracked(folder);
    expect(listed).toEqual([
      '.gitignore',
      'AGENTS.md',
      'CLAUDE.md',
      'docs/.gitkeep',
      'model/.gitkeep',
      'prototypes/.gitkeep',
      'skills/.gitkeep',
      'workspace.yaml',
    ]);
    for (const file of listed) expect(readFileSync(join(folder, file), 'utf8')).toBeDefined();
    for (const file of ['docs/.gitkeep', 'model/.gitkeep', 'skills/.gitkeep', 'prototypes/.gitkeep']) {
      expect(readFileSync(join(folder, file), 'utf8')).toBe('');
    }

    // repos/ exists on disk and is the only folder madarch leaves untracked.
    expect(readdirSync(folder, { withFileTypes: true }).find((entry) => entry.name === 'repos')?.isDirectory()).toBe(true);
    // Ignored, so nothing of it is staged, tracked or offered by status.
    expect(git(['status', '--porcelain'], folder).stdout).toBe('');

    const commits = git(['rev-list', '--count', 'HEAD'], folder);
    expect(commits).toMatchObject({ ok: true, stdout: '1\n' });

    // A folder a person's git does not track.
    expect(git(['check-ignore', '-q', 'repos/'], folder)).toMatchObject({ ok: true });
  });

  test('the manifest reads the draft back: its id, the folder name and the schema version', () => {
    const home = tempFolder('madarch-products-');
    const draft = draftIn(home);
    if (draft.outcome !== 'created') throw new Error(`the draft was not created: ${JSON.stringify(draft)}`);

    const read = readProduct(draft.folder);
    expect(read).toMatchObject({ ok: true, product: { schemaVersion: 1, name: 'idea-2026-10-09' } });
    if (!read.ok) return;
    expect(read.product.id).toBe(draft.id);
    expect(read.product.folder).toBe(draft.folder);
  });

  test('a second draft that day is -2, with its own id and its own first commit', () => {
    const home = tempFolder('madarch-products-');
    const first = draftIn(home);
    const second = draftIn(home);
    if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error('a draft was not created');
    expect(second.folder).toBe(join(home, 'idea-2026-10-09-2'));
    expect(second.id).not.toBe(first.id);
    expect(git(['rev-list', '--count', 'HEAD'], second.folder).stdout).toBe('1\n');

    const third = draftIn(home);
    if (third.outcome !== 'created') throw new Error('the third draft was not created');
    expect(third.folder).toBe(join(home, 'idea-2026-10-09-3'));
  });

  test('a day of one-digit month and date is padded to two digits', () => {
    const home = tempFolder('madarch-products-');
    const draft = createDraft({ home: refuseNonScratchHome(home, 'the padded-day test'), today: new Date(2026, 0, 5), gitEnv: gitEnv(GIT_ENV) });
    if (draft.outcome !== 'created') throw new Error('the draft was not created');
    expect(draft.folder).toBe(join(home, 'idea-2026-01-05'));
  });

  test('the skeleton is the same bytes in every draft, except the id and the folder name', () => {
    const homeA = tempFolder('madarch-products-a-');
    const homeB = tempFolder('madarch-products-b-');
    const a = draftIn(homeA);
    const b = draftIn(homeB);
    if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error('a draft was not created');

    for (const file of ['AGENTS.md', 'CLAUDE.md', '.gitignore', 'docs/.gitkeep', 'model/.gitkeep', 'skills/.gitkeep', 'prototypes/.gitkeep']) {
      expect(readFileSync(join(a.folder, file), 'utf8')).toBe(readFileSync(join(b.folder, file), 'utf8'));
    }
    // The manifest is the same shape everywhere; only its id and the
    // folder's name differ, which the capability makes different anyway.
    const fieldsA = readFileSync(join(a.folder, 'workspace.yaml'), 'utf8');
    const fieldsB = readFileSync(join(b.folder, 'workspace.yaml'), 'utf8');
    expect(fieldsA.replace(draftIdOf(fieldsA), draftIdOf(fieldsB))).toBe(fieldsB);
  });

  test("AGENTS.md is the constitution: the folders and what each is for, and madarch's markers around the part it maintains", () => {
    const home = tempFolder('madarch-products-');
    const draft = draftIn(home);
    if (draft.outcome !== 'created') throw new Error('the draft was not created');
    const agents = readFileSync(join(draft.folder, 'AGENTS.md'), 'utf8');

    for (const folder of ['docs/', 'model/', 'skills/', 'prototypes/', 'repos/']) {
      expect(agents).toContain(folder);
    }
    expect(agents).toContain('Markdown');
    expect(agents).toContain('git');
    expect(agents).toContain("team's own skills");
    // A marker pair around the part the pinned program maintains, its end
    // unmistakable: the set's own markers (decision 0019 — the creation is
    // the set's program, so its markers name the program, not madarch).
    const lines = agents.split('\n');
    for (const line of ['# Constitution', '## Folders', '## Documents', '<!-- product:maintained -->', '<!-- /product:maintained -->']) {
      expect(lines).toContain(line);
    }
  });

  test('CLAUDE.md holds nothing but AGENTS.md', () => {
    const home = tempFolder('madarch-products-');
    const draft = draftIn(home);
    if (draft.outcome !== 'created') throw new Error('the draft was not created');
    expect(readFileSync(join(draft.folder, 'CLAUDE.md'), 'utf8').trim()).toBe('@AGENTS.md');
  });

  test("nothing madarch writes into the product holds the products home's absolute path", () => {
    const home = tempFolder('madarch-products-');
    const draft = draftIn(home);
    if (draft.outcome !== 'created') throw new Error('the draft was not created');
    for (const file of tracked(draft.folder)) {
      const text = readFileSync(join(draft.folder, file), 'utf8');
      expect(text).not.toContain(draft.folder);
      expect(text).not.toContain(home);
    }
    // And nothing in the committed history holds it either.
    expect(git(['grep', '-I', '--fixed-strings', '-e', home, 'HEAD'], draft.folder)).toMatchObject({ ok: false });
  });

  test('the loader variables the caller carries never reach the draft\'s git', () => {
    const home = tempFolder('madarch-products-');
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = '/nowhere';
    process.env.GIT_INDEX_FILE = '/nowhere/index';
    process.env.GIT_WORK_TREE = '/nowhere/tree';
    try {
      const draft = draftIn(home);
      expect(draft).toMatchObject({ outcome: 'created' });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('the draft\'s git is called bare, with the caller\'s own environment filtered of the loader variables', () => {
    // A sealed identity, not an empty one: the environment the git calls
    // run in is still built from the process's, which here carries a
    // GIT_DIR no git in the draft must see — the identity the test itself
    // needs must not come from the machine's git configuration.
    const home = tempFolder('madarch-products-');
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/nowhere';
    try {
      const draft = createDraft({ home, today: EXAMPLE_DAY, gitEnv: gitEnv(GIT_ENV) });
      expect(draft).toMatchObject({ outcome: 'created' });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test('a products home that is a file is refused, and no product folder is created anywhere', () => {
    const base = tempFolder('madarch-products-file-');
    const home = join(base, 'home');
    writeFileSync(home, 'not a folder\n');
    const draft = draftIn(home);
    expect(draft).toMatchObject({ outcome: 'refused' });
    if (draft.outcome !== 'refused') return;
    expect(draft.message).toContain(home);
    expect(draft.message).toContain('cannot be used');
    expect(readdirSync(base)).toEqual(['home']);
  });

  test.skipIf(process.getuid?.() !== 0)("a draft under the root products home is named by its own name, not one letter short", () => {
    // With a writable `--home /`, the old code took the name from
    // `folder.slice(home.length + 1)`, which for `/idea-2026-10-09` cuts
    // the first two characters and reads `dea-2026-10-09`. The test
    // touches the real root as a products home must, and cleans up after
    // itself by removing exactly the folder the creation call reported
    // — `draft.folder` — and nothing else: listing `/` before and after
    // and deleting the difference would delete an entry another process
    // made in the window, fail on one made after the snapshot, and leak
    // the draft if the second listing throws. What the test proves: the
    // draft's name and folder are the ones the reservation reported, the
    // folder sits directly under the products home `/`, and the manifest
    // reads back under that name. What it does not prove: that `/` is
    // unchanged outside the draft — creating and removing a folder
    // changes `/`'s own timestamps, so "leaves `/` as found" is not
    // something a folder-listing test can honestly say.
    let draft: ReturnType<typeof draftIn> | undefined;
    try {
      // The one exemption the guard holds: this test touches `/` as a
      // products home on purpose, and removes exactly the folder the
      // creation reports. The guard's allowance says so in the same breath.
      draft = createDraft({ home: refuseNonScratchHome('/', 'the root home test', { allow: 'the root home test', why: 'touching / is the test\'s own subject' }), today: EXAMPLE_DAY, gitEnv: gitEnv(GIT_ENV) });
      if (draft.outcome !== 'created') throw new Error(`the draft was not created: ${JSON.stringify(draft)}`);
      expect(draft.folder).toBe(join('/', draft.name));
      // The name is the folder's own name — read never by a slice of the path.
      expect(draft.name.startsWith('idea-')).toBe(true);
      const read = readProduct(draft.folder);
      expect(read).toMatchObject({ ok: true, product: { name: draft.name } });
    } finally {
      if (draft?.outcome === 'created') {
        rmSync(draft.folder, { recursive: true, force: true });
        expect(readdirSync('/').includes(draft.name)).toBe(false);
      }
    }
  });
  test("a git that refuses to commit fails with git's own words and leaves no folder behind", () => {
    const stubs = tempFolder('madarch-products-gitstub-');
    const script = ['#!/bin/sh', 'if [ "$1" = "commit" ]; then', "  echo 'stub: refusing to commit' >&2; exit 1; fi", `exec ${shQuote(realGit())} "$@"`, ''].join('\n');
    writeFileSync(join(stubs, 'git'), script);
    chmodSync(join(stubs, 'git'), 0o700);
    const home = tempFolder('madarch-products-');
    const draft = createDraft({ home: refuseNonScratchHome(home, 'a stub test'), today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: stubs }) });
    expect(draft).toMatchObject({ outcome: 'failed' });
    if (draft.outcome !== 'failed') return;
    expect(draft.message).toContain('refusing to commit');
    expect(readdirSync(home).filter((name) => name.startsWith('idea-'))).toEqual([]);
  });

  test('a git that refuses to stage fails with git\'s own words and leaves no folder behind', () => {
    const stubs = tempFolder('madarch-products-gitstub-add-');
    const script = ['#!/bin/sh', 'if [ "$1" = "add" ]; then', "  echo 'stub: refusing to add' >&2; exit 1; fi", `exec ${shQuote(realGit())} "$@"`, ''].join('\n');
    writeFileSync(join(stubs, 'git'), script);
    chmodSync(join(stubs, 'git'), 0o700);
    const home = tempFolder('madarch-products-');
    const draft = createDraft({ home: refuseNonScratchHome(home, 'a stub test'), today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: stubs }) });
    expect(draft).toMatchObject({ outcome: 'failed' });
    if (draft.outcome !== 'failed') return;
    expect(draft.message).toContain('refusing to add');
    expect(readdirSync(home).filter((name) => name.startsWith('idea-'))).toEqual([]);
  });

  test('a home that cannot be created is refused, naming the path', () => {
    const base = tempFolder('madarch-products-ro-');
    const home = join(base, 'blocker', 'deeper', 'products');
    writeFileSync(join(base, 'blocker'), 'a file where a folder is needed\n');
    const draft = draftIn(home);
    expect(draft).toMatchObject({ outcome: 'refused' });
    if (draft.outcome !== 'refused') return;
    expect(draft.message).toContain(home);
    expect(draft.message).toContain('cannot be created');
    expect(readdirSync(base)).toEqual(['blocker']);
  });
});

describe('readProduct', () => {
  test('the manifest may name a field this madarch does not know, and still opens', () => {
    const home = tempFolder('madarch-products-');
    const draft = draftIn(home);
    if (draft.outcome !== 'created') throw new Error('the draft was not created');
    const manifest = readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8');
    writeFileSync(join(draft.folder, 'workspace.yaml'), `${manifest}wikiRevision: 7\n`);
    const read = readProduct(draft.folder);
    expect(read).toMatchObject({ ok: true, product: { schemaVersion: 1, id: draft.id, name: 'idea-2026-10-09' } });
  });

  test('a manifest naming no name falls back to the folder\'s name, which a draft\'s name is', () => {
    const base = tempFolder('madarch-products-nomame-');
    const folder = join(base, 'my-product-folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', ''].join('\n'));
    const read = readProduct(folder);
    expect(read).toMatchObject({ ok: true, product: { schemaVersion: 1, id: '3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', name: 'my-product-folder' } });

    // An empty name is no name; and a folder's path may end in a slash.
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: ""', ''].join('\n'));
    expect(readProduct(folder)).toMatchObject({ ok: true, product: { name: 'my-product-folder' } });
    expect(readProduct(`${folder}/`)).toMatchObject({ ok: true, product: { name: 'my-product-folder' } });
  });

  test('a manifest naming no id is refused, naming the file and the field', () => {
    const home = tempFolder('madarch-products-');
    const draft = draftIn(home);
    if (draft.outcome !== 'created') throw new Error('the draft was not created');
    const manifest = readFileSync(join(draft.folder, 'workspace.yaml'), 'utf8');
    const withoutId = manifest.split('\n').filter((line) => !line.startsWith('id:')).join('\n');
    writeFileSync(join(draft.folder, 'workspace.yaml'), withoutId);
    const read = readProduct(draft.folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(draft.folder, 'workspace.yaml'));
    expect(read.message).toContain('id');
  });

  test('a folder holding no manifest is refused, naming the file looked for and the folder', () => {
    const folder = tempFolder('madarch-products-empty-');
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain(folder);
    expect(read.message).toContain('workspace.yaml');
    expect(read.message).toContain('holds no workspace.yaml');
    expect(read.line).toBe(1);
  });

  test('a manifest that is a folder is refused as one that could not be read', () => {
    const folder = tempFolder('madarch-products-dirman-');
    mkdirSync(join(folder, 'workspace.yaml'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain('could not be read');
    expect(read.line).toBe(1);
  });
});

/** The id named by a manifest's text, read only to build one expected text from another. */
function draftIdOf(manifest: string): string {
  const line = manifest.split('\n').find((line) => line.startsWith('id:'));
  expect(line).toBeDefined();
  return (line ?? '').slice('id: '.length).trim();
}

describe('createDraft: reservations and homes that cannot be used', () => {
  test('a folder that appears before the draft is named is left alone, and the draft takes the next suffix', () => {
    // The shape the review found: another run's folder stands where this
    // run's first candidate name points, with an inner `docs` that is a
    // file. The run must refuse nothing, delete nothing of that folder,
    // and take the day's next suffix.
    const home = tempFolder('madarch-products-race-');
    const other = join(home, 'idea-2026-10-09');
    mkdirSync(other);
    writeFileSync(join(other, 'docs'), "another run's draft\n");
    const draft = draftIn(home);
    expect(draft).toMatchObject({ outcome: 'created' });
    if (draft.outcome !== 'created') return;
    expect(draft.folder).toBe(join(home, 'idea-2026-10-09-2'));
    expect(readFileSync(join(other, 'docs'), 'utf8')).toContain('another run');
  });

  test('a products home the process cannot write into is refused, not failed', () => {
    if (process.getuid?.() === 0) return; // root writes anywhere; the case is meaningless there.
    const base = tempFolder('madarch-products-nowrap-');
    const home = join(base, 'products');
    mkdirSync(home, { recursive: true, mode: 0o555 });
    try {
      const draft = draftIn(home);
      expect(draft).toMatchObject({ outcome: 'refused' });
      if (draft.outcome !== 'refused') return;
      expect(draft.message).toContain(home);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  test('git missing from the environment fails with git\'s own error as the cause', () => {
    const home = tempFolder('madarch-products-nogit-');
    const draft = createDraft({ home: refuseNonScratchHome(home, 'the git-missing test'), today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: '/nonexistent' }) });
    expect(draft).toMatchObject({ outcome: 'failed' });
    if (draft.outcome !== 'failed') return;
    // The cause after the colon is git's own error, never nothing:
    expect(draft.message).toMatch(/git init failed in .+: .+/);
    expect(readdirSync(home).filter((name) => name.startsWith('idea-'))).toEqual([]);
  });

  test('a draft read by a relative path names the full path', () => {
    const home = tempFolder('madarch-products-rel-');
    const draft = draftIn(home);
    expect(draft.outcome).toBe('created');
    if (draft.outcome !== 'created') return;
    const saved = process.cwd();
    process.chdir(home);
    try {
      const base = draft.folder.split('/').at(-1)!;
      const read = readProduct(base);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.product.folder).toBe(join(home, base));
      expect(read.product.id).toBe(draft.id);
    } finally {
      process.chdir(saved);
    }
  });
});

describe('createDraft: a cleanup that fails is reported', () => {
  test('git fails and the leftover folder cannot be removed: both failures are named, with the full path', () => {
    if (process.getuid?.() === 0) return; // root unlinks anywhere; the case is meaningless there.
    const stubs = tempFolder('madarch-products-wedgestub-');
    // The stub refuses the add and makes the draft's own folder
    // unremovable before it exits, so the cleanup fails after the failure.
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "add" ]; then',
      `  ${shQuote(Bun.which('chmod') ?? 'chmod')} u-w . docs model skills prototypes repos`,
      "  echo 'stub: refusing to add' >&2; exit 1;",
      'fi',
      `exec ${shQuote(realGit())} "$@"`,
      '',
    ].join('\n');
    writeFileSync(join(stubs, 'git'), script);
    chmodSync(join(stubs, 'git'), 0o700);
    const home = tempFolder('madarch-products-');
    const draft = createDraft({ home: refuseNonScratchHome(home, 'a stub test'), today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: stubs }) });
    expect(draft).toMatchObject({ outcome: 'failed' });
    if (draft.outcome !== 'failed') return;
    expect(draft.message).toContain('refusing to add');
    const leftover = readdirSync(home).find((name) => name.startsWith('idea-'));
    expect(leftover).toBeDefined();
    expect(draft.message).toContain(join(home, leftover ?? ''));
    expect(draft.message).toContain('could not be removed');
    // Let the tests' own cleanup remove the leftover: the stub made the
    // draft's own folders unwritable, and this undoes exactly that.
    for (const dir of ['', 'docs', 'model', 'skills', 'prototypes', 'repos']) {
      chmodSync(join(home, leftover!, dir), 0o700);
    }
  });
});
