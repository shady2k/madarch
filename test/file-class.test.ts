
/**
 * A file's class (madarch-64o5.66): the catalogue declares the patterns, the disk plugin reads them from its unit, and
 * every file states code, test, documentation, dependency or generated.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { extract as diskExtract } from '../plugins/disk/main.js';
import diskContract from '../plugins/disk/contract.json';

type Context = Parameters<typeof diskExtract>[1];
type Unit = Parameters<typeof diskExtract>[0];

const ROOT = mkdtempSync(join(tmpdir(), 'madarch-file-class-'));
const REPOSITORY = join(ROOT, 'repo');
const priorGit = process.env['MADARCH_TOOL_GIT'];
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  TZ: 'UTC', LC_ALL: 'C',
};
const declaration = parse(readFileSync(new URL('../catalog/code/structure/code.file.yaml', import.meta.url), 'utf8')) as { classes?: readonly { name: string; paths?: readonly string[]; default?: boolean }[] };
let commit = '';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPOSITORY, env: { ...process.env, ...IDENTITY } }).toString('utf8').trim();
}

beforeAll(() => {
  const executable = Bun.which('git');
  if (executable === null) throw new Error('git is required');
  process.env['MADARCH_TOOL_GIT'] = executable;
  mkdirSync(join(REPOSITORY, 'src'), { recursive: true });
  mkdirSync(join(REPOSITORY, 'test', 'unit'), { recursive: true });
  mkdirSync(join(REPOSITORY, 'docs'), { recursive: true });
  mkdirSync(join(REPOSITORY, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(REPOSITORY, 'dist'), { recursive: true });
  writeFileSync(join(REPOSITORY, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(REPOSITORY, 'test', 'unit', 'app.ts'), 'import { app } from "../../src/app";\n');
  writeFileSync(join(REPOSITORY, 'docs', 'guide.md'), '# Guide\n');
  writeFileSync(join(REPOSITORY, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(REPOSITORY, 'dist', 'bundle.min.js'), 'var a=1;\n');
  git('init', '-q', '-b', 'main');
  git('add', '-f', '-A');
  git('commit', '-qm', 'one file of each class');
  commit = git('rev-parse', 'HEAD');
});

afterAll(() => {
  if (priorGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
  else process.env['MADARCH_TOOL_GIT'] = priorGit;
  rmSync(ROOT, { recursive: true, force: true });
});

test('the catalogue declares the five classes and their patterns', () => {
  expect(declaration.classes?.map((rule) => rule.name)).toEqual(['dependency', 'generated', 'test', 'documentation', 'code']);
  expect(declaration.classes?.find((rule) => rule.name === 'code')?.default).toBe(true);
  expect(declaration.classes?.find((rule) => rule.name === 'dependency')?.paths).toContain('**/node_modules/**');
});

test('a file of each class is classified, and node_modules is a dependency', async () => {
  const fields = ['repository', 'path', 'class'];
  const selected = { ...diskContract.outputs, vertices: diskContract.outputs.vertices.map((vertex) => vertex.kind === 'code.file' ? { ...vertex, fields: vertex.fields.filter((field) => fields.includes(field.name)) } : vertex) };
  const unit = {
    kind: 'code.file',
    inputs: { repositories: [{ repository: 'fixture', root: REPOSITORY, commit, url: '' }], edgeOutputs: [], contract: selected, classRules: declaration.classes ?? [] },
  } as unknown as Unit;
  const context = { signal: new AbortController().signal, progress() {}, graph: { files: async () => [], value: async () => '' } } as unknown as Context;
  const answer = await diskExtract(unit, context);
  expect(answer.end?.state).toBe('complete');
  const classes = Object.fromEntries((answer.vertices ?? []).map((vertex) => [String(vertex.key['path']), vertex.values?.['class']]));
  expect(classes).toEqual({
    'dist/bundle.min.js': 'generated',
    'docs/guide.md': 'documentation',
    'node_modules/pkg/index.js': 'dependency',
    'src/app.ts': 'code',
    'test/unit/app.ts': 'test',
  });
  expect(classes['node_modules/pkg/index.js']).toBe('dependency');
}, 60_000);
