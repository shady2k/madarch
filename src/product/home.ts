/**
 * Where madarch keeps its own things on a machine: the madarch home that
 * `MADARCH_HOME` names (else `~/madarch`), the products home under it, and the
 * home of the person the process runs for.
 *
 * One module holds these three readings so no two callers disagree about them:
 * `madarch new` writes its drafts under the products home, and the wizard
 * installs an agent's ACP adapter under the madarch home, beside them.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The environment these homes are read from: the process's, or the caller's. */
export type DraftEnv = Readonly<Record<string, string | undefined>>;

/**
 * The person's home as this process reads it: the environment's `HOME`, which
 * is what `os.homedir()` reports when a process starts — and which is the only
 * one a run can point elsewhere, since Bun resolves `homedir()` once and a
 * preload cannot move it afterwards (madarch-1xq: what madarch writes must
 * follow the home a test run gives the process, not the account's own).
 */
export function homeFromEnv(env: DraftEnv = process.env): string {
  const named = env.HOME?.trim();
  return named !== undefined && named !== '' ? named : homedir();
}

/**
 * The madarch home: the folder `MADARCH_HOME` names, otherwise `~/madarch`.
 * A variable that names only spaces counts as unset, as everywhere in madarch.
 */
export function madarchHome(env: DraftEnv = process.env, home = homeFromEnv(env)): string {
  const named = env.MADARCH_HOME?.trim();
  if (named !== undefined && named !== '') return resolve(named);
  return join(home, 'madarch');
}

/**
 * The products home: the folder `--home` names when this command was given
 * one; otherwise `products` under the madarch home that `MADARCH_HOME`
 * names; otherwise `products` under `~/madarch`. An option or a variable
 * that names only spaces counts as unset, as everywhere in madarch.
 */
export function productsHome(env: DraftEnv, given?: string, home = homeFromEnv(env)): string {
  const named = given?.trim();
  if (named !== undefined && named !== '') return named;
  return join(madarchHome(env, home), 'products');
}
