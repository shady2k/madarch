/**
 * Who the user is (decision 0031): the local implementation answers with git's
 * name and email of the product repository, marks the identity "local, not
 * verified", says whether a signing key is configured, and refuses with the
 * folder and the command that fixes it when git does not know the user.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOCAL_MARK, authorOf, identityTrailer, localGitIdentity, whoIsTheUser, type IdentityProvider } from '../src/identity/identity.js';
import { gitEnv } from './git-env.js';

/** git's configuration sources sealed off: no system or global user is the fixture's. */
const SEALED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let folder: string | undefined;
afterEach(() => { if (folder !== undefined) rmSync(folder, { recursive: true, force: true }); folder = undefined; });

function repository(config: Record<string, string>): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-identity-'));
  const run = (args: string[]): void => { const done = spawnSync('git', args, { cwd: folder, env: gitEnv(), encoding: 'utf8' }); if (done.status !== 0) throw new Error(done.stderr); };
  run(['init', '--quiet', '--initial-branch=main']);
  for (const [key, value] of Object.entries(config)) run(['config', key, value]);
  return folder;
}

describe('the local identity', () => {
  
  test('notes that the user\'s own signing key is configured, by a key or by signing every commit', () => {
    const keyed = localGitIdentity(repository({ 'user.name': 'A', 'user.email': 'a@example.test', 'user.signingkey': 'ABCDEF' }));
    expect(keyed.ok && keyed.identity.signing).toBe(true);
    rmSync(folder!, { recursive: true, force: true });
    const signing = localGitIdentity(repository({ 'user.name': 'A', 'user.email': 'a@example.test', 'commit.gpgsign': 'true' }));
    expect(signing.ok && signing.identity.signing).toBe(true);
  });

  test('a missing name or email is a refusal naming the product folder and the command that sets it', () => {
    // git is asked in a sealed environment: a machine's own system or global config names a user this fixture did not.
    const noName = localGitIdentity(repository({ 'user.email': 'a@example.test' }), SEALED);
    expect(noName.ok).toBe(false);
    if (!noName.ok) {
      expect(noName.message).toContain(folder!);
      expect(noName.message).toContain('git config --global user.name');
    }
    rmSync(folder!, { recursive: true, force: true });
    const noEmail = localGitIdentity(repository({ 'user.name': 'A' }), SEALED);
    expect(noEmail.ok).toBe(false);
    if (!noEmail.ok) {
      expect(noEmail.message).toContain(folder!);
      expect(noEmail.message).toContain('git config --global user.email');
    }
  });

  
  test('git\'s author variables come before the configuration, and a missing email is told even when the name is given', () => {
    const answer = localGitIdentity(repository({ 'user.name': 'Config', 'user.email': 'config@example.test' }), { GIT_AUTHOR_NAME: 'Env Name', GIT_AUTHOR_EMAIL: 'env@example.test' });
    expect(answer.ok && [answer.identity.name, answer.identity.email]).toEqual(['Env Name', 'env@example.test']);
    rmSync(folder!, { recursive: true, force: true });
    const noEmail = localGitIdentity(repository({ 'user.name': 'A' }), { ...SEALED, GIT_AUTHOR_NAME: 'Env Name' });
    expect(noEmail.ok).toBe(false);
  });

  test('whoIsTheUser asks the provider it is given, so a server\'s verified identity plugs in behind the same question', () => {
    const verified: IdentityProvider = () => ({ ok: true, identity: { name: 'Server User', email: 'u@example.test', verification: 'local-git', mark: 'from the test provider', signing: true } });
    const answer = whoIsTheUser('/anywhere', verified);
    expect(answer.ok && answer.identity.mark).toBe('from the test provider');
  });
});
