/**
 * A product's page templates are refused at start (decision 0036, section 6): a template naming a component the app
 * does not draw, or a parameter that component does not take, stops the server with the file and the line, and a
 * product whose templates are whole serves and lists them in the bootstrap.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf } from '../src/product/store.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

let root = '';
let home = '';
let product = '';
let app = '';
let server: StartedServer | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-server-templates-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(home, { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  const draft = createDraft({ home, name: 'templates', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  product = draft.folder;
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

test('a template naming an unknown component stops the start, naming the file and the line', async () => {
  const path = join(product, 'templates', 'probe.yaml');
  writeFileSync(path, 'template: probe\nsections:\n  - id: header\n    component: header\n    query: id\n    params: { titlePath: id }\n  - id: carousel\n    component: carousel\n    query: id\n');
  try {
    const refused = startPreparedServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    const message = await refused.then(() => '', (error: Error) => error.message);
    expect(message).toContain('templates/probe.yaml:8:');
    expect(message).toContain('"carousel"');
  } finally {
    unlinkSync(path);
  }
}, 180_000);

test('a parameter the component does not take stops the start too', async () => {
  const path = join(product, 'templates', 'probe.yaml');
  writeFileSync(path, 'template: probe\nsections:\n  - id: header\n    component: header\n    query: id\n    params:\n      titlePath: id\n      carousel: true\n');
  try {
    const refused = startPreparedServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    const message = await refused.then(() => '', (error: Error) => error.message);
    expect(message).toContain('templates/probe.yaml:8:');
    expect(message).toContain('"carousel"');
  } finally {
    unlinkSync(path);
  }
}, 180_000);

test('a product whose templates are whole serves, and the bootstrap lists them', async () => {
  server = await startPreparedServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
  const answer = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ bootstrap { catalogueTemplate templates { name body } recordTemplates { kind template } roles } }' }) });
  const body = (await answer.json()) as { data?: { bootstrap: { catalogueTemplate: string; templates: { name: string; body: string }[]; recordTemplates: { kind: string; template: string }[]; roles: string[] } } };
  const bootstrap = body.data!.bootstrap;
  expect(bootstrap.catalogueTemplate).toBe('catalogue-entity');
  expect(bootstrap.templates.map((one) => one.name).sort()).toEqual(['catalogue-entity', 'entity', 'home', 'text']);
  expect(bootstrap.templates.every((one) => one.body.length > 0)).toBe(true);
  expect(bootstrap.roles.length).toBeGreaterThan(0);
}, 180_000);
