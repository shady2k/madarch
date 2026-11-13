/**
 * `GET /graphql/schema` (decision 0036): one product's GraphQL schema, derived from its published manifest and
 * served as SDL, so the frontend and outside systems read the contract the server holds. It answers from the
 * manifest alone, before any store is opened.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { buildSchema } from 'graphql';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf } from '../src/product/store.js';
import type { StartedServer } from '../src/server/http.js';
import { prepareTestProduct, startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

let root = '';
let product = '';
let server: StartedServer | undefined;
let closeOwner: (() => Promise<void>) | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-graphql-route-'));
  const home = join(root, 'products');
  const app = join(root, 'app');
  mkdirSync(home, { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  const draft = createDraft({ home, name: 'schema-route', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  product = draft.folder;
  closeOwner = await prepareTestProduct(product, home);
  server = await startPreparedServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await closeOwner?.();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

test('GET /graphql/schema answers the SDL the product manifest derives', async () => {
  const answer = await fetch(`${server!.url}/graphql/schema`);
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type') ?? '').toContain('application/graphql');
  const text = await answer.text();
  expect(() => buildSchema(text)).not.toThrow();
  const read = readKinds(product);
  if (!read.present) throw new Error(`${product}/madarch/catalog.yaml:1: the fixture product holds no manifest`);
  expect(text).toBe(graphqlSchemaOf(publishedManifestOf(read.manifest)));
});

/** One GraphQL operation as the wiki's client sends it. */
async function post(body: unknown): Promise<{ status: number; body: any }> {
  const answer = await fetch(`${server!.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: answer.status, body: await answer.json() };
}

test('POST /graphql answers the product graph through the one executor', async () => {
  const bootstrap = await post({ query: '{ bootstrap { structureRevision home { id } templates { name } } }' });
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.body.errors).toBeUndefined();
  expect(typeof bootstrap.body.data.bootstrap.structureRevision).toBe('string');
  expect(bootstrap.body.data.bootstrap.structureRevision.length).toBe(64);
  expect(bootstrap.body.data.bootstrap.templates.length).toBeGreaterThan(0);
  const catalogue = await post({ query: '{ allCatalogueEntity(first: 1) { totalCount edges { node { name taken } } } }' });
  expect(catalogue.status).toBe(200);
  expect(catalogue.body.errors).toBeUndefined();
  expect(catalogue.body.data.allCatalogueEntity.totalCount).toBe(520);
});

test('POST /graphql refuses a query deeper than six levels', async () => {
  const answer = await post({ query: '{ allCatalogueEntity { edges { node { derivesFrom { edges { node { derivedBy { edges { cursor } } } } } } } } }' });
  expect(answer.status).toBe(400);
  expect(answer.body.errors[0].extensions.code).toBe('LIMIT_DEPTH');
});

test('POST /graphql refuses a body that is not an operation', async () => {
  const answer = await post({ nope: true });
  expect(answer.status).toBe(400);
  expect(answer.body.error.field).toBe('query');
});
