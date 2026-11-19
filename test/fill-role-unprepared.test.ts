import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { declareFileTextQueue } from '../src/knowledge/file-texts.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { runFillRole } from '../src/knowledge/fill-role.js';

test('default store preparation installs the file-text queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-file-text-queue-'));
  const owner = await createDatabaseOwner({ store: join(root, 'graph') });
  try {
    await prepareQueueSchema(owner);
    const queue = await createPgBossQueue({ owner, supervise: false });
    try { await declareFileTextQueue(queue); } finally { await queue.stop(); }
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('a store without file-texts is reported once and releases its owner before the next pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-unprepared-'));
  const store = join(root, 'product', 'graph');
  mkdirSync(store, { recursive: true });
  const preparation = await createDatabaseOwner({ store });
  const opened: { close(): Promise<void> }[] = [];
  try {
    await prepareQueueSchema(preparation, { declarations: [
      { name: 'fill-runs', leaseSeconds: 900, retries: 1, retryDelaySeconds: 5, retryBackoff: false, singletons: true },
    ] });
    const messages: string[] = [];
    let passes = 0;
    let closes = 0;
    const closedByPass: number[] = [];
    expect(await runFillRole({
      knowledgeRoot: root,
      log: (line) => messages.push(line),
      idle: () => { closedByPass.push(closes); return passes++ === 3; },
      openStore: async (folder) => {
        const owner = await createDatabaseOwner({ store: folder, connectOnly: true });
        const close = owner.close.bind(owner);
        owner.close = async () => { closes++; await close(); };
        opened.push(owner);
        return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
      },
    })).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`the store ${join(root, 'product')} could not be opened`);
    expect(messages[0]).toContain('the queue "file-texts" is not prepared');
    expect(opened).toHaveLength(1);
    expect(closedByPass).toEqual([0, 1, 1, 1]);
    expect(closes).toBe(1);
  } finally {
    for (const owner of opened) await owner.close();
    await preparation.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
