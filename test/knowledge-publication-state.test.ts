import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { setManifestPublicationState, waitForManifestPublication } from '../src/product/manifest-publication-state.js';
import { gitEnv } from './git-env.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const products: KnowledgeProduct[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const product of products.splice(0)) await product.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'madarch-publication-'));
  folders.push(work);
  const draft = createDraft({ home: join(work, 'home'), name: 'publication-shop', gitEnv: gitEnv(IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(`the product was not made: ${JSON.stringify(draft)}`);
  setManifestPublicationState(draft.folder, { status: 'pending' });
  // These presses select a fixture adapter: admission sees the agent the default manifest requires, but the queue spy
  // keeps publication tests from starting it. A launch would leave evidence and fail the assertion below.
  const launched = join(work, 'agent-launched');
  const adapter = join(work, 'claude-agent-acp');
  writeFileSync(adapter, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(launched)}, 'unexpected launch');
process.exit(1);
`);
  chmodSync(adapter, 0o700);
  const product = new KnowledgeProduct({ productFolder: draft.folder, storeRoot: join(work, 'store'), fillQueued: true, env: { HOME: join(work, 'home'), PATH: work } });
  products.push(product);
  const internals = product as unknown as { open(): Promise<never>; runQueuedFill(): Promise<void> };
  const open = spyOn(internals, 'open').mockImplementation(async () => { throw new Error('unexpected store open'); });
  const queued = spyOn(internals, 'runQueuedFill').mockResolvedValue(undefined);
  return { folder: draft.folder, product, open, queued, launched };
}

test('pending and failed status retain the full unfilled shape without opening the store', async () => {
  const { folder, product, open } = fixture();
  const status = await product.status();
  expect(status).toMatchObject({ publication: 'pending', manifest: 'not-filled', fill: { state: 'idle' }, filled: false, incomplete: false, kinds: [], groups: [], repositories: [], home: null, roles: {} });
  expect(status.product.id).toBeString();
  expect(status.bounds).toBeDefined();
  expect(status.writer).toBeDefined();
  expect(status.loop).toBeDefined();
  unlinkSync(join(folder, 'madarch/kinds.yaml'));
  expect(await product.status()).toMatchObject({ publication: 'pending', manifest: 'no-manifest' });
  setManifestPublicationState(folder, { status: 'failed', message: 'bad schema' });
  expect(await product.status()).toMatchObject({ publication: 'failed', publicationMessage: 'bad schema', fill: { state: 'idle' } });
  expect(await product.startFill()).toMatchObject({ started: false, message: expect.stringContaining('bad schema') });
  expect(open).not.toHaveBeenCalled();
});

test('pending publication does not bypass the declared plugin agent requirement', async () => {
  const { product, open, queued } = fixture();
  expect(await product.startFill()).toMatchObject({ started: false, message: expect.stringContaining('requested an agent but none is selected') });
  expect(open).not.toHaveBeenCalled();
  expect(queued).not.toHaveBeenCalled();
});

test('one accepted fill waits for publication and dispatches through the existing queue once', async () => {
  const { folder, product, open, queued, launched } = fixture();
  expect(await product.startFill({ agent: 'claude-code' })).toMatchObject({ started: true, fill: { state: 'running' } });
  expect(await product.startFill()).toMatchObject({ started: false, message: 'a fill of this product is already running' });
  expect(open).not.toHaveBeenCalled();
  expect(queued).not.toHaveBeenCalled();
  setManifestPublicationState(folder, { status: 'published' });
  await product.settled();
  expect(queued).toHaveBeenCalledTimes(1);
  expect(existsSync(launched)).toBe(false);
});

test('publication failure ends the waiting fill with diagnostics and never queues it', async () => {
  const { folder, product, open, queued } = fixture();
  expect(await product.startFill({ agent: 'claude-code' })).toMatchObject({ started: true });
  setManifestPublicationState(folder, { status: 'failed', message: 'schema rejected' });
  await product.settled();
  expect(await product.status()).toMatchObject({ publication: 'failed', publicationMessage: 'schema rejected', fill: { state: 'failed', code: 'store', message: expect.stringContaining('schema rejected') } });
  expect(open).not.toHaveBeenCalled();
  expect(queued).not.toHaveBeenCalled();
});

test('close cancels a waiting fill without waiting for daemon publication', async () => {
  const { product, queued } = fixture();
  expect(await product.startFill({ agent: 'claude-code' })).toMatchObject({ started: true });
  await product.close();
  await product.settled();
  expect(queued).not.toHaveBeenCalled();
});

test('publication wait settles on state transitions and supports cancellation', async () => {
  const folder = '/publication-promise-only';
  setManifestPublicationState(folder, { status: 'pending' });
  const abort = new AbortController();
  const waiting = waitForManifestPublication(folder);
  const cancelled = waitForManifestPublication(folder, abort.signal);
  abort.abort();
  await expect(cancelled).rejects.toThrow('shutting down');
  setManifestPublicationState(folder, { status: 'published' });
  expect(await waiting).toEqual({ status: 'published' });
  expect(await waitForManifestPublication(folder)).toEqual({ status: 'published' });
});
