import { expect, test } from 'bun:test';
import { compareCoverage } from '../scripts/test-coverage-diff';
import { resolve } from 'node:path';

const record = (body: string) => `SF:src/x.ts\n${body}\nend_of_record\n`;
const compare = (before: string, after = '', allow?: string) => compareCoverage({
  before: { path: 'old.lcov', text: before }, after: { path: 'new.lcov', text: after },
  ...(allow === undefined ? {} : { allow: { path: 'allow.json', text: allow } }),
});

test('unchanged coverage exits 0 and warns that source versions are unverified', () => {
  const result = compare(record('DA:1,1'), record('DA:1,1'));
  expect(result.code).toBe(0);
  expect(result.output).toContain('explicit line mapping or separate confirmation through the check map');
});
test('coverage loss exits exactly 1 with a full product coordinate', () => {
  const result = compare(record('DA:7,1'));
  expect(result.code).toBe(1);
  expect(result.output).toContain(`${resolve('src/x.ts')}:7: covered before, uncovered now`);
});
test('a line present with count zero loses earlier coverage', () => {
  const result = compare(record('DA:7,1'), record('DA:7,0'));
  expect(result.code).toBe(1);
  expect(result.output).toContain(`${resolve('src/x.ts')}:7: covered before, uncovered now`);
});
test('a line uncovered in both reports is not a loss', () => {
  expect(compare(record('DA:2,0'), record('DA:2,0')).code).toBe(0);
});
test('allow line zero is refused', () => {
  const result = compare('', '', '{"allow":[{"file":"src/x.ts","line":0,"reason":"moved"}]}');
  expect(result.code).toBe(2);
  expect(result.output).toContain(`${resolve('allow.json')}:1: ${resolve('src/x.ts')}: no positive safe line number`);
});
test('a repeated allow entry is refused', () => {
  const result = compare('', '', '{"allow":[{"file":"src/x.ts","line":7,"reason":"moved"},{"file":"src/x.ts","line":7,"reason":"moved"}]}');
  expect(result.code).toBe(2);
  expect(result.output).toContain(`${resolve('allow.json')}:1: ${resolve('src/x.ts')}:7 is named twice`);
});
test('a reason permits a loss with exit 0', () => {
  expect(compare(record('DA:7,1'), '', JSON.stringify({ allow: [{ file: 'src/x.ts', line: 7, reason: 'moved' }] })).code).toBe(0);
});
test('repeated SF blocks preserve covered lines in either order', () => {
  for (const counts of [[1, 0], [0, 1]]) {
    expect(compare(counts.map(count => record(`DA:7,${count}`)).join('')).code).toBe(1);
  }
});
for (const tag of ['DA', 'FN', 'BRDA']) for (const line of ['0', '9007199254740993']) {
  test(`${tag} line ${line} is bad input exit 2`, () => {
    const suffix = tag === 'DA' ? ',1' : tag === 'FN' ? ',name' : ',0,0,1';
    const result = compare(record(`${tag}:${line}${suffix}`));
    expect(result.code).toBe(2);
    expect(result.output).toContain(`${resolve('old.lcov')}:2:`);
  });
}
test('malformed relative lcov input names its full record coordinate', () => {
  const result = compare(record('DA:7'));
  expect(result.code).toBe(2);
  expect(result.output).toContain(`${resolve('old.lcov')}:2:`);
});
test('reason errors name JSON lines and full product paths, not array indices', () => {
  const result = compare(record('DA:7,1'), '', '{\n "allow": [\n {"file":"src/x.ts","line":7,"reason":""}\n ]\n}');
  expect(result.code).toBe(2);
  expect(result.output).toContain(`${resolve('allow.json')}:3:`);
  expect(result.output).toContain(`${resolve('src/x.ts')}:7:`);
});
test('invalid JSON names its actual line', () => {
  const result = compare('', '', '{\n "allow": [\n !\n]}');
  expect(result.code).toBe(2);
  expect(result.output).toContain(`${resolve('allow.json')}:3:`);
});
test('unsafe allow line is bad input exit 2', () => {
  expect(compare('', '', '{"allow":[{"file":"src/x.ts","line":9007199254740993,"reason":"moved"}]}').code).toBe(2);
});
test('non-product coverage is ignored', () => {
  expect(compare('SF:test/x.ts\nDA:7,1\nend_of_record\n').code).toBe(0);
});
test('loss diagnostics use shared deterministic file ordering', () => {
  const result = compare('SF:src/z.ts\nDA:1,1\nend_of_record\nSF:src/a.ts\nDA:1,1\nend_of_record\n');
  expect(result.output.indexOf(`${resolve('src/a.ts')}:1:`)).toBeLessThan(result.output.indexOf(`${resolve('src/z.ts')}:1:`));
});

test('multiline reason errors point to the reason field', () => {
  const result = compare('', '', '{\n "allow": [{\n "file": "src/x.ts",\n "line": 7,\n "reason": ""\n }]\n}');
  expect(result.code).toBe(2);
  expect(result.output).toContain(`${resolve('allow.json')}:5:`);
});
