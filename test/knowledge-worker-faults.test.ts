/**
 * What happens when the processes the knowledge wiki leans on end or are asked to end at the wrong moment
 * (madarch-m38l.4, the review's findings): a fill worker that dies in the middle of a unit's tool call, a wiki that
 * shuts down while its store opens, a read worker that dies mid-transaction or whose pipe closes mid-transaction.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct, type FillWorkerHandle } from '../src/knowledge/product.js';
import { RemoteOwner, type ReadWorkerProcess } from '../src/knowledge/remote-owner.js';
import { createPGliteDatabaseOwner, insideCompiledBinary } from '../src/adapters/database-owner.js';
import { runReadWorker } from '../src/knowledge/read-worker.js';
import { encodeWire, decodeWire } from '../src/knowledge/wire.js';
import type { FromWorker, ToWorker } from '../src/knowledge/fill-protocol.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

let root: string | undefined;
afterEach(() => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); root = undefined; });

/** A channel of lines a test writes into and a consumer reads from. */
function channel(): { lines: AsyncIterable<string>; push: (line: string) => void; end: () => void } {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push: (line) => { queue.push(line); wake?.(); },
    end: () => { ended = true; wake?.(); },
    lines: (async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
  };
}

function tinyProduct(): { folder: string; store: string } {
  root = mkdtempSync(join(tmpdir(), 'madarch-faults-'));
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  const env = gitEnv(SAMPLE_IDENTITY);
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repository, env }); };
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'one', '--date', '2026-03-01T10:00:00Z');
  const home = join(root, 'home');
  mkdirSync(home);
  return { folder: makeProduct(home, 'tiny', repository, 'tiny'), store: join(root, 'store') };
}

describe('a fill worker that ends while a unit waits for a tool answer', () => {
  test('the unit\'s call is answered with an error, the unit ends and the job does not hang', async () => {
    const { folder, store } = tinyProduct();
    const toWorker: ToWorker[] = [];
    const out = channel();
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    const worker: FillWorkerHandle = { send: (message) => { toWorker.push(message); }, lines: out.lines, exited, stderr: () => 'it died', kill: () => undefined };
    let answered: unknown = 'not asked';
    const product = new KnowledgeProduct({
      productFolder: folder,
      storeRoot: store,
      env: { HOME: join(root!, 'user'), PATH: join(root!, 'none') },
      workerFactory: () => worker,
      agentFactory: () => ({
        run: async (request) => { answered = await request.tools.call('overview', {}); },
        close: async () => undefined,
      }),
    });
    try {
      // Choose an agent by its file, as the wiki does, so the press carries an agent.
      mkdirSync(join(store, JSON.parse(JSON.stringify((product.product() as { id: string }).id))), { recursive: true });
      writeFileSync(join(store, (product.product() as { id: string }).id, 'writer.json'), '{"agent":"claude-code"}\n');
      const started = await product.startFill();
      expect(started.started).toBe(true);
      const say = (message: FromWorker): void => out.push(JSON.stringify(message));
      // Wait for the start message the server sends once its reader is open.
      for (let tries = 0; tries < 400 && !toWorker.some((message) => message.type === 'start'); tries += 1) await new Promise((rest) => setTimeout(rest, 100));
      expect(toWorker.some((message) => message.type === 'start')).toBe(true);
      say({ type: 'agent-wanted' });
      for (let tries = 0; tries < 100 && !toWorker.some((message) => message.type === 'agent-ready'); tries += 1) await new Promise((rest) => setTimeout(rest, 50));
      say({ type: 'unit', id: 'product:tiny', prompt: 'p', definitions: [] });
      for (let tries = 0; tries < 100 && !toWorker.some((message) => message.type === 'tool'); tries += 1) await new Promise((rest) => setTimeout(rest, 50));
      expect(toWorker.some((message) => message.type === 'tool')).toBe(true);
      // The worker ends without ever answering the call.
      out.end();
      exit(1);
      await Promise.race([product.settled(), new Promise((_, reject) => setTimeout(() => reject(new Error('the job hung on a tool call the dead worker never answered')), 15_000))]);
      expect(answered).toMatchObject({ isError: true, answer: { error: 'worker-gone' } });
      expect(product.fillState().state).toBe('failed');
    } finally {
      await product.close();
    }
  }, 90_000);
});

describe('a wiki that shuts down while its store opens', () => {
  test('starts no fill worker', async () => {
    const { folder, store } = tinyProduct();
    let spawned = 0;
    const product = new KnowledgeProduct({ productFolder: folder, storeRoot: store, workerFactory: () => { spawned += 1; throw new Error('must not start'); } });
    const started = await product.startFill();
    expect(started.started).toBe(true);
    await product.close();
    expect(spawned).toBe(0);
  }, 60_000);
});

describe('a read worker that ends', () => {
  const fakeProcess = (): { process: ReadWorkerProcess; send: (line: string) => void; end: () => void; written: string[] } => {
    const out = channel();
    const written: string[] = [];
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    return { written, send: out.push, end: () => { out.end(); exit(1); }, process: { write: (line) => { written.push(line); }, lines: out.lines, exited, stderr: () => '', kill: () => undefined } };
  };

  test('a transaction waiting for its end, and the close that waits for the transaction, settle when the worker dies', async () => {
    const fake = fakeProcess();
    const owner = new RemoteOwner('/nowhere/read/1', { create: false, factory: () => fake.process });
    fake.send(encodeWire({ type: 'ready' }));
    await owner.ready;
    const transaction = owner.transaction('snapshot', async (tx) => {
      const asked = tx.query('SELECT 1');
      // The worker begins the transaction, answers nothing more and dies.
      await new Promise((rest) => setTimeout(rest, 50));
      fake.end();
      return await asked;
    });
    // The begin request carries the id the answer names.
    for (let tries = 0; tries < 100 && !fake.written.some((line) => decodeWire<{ type: string }>(line).type === 'begin'); tries += 1) await new Promise((rest) => setTimeout(rest, 10));
    const begin = decodeWire<{ id: number }>(fake.written.find((line) => decodeWire<{ type: string }>(line).type === 'begin')!);
    fake.send(encodeWire({ type: 'begun', id: begin.id }));
    await expect(transaction).rejects.toThrow();
    await Promise.race([owner.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('close hung on a transaction the dead worker never ended')), 5_000))]);
  });

  test('the worker whose pipe closes in the middle of a transaction rolls it back and ends', async () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-read-eof-'));
    const input = channel();
    const said: string[] = [];
    const finished = runReadWorker({ lines: input.lines, send: (line) => { said.push(line); } });
    input.push(encodeWire({ type: 'open', path: join(root, 'read', '0'), create: true }));
    for (let tries = 0; tries < 300 && !said.some((line) => decodeWire<{ type: string }>(line).type === 'ready'); tries += 1) await new Promise((rest) => setTimeout(rest, 100));
    expect(said.some((line) => decodeWire<{ type: string }>(line).type === 'ready')).toBe(true);
    input.push(encodeWire({ type: 'begin', id: 1, kind: 'snapshot' }));
    for (let tries = 0; tries < 100 && !said.some((line) => decodeWire<{ type: string }>(line).type === 'begun'); tries += 1) await new Promise((rest) => setTimeout(rest, 50));
    // The server dies: no end is ever sent.
    input.end();
    const code = await Promise.race([finished, new Promise<number>((_, reject) => setTimeout(() => reject(new Error('the read worker kept its database after the server closed the pipe')), 20_000))]);
    expect(code).toBe(0);
  }, 60_000);

  test('an existing store with no tables at all (the folder the home made) is read with the graph and fill tables made on open', async () => {
    root = mkdtempSync(join(tmpdir(), 'madarch-read-nofill-'));
    const path = join(root, 'read', '1');
    mkdirSync(join(root, 'read'), { recursive: true });
    const maker = createPGliteDatabaseOwner({ path, btreeGist: true });
    await maker.ready;
    await maker.close();
    const input = channel();
    const said: string[] = [];
    const finished = runReadWorker({ lines: input.lines, send: (line) => { said.push(line); } });
    input.push(encodeWire({ type: 'open', path, create: false }));
    const has = (type: string): boolean => said.some((line) => decodeWire<{ type: string }>(line).type === type);
    for (let tries = 0; tries < 300 && !has('ready') && !has('failed'); tries += 1) await new Promise((rest) => setTimeout(rest, 100));
    expect(has('ready')).toBe(true);
    input.push(encodeWire({ type: 'query', id: 7, sql: 'SELECT (SELECT count(*) FROM knowledge_fill) + (SELECT count(*) FROM node_version) AS n' }));
    for (let tries = 0; tries < 100 && !has('rows') && !has('error'); tries += 1) await new Promise((rest) => setTimeout(rest, 50));
    expect(said.map((line) => decodeWire<{ type: string }>(line).type)).not.toContain('error');
    expect(has('rows')).toBe(true);
    input.end();
    await finished;
  }, 60_000);

  test('the compiled-binary check knows the Windows bundle path as well as the Linux one', () => {
    expect(insideCompiledBinary('file:///$bunfs/root/madarch-linux-x64')).toBe(true);
    expect(insideCompiledBinary('file:///B:/~BUN/root/madarch-windows-x64.exe')).toBe(true);
    expect(insideCompiledBinary('file:///B:/%7EBUN/root/madarch-windows-x64.exe')).toBe(true);
    expect(insideCompiledBinary('B:\\~BUN\\root\\madarch-windows-x64.exe')).toBe(true);
    expect(insideCompiledBinary('file:///work/madarch/src/adapters/database-owner.ts')).toBe(false);
  });
});
