/**
 * The git runs madarch's lifecycle commands make, in the product folder or a
 * checkout under it (decision 0021: the lifecycle commands are madarch's own
 * code). Two things are this module's alone: the loader variables (`GIT_DIR`
 * and its companions) never reach a git call here, so a command run inside
 * another repository's worktree never writes into it, and the folder a step
 * means to answer for is compared with the repository git itself resolves —
 * a folder reached through a symlink, a working tree the folder merely
 * stands inside — so a command never answers for someone else's history.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** The subset of the environment git must not inherit from a caller. */
const GIT_LEAKS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'];

/** How one git run ended: its whole output, whatever stream that came on. */
export type GitResult = { ok: true; output: string } | { ok: false; output: string };

/** Extra environment for one git invocation, merged over the process's — how a test seals an identity. */
export type GitEnv = Readonly<Record<string, string>>;

/**
 * One git invocation in a folder. The caller's loader variables (`GIT_DIR`
 * and its companions) are stripped, so a git call here never reaches into
 * another repository's worktree, and `extra` is merged over what is left,
 * which is how a test seals an identity.
 */
export function runGit(folder: string, args: readonly string[], extra?: GitEnv): GitResult {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !GIT_LEAKS.includes(name)) env[name] = value;
  }
  Object.assign(env, extra ?? {});
  const run = spawnSync('git', args, { cwd: folder, encoding: 'utf8', env });
  const output = `${run.stderr ?? ''}${run.stdout ?? ''}`.trim();
  if (run.error !== undefined) {
    // No run happened: git's own error — normally ENOENT under a name PATH
    // does not hold — is the only cause there is.
    return { ok: false, output: output === '' ? run.error.message : `${output}; ${run.error.message}` };
  }
  if (run.status !== 0) return { ok: false, output };
  return { ok: true, output };
}

/**
 * Whether two paths name the same folder. `git` answers with the path its own
 * working directory resolved to, which is the real one: a folder reached
 * through a symlink would otherwise be taken for another folder, and a
 * product reached through a link would answer for nothing at all. A path that
 * cannot be resolved — one of them removed mid-command — falls back to the
 * spelling itself.
 */
export function sameFolder(one: string, other: string): boolean {
  try {
    return realpathSync(one) === realpathSync(other);
  } catch {
    return resolve(one) === resolve(other);
  }
}

/**
 * Whether a folder is a git repository of its own, rather than a folder
 * standing inside one: `git` run in a folder with no repository of its own
 * answers for the repository above it, so a command that wrote there would
 * write to someone else's product.
 */
export function ownRepository(folder: string, gitEnv?: GitEnv): boolean {
  const top = runGit(folder, ['rev-parse', '--show-toplevel'], gitEnv);
  return top.ok && sameFolder(top.output, folder);
}
