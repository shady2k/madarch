import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { initLife, whereAmI } from '../src/product/lifecycle.js';
import { readProduct } from '../src/product/manifest.js';
import { runGit } from '../src/product/git.js';
import { gitEnv } from './git-env.js';
import { GIT_ENV } from './repo-fixture.js';
import { ISOLATED_HOME, noStrayDrafts } from './scratch-home.js';

process.env.MADARCH_HOME = ISOLATED_HOME;
const roots: string[] = [];
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  saved.clear();
  expect(noStrayDrafts().newEntries).toEqual([]);
});

function fixture(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-init-checkout-'));
  roots.push(root);
  // repo add commits with the caller's identity, just like the CLI.
  for (const [name, value] of Object.entries(gitEnv(GIT_ENV))) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  return { root, home: join(root, 'products') };
}

function checkout(root: string, name: string): string {
  const source = join(root, name);
  mkdirSync(source);
  expect(runGit(source, ['init', '--quiet', '--initial-branch=main']).ok).toBe(true);
  return source;
}

function folderOf(result: ReturnType<typeof initLife>): string {
  expect(result.errors).toEqual([]);
  expect(result.exit).toBe(0);
  const fact = result.prints.find((line) => line.startsWith('folder: '));
  expect(fact).toBeDefined();
  return fact!.slice('folder: '.length);
}

test('a source workspace and madarch settings are linked without modifying the checkout', () => {
  const { root, home } = fixture();
  const source = checkout(root, 'madarch');
  const settings = 'schemaVersion: 1\nid: madarch\nname: madarch\n';
  writeFileSync(join(source, 'workspace.yaml'), settings);
  mkdirSync(join(source, 'madarch'));
  writeFileSync(join(source, 'madarch', 'kinds.yaml'), 'source settings\n');
  expect(runGit(source, ['add', '-A']).ok).toBe(true);
  expect(runGit(source, ['commit', '--quiet', '-m', 'Source settings']).ok).toBe(true);
  const before = runGit(source, ['rev-parse', 'HEAD']);
  // where retains the manifest contract; init distinguishes settings from a managed product.
  expect(whereAmI({ folder: source }).outcome).toBe('product');
  const folder = folderOf(initLife({ cwd: source, home, template: 'everything' }));
  expect(folder).toBe(join(home, 'madarch'));
  const product = readProduct(folder);
  expect(product).toMatchObject({ ok: true, product: { name: 'madarch', repos: [{ name: 'madarch', linked: true }] } });
  if (!product.ok) throw new Error(product.message);
  expect(product.product.id).not.toBe('madarch');
  expect(existsSync(join(folder, 'madarch', 'kinds.yaml'))).toBe(true);
  expect(realpathSync(join(folder, 'repos', 'madarch'))).toBe(realpathSync(source));
  expect(readFileSync(join(source, 'workspace.yaml'), 'utf8')).toBe(settings);
  expect(runGit(source, ['rev-parse', 'HEAD'])).toEqual(before);
  expect(runGit(source, ['status', '--porcelain']).output).toBe('');
  expect(folderOf(initLife({ cwd: source, home, template: 'none' }))).toBe(folder);
  expect(readdirSync(home)).toEqual(['madarch']);
});

test('an empty git folder creates an unlinked draft; untracked code is linked', () => {
  const { root, home } = fixture();
  const empty = checkout(root, 'empty');
  const draft = folderOf(initLife({ cwd: empty, home, template: 'none' }));
  expect(readProduct(draft)).toMatchObject({ ok: true, product: { repos: [] } });
  expect(readdirSync(join(draft, 'repos'))).toEqual([]);
  expect(readdirSync(empty)).toEqual(['.git']);
  const source = checkout(root, 'untracked');
  writeFileSync(join(source, 'index.ts'), 'export const answer = 42;\n');
  const linked = folderOf(initLife({ cwd: source, home, template: 'none' }));
  expect(realpathSync(join(linked, 'repos', 'untracked'))).toBe(realpathSync(source));
  expect(readProduct(linked)).toMatchObject({ ok: true, product: { repos: [{ name: 'untracked', linked: true }] } });
});

test('a generated product remains idempotent after moving outside the configured home', () => {
  const { root, home } = fixture();
  const draft = createDraft({ home, name: 'idea', template: 'none' });
  expect(draft.outcome).toBe('created');
  if (draft.outcome !== 'created') throw new Error(draft.message);
  expect(folderOf(initLife({ cwd: draft.folder, home, template: 'none' }))).toBe(draft.folder);
  const moved = join(root, 'moved');
  renameSync(draft.folder, moved);
  const before = runGit(moved, ['rev-parse', 'HEAD']);
  expect(folderOf(initLife({ cwd: moved, home: join(root, 'other-home'), template: 'none' }))).toBe(moved);
  expect(runGit(moved, ['rev-parse', 'HEAD'])).toEqual(before);
  expect(existsSync(join(root, 'other-home'))).toBe(false);
});
