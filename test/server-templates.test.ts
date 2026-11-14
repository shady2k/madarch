/** Template faults stay on their page and in Problems; other pages keep serving. */
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
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { checkProductTemplates } from '../src/graph/template-check.js';
import { prepareStoreAcceptanceFixture } from '../scripts/clean-install-fixture.js';
import { composePage } from '../src/page-contract/compose.js';
import { readKinds } from '../src/product/manifest/kinds.js';

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

test('template component and parameter findings do not stop other pages serving', async () => {
  const path = join(product, 'templates', 'probe.yaml');
  for (const body of [
    'template: probe\nsections:\n  - id: carousel\n    component: carousel\n    query: id\n',
    'template: probe\nsections:\n  - id: header\n    component: header\n    query: id\n    params: { titlePath: id, carousel: true }\n',
  ]) {
    writeFileSync(path, body);
    const running = await startPreparedServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      expect((await fetch(running.url)).status).toBe(200);
      const findings = checkProductTemplates(product);
      expect(findings.some((one) => one.file === 'templates/probe.yaml' && one.line > 1 && one.message.includes('carousel'))).toBe(true);
      const answer = await (await fetch(`${running.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ bootstrap { structureRevision catalogueTemplate templates { name body } recordTemplates { kind template } ownTemplates { id template } roles } }' }) })).json() as any;
      expect(composePage(answer.data.bootstrap, { template: 'search' }).findings).toEqual([]);
      expect(composePage(answer.data.bootstrap, { template: 'probe' }).findings.length).toBeGreaterThan(0);
    } finally {
      await running.stop();
      unlinkSync(path);
    }
  }
}, 180_000);

test('a reduced manifest keeps query failures on their page and in Problems', async () => {
  const draft = createDraft({ home, name: 'reduced', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  const folder = draft.folder;
  prepareStoreAcceptanceFixture(folder);
  const running = await startPreparedServer({ productFolder: folder, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
  try {
    const post = async (query: string, variables = {}) => await (await fetch(`${running.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })).json() as any;
    const answer = await post('{ bootstrap { structureRevision home { id kind template } catalogueTemplate templates { name body } recordTemplates { kind template } ownTemplates { id template } roles } }');
    const bootstrap = answer.data.bootstrap;
    const page = composePage(bootstrap, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000001' });
    expect(page.findings).toEqual([]);
    const invalid = await post(page.operation, page.variables);
    for (const field of ['repository', 'path', 'language']) expect(invalid.errors.map((one: { message: string }) => one.message).join()).toContain(`Cannot query field "${field}"`);
    expect((await fetch(running.url)).status).toBe(200);
    const valid = await post('{ bootstrap { roles } }');
    expect(valid.errors).toBeUndefined();
    const listing = await post('{ templateFindings { file line path message } }');
    expect(listing.errors).toBeUndefined();
    expect(listing.data.templateFindings.some((one: any) => one.file === `${folder}/templates/code-file.yaml` && one.line > 1 && one.message.includes('repository'))).toBe(true);
    writeFileSync(join(folder, 'templates/code-file.yaml'), 'template: code-file\nrecords: [code.file]\nsections: []\n');
    const refreshed = await post('{ templateFindings { file } }');
    expect(refreshed.data.templateFindings.some((one: { file: string }) => one.file === `${folder}/templates/code-file.yaml`)).toBe(false);
  } finally {
    await running.stop();
  }
}, 180_000);

test('query diagnostics keep an inherited yml section source and use the supplied published manifest', () => {
  const base = join(product, 'templates', 'probe-base.yml');
  const child = join(product, 'templates', 'probe-child.yaml');
  const manifest = readKinds(product);
  if (!manifest.present) throw new Error('fixture manifest is missing');
  writeFileSync(base, 'template: probe-base\nsections:\n  - id: bad\n    component: header\n    query: missingTemplateField\n    params: { titlePath: id }\n');
  writeFileSync(child, 'template: probe-child\nextends: probe-base\nrecords: [code.file]\n');
  try {
    const findings = checkProductTemplates(product, manifest.manifest);
    expect(findings.some((one) => one.file === 'templates/probe-base.yml' && one.line === 3 && one.message.includes('missingTemplateField'))).toBe(true);
    expect(findings.some((one) => one.file === 'templates/probe-child.yaml' && one.message.includes('missingTemplateField'))).toBe(false);
  } finally {
    unlinkSync(base);
    unlinkSync(child);
  }
});

test('a product whose templates are whole serves, and the bootstrap lists them', async () => {
  server = await startPreparedServer({ productFolder: product, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
  const answer = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ bootstrap { catalogueTemplate templates { name body } recordTemplates { kind template } roles } }' }) });
  const body = (await answer.json()) as { data?: { bootstrap: { catalogueTemplate: string; templates: { name: string; body: string }[]; recordTemplates: { kind: string; template: string }[]; roles: string[] } } };
  const bootstrap = body.data!.bootstrap;
  expect(bootstrap.catalogueTemplate).toBe('catalogue-entity');
  const starterTemplates = Object.keys(CATALOG_FILES)
    .filter((path) => path.startsWith('templates/pages/'))
    .map((path) => path.slice('templates/pages/'.length, -'.yaml'.length))
    .sort();
  expect(bootstrap.templates.map((one) => one.name).sort()).toEqual(starterTemplates);
  expect(bootstrap.templates.every((one) => one.body.length > 0)).toBe(true);
  expect(bootstrap.roles.length).toBeGreaterThan(0);
}, 180_000);
