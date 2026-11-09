/**
 * No code and no export unreachable from the declared entry points (decision 0033,
 * item 4): knip, in two passes.
 *
 * The **production** pass (`knip.production.json`) declares only what a user runs —
 * the binary's entry (`scripts/madarch.ts`) and the wiki app (`index.html`,
 * `main.tsx`) — and runs knip with `--production`. Tests and scripts are not
 * production entries: a module or an export they alone reach is dead in the
 * product, and this rule reports it. The pass's project is every module, so what
 * it finds is what no production entry reaches.
 *
 * The **non-production** pass (`knip.json`) declares the tests, the test helpers
 * and the scripts, and asks knip only for unused files. It is what keeps a test
 * helper or a script itself from being reported as an unused file: a file this
 * pass reaches is not the production pass's to report. A file it does not reach
 * is dead wherever it lies, and is reported too. It never makes a module under
 * `src/` or `wiki/app/src/` live: code there must be reachable from the
 * production entries, and a test that reaches it does not keep it.
 *
 * knip is run as the program it is, in its own process, and gives its report as
 * JSON: its own resolver knows TypeScript, and its process boundary is the report
 * it prints. It reports a name and the line it is exported on; a finding about a
 * whole file is reported at the file's first line.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/** The entry points and project of the production pass. */
const PRODUCTION_CONFIG = 'knip.production.json';

/** The entry points and project of the non-production pass: tests, test helpers and scripts. */
const NON_PRODUCTION_CONFIG = 'knip.json';

/** The issue kinds the reachability rule reads: unreachable files, exports, types and their members. */
const REACHABILITY_ISSUES = ['files', 'exports', 'nsExports', 'types', 'nsTypes', 'enumMembers'] as const;

interface KnipNamedIssue {
  readonly name: string;
  readonly line?: number;
}

interface KnipFileIssues {
  readonly file: string;
  readonly files?: readonly KnipNamedIssue[];
  readonly exports?: readonly KnipNamedIssue[];
  readonly nsExports?: readonly KnipNamedIssue[];
  readonly types?: readonly KnipNamedIssue[];
  readonly nsTypes?: readonly KnipNamedIssue[];
  readonly enumMembers?: readonly KnipNamedIssue[];
}

/** Where knip's own program lives in this repository's dependencies. */
function knipProgram(): string {
  const entry = fileURLToPath(import.meta.resolve('knip'));
  const program = resolve(entry, '../../bin/knip.js');
  if (!existsSync(program)) {
    throw new Error(`${program}:1: knip's program is not where its package entry says; run bun install`);
  }
  return program;
}

/** A path as knip writes it on this machine, with forward slashes. */
function normalize(path: string): string {
  return path.split('\\').join('/');
}

/**
 * Runs one knip pass over the repository and answers its issues. A configuration
 * that is missing is refused by name rather than read as a project with no
 * entries (which would report every module); a run that prints no JSON report is
 * refused with what knip said.
 */
async function knipReport(root: string, configName: string, options: { readonly production: boolean; readonly include: readonly string[] }): Promise<readonly KnipFileIssues[]> {
  const config = resolve(root, configName);
  if (!existsSync(config)) {
    throw new Error(`${config}:1: the reachability check reads its entry points from ${configName}, and this repository has none`);
  }
  const program = Bun.spawn(
    [process.execPath, knipProgram(), '--reporter', 'json', '--config', config, '--include', options.include.join(','), ...(options.production ? ['--production'] : [])],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  );
  const [output, errors, exitCode] = await Promise.all([
    new Response(program.stdout).text(),
    new Response(program.stderr).text(),
    program.exited,
  ]);
  let report: { readonly issues?: readonly KnipFileIssues[] };
  try {
    report = JSON.parse(output) as { issues?: readonly KnipFileIssues[] };
  } catch (error) {
    throw new Error(`${config}:1: knip exited ${exitCode} without a JSON report (${(error as Error).message}); what it said: ${errors.trim().split('\n').slice(-5).join(' | ')}`);
  }
  return report.issues ?? [];
}

/** Whether a path is one of the product's modules: the code this rule holds to production reachability. */
function inProduct(file: string): boolean {
  return file.startsWith('src/') || file.startsWith('wiki/app/src/');
}

/** Whether a path is a test file: the non-production pass's own, wherever it stands. */
function isTestFile(file: string): boolean {
  return file.startsWith('test/') || file.startsWith('wiki/app/test/') || /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file);
}

/**
 * Every module and export no declared entry reaches. The production pass names
 * what the product's entries do not reach; the non-production pass says which
 * test files and scripts are alive, so those files are not reported as unused.
 */
export async function unreachableViolations(root: string): Promise<ArchitectureViolation[]> {
  const production = await knipReport(root, PRODUCTION_CONFIG, { production: true, include: REACHABILITY_ISSUES });
  const nonProduction = await knipReport(root, NON_PRODUCTION_CONFIG, { production: false, include: ['files'] });
  const deadOutsideProduct = new Set<string>();
  for (const issues of nonProduction) {
    const file = normalize(issues.file);
    for (const unused of issues.files ?? []) {
      const name = normalize(unused.name);
      if (!inProduct(name)) deadOutsideProduct.add(name);
    }
  }
  const violations: ArchitectureViolation[] = [];
  for (const issues of production) {
    const file = normalize(issues.file);
    const product = inProduct(file);
    const test = isTestFile(file);
    // A test file under the product is the non-production pass's: when that pass reaches it, it is alive.
    const productTestAlive = product && test && !deadOutsideProduct.has(file);
    for (const unreachable of issues.files ?? []) {
      const name = normalize(unreachable.name);
      if (product) {
        if (productTestAlive && name === file) continue;
        violations.push({ rule: 'no-unreachable-code', file: name, line: 1, symbol: null });
      } else if (deadOutsideProduct.has(name)) {
        violations.push({ rule: 'no-unreachable-code', file: name, line: 1, symbol: null });
      }
    }
    if (!product || productTestAlive) continue;
    for (const kind of ['exports', 'nsExports', 'types', 'nsTypes', 'enumMembers'] as const) {
      for (const symbol of issues[kind] ?? []) {
        violations.push({ rule: 'no-unreachable-code', file, line: symbol.line ?? 1, symbol: symbol.name });
      }
    }
  }
  return unique(orderedViolations(violations));
}

/** One name exported twice in a module is one export: the finding is kept on the first line it is written on. */
function unique(violations: readonly ArchitectureViolation[]): ArchitectureViolation[] {
  const byIdentity = new Map<string, ArchitectureViolation>();
  for (const violation of violations) {
    const identity = `${violation.file}\u0000${violation.symbol ?? ''}`;
    const held = byIdentity.get(identity);
    if (held === undefined || violation.line < held.line) byIdentity.set(identity, violation);
  }
  return orderedViolations([...byIdentity.values()]);
}
