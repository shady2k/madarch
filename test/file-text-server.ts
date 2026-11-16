/** Answers a store's file reads the way the fill role does (madarch-u3vw.16): a test that serves only the api role runs
 *  this loop, so a page's blob read is answered from git's object store and the working copy is never read. */
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { QueueService } from '../src/fill/queue.js';
import { openFillRunQueue } from '../src/fill/run-jobs.js';
import { declareFileTextQueue, serveFileTexts } from '../src/knowledge/file-texts.js';

/** Serves file reads until stopped: one claim a pass, and a quiet gap between passes. */
export async function startFileTextServer(owner: DatabaseOwner): Promise<{ stop(): Promise<void>; served: () => number }> {
  const queue: QueueService = await openFillRunQueue(owner);
  await declareFileTextQueue(queue);
  let running = true;
  let served = 0;
  const loop = (async () => {
    while (running) {
      try {
        served += await serveFileTexts(queue, { env: process.env });
      } catch {
        // A claim that fails is the next pass's to take: the store may be closing under the loop.
      }
      if (running) await Bun.sleep(20);
    }
  })();
  return {
    stop: async () => { running = false; await loop; },
    served: () => served,
  };
}
