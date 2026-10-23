/**
 * The basis of a written page (madarch-m38l.8): the repository's commit, its
 * branch and its origin at the time the writer read it, recorded in the page's
 * front matter as `written-at`. Read from git; a page never claims a branch
 * or an origin the repository did not have. Credentials in an origin URL are
 * dropped before it reaches a file that is committed.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WrittenAt } from '../knowledge/index/page.js';

const run = promisify(execFile);

/** An origin URL without the user and password of its authority. */
export function withoutCredentials(origin: string): string {
  return origin.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

async function git(repository: string, args: string[]): Promise<string | undefined> {
  try {
    return (await run('git', args, { cwd: repository, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
  } catch {
    return undefined;
  }
}

/** Where the writer read `repository` at `ref`: the full commit id, the checked-out branch when there is one, the `origin` remote when there is one. */
export async function writtenAtOf(repository: string, ref: string, name = path.basename(repository)): Promise<WrittenAt> {
  const commit = await git(repository, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (commit === undefined || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`src/writer/basis.ts: ${repository} has no commit ${ref}: the page cannot record what it was written from`);
  const branch = await git(repository, ['branch', '--show-current']);
  const origin = await git(repository, ['remote', 'get-url', 'origin']);
  return { repository: name, commit, ...(branch === undefined || branch === '' ? {} : { branch }), ...(origin === undefined || origin === '' ? {} : { origin: withoutCredentials(origin) }) };
}
