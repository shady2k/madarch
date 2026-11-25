/**
 * The default deadline of every test (madarch-tzte.36, madarch-x9a7.5): a
 * sixty-second hang guard instead of Bun's five for a test that names no bound
 * of its own.
 *
 * It is set here, in a preload both `bunfig.toml` files declare, because Bun
 * 1.4.2 does not apply `[test] timeout` from `bunfig.toml`: with that key set, a
 * test that sleeps 7 s still fails at 5 003 ms, while `setDefaultTimeout` from a
 * preload makes the same test pass. `bun test --timeout=<ms>` has the same
 * effect; `scripts/run-tests.ts` passes `--timeout=60000` when the caller names
 * no timeout of its own, so a run started through it is covered whichever file
 * the preload reaches, and the preload covers runs started in the folder
 * directly.
 *
 * The bound is a hang guard, not a licence for a slow test: it is at least three
 * times the worst single case measured on the box (11.2 s), and it exists so a
 * machine slower than GitHub's runners does not stop a healthy case at five
 * seconds. The rule that a single file runs in at most 30 seconds
 * (`test/slow-files.json`, `SLOW_THRESHOLD_SECONDS` in `scripts/run-tests.ts`)
 * and the suite budget (madarch-x9a7) are unchanged, and a case whose work is
 * long still names its own bound in the test.
 *
 * A test that names its own bound keeps it, longer or shorter. Measured
 * 2026-10-20 (madarch-cznn), a preload's default did not reach every file of a
 * run that held several — a throwaway case that sleeps 6 s passed alone and was
 * stopped at 5 000 ms beside a second test file — which is why the runner passes
 * the flag as well. The cause of a slow case is usually the databases it opens:
 * since 2026-11-07 a run holds one PostgreSQL server, and a case opens a
 * database on it (`test/test-database.ts`).
 */
import { setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60_000);
