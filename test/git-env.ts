/**
 * The environment a fixture's git call runs in: the machine's PATH, the
 * caller's overrides, and git's configuration sources sealed off — no user
 * or system config file, and no inherited `GIT_DIR` or `GIT_INDEX_FILE`
 * reaching the call — so a fixture's commits and hashes never depend on
 * the machine's git config or on the environment the test was started
 * from. Everything else is dropped: a whitelisted environment cannot
 * leak a hostile variable through.
 */
export function gitEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    ...overrides,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
