/**
 * The architectural violations the rules of decision 0033 (item 4) find, and the
 * list that lets them be paid off instead of switched off.
 *
 * The rules — one writer for the graph, one storage layer, one entry point for a
 * fill, no code unreachable from the declared entries — meet a body of code that
 * breaks them in ways a later stage of the decision deletes. A rule that failed on
 * all of that on its first day would be switched off on its first day, so today's
 * violations are written down in .architecture/violations.json, and the check
 * holds the two sides to each other:
 *
 * - a violation that occurs and is not listed fails the check (a new one, or one
 *   whose entry was dropped), and
 * - an entry that no longer occurs fails the check too, so the list can only
 *   shrink: it is a debt, not an allowlist. A commit that lists a new violation
 *   is refused by CI unless it carries the owner's decision (base-guard.ts says
 *   how).
 *
 * An entry names the rule, the file and the import or symbol. It does not name
 * the line: a line moves whenever code above it moves, and a list that changed
 * every time an unrelated edit shifted a statement would be rewritten by hand
 * instead of read. The line is reported where it is found, in the message the
 * check prints, and it is the reason an entry looked up in a failure message
 * leads straight to the import.
 *
 * The file is in code point order of (rule, file, symbol), written with two
 * spaces of indentation and a final newline, so two machines that find the same
 * violations write the same bytes.
 */
import { byCodePoint } from '../../../src/model/order.js';

/** The rules, as a reader names them. The order is the order of the list's sort. */
export const ARCHITECTURE_RULES = [
  'graph-single-writer',
  'graph-writes-in-writer',
  'no-retired-surfaces',
  'no-unreachable-code',
  'one-fill-entry',
  'product-file-readers',
  'sql-only-in-storage-layer',
  'starter-data-when-copying',
] as const;

export type ArchitectureRule = (typeof ARCHITECTURE_RULES)[number];

/**
 * The rules that take no baseline: a violation they find is fixed, never written
 * into the list, and no commit's owner decision may keep one there.
 */
export const NO_BASELINE_RULES: readonly ArchitectureRule[] = ['no-unreachable-code', 'starter-data-when-copying'];

/**
 * One violation as a rule found it.
 *
 * `symbol` is what the entry is about, in the vocabulary of its rule: for
 * `sql-only-in-storage-layer` and `graph-single-writer` the module or package that
 * was imported, for `one-fill-entry` the runner module and the runner's name
 * (`src/extract/driver/index.ts:fillGraph`), for `no-unreachable-code` the name of
 * the export, and `null` where the finding is the file itself — a module no entry
 * reaches.
 */
export interface ArchitectureViolation {
  readonly rule: ArchitectureRule;
  /** The module the violation is in, as a path from the repository root. */
  readonly file: string;
  /** The 1-based line the violation is on; 1 where the finding is the whole file. */
  readonly line: number;
  readonly symbol: string | null;
}

/** One entry of .architecture/violations.json. */
export interface ListedViolation {
  readonly rule: ArchitectureRule;
  readonly file: string;
  readonly symbol: string | null;
}

/**
 * What a violation is, for comparing two of them: the rule, the file and the
 * import or symbol, and nothing that moves with the code around it.
 */
export function identityOf(violation: ListedViolation): string {
  return `${violation.rule}\u0000${violation.file}\u0000${violation.symbol ?? ''}`;
}

/**
 * Code point order of (rule, file, symbol): by the rule's name, then by the file's
 * path, then by the symbol, a whole-file finding standing before any symbol of the
 * same file.
 */
function compareViolations(left: ListedViolation, right: ListedViolation): number {
  return (
    byCodePoint(left.rule, right.rule) ||
    byCodePoint(left.file, right.file) ||
    byCodePoint(left.symbol ?? '', right.symbol ?? '')
  );
}

/** The violations in the one order every file, message and diff of them uses. */
export function orderedViolations<T extends ListedViolation>(violations: readonly T[]): T[] {
  return [...violations].sort(compareViolations);
}

/** What comparing what the rules found with what the file lists gives. */
export interface ViolationListComparison {
  /** Violations found now that the file does not list, in code point order. */
  readonly unlisted: readonly ArchitectureViolation[];
  /** Entries the file lists that no rule found now, in code point order. */
  readonly stale: readonly ListedViolation[];
  /** Entries the file lists more than once: the same violation written twice. */
  readonly duplicated: readonly ListedViolation[];
}

/**
 * Compares what the rules found with the list. A violation is the same violation
 * whatever line it is on, so a line that moved is neither a new entry nor a stale
 * one; a rule that stops finding an entry makes it stale, and a rule that finds
 * one the file lacks makes it unlisted.
 */
export function compareViolationLists(
  found: readonly ArchitectureViolation[],
  listed: readonly ListedViolation[],
): ViolationListComparison {
  const listedIdentities = new Set(listed.map(identityOf));
  const foundIdentities = new Set(found.map(identityOf));
  const seen = new Set<string>();
  const duplicated: ListedViolation[] = [];
  for (const entry of orderedViolations(listed)) {
    const identity = identityOf(entry);
    if (seen.has(identity)) duplicated.push(entry);
    seen.add(identity);
  }
  return {
    unlisted: orderedViolations(found.filter((violation) => !listedIdentities.has(identityOf(violation)))),
    stale: orderedViolations(listed.filter((entry) => !foundIdentities.has(identityOf(entry)))),
    duplicated,
  };
}

/** A refusal while reading the list: what is wrong, and where. */
export interface ViolationListRefusal {
  readonly file: string;
  readonly message: string;
}

/**
 * Reads .architecture/violations.json. The file is data a person edits by hand, so
 * every way it can be wrong is refused by name — an unknown rule, a missing field,
 * a path that is not a path — rather than read as something it is not.
 */
export function readViolationList(
  text: string,
  file: string,
): { readonly ok: true; readonly violations: readonly ListedViolation[] } | { readonly ok: false; readonly refusal: ViolationListRefusal } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, refusal: { file, message: `the list is not JSON: ${(error as Error).message}` } };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, refusal: { file, message: 'the list is a JSON array of {rule, file, symbol} entries, and this is not an array' } };
  }
  const violations: ListedViolation[] = [];
  for (const [index, entry] of parsed.entries()) {
    const where = `entry ${index + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, refusal: { file, message: `${where} is not an object with rule, file and symbol` } };
    }
    const held = entry as Record<string, unknown>;
    const unknown = Object.keys(held).filter((key) => key !== 'rule' && key !== 'file' && key !== 'symbol');
    if (unknown.length > 0) {
      return { ok: false, refusal: { file, message: `${where} carries ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and an entry is exactly rule, file and symbol` } };
    }
    const rule = held['rule'];
    if (typeof rule !== 'string' || !(ARCHITECTURE_RULES as readonly string[]).includes(rule)) {
      return { ok: false, refusal: { file, message: `${where} names the rule ${JSON.stringify(rule)}, which is not one of ${ARCHITECTURE_RULES.join(', ')}` } };
    }
    const path = held['file'];
    if (typeof path !== 'string' || path.length === 0) {
      return { ok: false, refusal: { file, message: `${where} names the file ${JSON.stringify(path)}, and a file is a path from the repository root` } };
    }
    const symbol = held['symbol'];
    if (symbol !== null && typeof symbol !== 'string') {
      return { ok: false, refusal: { file, message: `${where} names the symbol ${JSON.stringify(symbol)}, and a symbol is a string or null` } };
    }
    violations.push({ rule: rule as ArchitectureRule, file: path, symbol });
  }
  return { ok: true, violations };
}

/** The bytes .architecture/violations.json holds for these violations. */
export function renderViolationList(violations: readonly ListedViolation[]): string {
  const rows = orderedViolations(violations.map((entry) => ({ rule: entry.rule, file: entry.file, symbol: entry.symbol })));
  return `${JSON.stringify(rows, null, 2)}\n`;
}
