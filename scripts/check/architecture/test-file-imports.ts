/**
 * A test file imports no other test file. Bun registers every case a file's
 * imports reach, so importing `a.test.ts` from `b.test.ts` registers a's cases
 * again inside b: one pass runs them twice, and every change to a is paid for by
 * both files. Test code two test files share stands in a module that is not named
 * `*.test.ts` (test/product-cli-helpers.ts is one).
 *
 * The finding is read from the import graph: a test case file's own syntax tree
 * (imports.ts) names every specifier it writes, static imports, re-exports and
 * dynamic `import()` alike, and the modules of `test/` resolve it to the file it
 * names (sources.ts). Only the repository's own `test/` folder is walked, in code
 * point order, and the line comes from the statement's own byte offset: nothing is
 * read from a pattern over the text.
 */
import { importStatementsOf } from './imports.js';
import { moduleSet, resolveModuleSpecifier } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/** The suffixes this repository names a test case file with; bun registers no case from any other module. */
const TEST_FILE_SUFFIXES: readonly string[] = ['.test.ts', '.test.tsx', '.test.mts', '.test.cts', '.test.js', '.test.jsx', '.test.mjs', '.test.cjs'];

/** Whether a path names a test case file. */
function isTestCaseFile(file: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

/**
 * Every import of one test case file by another, as the rule names it: the
 * importing file, the line the statement stands on, and the imported test file.
 * One test file imported twice is one finding, on the first line it is written.
 */
export function testFileImportViolations(root: string): ArchitectureViolation[] {
  const modules = moduleSet(root, ['test']);
  const held = new Map<string, ArchitectureViolation>();
  for (const file of modules.modules) {
    if (!isTestCaseFile(file)) continue;
    for (const statement of importStatementsOf(root, file)) {
      const target = resolveModuleSpecifier(modules, file, statement.specifier);
      if (target === null || !isTestCaseFile(target)) continue;
      const key = `${file}\u0000${target}`;
      if (!held.has(key)) held.set(key, { rule: 'no-test-file-imports', file, line: statement.line, symbol: target });
    }
  }
  return orderedViolations([...held.values()]);
}
