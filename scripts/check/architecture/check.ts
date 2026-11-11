/**
 * The architecture check (decision 0033, item 4): the four rules, run over the
 * repository, held against the list of violations the project has accepted.
 *
 * `bun run check` runs it (scripts/check-architecture.ts), and so CI. It fails when a
 * rule finds a violation the list does not hold, when the list holds one no rule
 * finds any more, and when the list holds one twice; it passes when the two sides
 * are the same violations. Where a failure is about a violation, the message names
 * the rule, the module's full path and the line the violation is on, so a reader
 * goes from the message to the import.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dependencyRuleViolations } from './dependency-rules.js';
import { fillEntryViolations } from './fill-entry.js';
import { graphWriteViolations } from './graph-writes.js';
import { schemaPreparationViolations } from './schema-preparation.js';
import { starterDataViolations } from './starter-data.js';
import { unreachableViolations } from './reachability.js';
import { moduleSet, repositoryRoot } from './sources.js';
import {
  ARCHITECTURE_RULES,
  NO_BASELINE_RULES,
  compareViolationLists,
  orderedViolations,
  readViolationList,
  renderViolationList,
  type ArchitectureRule,
  type ArchitectureViolation,
  type ListedViolation,
  type ViolationListComparison,
} from './violation.js';

/** The file the accepted violations are written in, as a path from the repository root. */
export const VIOLATION_LIST = '.architecture/violations.json';

export interface ArchitectureCheckOptions {
  /** The repository to check; the checkout this module belongs to unless a fixture is checked. */
  readonly root?: string;
  /** The rules to run; all of them unless the caller asks for some (a test of one rule, or a quick run). */
  readonly rules?: readonly ArchitectureRule[];
}

export interface ArchitectureReport {
  readonly root: string;
  readonly rules: readonly ArchitectureRule[];
  /** The list's path, absolute. */
  readonly listPath: string;
  /** The list as read, the rule-named entries of it the run compares against. */
  readonly listed: readonly ListedViolation[];
  /** The listed entries of a rule that takes no baseline: dead code is fixed, never written down. */
  readonly noBaseline: readonly ListedViolation[];
  /** The list's own bytes, for reporting an entry on the line it is written on. */
  readonly listText: string;
  /** Every violation the rules found, in code point order. */
  readonly found: readonly ArchitectureViolation[];
  readonly comparison: ViolationListComparison;
  /** What is wrong with the list file itself, when it could not be read. */
  readonly refusal: string | null;
}

/** Runs the rules named over the repository named and compares them with the list. */
export async function architectureCheck(options: ArchitectureCheckOptions = {}): Promise<ArchitectureReport> {
  const root = resolve(options.root ?? repositoryRoot());
  const rules = options.rules ?? ARCHITECTURE_RULES;
  const listPath = resolve(root, VIOLATION_LIST);
  const found: ArchitectureViolation[] = [];
  if (rules.includes('graph-single-writer') || rules.includes('no-retired-surfaces') || rules.includes('sql-only-in-storage-layer')) {
    const modules = moduleSet(root);
    found.push(...(await dependencyRuleViolations(root, rules, modules)));
  }
  if (rules.includes('one-fill-entry')) found.push(...fillEntryViolations(root));
  if (rules.includes('graph-writes-in-writer')) found.push(...graphWriteViolations(root));
  if (rules.includes('no-unreachable-code')) found.push(...(await unreachableViolations(root)));
  if (rules.includes('schema-preparation-only')) found.push(...await schemaPreparationViolations(root));
  if (rules.includes('starter-data-when-copying')) found.push(...starterDataViolations(root));
  const located = orderedViolations(found);
  if (!existsSync(listPath)) {
    return {
      root,
      rules,
      listPath,
      listed: [],
      noBaseline: [],
      listText: '',
      found: located,
      comparison: { unlisted: located, stale: [], duplicated: [] },
      refusal: `${listPath}:1: the list of accepted violations is missing; write it with bun scripts/check-architecture.ts --update`,
    };
  }
  const listText = readFileSync(listPath, 'utf8');
  const read = readViolationList(listText, listPath);
  if (!read.ok) {
    return {
      root,
      rules,
      listPath,
      listed: [],
      noBaseline: [],
      listText,
      found: located,
      comparison: { unlisted: located, stale: [], duplicated: [] },
      refusal: `${read.refusal.file}:1: ${read.refusal.message}`,
    };
  }
  const listed = read.violations.filter((entry) => rules.includes(entry.rule));
  const noBaseline = listed.filter((entry) => NO_BASELINE_RULES.includes(entry.rule));
  return { root, rules, listPath, listed, noBaseline, listText, found: located, comparison: compareViolationLists(located, listed), refusal: null };
}

/** True when the check has nothing to report: the two sides hold the same violations. */
export function architectureCheckPasses(report: ArchitectureReport): boolean {
  return (
    report.refusal === null &&
    report.noBaseline.length === 0 &&
    report.comparison.unlisted.length === 0 &&
    report.comparison.stale.length === 0 &&
    report.comparison.duplicated.length === 0
  );
}

/**
 * What the check has to say, one problem per line: a violation the list does not
 * hold, an entry the rules no longer find, an entry written twice, and what the rules
 * found in all.
 */
export function architectureProblemLines(report: ArchitectureReport): string[] {
  const lines: string[] = [];
  if (report.refusal !== null) lines.push(report.refusal);
  const listText = report.listText;
  for (const entry of report.noBaseline) {
    lines.push(
      `${report.listPath}:${lineOfListedEntry(listText, entry)}: ${entry.rule}: ${entry.file}: ${entry.symbol ?? 'the file itself'} is listed, and ${entry.rule} takes no baseline: violations are fixed, never written into ${VIOLATION_LIST}`,
    );
  }
  for (const violation of report.comparison.unlisted) {
    lines.push(
      `${absolute(report.root, violation.file)}:${violation.line}: ${violation.rule}: ${describe(violation)}; ${NO_BASELINE_RULES.includes(violation.rule) ? `${violation.rule} takes no baseline — fix the violation` : `${VIOLATION_LIST} does not list it, and a violation that is not written down is a new one — fix it, or list it in a commit that carries the owner's decision`}`,
    );
  }
  for (const entry of report.comparison.duplicated) {
    lines.push(
      `${report.listPath}:${lineOfListedEntry(listText, entry)}: ${entry.rule}: ${entry.file}: ${entry.symbol ?? 'the file itself'} is listed more than once; ${VIOLATION_LIST} holds each violation once`,
    );
  }
  for (const entry of report.comparison.stale) {
    lines.push(
      `${report.listPath}:${lineOfListedEntry(listText, entry)}: ${entry.rule}: ${entry.file}: ${entry.symbol ?? 'the file itself'} is listed and no rule finds it any more; ${VIOLATION_LIST} only shrinks, so the entry goes in the same change that fixed it`,
    );
  }
  return lines;
}

/**
 * The bytes ${VIOLATION_LIST} holds for the violations the rules find now: the same
 * choices of order and shape the list was written with.
 */
export function renderViolationListOf(report: ArchitectureReport): string {
  return renderViolationList(
    report.found
      .filter((violation) => !NO_BASELINE_RULES.includes(violation.rule))
      .map((violation) => ({ rule: violation.rule, file: violation.file, symbol: violation.symbol })),
  );
}

/** How many violations the run found per rule, for the summary a check prints. */
export function countsByRule(violations: readonly ArchitectureViolation[]): ReadonlyMap<ArchitectureRule, number> {
  const counts = new Map<ArchitectureRule, number>();
  for (const rule of ARCHITECTURE_RULES) counts.set(rule, 0);
  for (const violation of violations) counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
  return counts;
}

/** What one violation is, in the words of its rule. */
function describe(violation: ArchitectureViolation): string {
  switch (violation.rule) {
    case 'schema-preparation-only':
      return `${violation.file} reaches schema preparation (${violation.symbol}): only the store preparation boundary may change a schema, and runtime consumers may not import it`;
    case 'graph-single-writer':
      return `${violation.file} imports the graph's publication API ${violation.symbol}, which only the graph store (src/graph) and the storage layer (src/adapters) may import — every other module drafts and has its draft published`;
    case 'graph-writes-in-writer':
      return `${violation.file} writes the graph table ${violation.symbol ?? 'row'} itself, and the one writer of the graph is src/graph/write.ts: a module drafts and has its draft published`;
    case 'no-retired-surfaces':
      return `${violation.file} imports ${violation.symbol}, which is a retired surface (src/extract, src/history or src/query): the work that replaced it is the fill's record passes`;
    case 'sql-only-in-storage-layer':
      return `${violation.file} imports ${whatCarriesTheConnection(violation.symbol)}, and only the graph store (src/graph) and the storage layer (src/adapters) hold a connection or run a query — every other module asks a store`;
    case 'one-fill-entry': {
      const [module = '', name = '*'] = (violation.symbol ?? '').split(':');
      const whole = name === '*' ? 'the runner module as a whole' : `the fill runner ${name}`;
      return `${violation.file} imports ${whole} of ${module}, and only the orchestrator host (src/fill/orchestrator-host.ts) starts a fill`;
    }
    case 'starter-data-when-copying':
      return `${violation.file} imports the starter set ${violation.symbol}, and only src/product/draft.ts (what \`madarch new\` runs) copies the starter set into a product: the engine reads the product's own catalogue, templates and loop kinds, and a file it lacks is a problem naming that file`;
    case 'no-unreachable-code':
      return violation.symbol === null
        ? `the module is unreachable from every declared entry point of knip.json`
        : `the export ${violation.symbol} is unreachable from every declared entry point of knip.json`;
  }
}

/**
 * What the module a storage rule names is, in the words of the rule: the connection
 * itself, the interface a statement runs through, or a client of the database.
 */
function whatCarriesTheConnection(symbol: string | null): string {
  if (symbol === 'src/adapters/database-owner.ts') return 'the database owner, which is the process\'s one connection';
  if (symbol === 'src/sql-driver.ts') return 'the query interface, through which a module runs statements of its own';
  return `the database client ${symbol}`;
}

/** A path from the repository root as the absolute path a reader can open. */
function absolute(root: string, file: string): string {
  return resolve(root, ...file.split('/'));
}

/**
 * The line of an entry of the list, found in the text of the file as the file writes
 * it (rule, file, symbol, one per line). A file someone has written in another shape
 * is not read as wrong here: the entry is reported at the file's first line.
 */
function lineOfListedEntry(text: string, entry: ListedViolation): number {
  const lines = text.split('\n').map((line) => withoutComma(line.trim()));
  const rule = `"rule": ${JSON.stringify(entry.rule)}`;
  const file = `"file": ${JSON.stringify(entry.file)}`;
  const symbol = `"symbol": ${entry.symbol === null ? 'null' : JSON.stringify(entry.symbol)}`;
  for (const [index, line] of lines.entries()) {
    if (line !== rule) continue;
    if (lines[index + 1] !== file) continue;
    if (lines[index + 2] !== symbol) continue;
    return index + 1;
  }
  return 1;
}

/** A field's line without the comma that separates it from the next. */
function withoutComma(line: string): string {
  return line.endsWith(',') ? line.slice(0, -1) : line;
}
