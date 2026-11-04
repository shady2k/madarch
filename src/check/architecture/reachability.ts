/**
 * No code and no export unreachable from the declared entry points (decision 0033,
 * item 4): knip, from knip.json.
 *
 * The entry points are the programs and surfaces the repository starts at, declared
 * in that file: `scripts/madarch.ts` and the scripts beside it, `src/index.ts` (the
 * library's own surface), the server and the worker processes the CLI reaches, the
 * test files, and the wiki app's entries (its `index.html`, `main.tsx`, vite
 * configuration and tests). What knip reports is a module no entry reaches, or an
 * export no reachable module uses.
 *
 * knip is run as the program it is, in its own process, and gives its report as
 * JSON: its own resolver (oxc-resolver) knows TypeScript, and its process boundary is
 * the report it prints. It reports a name and the line it is exported on; a finding
 * about a whole file is reported at the file's first line.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/** The entry points and project of the reachability check: the committed configuration. */
const REACHABILITY_CONFIG = 'knip.json';

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

/**
 * Every module and export no declared entry reaches, in the root named. A root whose
 * configuration is missing is refused by name rather than read as a project with no
 * entries (which would report every module).
 */
export async function unreachableViolations(root: string): Promise<ArchitectureViolation[]> {
  const config = resolve(root, REACHABILITY_CONFIG);
  if (!existsSync(config)) {
    throw new Error(`${config}:1: the reachability check reads its entry points from ${REACHABILITY_CONFIG}, and this repository has none`);
  }
  const program = Bun.spawn(
    [process.execPath, knipProgram(), '--reporter', 'json', '--config', config, '--include', REACHABILITY_ISSUES.join(',')],
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
  const violations: ArchitectureViolation[] = [];
  for (const issues of report.issues ?? []) {
    const file = issues.file.split('\\').join('/');
    for (const unreachable of issues.files ?? []) {
      violations.push({ rule: 'no-unreachable-code', file: unreachable.name.split('\\').join('/'), line: 1, symbol: null });
    }
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
