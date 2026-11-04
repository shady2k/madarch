/**
 * The list of accepted violations only shrinks, and CI holds it to that against the
 * branch's merge base (decision 0033, item 4: "Rules live in one configuration in the
 * repository and change only in a commit that carries the owner's decision").
 *
 * `bun run check` keeps the list honest about the code: a violation the list does not
 * hold fails it. That leaves one way left to pass with a new violation — write it into
 * the list. This guard closes it: it reads the list as the merge base has it and the
 * list as the branch has it, and an entry the branch gained fails the build unless a
 * commit on the branch carries a line `Owner-decision: <the decision, in the owner's
 * words>`.
 *
 * The base is the merge base of HEAD and origin/main unless one is named. A base that
 * does not hold the list at all is not a base to compare with — the list is being
 * introduced by this branch — and nothing is reported as gained from it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  identityOf,
  orderedViolations,
  readViolationList,
  type ListedViolation,
} from './violation.js';
import { repositoryRoot } from './sources.js';
import { VIOLATION_LIST } from './check.js';

/** The line a commit carries when the owner decided that a violation may join the list. */
const OWNER_DECISION_PREFIX = 'Owner-decision:';

export interface BaseGuardReport {
  readonly root: string;
  /** The commit the branch is compared against, or `null` when it could not be resolved. */
  readonly base: string | null;
  /** False when the base holds no list, so there is nothing to have gained from it. */
  readonly baseHasList: boolean;
  /** The entries the branch holds that the base does not. */
  readonly added: readonly ListedViolation[];
  /** The first `Owner-decision:` line a commit of the branch carries, or `null`. */
  readonly ownerDecision: string | null;
}

/** Runs a git command in the repository and answers its standard output, or throws with what git said. */
function git(root: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    const said = stderr === undefined ? '' : `: ${stderr.toString().trim()}`;
    throw new Error(`git -C ${root} ${args.join(' ')} failed${said}`);
  }
}

/** The commit a branch's list is compared against: the merge base with origin/main, or the one named. */
function resolveBase(root: string, base?: string): string {
  if (base !== undefined) return git(root, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  try {
    return git(root, ['merge-base', 'HEAD', 'origin/main']).trim();
  } catch (error) {
    throw new Error(`${(error as Error).message}\n  the guard compares the branch with origin/main and could not find its merge base: fetch origin/main (git fetch origin main) or name the base with --base <commit>`);
  }
}

/** Reads the list at a commit, or answers `null` when that commit holds no list. */
function listAtCommit(root: string, commit: string): readonly ListedViolation[] | null {
  let text: string;
  try {
    text = git(root, ['show', `${commit}:${VIOLATION_LIST}`]);
  } catch {
    return null;
  }
  const read = readViolationList(text, `${commit}:${VIOLATION_LIST}`);
  if (!read.ok) throw new Error(`${VIOLATION_LIST} at ${commit}:1: ${read.refusal.message}`);
  return read.violations;
}

/** The first owner's decision a commit of the range carries. */
function ownerDecisionBetween(root: string, base: string): string | null {
  const bodies = git(root, ['log', '--format=%B', `${base}..HEAD`]);
  for (const line of bodies.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OWNER_DECISION_PREFIX)) continue;
    const decision = trimmed.slice(OWNER_DECISION_PREFIX.length).trim();
    if (decision.length > 0) return trimmed;
  }
  return null;
}

/** Compares the branch's list with the base's and reads the owner's decision, if any. */
export function baseGuard(options: { readonly root?: string; readonly base?: string } = {}): BaseGuardReport {
  const root = resolve(options.root ?? repositoryRoot());
  const base = resolveBase(root, options.base);
  const baseList = listAtCommit(root, base);
  const headPath = resolve(root, VIOLATION_LIST);
  const headRead = readViolationList(existsSync(headPath) ? readFileSync(headPath, 'utf8') : '[]', headPath);
  if (!headRead.ok) throw new Error(`${headPath}:1: ${headRead.refusal.message}`);
  if (baseList === null) return { root, base, baseHasList: false, added: [], ownerDecision: null };
  const held = new Set(baseList.map(identityOf));
  const added = orderedViolations(headRead.violations.filter((entry) => !held.has(identityOf(entry))));
  return { root, base, baseHasList: true, added, ownerDecision: added.length > 0 ? ownerDecisionBetween(root, base) : null };
}

/** True when no entry joined the list, or the owner decided that it may. */
export function baseGuardPasses(report: BaseGuardReport): boolean {
  return report.added.length === 0 || report.ownerDecision !== null;
}

/** What the guard has to say, one problem per line. */
export function baseGuardProblemLines(report: BaseGuardReport): string[] {
  if (baseGuardPasses(report)) return [];
  const where = `${resolve(report.root, VIOLATION_LIST)}:1`;
  return report.added.map(
    (entry) =>
      `${where}: ${entry.rule}: the entry ${entry.file}: ${entry.symbol ?? 'the file itself'} joined ${VIOLATION_LIST} since ${report.base}, and no commit of this branch carries "${OWNER_DECISION_PREFIX}"; the list only shrinks, so the violation is fixed rather than listed — or the owner decides`,
  );
}
