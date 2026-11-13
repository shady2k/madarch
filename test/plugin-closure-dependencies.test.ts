/** Dependency selection and import refusals happen before a plugin child starts. */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf, ClosureRefusal } from '../src/plugin/closure.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function plugin(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'closure-deps-'));
  roots.push(root);
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'dependency-test', version: '1.0.0', entry: 'main.ts', produces: [{ kind: 'fixture.problem', fields: '*', reads: [] }], runtime: { name: 'bun', version: Bun.version } }));
  writeFileSync(join(root, 'main.ts'), source);
  return root;
}
function pkg(root: string, name: string, dependencies: Record<string, string> = {}, source = 'export const value = 1;'): void {
  const folder = join(root, 'node_modules', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, main: 'index.js', dependencies }));
  writeFileSync(join(folder, 'index.js'), source);
}

test('only declared packages and their transitive resolutions enter the closure, including scoped and nested packages', () => {
  const root = plugin('import { value } from "@example/one"; console.log(value);');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@example/one': '1' } }));
  pkg(root, '@example/one', { two: '1' }, 'export { value } from "two";');
  pkg(join(root, 'node_modules/@example/one'), 'two');
  pkg(root, 'two', {}, 'export const value = 2;');
  pkg(root, 'unrelated');
  const paths = closureOf(root).files.map((file) => file.path);
  expect(paths).toContain('node_modules/@example/one/node_modules/two/index.js');
  expect(paths).not.toContain('node_modules/two/index.js');
  expect(paths).not.toContain('node_modules/unrelated/index.js');
});

test('a missing or undeclared runtime import is refused with the import, full path and source line', () => {
  for (const source of ['// first line\nimport "not-installed";', '// first line\nawait import("not-installed");', '// first line\nrequire("not-installed");', '// first line\nexport * from "not-installed";']) {
    const root = plugin(source);
    if (source.includes('require')) writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'not-installed': '1' } }));
    else pkg(root, 'not-installed');
    let caught: unknown;
    try { closureOf(root); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ClosureRefusal);
    const refusal = caught as ClosureRefusal;
    expect(refusal.code).toBe('plugin-import');
    expect(refusal.file).toBe(join(root, 'main.ts'));
    expect(refusal.line).toBe(2);
    expect(refusal.message).toContain(`${join(root, 'main.ts')}:2:`);
    expect(refusal.message).toContain('"not-installed"');
  }
});

test('missing relative imports in dependencies name that dependency file and line', () => {
  const root = plugin('import "one";');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { one: '1' } }));
  pkg(root, 'one', {}, '// header\nimport "./absent.js";');
  expect(() => closureOf(root)).toThrow(`${join(root, 'node_modules/one/index.js')}:2: import "./absent.js"`);
});

test('dependency names cannot escape the plugin folder', () => {
  const root = plugin('export {};');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '../../outside': '1' } }));
  expect(() => closureOf(root)).toThrow(`${join(root, 'package.json')}:1: invalid dependency package name`);
});

test('a scoped dependency cannot hide a symbolic link in an ancestor', () => {
  const root = plugin('export {};');
  const outside = plugin('export {};');
  mkdirSync(join(outside, 'one'));
  writeFileSync(join(outside, 'one/package.json'), '{"name":"@scope/one"}');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@scope/one': '1' } }));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(outside, join(root, 'node_modules/@scope'));
  expect(() => closureOf(root)).toThrow(`${join(root, 'node_modules/@scope')}:1: a symbolic link`);
});

test.each([
  { source: '// header\nimport /* comment */ "not-installed";', line: 2 },
  { source: '// header\nimport /* comment\ncontinued */ "not-installed";', line: 3 },
  { source: String.raw`// header
import "not\x2dinstalled";`, line: 2 },
  { source: 'const earlier = "not-installed";\n\nimport "not-installed";', line: 3 },
  { source: 'const earlier = "from";\nconst other = "not-installed";\nimport "not-installed";', line: 3 },
  { source: '// header\nimport {\n  value\n} from\n  "not-installed";\nconsole.log(value);', line: 5 },
])('import locations retain the literal line through comments, escapes and multiline syntax: $line', ({ source, line }) => {
  const root = plugin(source);
  let caught: unknown;
  try { closureOf(root); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ClosureRefusal);
  const refusal = caught as ClosureRefusal;
  expect(refusal.code).toBe('plugin-import');
  expect(refusal.file).toBe(join(root, 'main.ts'));
  expect(refusal.line).toBe(line);
  expect(refusal.message).toContain(`${join(root, 'main.ts')}:${line}: import "not-installed"`);
});
