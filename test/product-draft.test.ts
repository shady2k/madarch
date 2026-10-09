import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createDraft, productsHome, reserveDraftFolder } from '../src/product/draft.js';

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
const draftIn = (home: string) => createDraft({ home, today: EXAMPLE_DAY, gitEnv: gitEnv(GIT_ENV) });

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
    const draft = createDraft({ home, today: new Date(2026, 0, 5), gitEnv: gitEnv(GIT_ENV) });
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
    // A marker pair around the part madarch maintains, its end unmistakable.
    const lines = agents.split('\n');
    for (const line of ['# Constitution', '## Folders', '## Documents', '<!-- madarch:maintained -->', '<!-- /madarch:maintained -->']) {
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
      draft = draftIn('/');
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
    const draft = createDraft({ home, today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: stubs }) });
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
    const draft = createDraft({ home, today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: stubs }) });
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

  test('a manifest whose name is not a word is refused, naming the field and its line', () => {
    const folder = tempFolder('madarch-products-badname-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: 5', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain('"name"');
    expect(read.line).toBe(3);
  });

  test('a manifest naming no schema version is refused, naming the field', () => {
    const folder = tempFolder('madarch-products-noschema-');
    writeFileSync(join(folder, 'workspace.yaml'), ['id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: idea-2026-10-09', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain('names no "schemaVersion"');
  });

  test('a manifest whose id is there but empty is refused as one naming no id', () => {
    const folder = tempFolder('madarch-products-noid2-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', `id: ""`, 'name: idea-2026-10-09', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain('"id"');
  });

  test('a manifest whose id is only spaces is refused as well', () => {
    const folder = tempFolder('madarch-products-blankid-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', "id: '   '", 'name: idea-2026-10-09', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain('"id"');
  });

  test('a manifest whose id is not a word is refused, naming the field and what stood there', () => {
    const folder = tempFolder('madarch-products-badid-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'name: idea-2026-10-09', 'id: 5', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain('5');
    expect(read.message).toContain('"id"');
    expect(read.message).not.toContain('names no');
    expect(read.line).toBe(3);
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

  test('a manifest naming no id is refused with its own words, not the missing value\'s', () => {
    const folder = tempFolder('madarch-products-noid3-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'name: idea-2026-10-09', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain('names no "id"');
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

  test('a schema version this madarch does not know is refused, naming the field and its line', () => {
    const folder = tempFolder('madarch-products-version-');
    writeFileSync(join(folder, 'workspace.yaml'), ['# the manifest of a later madarch with a new schema version', 'name: idea-2026-10-09', 'schemaVersion: 2', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain('"schemaVersion"');
    expect(read.line).toBe(3);
  });

  test('a manifest that cannot be read is refused, naming the file, the line and the reason', () => {
    const folder = tempFolder('madarch-products-bad-');
    writeFileSync(join(folder, 'workspace.yaml'), ['id: [', 'name: idea-2026-10-09', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    // The line the parser gives when it stops reading, 1 or later.
    expect(read.line).toBeGreaterThanOrEqual(1);
    expect(read.message).toContain('cannot be read as YAML');
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

  test('a manifest that is not a mapping is refused, naming the file', () => {
    const folder = tempFolder('madarch-products-stray-');
    writeFileSync(join(folder, 'workspace.yaml'), 'just a word\n');
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
  });

  test('a manifest that is empty, and one that is a list, are each refused', () => {
    const empty = tempFolder('madarch-products-emptyfile-');
    writeFileSync(join(empty, 'workspace.yaml'), '');
    const readEmpty = readProduct(empty);
    expect(readEmpty.ok).toBe(false);

    const listed = tempFolder('madarch-products-listfile-');
    writeFileSync(join(listed, 'workspace.yaml'), '- just a list\n');
    const readListed = readProduct(listed);
    expect(readListed.ok).toBe(false);
    if (readListed.ok) return;
    expect(readListed.file).toBe(join(listed, 'workspace.yaml'));
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

  test("the reservation itself takes the next suffix on EEXIST and never touches a folder it did not create", () => {
    // The first-round race test pre-created the competitor before the run
    // ever chose a name; the old list-then-mkdir implementation survived
    // that too. The honest seam is the reservation step itself: one
    // non-recursive mkdir of the candidate, which must take the next
    // suffix when the name is taken and leave the other run's folder
    // exactly as it found it.
    const home = tempFolder('madarch-products-reserve-');
    const other = join(home, 'idea-2026-10-09');
    mkdirSync(other);
    writeFileSync(join(other, 'docs'), "another run's draft\n");
    const reserved = reserveDraftFolder(home, '2026-10-09');
    expect(reserved).toEqual({ folder: join(home, 'idea-2026-10-09-2'), name: 'idea-2026-10-09-2' });
    expect(readFileSync(join(other, 'docs'), 'utf8')).toContain('another run');
    // A first name still free is taken as it is.
    const fresh = reserveDraftFolder(home, '2026-10-10');
    expect(fresh).toEqual({ folder: join(home, 'idea-2026-10-10'), name: 'idea-2026-10-10' });
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
    const draft = createDraft({ home, today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: '/nonexistent' }) });
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
    const draft = createDraft({ home, today: EXAMPLE_DAY, gitEnv: gitEnv({ ...GIT_ENV, PATH: stubs }) });
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

describe('readProduct: manifests the reader cannot take', () => {
  test('a valid manifest followed by an unresolvable alias is refused, not thrown over', () => {
    const folder = tempFolder('madarch-products-alias-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: idea-2026-10-09', 'extra: *missing', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.line).toBe(4);
    expect(read.message).toContain('cannot be read as YAML');
  });

  test('a manifest using an alias as a mapping key is refused, naming the line the alias stands on', () => {
    // The review's shape: `extra: &key id` then `*key : replacement`. With
    // the alias resolved the key is `id`, so the later pairing overwrites
    // the product's id and the reader would succeed with the wrong id.
    const folder = tempFolder('madarch-products-aliaskey-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'extra: &key id', '*key : replacement-id', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain('alias');
    expect(read.line).toBe(4);
  });

  test("a valid alias cannot pin a later alias's failure on the earlier line", () => {
    // Line 3 holds an alias that resolves; line 4 holds one that never
    // appeared. The conversion refusal must name line 4.
    const folder = tempFolder('madarch-products-aliasline-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: &ref 1', 'id: *ref', 'extra: *missing', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.line).toBe(3);
  });
  test("a valid alias cannot pin a later alias's failure on the earlier line", () => {
    // Line 3 holds an alias that resolves; line 4 holds one that never
    // appeared. The conversion refusal must name line 4.
    const folder = tempFolder('madarch-products-aliasline-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: &ref 1', 'id: *ref', 'extra: *missing', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.line).toBe(3);
  });
  test("an alias with a forward reference is refused, naming the alias stand-in's line in document order", () => {
    // `*later` stands on line 4 while its anchor is defined on line 5: an
    // alias resolves only when its anchor was defined before it, and the
    // refusal names line 4 — where the reader knows the problem — never
    // the resolved alias `*id` on line 3.
    const folder = tempFolder('madarch-products-aliasforward-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: &id original', 'name: *id', 'extra: *later', 'future: &later present', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.line).toBe(4);
    expect(read.message).toContain('cannot be read as YAML');
  });
  test("an unresolved alias that stands later keeps the earlier one's line as the blame", () => {
    // The failure is the forward reference on line 4; another alias the
    // document never resolves at line 6 does not move where the reader
    // looks. Resolution goes in document order and reports the first
    // alias whose anchor was not defined before it.
    const folder = tempFolder('madarch-products-aliaslater-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: &id original', 'name: *id', 'extra: *later', 'future: &later present', 'unknown: *missing', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.line).toBe(4);
  });
  test("an alias-limit refusal cannot blame a later unresolved alias's line", () => {
    // The review's mixed shape: well over the alias count limit, and an
    // alias behind them that never appeared. The refusal is the limit —
    // conversion stops there and never reaches the later alias — so the
    // ordered walk must not be consulted, and line 1 says unknown.
    const folder = tempFolder('madarch-products-limitalias-');
    const manifest = [
      'schemaVersion: 1',
      'id: &i product-identity',
      ...Array.from({ length: 120 }, (_, n) => `f${n}: *i`),
      'unrelated: *missing',
      '',
    ].join('\n');
    writeFileSync(join(folder, 'workspace.yaml'), manifest);
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain('cannot be read as YAML');
    expect(read.line).toBe(1);
  });
  test("an alias-limit refusal cannot blame a later forward reference's line either", () => {
    // The same mixed shape with a forward reference instead: the anchor
    // stands after the alias, but the limit ends conversion first.
    const folder = tempFolder('madarch-products-limforward-');
    const manifest = [
      'schemaVersion: 1',
      'id: &i product-identity',
      ...Array.from({ length: 120 }, (_, n) => `f${n}: *i`),
      'extra: *later',
      'future: &later defined-later',
      '',
    ].join('\n');
    writeFileSync(join(folder, 'workspace.yaml'), manifest);
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.line).toBeGreaterThanOrEqual(1);
    expect(read.message).toContain('cannot be read as YAML');
    expect(read.line).toBe(1);
  });

  test('a conversion failure no unresolved alias explains — an alias limit reached — reports line 1 as unknown', () => {
    // Well over the reader's alias count limit: the document is refused
    // by the parser's guard, not at any one alias. Naming the first
    // alias would blame a field that reads fine; line 1 says unknown.
    const folder = tempFolder('madarch-products-aliaslimit-');
    const manifest = ['schemaVersion: 1', 'id: &i product-identity', ...Array.from({ length: 120 }, (_, n) => `f${n}: *i`), ''].join('\n');
    writeFileSync(join(folder, 'workspace.yaml'), manifest);
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toContain('cannot be read as YAML');
    expect(read.line).toBe(1);
  });
  test('a manifest naming a field twice is refused, naming the line the duplicate stands on', () => {
    const folder = tempFolder('madarch-products-dup-');
    writeFileSync(join(folder, 'workspace.yaml'), ['schemaVersion: 1', 'id: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d', 'name: idea-2026-10-09', 'schemaVersion: 2', ''].join('\n'));
    const read = readProduct(folder);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.file).toBe(join(folder, 'workspace.yaml'));
    expect(read.message).toContain('"schemaVersion"');
    expect(read.message).toContain('twice');
    expect(read.line).toBe(4);
  });
});
