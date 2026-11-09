/**
 * «Не проблема» is a file in the product repository (madarch-m38l.19): the
 * stable id is the rule and the finding's identity, the reason is the
 * person's own words, and reading the folder gives the listing the ids to
 * leave out without trusting a position in a list.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dismissalFile, readProblemDismissals, writeProblemDismissal } from '../src/loop/problem-files.js';
import { problemId } from '../src/problems/types.js';

const author = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };
const folder = (): string => mkdtempSync(join(tmpdir(), 'madarch-problems-dismissal-'));

describe('a dismissal is a file of the product', () => {
  test('the reason, who said it and the stable id are written once and read back', () => {
    const product = folder();
    const written = writeProblemDismissal({
      productFolder: product, rule: 'security.sql-input', identity: 'code.sql-sink:src/a.ts#3\u0000code.sql-build:src/a.ts#2',
      place: 'src/a.ts:3', reason: '  The query is built from a constant.  ', by: author, at: '2026-10-29T10:00:00.000Z',
    });
    expect(written.file).toBe(dismissalFile('security.sql-input', 'code.sql-sink:src/a.ts#3\u0000code.sql-build:src/a.ts#2'));
    const disk = readFileSync(join(product, written.file), 'utf8');
    expect(disk).toContain('kind: problem-dismissal');
    expect(disk).toContain('## Why it is not a problem');
    expect(disk).toContain('The query is built from a constant.');
    const read = readProblemDismissals(product);
    expect(read.problems).toEqual([]);
    expect(read.items).toEqual([{
      id: problemId('security.sql-input', 'code.sql-sink:src/a.ts#3\u0000code.sql-build:src/a.ts#2'),
      rule: 'security.sql-input', identity: 'code.sql-sink:src/a.ts#3\u0000code.sql-build:src/a.ts#2',
      place: 'src/a.ts:3', reason: 'The query is built from a constant.', by: author, at: '2026-10-29T10:00:00.000Z', file: written.file,
    }]);
  });

  test('a second record of the same problem is refused, and so is a reason that says nothing', () => {
    const product = folder();
    const input = { productFolder: product, rule: 'large-file', identity: 'code.file:src/a.ts', place: 'src/a.ts:1', reason: 'It is one table.', by: author, at: '2026-10-29T10:00:00.000Z' };
    writeProblemDismissal(input);
    expect(() => writeProblemDismissal(input)).toThrow('this problem is already dismissed');
    expect(() => writeProblemDismissal({ ...input, identity: 'code.file:src/b.ts', reason: '   ' })).toThrow('a dismissal says why the problem is not one');
  });

  test('a file without front matter or with another kind is a finding with its path and line, not a silent skip', () => {
    const product = folder();
    mkdirSync(join(product, 'docs/problems'), { recursive: true });
    writeFileSync(join(product, 'docs/problems/no-front.md'), 'nothing\n');
    writeFileSync(join(product, 'docs/problems/wrong-kind.md'), '---\nkind: correction\nreason: x\n---\n');
    writeFileSync(join(product, 'docs/problems/incomplete.md'), '---\nkind: problem-dismissal\nrule: large-file\n---\n');
    const read = readProblemDismissals(product);
    expect(read.items).toEqual([]);
    expect(read.problems.map((problem) => problem.file)).toEqual(['docs/problems/incomplete.md', 'docs/problems/no-front.md', 'docs/problems/wrong-kind.md']);
    expect(read.problems.map((problem) => problem.message).join('\n')).toContain('a dismissal opens with front matter');
    expect(read.problems.map((problem) => problem.message).join('\n')).toContain('"kind" is "problem-dismissal"');
    expect(read.problems.map((problem) => problem.message).join('\n')).toContain('a dismissal names "rule", "identity", "place", "reason", "by"');
  });

  test('a dismissal that cannot be read keeps the other records and says which file is broken', () => {
    const product = folder();
    writeProblemDismissal({ productFolder: product, rule: 'debt.todo', identity: 'code.debt:src/a.ts#1', place: 'src/a.ts:1', reason: 'Tracked elsewhere.', by: author, at: '2026-10-29T10:00:00.000Z' });
    writeFileSync(join(product, 'docs/problems/broken.md'), '---\nkind: problem-dismissal\nrule: [\n---\n');
    const read = readProblemDismissals(product);
    expect(read.items).toHaveLength(1);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]!.file).toBe('docs/problems/broken.md');
  });
});
