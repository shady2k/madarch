import { reportInitFailure } from './init-language-diagnostic.js';
/**
 * The language of a first run (madarch-64o5.84): `MADARCH_LANG`, else the language this machine remembers from an
 * earlier first run (the madarch home's `settings.json`, where the wiki's reading role lives), else the locale. The
 * answer is kept, the product's manifest carries it — the setting the wiki already reads — and a non-interactive run
 * never asks.
 */
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { commandLanguage, rememberedLanguage } from '../src/product/command-language.js';
import { languageFromAnswer, languageQuestion } from '../src/product/cli.js';
import { STARTER_TEMPLATES, templateMenuLines } from '../src/knowledge/starter-templates.js';
import { readLanguage, writeLanguage } from '../src/knowledge/settings.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-init-language-'));
  roots.push(root);
  return root;
}

test('the language comes from MADARCH_LANG, then the machine, then the locale', () => {
  const root = home();
  expect(commandLanguage({ LANG: 'ru_RU.UTF-8' } as never)).toBe('ru');
  expect(commandLanguage({ LANG: 'en_US.UTF-8' } as never)).toBe('en');
  // A remembered language beats the locale, and MADARCH_LANG beats both.
  writeLanguage({ MADARCH_HOME: root }, 'ru');
  expect(rememberedLanguage({ MADARCH_HOME: root } as never)).toBe('ru');
  expect(commandLanguage({ MADARCH_HOME: root, LANG: 'en_US.UTF-8' } as never)).toBe('ru');
  expect(commandLanguage({ MADARCH_HOME: root, MADARCH_LANG: 'en', LANG: 'ru_RU.UTF-8' } as never)).toBe('en');
  // The file keeps what it held: the language sits beside the role.
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
  writeLanguage({ MADARCH_HOME: root }, 'ru');
  expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))).toEqual({ role: 'everything', roleAsked: true, language: 'ru' });
  expect(readLanguage({ MADARCH_HOME: root })).toBe('ru');
});

test('the question offers both languages and the default from the locale', () => {
  expect(languageQuestion('ru')).toContain('1. Русский 2. English (1)');
  expect(languageQuestion('en')).toContain('1. Русский 2. English (2)');
  expect(languageFromAnswer('1', 'en')).toBe('ru');
  expect(languageFromAnswer('2', 'ru')).toBe('en');
  expect(languageFromAnswer('русский', 'en')).toBe('ru');
  expect(languageFromAnswer('', 'en')).toBe('en');
  expect(languageFromAnswer('что-то', 'ru')).toBe('ru');
});

test('a --json init never asks, and the product carries the remembered language for the wiki', () => {
  const root = home();
  const products = join(root, 'products');
  mkdirSync(products, { recursive: true });
  writeLanguage({ MADARCH_HOME: root }, 'ru');
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: root, MADARCH_HOME: root, MADARCH_OWN_WIKI: 'off', MADARCH_PLUGIN_SANDBOX: 'off', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  delete env['MADARCH_LANG'];
  // No TTY: a piped run must never wait for an answer.
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'madarch.ts'), 'init', join(root, 'idea'), '--home', products, '--template', 'everything', '--json', '--no-open', '--port', '0'], { cwd: root, env, encoding: 'utf8', timeout: 120_000, input: '' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  expect(output).not.toContain('Language / Язык');
  reportInitFailure(run);
  expect(run.status).toBe(0);
  // The product's folder is the one the command printed: a first init of a day makes idea-<date>, not idea.
  const line = output.split('\n').map((one) => one.trim()).find((one) => one.startsWith('{') && one.endsWith('}'));
  if (line === undefined) throw new Error(`init printed no JSON facts: ${output}`);
  const facts = JSON.parse(line) as { folder?: string };
  if (facts.folder === undefined) throw new Error(`init's facts name no folder: ${line}`);
  // The setting the wiki reads for its pages and its settings page, in the manifest a first run wrote.
  const manifest = parse(readFileSync(join(facts.folder, 'madarch', 'catalog.yaml'), 'utf8')) as { language?: string };
  expect(manifest.language).toBe('ru');
}, 120_000);

test('the template menu names the templates in the language the person answered (madarch-64o5.84)', () => {
  const russian = templateMenuLines(STARTER_TEMPLATES, 'ru').join('\n');
  const english = templateMenuLines(STARTER_TEMPLATES, 'en').join('\n');
  for (const template of STARTER_TEMPLATES) {
    expect(russian).toContain(template.title.ru);
    expect(russian).toContain(template.description.ru);
    expect(english).toContain(template.title.en);
  }
  // At least one template really differs, or the two languages would be the same words twice.
  expect(STARTER_TEMPLATES.some((template) => template.title.ru !== template.title.en)).toBe(true);
});

test('a checkout initialized with MADARCH_LANG=ru gets a product whose manifest speaks Russian (madarch-64o5.84)', () => {
  const root = home();
  const checkout = join(root, 'checkout');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, 'README.md'), '# Code\n');
  const git = spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: checkout, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  expect(git.status).toBe(0);
  spawnSync('git', ['add', '-A'], { cwd: checkout });
  spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'code'], { cwd: checkout });
  const products = join(root, 'products');
  mkdirSync(products, { recursive: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: root, MADARCH_HOME: root, MADARCH_OWN_WIKI: 'off', MADARCH_PLUGIN_SANDBOX: 'off', MADARCH_LANG: 'ru', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'madarch.ts'), 'init', checkout, '--home', products, '--template', 'everything', '--json', '--no-open', '--port', '0'], { cwd: root, env, encoding: 'utf8', timeout: 120_000, input: '' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  reportInitFailure(run);
  expect(run.status).toBe(0);
  const line = output.split('\n').map((one) => one.trim()).find((one) => one.startsWith('{') && one.endsWith('}'));
  if (line === undefined) throw new Error(`init printed no JSON facts: ${output}`);
  const facts = JSON.parse(line) as { folder?: string };
  if (facts.folder === undefined) throw new Error(`init's facts name no folder: ${line}`);
  const manifest = parse(readFileSync(join(facts.folder, 'madarch', 'catalog.yaml'), 'utf8')) as { language?: string };
  expect(manifest.language).toBe('ru');
}, 120_000);
