/**
 * The git this madarch's fill reads (madarch-8bdc.2.5, item 6): a fill runs whatever `git` is on PATH, and the two
 * passes use options a version older than this does not have. The oldest requirement is `git check-attr --source`,
 * which git 2.40 added (release notes, "check-attr learned to take an optional tree-ish"); `git log
 * --diff-merges=<how>` needs 2.31, and `git rev-parse --show-object-format` needs 2.29. Measured on this repository's
 * box: git 2.43.0 answers every one of them, and the fill's own tests run them.
 *
 * A fill refuses an older git by name before it reads anything, stating the version found and the one it needs. The
 * run checks `git --version`; CLI fills also check before reading the pinned schema contract.
 */
import { execFileSync } from 'node:child_process';

/** The oldest git a fill reads, as `major.minor`: `check-attr --source` is the option that sets the floor. */
const FILL_GIT_MIN = { major: 2, minor: 40 } as const;

/** The oldest git a fill reads, as a reader says it. */
export const FILL_GIT_MIN_TEXT = `${String(FILL_GIT_MIN.major)}.${String(FILL_GIT_MIN.minor)}`;

/**
 * What one `git --version` answer earns: undefined when it is the fill's git or newer, and the refusal's words when
 * it is older or is no git version at all. A reader can open the reason and the version found in it.
 */
export function gitVersionRefusal(said: string): string | undefined {
  const text = said.trim();
  const match = /^git version (\d+)\.(\d+)/u.exec(text);
  if (match === null) {
    return `the fill reads git ${FILL_GIT_MIN_TEXT} or newer, and "git --version" answered ${JSON.stringify(text)}: that is no git this fill can read`;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > FILL_GIT_MIN.major || (major === FILL_GIT_MIN.major && minor >= FILL_GIT_MIN.minor)) return undefined;
  return `the fill reads git ${FILL_GIT_MIN_TEXT} or newer, and this machine's git is ${match[1]}.${String(Number(match[2]))} (${JSON.stringify(text)}): the history pass runs "git check-attr --source", which git 2.40 added, and "git log --diff-merges" (2.31) and "git rev-parse --show-object-format" (2.29) are its other floors`;
}

/**
 * Refuses a git older than the fill reads, by name and before any stage runs: the version found is in the reason, so
 * a person installs a newer git rather than reading a mystery failure of the first repository.
 */
export function assertFillGitVersion(read: () => string = () => execFileSync('git', ['--version'], { encoding: 'utf8' })): void {
  let said: string;
  try {
    said = read();
  } catch (error) {
    throw new Error(`the fill reads git ${FILL_GIT_MIN_TEXT} or newer, and git could not be run at all: ${error instanceof Error ? error.message : String(error)} (src/fill/git-version.ts)`);
  }
  const refusal = gitVersionRefusal(said);
  if (refusal !== undefined) throw new Error(`${refusal} (src/fill/git-version.ts)`);
}
