/**
 * Who the user is (decision 0031): the one place every write of the wiki asks.
 *
 * Without a team server the answer is git's: `user.name` and `user.email` of the
 * product repository, with a note on whether the user's own signing key is
 * configured. Nothing here proves who the person is, because git's author is
 * whatever the person set, so every identity this module answers carries the
 * mark "local, not verified" and says how it was verified (`local-git`: not at
 * all). A team server's implementation (OpenID Connect sign-in, the author from
 * the verified claims, the server as committer) plugs in behind the same
 * `IdentityProvider`; it is designed in decision 0031 and not built.
 */
import { runGit } from '../product/git.js';

/** How an identity was verified. `local-git` is git's own configuration, which proves nothing. */
type Verification = 'local-git';

/** The mark every local identity is written with. */
export const LOCAL_MARK = 'local, not verified';

interface Identity {
  name: string;
  email: string;
  verification: Verification;
  /** The words shown beside a write: "local, not verified" for a local identity. */
  mark: string;
  /** Whether the user's own signing key is configured, so git will sign the commit. */
  signing: boolean;
}

export type IdentityResult = { ok: true; identity: Identity } | { ok: false; message: string };

/** Answers who the user is for a write into the product repository at `folder`. */
export type IdentityProvider = (folder: string, env?: Readonly<Record<string, string | undefined>>) => IdentityResult;

/** The local implementation: git's `user.name` and `user.email` as the product repository sees them. */
/** The refusal when git does not know the user: what is missing, where, and the commands that fix it. */
const missing = (folder: string, key: 'user.name' | 'user.email'): string =>
  `git has no ${key} for ${folder}, so the wiki cannot say who wrote this: run  git config --global user.name "Your Name"  and  git config --global user.email "you@example.com"  (or the same without --global inside ${folder}), then try again`;

export const localGitIdentity: IdentityProvider = (folder, environment = process.env) => {
  // git is asked in the environment the caller named; a variable the caller leaves out (`undefined`) is left out of git's.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) env[key] = value;
  // git's own order: the author variables, then the configuration.
  const named = (env['GIT_AUTHOR_NAME'] ?? '').trim();
  const mailed = (env['GIT_AUTHOR_EMAIL'] ?? '').trim();
  // git is asked in the environment the caller named: a test seals the machine's own config there, and a server asks
  // with the environment its process was given.
  const name = named !== '' ? { ok: true, output: named } : runGit(folder, ['config', '--get', 'user.name'], env);
  if (!name.ok || name.output.trim() === '') {
    return { ok: false, message: missing(folder, 'user.name') };
  }
  const email = mailed !== '' ? { ok: true, output: mailed } : runGit(folder, ['config', '--get', 'user.email'], env);
  if (!email.ok || email.output.trim() === '') {
    return { ok: false, message: missing(folder, 'user.email') };
  }
  const key = runGit(folder, ['config', '--get', 'user.signingkey'], env);
  const sign = runGit(folder, ['config', '--type=bool', '--get', 'commit.gpgsign'], env);
  return {
    ok: true,
    identity: {
      name: name.output.trim(),
      email: email.output.trim(),
      verification: 'local-git',
      mark: LOCAL_MARK,
      signing: (key.ok && key.output.trim() !== '') || (sign.ok && sign.output.trim() === 'true'),
    },
  };
};

/** The one question every write asks. A provider other than the local one is passed by the server that has one. */
export function whoIsTheUser(folder: string, provider: IdentityProvider = localGitIdentity, env?: Readonly<Record<string, string | undefined>>): IdentityResult {
  return provider(folder, env);
}
