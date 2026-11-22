import { publishValidatedManifests, validateProductManifests, readPublishedManifest } from '../src/graph/manifest-publication.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { expect, spyOn, test } from 'bun:test';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { createRun } from '../src/graph/fill-state.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { setManifestPublicationState } from '../src/product/manifest-publication-state.js';
import { prepareTestProduct } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { commitProduct, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';

test('pending and failed publication read persisted runs without opening the catalogue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-status-run-'));
  const home = join(root, 'products');
  const storeRoot = join(root, 'store');
  let release: (() => Promise<void>) | undefined;
  let reader: KnowledgeProduct | undefined;
  let owner: Awaited<ReturnType<typeof createDatabaseOwner>> | undefined;
  try {
    const draft = createDraft({ home, name: 'status-run', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const store = productStoreFolder(draft.folder, storeRoot);
    mkdirSync(storeDatabasePath(store), { recursive: true });
    setManifestPublicationState(draft.folder, { status: 'pending' });
    reader = new KnowledgeProduct({ productFolder: draft.folder, storeRoot });
    expect(await reader.status()).toMatchObject({ publication: 'pending', fill: { state: 'idle' } });
    expect((await reader.status()).fill.run).toBeUndefined();
    owner = await createDatabaseOwner({ store: storeDatabasePath(store) });
    expect((await reader.status()).fill.run).toBeUndefined();
    await owner.close();
    owner = undefined;
    mkdirSync(join(draft.folder, 'madarch'), { recursive: true });
    writeFolderManifest(draft.folder, `kinds:
  note:
    source: graph
    key: [name]
    fields:
      - { name: name, type: text, producers: [person] }
`);
    commitProduct(draft.folder, 'Declare the status fixture catalogue');
    const validated = validateProductManifests(draft.folder);
    if (!validated.ok) throw new Error(validated.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
    if (validated.value === undefined) throw new Error(`${draft.folder}/madarch/catalog.yaml:1: the fixture catalogue is absent`);
    release = await prepareTestProduct(draft.folder, home, storeRoot);
    owner = await createDatabaseOwner({ store: storeDatabasePath(store), connectOnly: true });
    await publishValidatedManifests(owner, validated.value);
    const manifest = await owner.run(tx => readPublishedManifest(tx));
    if (manifest === undefined) throw new Error('prepared fixture manifest missing');
    const database = { transaction: owner.transaction.bind(owner), graphContract: withAssertionContract(withManifestContract(graphContractOf(manifest))) };
    await createRun(database, { runId: 'saved-run', product: 'status-run', at: 100 });
    mkdirSync(join(store, 'traces'), { recursive: true });
    writeFileSync(join(store, 'traces', 'orphan.jsonl'), '{}\n');
    setManifestPublicationState(draft.folder, { status: 'pending' });
    const open = spyOn(reader as unknown as { open(): Promise<never> }, 'open');
    expect(await reader.status()).toMatchObject({ publication: 'pending', fill: { run: { runId: 'saved-run', state: 'created', spans: 0 } } });
    const span = (id: string) => JSON.stringify({ traceId: 'trace', spanId: id, name: 'fill.unit', startTimeUnixNano: 1_000_000, endTimeUnixNano: 2_000_000 });
    const trace = join(store, 'traces', 'saved-run.jsonl');
    writeFileSync(trace, `${span('first')}\n`);
    expect((await reader.status()).fill.run?.spans).toBe(1);
    appendFileSync(trace, `${span('second')}\n`);
    expect((await reader.status()).fill.run?.spans).toBe(2);
    writeFileSync(`${trace}.replacement`, `${span('replacement')}\n`);
    renameSync(`${trace}.replacement`, trace);
    expect((await reader.status()).fill.run?.spans).toBe(1);
    setManifestPublicationState(draft.folder, { status: 'failed', message: 'kinds.yaml:7: rejected' });
    expect(await reader.status()).toMatchObject({ publication: 'failed', publicationMessage: 'kinds.yaml:7: rejected', fill: { run: { runId: 'saved-run' } } });
    await createRun(database, { runId: 'new-run', product: 'status-run', at: 200 });
    expect((await reader.status()).fill.run).toMatchObject({ runId: 'new-run', spans: 0 });
    expect(await reader.runView('saved-run')).toMatchObject({ runId: 'saved-run', spans: 1 });
    expect(await reader.runView('orphan')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    setManifestPublicationState(draft.folder, { status: 'published' });
    expect(await reader.status()).toMatchObject({ publication: 'done', fill: { run: { runId: 'new-run', spans: 0 } } });
    setManifestPublicationState(draft.folder, { status: 'pending' });
    await owner.run(async (tx) => { await tx.query('DROP TABLE assertion CASCADE'); });
    await expect(reader.status()).rejects.toThrow('assertion');
  } finally {
    await reader?.close();
    await owner?.close();
    await release?.();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
