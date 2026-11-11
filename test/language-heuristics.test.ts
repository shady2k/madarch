/**
 * The language producer's heuristics (madarch-j9ao.1, item 7): GitHub Linguist's own rules, vendored from
 * github-linguist v9.7.0 as data and read with the Oniguruma engine Ruby's regexes are built on, decide a
 * path whose extension several languages claim. The fixtures are the project's own: a TypeScript module, a
 * Qt translation (which is XML though its extension is `.ts`), and the three languages a `.h` may be.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import * as dataset from 'linguist-languages';
import { HEURISTICS_CONSIDER_BYTES, decideLanguage, firstBytes } from '../src/fill/stages/language-heuristics.js';
import { languageOfPath } from '../src/fill/stages/repository-facts.js';
import { runFill } from '../src/fill/run.js';
import { listFiles } from '../src/graph/index.js';
import { createTestDatabaseOwner } from './test-database.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import { makeProduct, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';

const FIXTURES = join(import.meta.dir, 'fixtures/language-heuristics');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

test('the vendored heuristics are github-linguist v9.7.0\'s file, byte for byte, and agree with the pinned dataset', () => {
  const text = readFileSync(join(import.meta.dir, '../src/fill/stages/linguist/heuristics.yml'), 'utf8');
  // The pin: the file as github-linguist v9.7.0 released it (the release linguist-languages 9.5.0 carries).
  expect(createHash('sha256').update(text).digest('hex')).toBe('7fb4f1df1f8dead4bf12e3b408085f90144d3719f35db206756d762aa046aff1');
  const data = parseDocument(text).toJSON() as { disambiguations: { extensions: string[]; rules: { language: string | string[] }[] }[] };
  const languages = new Set(Object.keys(dataset));
  const extensions = new Set<string>();
  const filenames = new Set<string>();
  for (const entry of Object.values(dataset as unknown as Record<string, { extensions?: string[]; filenames?: string[] }>)) {
    for (const extension of entry.extensions ?? []) extensions.add(extension.toLowerCase());
    for (const name of entry.filenames ?? []) filenames.add(name.toLowerCase());
  }
  // The data and the dataset come from the same release: every language a rule names is a language the dataset
  // holds, and every extension (or file name) a rule keys on is one the dataset knows.
  for (const disambiguation of data.disambiguations) {
    for (const rule of disambiguation.rules) for (const language of Array.isArray(rule.language) ? rule.language : [rule.language]) expect(languages.has(language)).toBe(true);
    for (const extension of disambiguation.extensions) expect(extensions.has(extension.toLowerCase()) || filenames.has(extension.toLowerCase())).toBe(true);
  }
});

test('a .ts module is TypeScript and a Qt translation (XML with a .ts name) is XML', async () => {
  expect(languageOfPath('src/service.ts')).toEqual({ language: 'ambiguous', candidates: ['TypeScript', 'XML'] });
  expect(await decideLanguage('src/service.ts', fixture('service.ts'), ['TypeScript', 'XML'])).toEqual({ language: 'TypeScript' });
  expect(await decideLanguage('i18n/messages.ts', fixture('messages.ts'), ['TypeScript', 'XML'])).toEqual({ language: 'XML' });
});

test('a .h header is C, C++ or Objective-C as its own words say', async () => {
  const candidates = languageOfPath('include/widget.h').candidates;
  expect([...candidates].sort()).toEqual(['C', 'C++', 'Objective-C']);
  expect(await decideLanguage('include/counter.h', fixture('counter.h'), candidates)).toEqual({ language: 'C' });
  expect(await decideLanguage('include/shape.h', fixture('shape.h'), candidates)).toEqual({ language: 'C++' });
  expect(await decideLanguage('include/widget.h', fixture('widget.h'), candidates)).toEqual({ language: 'Objective-C' });
});

test('a path no rule decides keeps the dataset\'s candidates, and a language outside them is never invented', async () => {
  expect(languageOfPath('build/layer.cake').candidates).toEqual(['C#', 'CoffeeScript']);
  expect(await decideLanguage('build/layer.cake', fixture('layer.cake'), ['C#', 'CoffeeScript'])).toBeUndefined();
  // A rule that names TypeScript does not decide a path whose candidates know no TypeScript.
  expect(await decideLanguage('src/service.ts', fixture('service.ts'), ['XML'])).toBeUndefined();
});

test('the rules read the first 50 KiB of the text and never cut a character in two', async () => {
  expect(HEURISTICS_CONSIDER_BYTES).toBe(50 * 1024);
  const body = 'é'.repeat(HEURISTICS_CONSIDER_BYTES);
  const cut = firstBytes(body, HEURISTICS_CONSIDER_BYTES);
  expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(HEURISTICS_CONSIDER_BYTES);
  expect(cut.endsWith('é')).toBe(true);
  expect(firstBytes('short', 1024)).toBe('short');
});

test('a fill writes the decided language as the file opinion, and the candidates where no rule decides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-language-heuristics-'));
  const home = join(root, 'products');
  const repository = join(root, 'code');
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(repository, 'include'), { recursive: true });
  mkdirSync(join(repository, 'i18n'), { recursive: true });
  mkdirSync(join(repository, 'build'), { recursive: true });
  writeFileSync(join(repository, 'src', 'service.ts'), fixture('service.ts'));
  writeFileSync(join(repository, 'i18n', 'messages.ts'), fixture('messages.ts'));
  writeFileSync(join(repository, 'include', 'counter.h'), fixture('counter.h'));
  writeFileSync(join(repository, 'include', 'shape.h'), fixture('shape.h'));
  writeFileSync(join(repository, 'include', 'widget.h'), fixture('widget.h'));
  writeFileSync(join(repository, 'build', 'layer.cake'), fixture('layer.cake'));
  const env = gitEnv(SAMPLE_IDENTITY);
  const git = (...args: string[]): void => { const done = Bun.spawnSync(['git', ...args], { cwd: repository, env, stdout: 'pipe', stderr: 'pipe' }); if (done.exitCode !== 0) throw new Error(`${args.join(' ')}: ${done.stderr.toString()}`); };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'the language fixtures');
  const folder = makeProduct(home, 'shop', repository, 'code');
  const store = productStoreFolder(folder, knowledgeRootOf(home));
  const owner = await createTestDatabaseOwner({ store, btreeGist: true });
  try {
    const run = await runFill({ product: folder, database: owner, steps: ['repository-tree'], store, home: store, runId: 'language-heuristics' });
    expect(run.ok).toBe(true);
    const page = await listFiles(owner, { repository: 'code', limit: 20 });
    const languages = new Map(page.rows.map((row) => [row.path, [row.language, [...row.candidates]]]));
    expect(languages.get('src/service.ts')).toEqual(['TypeScript', ['TypeScript']]);
    expect(languages.get('i18n/messages.ts')).toEqual(['XML', ['XML']]);
    expect(languages.get('include/counter.h')).toEqual(['C', ['C']]);
    expect(languages.get('include/shape.h')).toEqual(['C++', ['C++']]);
    expect(languages.get('include/widget.h')).toEqual(['Objective-C', ['Objective-C']]);
    // No rule decides a .cake file: the opinion keeps the dataset's candidates and names no one language.
    expect(languages.get('build/layer.cake')).toEqual([null, ['C#', 'CoffeeScript']]);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
