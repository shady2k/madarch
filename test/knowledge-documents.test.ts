import { writeFolderManifest } from './catalog-folder-fixture.js';
/**
 * The document listing reads the graph's documents, never the first files of a repository (madarch-hsqs stage B
 * review): a repository of more files than the listing's bound still answers every document, and a truncation names
 * the total it cut. The fixture puts one file more than the bound before every document in code point order.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { withStorePreparationOwner, requestStorePreparation } from '../src/product/store-preparation.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
const DOCUMENT_LIMIT = 2000;
import { gitEnv } from './git-env.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { publishGraphDrafts } from '../src/graph/write.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
/** The documents the fixture writes: the bound, and ten whose paths sort after it. */
const DOCUMENTS = DOCUMENT_LIMIT + 10;
/** A path inside the fixture's document folder, zero-padded so code point order is the order written. */
const documentPath = (at: number): string => `z/d${String(at).padStart(4, '0')}.md`;

let work: string;
let folder: string;
let product: KnowledgeProduct;

describe('the documents of a repository larger than the listing bound', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-documents-'));
    const draft = createDraft({ home: join(work, 'home'), name: 'bulk-shop', gitEnv: gitEnv(IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
    folder = draft.folder;
    writeFolderManifest(folder, `kinds:
  document:
    template: templates/document.liquid
    source: graph
    origin: person
    key: [title]
    fields:
      - { name: title, type: text, producers: [fixture] }
      - { name: path, type: text, producers: [fixture] }
      - { name: markdown, type: text, producers: [fixture] }
      - { name: anchors, type: json, producers: [fixture] }
      - { name: links, type: json, producers: [fixture] }
`);
    writeFileSync(join(folder, 'templates', 'document.liquid'), '{{ title }}');
    // One file more than the bound, all of them sorting before every document: a listing that reads the first files
    // of the repository answers none of the documents.
    const fillers = join(folder, 'a');
    mkdirSync(fillers, { recursive: true });
    for (let at = 0; at <= DOCUMENT_LIMIT; at += 1) writeFileSync(join(fillers, `f${String(at).padStart(4, '0')}.txt`), 'filler\n');
    const documents = join(folder, 'z');
    mkdirSync(documents, { recursive: true });
    for (let at = 0; at < DOCUMENTS; at += 1) writeFileSync(join(folder, 'z', `d${String(at).padStart(4, '0')}.md`), `# Document ${at}\n`);
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: folder, env: gitEnv(IDENTITY) }); };
    git('add', '-A');
    git('commit', '--quiet', '-m', `Add ${DOCUMENT_LIMIT + 1} files and ${DOCUMENTS} documents`);
    product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
    await withStorePreparationOwner(async () => {
      await requestStorePreparation(storeDatabasePath(productStoreFolder(folder, join(work, 'store'))), await readPinnedGraphContract(folder));
      const started = await product.startFill();
      expect(started).toMatchObject({ started: true });
      await product.settled();
    });
    expect(product.fillState()).toMatchObject({ state: 'done' });
    // This manifest declares no automatic producer. Its empty fill succeeds; authored documents are explicit structured opinions.
    const read = readKinds(folder);
    if (!read.present) throw new Error(`${folder}/madarch/catalog.yaml:1: fixture manifest missing`);
    const manifest = read.manifest;
    const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, join(work, 'store'))), connectOnly: true });
    try {
      await owner.transaction('write', async (tx) => {
        await publishGraphDrafts(tx, graphContractOf(manifest), {
          vertices: Array.from({ length: DOCUMENTS }, (_, at) => ({
            kind: 'document', key: { title: `Document ${at}` },
            values: { path: documentPath(at), markdown: `# Document ${at}\n`, anchors: {}, links: [] },
            producer: 'fixture', producerVersion: '1',
          })), edges: [], removals: [],
        }, 1, { author: 'fixture' });
      });
    } finally { await owner.close(); }
  }, 900_000);

  afterAll(async () => {
    await product?.close();
    rmSync(work, { recursive: true, force: true });
  });

  test('every document is listed up to the bound, and the truncation names the total, never a silently smaller list', async () => {
    const listing = await product.documents();
    const own = listing.documents.filter((document) => document.repo === null);
    const expected = Array.from({ length: DOCUMENT_LIMIT }, (_, at) => documentPath(at));
    expect(own.map((document) => document.path)).toEqual(expected);
    expect(own[0]?.title).toBe('Document 0');
    expect(own[own.length - 1]?.title).toBe(`Document ${DOCUMENT_LIMIT - 1}`);
    expect(listing.truncated).toEqual([{ repo: null, total: DOCUMENTS, shown: DOCUMENT_LIMIT }]);
  }, 120_000);
});
