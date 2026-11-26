/**
 * The fill role of one store as a process of its own (madarch-8bdc.12), for the case that a signalled role stops its
 * store before it waits for the file-read sessions: the sessions never close here, so only the ending path's own budget
 * can end this process.
 *
 * Usage: bun fill-role-signal-child.ts <knowledge root> <ready file> <log file>
 *
 * The store is prepared here and the ready file is written from the role's second pass, so the case knows the role holds
 * the store's own server, and that no earlier pass asked it to stop, before it signals the role.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createDatabaseOwner } from '../../src/adapters/database-owner.js';
import { prepareQueueSchema } from '../../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../../src/graph/contract.js';
import { withAssertionContract } from '../../src/graph/system-contract.js';
import { runFillRole } from '../../src/knowledge/fill-role.js';

const [knowledgeRoot, readyFile, logFile] = process.argv.slice(2);
if (knowledgeRoot === undefined || readyFile === undefined || logFile === undefined) throw new Error('src/knowledge/fill-role.ts:1: this fixture needs its knowledge root, its ready file and its log file (test/fixtures/fill-role-signal-child.ts)');

let passes = 0;
await runFillRole({
  knowledgeRoot,
  log: (line) => appendFileSync(logFile, `${line}\n`),
  // The role is driven by the signal the case sends, never by an idle this fixture asks for. The second pass is the
  // signal that the store stands open: the first one prepared it, opened it and its queue, and answered no job.
  idle: () => {
    passes += 1;
    if (passes === 2) writeFileSync(readyFile, `${String(process.pid)}\n`);
    return false;
  },
  openStore: async (folder) => {
    const owner = await createDatabaseOwner({ store: folder });
    // The queues store preparation installs, the file-texts one the role itself serves included: without them the role's
    // own open is refused, and the store would be closed again before the case could signal it.
    await prepareQueueSchema(owner);
    return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
  },
  closeReadSessions: () => new Promise<void>(() => undefined),
});
