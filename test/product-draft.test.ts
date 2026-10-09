import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createDraft, productsHome } from '../src/product/draft.js';
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
    // No extra option: the git calls build their environment from the
    // process's, which here carries a GIT_DIR no git in the draft must see.
    const home = tempFolder('madarch-products-');
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = '/nowhere';
    try {
      const draft = createDraft({ home, today: EXAMPLE_DAY, gitEnv: {} });
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

  test("a git that refuses to commit fails with git's own words and leaves no folder behind", () => {
    const stubs = tempFolder('madarch-products-gitstub-');
    const script = ['#!/bin/sh', 'if [ "$1" = "commit" ]; then', "  echo 'stub: refusing to commit' >&2; exit 1; fi", 'exec /run/current-system/sw/bin/git "$@"', ''].join('\n');
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
    const script = ['#!/bin/sh', 'if [ "$1" = "add" ]; then', "  echo 'stub: refusing to add' >&2; exit 1; fi", 'exec /run/current-system/sw/bin/git "$@"', ''].join('\n');
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
