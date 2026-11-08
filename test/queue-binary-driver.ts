/**
 * The compiled binary's driver for the queue (madarch-tzte.19.2): one small
 * program, built with `bun build --compile`, that enqueues, claims, fails and
 * retries a job in its first phase and claims, completes and reads the queue
 * again in its second — a second process on the same store, which
 * is what "survives a restart" means for a queue.
 *
 * `test/queue-binary.test.ts` builds it and runs both phases; it is not a test
 * file itself, and it asserts nothing: it prints one JSON object per phase and
 * exits 0, or 1 with the failure on standard error, and the test holds the
 * values it expects. The driver needs its own
 * `initdb.wasm` beside the executable, which is what the build's `--asset`
 * arguments carry (scripts/build-binary.ts stages the same three for the
 * release binary).
 *
 *   queue-binary <store folder> first|second
 */
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { createTestDatabaseOwner } from './test-database.js';

const [folder, phase] = process.argv.slice(2);
if (folder === undefined || (phase !== 'first' && phase !== 'second')) {
  console.error('usage: queue-binary <store folder> first|second');
  process.exit(2);
}

const QUEUE = 'binary-units';
const DEAD = 'binary-units-dead';
const owner = await createTestDatabaseOwner({ store: folder });
const queue = await createPgBossQueue({ owner, schema: 'binary_queue', supervise: false });
try {
  await queue.declare({ name: DEAD, leaseSeconds: 60, retries: 0, retryDelaySeconds: 0, retryBackoff: false });
  await queue.declare({ name: QUEUE, leaseSeconds: 60, retries: 2, retryDelaySeconds: 1, retryBackoff: false, deadLetter: DEAD });

  if (phase === 'first') {
    const created = await queue.enqueue({ queue: QUEUE, data: { unit: 'binary' }, priority: 4 });
    const claimed = (await queue.claim<{ unit: string }>({ queue: QUEUE }))[0]!;
    const outcome = await queue.fail(QUEUE, claimed, 'the first attempt failed in the binary');
    const rightAway = (await queue.claim({ queue: QUEUE })).length;
    process.stdout.write(`${JSON.stringify({ phase, created: created.created, attempt: claimed.attempt, leaseSeconds: claimed.leaseSeconds, outcome, claimableRightAway: rightAway })}\n`);
  } else {
    // The failed attempt waits one second before it may be claimed again.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const claimed = (await queue.claim<{ unit: string }>({ queue: QUEUE }))[0]!;
    const settled = await queue.complete(QUEUE, claimed);
    const afterComplete = (await queue.claim({ queue: QUEUE })).length;
    const deadLetters = await queue.deadLetters(QUEUE);
    process.stdout.write(`${JSON.stringify({ phase, attempt: claimed.attempt, data: claimed.data, settled, afterComplete, deadLetters: deadLetters.length })}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  process.exitCode = 1;
} finally {
  await queue.stop();
  await owner.close();
}
