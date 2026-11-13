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
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

let root = '';
let product = '';
let server: StartedServer | undefined;

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
  server = await startServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server?.stop();
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
