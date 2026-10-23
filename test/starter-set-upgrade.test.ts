/**
 * A product made by an earlier madarch is brought to the current starter set (madarch-m38l.11). The fixture is the
 * manifest and the templates madarch 0.2.0 wrote for a draft product (`test/fixtures/product-0.2.0`): `committed/` is
 * what the draft's first commit held, `working/` is the working tree after the questions loop added its two kinds and a
 * page language. Every case builds its own git repository from them in a scratch folder.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { parseKinds, setKindsLanguage } from '../src/knowledge/kinds.js';
import { STARTER_FILES, STARTER_KINDS, ensureLoopKinds, starterManifest } from '../src/knowledge/seed.js';
import { addStarterItems, currentOffers, filesAPersonEdited, provenanceOf, rememberChangedStarterFileIfOwned, replaceWithStarterSet, starterOffers, upgradeStarterSet } from '../src/knowledge/starter-upgrade.js';
import { gitEnv } from './git-env.js';

const FIXTURE = join(import.meta.dir, 'fixtures', 'product-0.2.0');
let root: string | undefined;
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined; });

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.test' };
function git(folder: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: folder, encoding: 'utf8', env: gitEnv(identity) }).trim();
}
function files(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1)).sort();
}

/** A draft product as madarch 0.2.0 left it: the first commit, then the working tree the loop changed. */
function oldProduct(options: { working?: boolean } = {}): { product: string; record: string } {
  root = mkdtempSync(join(tmpdir(), 'madarch-upgrade-'));
  const product = join(root, 'product');
  mkdirSync(product);
  cpSync(join(FIXTURE, 'committed'), product, { recursive: true });
  git(product, 'init', '-q', '-b', 'main');
  git(product, 'add', '-A');
  git(product, 'commit', '-q', '-m', 'Create the draft product');
  if (options.working !== false) cpSync(join(FIXTURE, 'working'), product, { recursive: true });
  return { product, record: join(root, 'store', 'starter.json') };
}

const read = (product: string, path: string): string => readFileSync(join(product, path), 'utf8');
const manifestOf = (product: string) => parseKinds(read(product, 'madarch/kinds.yaml'), 'madarch/kinds.yaml', product);

describe('a manifest and templates only madarch wrote', () => {
  test('the old product reads with every kind in «Other»; the upgrade gives it the groups, roles and every kind, keeping its language', () => {
    const { product, record } = oldProduct();
    const before = manifestOf(product);
    expect(before.groups.size).toBe(0);
    expect(before.roles.size).toBe(0);
    expect(before.kinds.has('doc.use-case')).toBe(false);
    expect(before.findings.length).toBeGreaterThan(0); // `group: product` with no `groups:` makes question and correction findings

    const report = upgradeStarterSet(product, record);
    expect(report.kept).toEqual([]);
    expect(report.offers).toEqual([]);
    expect(report.rewritten).toContain('madarch/kinds.yaml');
    expect(report.rewritten).toContain('templates/domain.md');
    expect(report.written).toContain('templates/route.md');

    const after = manifestOf(product);
    expect(after.findings).toEqual([]);
    expect(after.language).toBe('ru');
    expect([...after.groups.keys()]).toEqual(['product', 'code', 'contracts', 'data', 'operations', 'tests', 'history']);
    expect([...after.roles.keys()].sort()).toEqual(['analyst', 'architect', 'developer', 'operations', 'product', 'tester']);
    for (const kind of STARTER_KINDS) expect(after.kinds.get(kind.name)?.group).toBe(kind.group);
    expect(after.kinds.get('doc.use-case')?.identifier).toEqual(['UC']);
    expect(after.kinds.get('code.route')?.group).toBe('contracts');
    expect(after.kinds.get('code.contract')?.group).toBe('contracts');
    expect(read(product, 'madarch/kinds.yaml')).toBe(starterManifest('ru'));
    for (const starter of STARTER_FILES.filter((file) => file.path.startsWith('templates/'))) expect(read(product, starter.path)).toBe(starter.content);
  });

  test('the language a person chose, which madarch wrote into the manifest, survives the upgrade, in either language', () => {
    for (const language of ['ru', 'en']) {
      const { product, record } = oldProduct({ working: false });
      expect(setKindsLanguage(product, language)).toBeUndefined();
      const report = upgradeStarterSet(product, record);
      expect(report.rewritten).toContain('madarch/kinds.yaml');
      expect(manifestOf(product).language).toBe(language);
      expect(read(product, 'madarch/kinds.yaml')).toBe(starterManifest(language));
      rmSync(root!, { recursive: true, force: true });
    }
  });

  test('a language change to an upgraded manifest remains madarch-owned on a later upgrade', () => {
    const { product, record } = oldProduct();
    upgradeStarterSet(product, record);
    const previous = read(product, 'madarch/kinds.yaml');
    expect(setKindsLanguage(product, 'en')).toBeUndefined();
    expect(rememberChangedStarterFileIfOwned(product, record, 'madarch/kinds.yaml', previous, read(product, 'madarch/kinds.yaml'))).toBe(true);
    const later = upgradeStarterSet(product, record);
    expect(later.kept).not.toContain('madarch/kinds.yaml');
    expect(later.offers).toEqual([]);
    expect(currentOffers(product, record)).toEqual([]);
  });

  test('a language change does not turn an edited manifest into madarch-owned', () => {
    const { product, record } = oldProduct();
    upgradeStarterSet(product, record);
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), `${read(product, 'madarch/kinds.yaml')}# person added this comment\n`);
    const before = read(product, 'madarch/kinds.yaml');
    const after = before.replace('language: ru', 'language: en').replace('# person added this comment\n', '');
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), after);
    expect(rememberChangedStarterFileIfOwned(product, record, 'madarch/kinds.yaml', before, after)).toBe(false);
    expect(provenanceOf(product, 'madarch/kinds.yaml', starterManifest('ru'), JSON.parse(readFileSync(record, 'utf8')))).toBe('person');
  });

  test('an edit inside a kind madarch added (its description) makes the manifest the person\'s', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), read(product, 'madarch/kinds.yaml').replace('Something the agent could not settle', 'Things we could not settle'));
    const report = upgradeStarterSet(product, record);
    expect(report.kept).toContain('madarch/kinds.yaml');
    expect(read(product, 'madarch/kinds.yaml')).toContain('Things we could not settle');
  });

  test('a second run changes nothing: the files are the current set', () => {
    const { product, record } = oldProduct();
    upgradeStarterSet(product, record);
    expect(upgradeStarterSet(product, record)).toEqual({ rewritten: [], written: [], kept: [], offers: [] });
  });

  test('the next madarch can move the set on again: what this one wrote is recorded on this machine, committed or not', () => {
    const { product, record } = oldProduct();
    upgradeStarterSet(product, record);
    const written = read(product, 'madarch/kinds.yaml');
    expect(provenanceOf(product, 'madarch/kinds.yaml', `${written}# a later version\n`, JSON.parse(readFileSync(record, 'utf8')))).toBe('madarch');
  });

  test('the draft as it was committed, with no change after it, is madarch\'s alone', () => {
    const { product, record } = oldProduct({ working: false });
    const report = upgradeStarterSet(product, record);
    expect(report.kept).toEqual([]);
    expect(manifestOf(product).findings).toEqual([]);
  });

  test('a product that is not a git repository and holds a manifest nobody can vouch for is left alone, and offered the additions', () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-upgrade-'));
    const product = join(root, 'product');
    cpSync(join(FIXTURE, 'working'), product, { recursive: true });
    const before = read(product, 'madarch/kinds.yaml');
    const report = upgradeStarterSet(product, join(root, 'starter.json'));
    expect(report.kept).toContain('madarch/kinds.yaml');
    expect(read(product, 'madarch/kinds.yaml')).toBe(before);
    expect(report.offers.length).toBeGreaterThan(0);
  });
});

describe('a manifest or a template a person edited is never rewritten', () => {
  test('an edit committed under a person\'s own message keeps the manifest byte for byte, and the set\'s additions are offered', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), `${read(product, 'madarch/kinds.yaml')}# my own note\n`);
    git(product, 'commit', '-q', '-am', 'Add a note to the manifest');
    const before = read(product, 'madarch/kinds.yaml');
    const report = upgradeStarterSet(product, record);
    expect(report.kept).toContain('madarch/kinds.yaml');
    expect(report.rewritten).not.toContain('madarch/kinds.yaml');
    expect(read(product, 'madarch/kinds.yaml')).toBe(before);
    const ids = report.offers.map((offer) => offer.id);
    expect(ids).toContain('group:product');
    expect(ids).toContain('roles');
    expect(ids).toContain('documents');
    expect(ids).toContain('kind:doc.use-case');
    expect(ids).toContain('kind:code.route');
    expect(ids).toContain('fields:code.service');
    expect(currentOffers(product, record).map((offer) => offer.id)).toEqual(ids);
  });

  test('an uncommitted edit of a tracked manifest, and a template edited after the draft, are kept', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), read(product, 'madarch/kinds.yaml').replace('folder: docs/domains', 'folder: docs/areas'));
    writeFileSync(join(product, 'templates', 'domain.md'), ':::body\n:::related{title="My own block" relation="relates"}\n');
    const report = upgradeStarterSet(product, record);
    expect(report.kept).toEqual(['madarch/kinds.yaml', 'templates/domain.md']);
    expect(read(product, 'madarch/kinds.yaml')).toContain('docs/areas');
    expect(read(product, 'templates/domain.md')).toContain('My own block');
    // The other templates, which nobody edited, are brought up to date.
    expect(read(product, 'templates/symbol.md')).toBe(STARTER_FILES.find((file) => file.path === 'templates/symbol.md')!.content);
    expect(filesAPersonEdited(product, record)).toEqual(['madarch/kinds.yaml', 'templates/domain.md']);
  });

  test('a comment a person added to an untouched old manifest and did not commit keeps it theirs: the texts differ, so it is not rewritten', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), `# a comment I wrote\n${read(product, 'madarch/kinds.yaml')}`);
    const before = read(product, 'madarch/kinds.yaml');
    const report = upgradeStarterSet(product, record);
    expect(report.kept).toContain('madarch/kinds.yaml');
    expect(read(product, 'madarch/kinds.yaml')).toBe(before);
  });

  test('items added to an edited manifest do not make it madarch\'s: it is still never replaced when the product is opened again', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), `# our own comment\n${read(product, 'madarch/kinds.yaml')}`);
    git(product, 'commit', '-q', '-am', 'Comment the manifest');
    addStarterItems(product, ['group:product', 'kind:code.route'], record);
    const added = read(product, 'madarch/kinds.yaml');
    const second = upgradeStarterSet(product, record);
    expect(second.kept).toContain('madarch/kinds.yaml');
    expect(read(product, 'madarch/kinds.yaml')).toBe(added);
    expect(added.startsWith('# our own comment\n')).toBe(true);
  });

  test('adding an offered kind writes the kind, its group and its template, keeps the comments, and the manifest then reads clean', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), `# my own comment\n${read(product, 'madarch/kinds.yaml')}`);
    git(product, 'commit', '-q', '-am', 'Comment the manifest');
    upgradeStarterSet(product, record);
    rmSync(join(product, 'templates', 'route.md'), { force: true });
    expect(manifestOf(product).findings.length).toBeGreaterThan(0);

    const written = addStarterItems(product, ['group:product', 'kind:code.route'], record);
    expect(written).toEqual(['templates/route.md', 'madarch/kinds.yaml']);
    const text = read(product, 'madarch/kinds.yaml');
    expect(text.startsWith('# my own comment\n')).toBe(true);
    const manifest = manifestOf(product);
    expect(manifest.findings).toEqual([]);
    expect(manifest.kinds.get('code.route')?.group).toBe('contracts');
    expect(manifest.groups.has('contracts')).toBe(true);
    expect(manifest.kinds.get('question')?.group).toBe('product');
    expect(starterOffers(text).map((offer) => offer.id)).not.toContain('kind:code.route');
    expect(addStarterItems(product, ['kind:code.route'], record)).toEqual([]);
  });

  test('adding the missing fields of a kind fills only what it lacks, and the roles come with the groups they lead', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), `${read(product, 'madarch/kinds.yaml')}# kept\n`);
    git(product, 'commit', '-q', '-am', 'Note');
    addStarterItems(product, ['group:product', 'fields:code.service', 'roles', 'documents'], record);
    const manifest = manifestOf(product);
    expect(manifest.findings).toEqual([]);
    expect(manifest.kinds.get('code.service')?.group).toBe('code');
    expect(manifest.kinds.get('code.service')?.labels?.['ru']?.one).toBe('Сервис');
    expect(manifest.kinds.get('code.service')?.relations.length).toBe(1);
    expect(manifest.roles.size).toBe(6);
    expect(manifest.excludeDocuments).toContain('AGENTS.md');
    expect(() => addStarterItems(product, ['kind:no-such'], record)).toThrow('no kind of the starter set');
    expect(() => addStarterItems(product, ['nonsense'], record)).toThrow('is not an item of the starter set');
  });
});

describe('ensureLoopKinds', () => {
  const bare = (manifest: string): string => {
    root = mkdtempSync(join(tmpdir(), 'madarch-loop-'));
    const product = join(root, 'product');
    mkdirSync(join(product, 'madarch'), { recursive: true });
    mkdirSync(join(product, 'templates'));
    writeFileSync(join(product, 'madarch', 'kinds.yaml'), manifest);
    writeFileSync(join(product, 'templates', 'product.md'), ':::body\n');
    return product;
  };

  test('a manifest with no groups gets the two kinds without a group, so neither becomes a finding', () => {
    const product = bare('# mine\nkinds:\n  product:\n    template: templates/product.md\n    source: markdown\n    file: docs/product.md\n');
    expect(ensureLoopKinds(product)).toContain('madarch/kinds.yaml');
    const text = read(product, 'madarch/kinds.yaml');
    expect(text).toContain('# mine');
    expect(text).not.toContain('group:');
    const manifest = manifestOf(product);
    expect(manifest.findings).toEqual([]);
    expect([...manifest.kinds.keys()]).toEqual(['product', 'question', 'correction']);
  });

  test('a manifest that declares the product group gets the kinds in it', () => {
    const product = bare('groups:\n  product: { en: "Product", ru: "Продукт" }\nkinds: {}\n');
    ensureLoopKinds(product);
    const manifest = manifestOf(product);
    expect(manifest.findings).toEqual([]);
    expect(manifest.kinds.get('question')?.group).toBe('product');
  });
});

describe('starting from scratch puts every starter file at the current set', () => {
  test('a manifest and a template a person edited are replaced, and the page language is kept', () => {
    const { product, record } = oldProduct();
    writeFileSync(join(product, 'templates', 'domain.md'), 'mine\n');
    const written = replaceWithStarterSet(product, record);
    expect(written).toContain('madarch/kinds.yaml');
    expect(written).toContain('templates/domain.md');
    expect(read(product, 'madarch/kinds.yaml')).toBe(starterManifest('ru'));
    expect(files(product).filter((file) => file.startsWith('templates/'))).toEqual(STARTER_FILES.filter((file) => file.path.startsWith('templates/')).map((file) => file.path).sort());
    expect(existsSync(dirname(record))).toBe(true);
  });
});
