/**
 * What a person writes in the wiki lands in the product repository
 * (decision 0029: "What people write cannot be rebuilt at all"; decision 0031:
 * identity is git locally). An answer is written into its question's file; a
 * correction is a new file. Each is committed in the product repository with
 * the person as the author (git's `user.name` and `user.email`) and carries
 * the mark "local, not verified": on a local install the author is whatever
 * the person set. A write that cannot be made is an error saying why; a write
 * that was made but not committed says so in `committed`.
 */
import { whoIsTheUser } from '../identity/identity.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Author, Question, Correction } from './entities.js';

const run = promisify(execFile);

/** Why a request is refused: for the reader, in words; `status` is the HTTP status it maps to. */
export class LoopRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Answered extends Committed { readonly question: Question; }
export interface Corrected extends Committed { readonly correction: Correction; }

export interface Committed {
  readonly committed: boolean;
  /** The commit's id when committed. */
  readonly commit?: string;
  /** Why nothing was committed. */
  readonly note?: string;
}

async function git(folder: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await run('git', ['-C', folder, ...args], { encoding: 'utf8', env: { ...env, LC_ALL: 'C' } });
  return stdout.trim();
}

/** The person writing: whoever the identity seam says the user is (decision 0031; git's name and email here, the author variables first). A missing one is refused with the fix. */
export async function localIdentity(productFolder: string, env: NodeJS.ProcessEnv = process.env): Promise<Author> {
  const who = whoIsTheUser(productFolder, undefined, env);
  if (!who.ok) throw new LoopRefusal(409, who.message);
  return { name: who.identity.name, email: who.identity.email, verified: who.identity.mark };
}

async function insideRepository(productFolder: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const top = await git(productFolder, ['rev-parse', '--show-toplevel'], env);
    return top === '' ? undefined : top;
  } catch {
    return undefined;
  }
}

/** Commits the files in the product repository with the person as author. Never throws: the result says what happened. */
export async function commitFiles(productFolder: string, files: readonly string[], message: string, by: Author, env: NodeJS.ProcessEnv = process.env): Promise<Committed> {
  const top = await insideRepository(productFolder, env);
  if (top === undefined) return { committed: false, note: `${productFolder} is not a git repository, so the file was written but not committed` };
  try {
    await git(productFolder, ['add', '--', ...files], env);
    // The user's own signing key, when git has one, signs the commit (decision 0031).
    const who = whoIsTheUser(productFolder, undefined, env);
    const signing = who.ok && who.identity.signing ? ['-S'] : [];
    await git(productFolder, ['-c', `user.name=${by.name}`, '-c', `user.email=${by.email}`, 'commit', '-q', ...signing, '-m', message, `--author=${by.name} <${by.email}>`, '--', ...files], env);
    return { committed: true, commit: await git(productFolder, ['rev-parse', 'HEAD'], env) };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    return { committed: false, note: `the file was written but git could not commit it in ${productFolder}: ${stderr.split('\n')[0] || (error as Error).message}` };
  }
}
