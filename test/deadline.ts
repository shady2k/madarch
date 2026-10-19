/**
 * The default deadline of every test (madarch-tzte.36): ten seconds instead of
 * Bun's five for a test that names no bound of its own.
 *
 * It is set here, in a preload both `bunfig.toml` files declare, because Bun
 * 1.4.2 does not apply `[test] timeout` from `bunfig.toml`: with that key set, a
 * test that sleeps 7 s still fails at 5 003 ms, while `setDefaultTimeout` from a
 * preload makes the same test pass and stops a 12 s one at 10 001 ms. Measured
 * on 1.4.2 on the SkyPilot pod, 2026-10-19, the same throwaway case file each
 * way. `bun test --timeout=10000` has the same effect but reaches only the run
 * that passes the flag; a preload reaches every run started in the folder,
 * CI's shards included.
 *
 * A test that names its own bound keeps it: a 12 s test written
 * `test(name, fn, 20_000)` passes under this default.
 *
 * The bound is there because several tests take 5.0-6.0 s on GitHub's runners
 * and each one that times out costs a shard rerun. The proper fix is the tests'
 * own speed (madarch-cznn), not this bound: it comes back down with that work.
 */
import { setDefaultTimeout } from 'bun:test';

setDefaultTimeout(10_000);
