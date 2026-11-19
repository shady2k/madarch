import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { closureOf } from '../src/plugin/closure.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { declareFileTextQueue, readFileTextByBlob } from '../src/knowledge/file-texts.js';
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

test.each([false, true])('a store without file-texts is reported once and releases its owner before the next pass (close rejects: %s)', async (closeRejects) => {
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
      idle: () => {
        expect(closes).toBe(opened.length);
        closedByPass.push(closes);
        return passes++ === 3;
      },
      openStore: async (folder) => {
        const owner = await createDatabaseOwner({ store: folder, connectOnly: true });
        const close = owner.close.bind(owner);
        owner.close = async () => {
          closes++;
          await close();
          if (closeRejects) throw new Error('fixture close failed');
        };
        opened.push(owner);
        return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
      },
    })).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`the store ${join(root, 'product')} could not be opened`);
    expect(messages[0]).toContain('the queue "file-texts" is not prepared');
    expect(opened).toHaveLength(3);
    expect(closedByPass).toEqual([0, 1, 2, 3]);
    expect(closes).toBe(opened.length);
  } finally {
    for (const owner of opened) await owner.close().catch(() => undefined);
    await preparation.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);


test('a store prepared after its first refusal is reopened and answers a file read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-fill-prepared-later-'));
  const knowledgeRoot = join(root, 'knowledge');
  const store = join(knowledgeRoot, 'product', 'graph');
  const product = join(root, 'product');
  mkdirSync(store, { recursive: true });
  mkdirSync(join(product, 'madarch'), { recursive: true });
  writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: sample\nname: sample\n');
  const plugin = join(product, 'plugins', 'git');
  cpSync(join(import.meta.dir, '..', 'plugins', 'git'), plugin, { recursive: true });
  writeFileSync(join(product, 'madarch', 'plugins.lock'), `plugins:\n  - id: git\n    version: 1.0.0\n    closure: ${closureOf(plugin).hash}\n    path: plugins/git\n`);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: product, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(product, 'a.ts'), 'export const answer = 42;\n');
  git('add', '-A');
  git('commit', '-qm', 'a file to read');
  const blob = git('rev-parse', 'HEAD:a.ts');
  const preparation = await createDatabaseOwner({ store });
  let stopped = false;
  let opens = 0;
  let closes = 0;
  let role: Promise<number> | undefined;
  let queue: Awaited<ReturnType<typeof createPgBossQueue>> | undefined;
  const messages: string[] = [];
  const refused = Promise.withResolvers<void>();
  try {
    await prepareQueueSchema(preparation, { declarations: [
      { name: 'fill-runs', leaseSeconds: 900, retries: 1, retryDelaySeconds: 5, retryBackoff: false, singletons: true },
    ] });
    role = runFillRole({
      knowledgeRoot,
      log: (line) => { messages.push(line); refused.resolve(); },
      idle: () => stopped,
      openStore: async (folder) => {
        const owner = await createDatabaseOwner({ store: folder, connectOnly: true });
        opens++;
        const close = owner.close.bind(owner);
        owner.close = async () => { closes++; await close(); };
        return Object.assign(owner, { graphContract: withAssertionContract(EMPTY_CONTRACT) });
      },
    });
    await refused.promise;
    expect(closes).toBe(opens);
    await prepareQueueSchema(preparation);
    queue = await createPgBossQueue({ owner: preparation, supervise: false });
    await declareFileTextQueue(queue);
    const answer = await readFileTextByBlob(queue, { product, repository: 'sample', root: product, blob, from: 1, fromColumn: null, to: null });
    expect(answer.text).toBe('export const answer = 42;\n');
    expect(answer.complete).toBe(true);
    expect(opens).toBeGreaterThanOrEqual(2);
    expect(messages).toHaveLength(1);
    stopped = true;
    expect(await role).toBe(0);
    expect(closes).toBe(opens);
  } finally {
    stopped = true;
    await role;
    await queue?.stop();
    await preparation.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
