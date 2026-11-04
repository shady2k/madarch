import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { architectureCheck, architectureProblemLines, VIOLATION_LIST } from '../src/check/architecture/check.js';
import { orderedViolations, type ArchitectureRule } from '../src/check/architecture/violation.js';
import { repositoryRoot } from '../src/check/architecture/sources.js';

/**
 * The architecture check against the repository itself (decision 0033, item 4): the
 * list the project holds is exactly the violations its rules find, so `bun run check`
 * and CI see the two sides agree. It is the slow case — knip reads every module of the
 * product and of the wiki app — and it is apart from test/architecture-check.test.ts,
 * whose fixture cases are the fast suite a mutation run drives.
 */
const REPOSITORY = repositoryRoot();

describe('the repository\'s own list', () => {
  test(
    'holds exactly the violations its own rules find, in code point order',
    async () => {
      const report = await architectureCheck();
      expect(report.root).toBe(REPOSITORY);
      expect(architectureProblemLines(report)).toEqual([]);

      const written = JSON.parse(readFileSync(report.listPath, 'utf8')) as { rule: ArchitectureRule; file: string; symbol: string | null }[];
      expect(written).toEqual(orderedViolations(written));
      expect(written.length).toBe(report.found.length);
      expect(readFileSync(join(REPOSITORY, VIOLATION_LIST), 'utf8')).toEndWith('\n');
    },
    180_000,
  );
});
