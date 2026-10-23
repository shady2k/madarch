/**
 * Who the wiki is for (decision 0031): the manifest's roles and glossary terms
 * read with their findings, the glossary term fields, the user's settings on the
 * machine, and the products-home server with madarch's own wiki beside the
 * products (what the root opens, the selector's flag, the status of the own
 * wiki, the settings route). The own wiki is a fixture repository on disk.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/knowledge/kinds.js';
import { glossaryTerms, madarchLinks, parseTermText } from '../src/knowledge/glossary.js';
import { readDocEntities } from '../src/knowledge/doc-entities.js';
import { readKinds } from '../src/knowledge/kinds.js';
import { readSettings, settingsPath, writeRole } from '../src/knowledge/settings.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { installOwnWiki } from '../src/product/own-wiki.js';
import { GLOSSARY, makeWikiRepository } from './own-wiki-fixture.js';
import { generateTrainingRepository, makeProduct } from './knowledge-fixture.js';

const MANIFEST = (roles: string): string => `groups:\n  product: { en: Product, ru: Продукт }\n  code: { en: Code, ru: Код }\nkinds:\n  product:\n    template: templates/product.md\n    source: markdown\n    file: docs/product.md\n${roles}`;

describe('the manifest\'s roles', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-roles-manifest-'));
  mkdirSync(join(folder, 'templates'));
  writeFileSync(join(folder, 'templates', 'product.md'), ':::body\n');
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  test('a role declares the blocks it opens and the groups that lead; "everything" needs no declaration', () => {
    const manifest = parseKinds(MANIFEST('roles:\n  developer: { lead: [code], open: [source, callers] }\n  product: { lead: [product] }\n'), 'kinds.yaml', folder);
    expect(manifest.findings).toEqual([]);
    expect([...manifest.roles.keys()]).toEqual(['developer', 'product']);
    expect(manifest.roles.get('developer')).toMatchObject({ open: ['source', 'callers'], lead: ['code'] });
    expect(manifest.roles.get('product')?.open).toBeUndefined();
  });

  test('an unknown role, a block outside the library and a group not declared are findings with the file and line, and the role is left out', () => {
    const manifest = parseKinds(MANIFEST('roles:\n  janitor: { lead: [code] }\n  tester: { open: [nothing] }\n  analyst: { lead: [elsewhere] }\n  architect: { lead: [code] }\n'), 'kinds.yaml', folder);
    expect(manifest.findings.map((finding) => [finding.line, finding.message.split(':')[0]])).toEqual([[10, 'role "janitor"'], [11, 'role "tester"'], [12, 'role "analyst"']]);
    expect(manifest.findings[0]!.message).toContain('everything');
    expect(manifest.findings[1]!.message).toContain('"nothing" is not a block of the library');
    expect(manifest.findings[2]!.message).toContain('"elsewhere" is not a group');
    expect([...manifest.roles.keys()]).toEqual(['architect']);
  });

  test('the starter manifest declares sensible roles of its own', () => {
    const starter = makeWikiRepository(mkdtempSync(join(tmpdir(), 'madarch-roles-starter-')));
    try {
      const read = readKinds(starter);
      expect(read.present && read.manifest.findings).toEqual([]);
      if (!read.present) return;
      expect([...read.manifest.roles.keys()]).toEqual(['product', 'analyst', 'architect', 'developer', 'operations', 'tester']);
      expect(read.manifest.roles.get('developer')!.open).toContain('source');
      expect(read.manifest.roles.get('product')!.open).not.toContain('source');
    } finally {
      rmSync(starter, { recursive: true, force: true });
    }
  });
});

describe('glossary terms', () => {
  test('the definition is the plain words; synonyms, code names, places of use and the ambiguity are the labelled lines', () => {
    const fields = parseTermText('The file that tells the wiki which kinds a product has.\n- Also called: manifests, `kinds file`\n- In code: `madarch/kinds.yaml`, `MADARCH_HOME`\n- Used in: [the reference](madarch:doc:docs/reference.md#manifest)\n- Ambiguous: also the build manifest; see [Q-3](madarch:doc:docs/reference.md#question)');
    expect(fields).toEqual({
      definition: 'The file that tells the wiki which kinds a product has.',
      synonyms: ['manifests', 'kinds file'],
      code: ['madarch/kinds.yaml', 'MADARCH_HOME'],
      usedIn: '[the reference](madarch:doc:docs/reference.md#manifest)',
      ambiguous: 'also the build manifest; see [Q-3](madarch:doc:docs/reference.md#question)',
    });
    expect(madarchLinks(fields.usedIn)).toEqual(['madarch:doc:docs/reference.md#manifest']);
  });

  test('Russian labels are read, a line that is no label stays in the definition, and an empty ambiguity is still an ambiguity', () => {
    const fields = parseTermText('Слово: определение, а не метка.\nВторая строка определения.\n  - Также называют: фолио, folio\n  - В коде: `Folio`\n  - Неоднозначно:');
    expect(fields.definition).toBe('Слово: определение, а не метка.\nВторая строка определения.');
    expect(fields.synonyms).toEqual(['фолио', 'folio']);
    expect(fields.code).toEqual(['Folio']);
    expect(fields.ambiguous).toBe('-');
  });

  test('a term without labels has only its definition and is not ambiguous', () => {
    expect(parseTermText('Plain words.')).toEqual({ definition: 'Plain words.', synonyms: [], code: [], usedIn: null, ambiguous: null });
  });

  test('the terms of the manifest\'s glossary documents are listed in order, each with the document, line and anchor it is stated at', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-glossary-'));
    try {
      makeWikiRepository(folder);
      const read = readKinds(folder);
      if (!read.present) throw new Error('no manifest');
      const docs = readDocEntities([{ repo: null, path: 'docs/glossary.md', text: GLOSSARY }], read.manifest);
      const terms = glossaryTerms(read.manifest, docs.entities);
      expect(terms.map((term) => term.title)).toEqual(['Capture', 'Manifest', 'Payment token']);
      const token = terms.find((term) => term.title === 'Payment token')!;
      expect(token).toMatchObject({ path: 'docs/glossary.md', line: 7, anchor: 'payment-token', ambiguous: 'the documents also use it for the vault reference; see [the open question](madarch:doc:docs/reference.md#question)' });
      expect(terms.find((term) => term.title === 'Capture')!.ambiguous).toBeNull();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the user\'s settings on the machine', () => {
  test('nobody asked is "everything" and not yet asked; a chosen role is kept in the madarch home and read back, other keys kept', () => {
    const home = mkdtempSync(join(tmpdir(), 'madarch-settings-'));
    try {
      const env = { MADARCH_HOME: home };
      expect(readSettings(env)).toEqual({ role: 'everything', asked: false });
      writeFileSync(settingsPath(env), '{"other":1}\n');
      expect(writeRole(env, 'developer')).toEqual({ role: 'developer', asked: true });
      expect(readSettings(env)).toEqual({ role: 'developer', asked: true });
      expect(JSON.parse(readFileSync(settingsPath(env), 'utf8'))).toEqual({ other: 1, role: 'developer', roleAsked: true });
      expect(() => writeRole(env, 'janitor')).toThrow('the roles are product, analyst, architect, developer, operations, tester, everything');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a settings file that is not JSON is an error naming the file, never read as a default', () => {
    const home = mkdtempSync(join(tmpdir(), 'madarch-settings-'));
    try {
      const env = { MADARCH_HOME: home };
      writeFileSync(settingsPath(env), '{broken');
      expect(() => readSettings(env)).toThrow(settingsPath(env));
      expect(() => writeRole(env, 'tester')).toThrow(settingsPath(env));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the products-home server with madarch\'s own wiki', () => {
  let work: string;
  let emptyHome: string;
  let busyHome: string;
  let madarchHome: string;
  let empty: StartedServer;
  let busy: StartedServer;
  const get = async (server: StartedServer, path: string, init?: RequestInit): Promise<{ status: number; body: any; location: string | null }> => {
    const response = await fetch(`${server.url}${path}`, { redirect: 'manual', ...init });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body, location: response.headers.get('location') };
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-own-server-'));
    madarchHome = join(work, 'madarch-home');
    const source = makeWikiRepository(join(work, 'source'));
    const installed = installOwnWiki({ env: { MADARCH_HOME: madarchHome }, repository: source });
    if (!installed.ok) throw new Error(installed.message);
    const app = join(work, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
    emptyHome = join(work, 'empty-home');
    mkdirSync(emptyHome);
    busyHome = join(work, 'busy-home');
    mkdirSync(busyHome);
    const mine = makeWikiRepository(join(busyHome, 'my-product'), { 'docs/extra.md': '# Extra\n' });
    writeFileSync(join(mine, 'workspace.yaml'), 'schemaVersion: 1\nid: 2ed7a5e0-3aa5-4e9a-9d3c-76d0a0c5c0aa\nname: My product\n');
    const common = { appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined, env: { MADARCH_HOME: madarchHome }, ownWiki: { folder: installed.folder } };
    empty = await startServer({ ...common, productHome: emptyHome, knowledgeRoot: join(work, 'store-a') });
    busy = await startServer({ ...common, productHome: busyHome, knowledgeRoot: join(work, 'store-b') });
  }, 60_000);

  afterAll(async () => {
    await empty.stop();
    await busy.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test('with no product, the root opens madarch\'s own wiki, which is in the selector flagged as such', async () => {
    const root = await get(empty, '/');
    expect(root.status).toBe(302);
    expect(root.location).toBe('/products/madarch-wiki/');
    const products = await get(empty, '/api/products');
    expect(products.body).toEqual({ products: [{ name: 'Example docs', folder: 'madarch-wiki', own: true }] });
  });

  test('with a product, the root opens the product and the selector lists both, the own wiki flagged; the product\'s status is not marked own, the wiki\'s is', async () => {
    const root = await get(busy, '/');
    expect(root.location).toBe('/products/my-product/');
    const products = await get(busy, '/api/products');
    expect(products.body.products).toEqual([{ name: 'Example docs', folder: 'madarch-wiki', own: true }, { name: 'My product', folder: 'my-product' }]);
    const own = await get(busy, '/products/madarch-wiki/api/k/status');
    expect(own.body.own).toBe(true);
    expect(own.body.home).toBe('product:docs');
    expect(Object.keys(own.body.roles)).toEqual(['product', 'analyst', 'architect', 'developer', 'operations', 'tester']);
    expect((await get(busy, '/products/my-product/api/k/status')).body.own).toBeUndefined();
  });

  test('reading the own wiki does not make it the product the root opens next', async () => {
    const page = await fetch(`${busy.url}/products/madarch-wiki/`, { headers: { accept: 'text/html' } });
    expect(page.headers.get('set-cookie')).toBeNull();
    const mine = await fetch(`${busy.url}/products/my-product/`, { headers: { accept: 'text/html' } });
    expect(mine.headers.get('set-cookie')).toContain('madarch-last-product=my-product');
  });

  test('the own wiki is documentation: no fill, no start over', async () => {
    const fill = await get(busy, '/products/madarch-wiki/api/k/fill', { method: 'POST' });
    expect(fill.status).toBe(409);
    expect(fill.body.message).toContain('documentation');
    expect((await get(busy, '/products/madarch-wiki/api/k/reset', { method: 'POST' })).status).toBe(403);
  });

  test('the glossary is read with no fill: the terms, their fields and the resolution of the links they hold; the ambiguity is flagged', async () => {
    const answer = await get(busy, '/products/madarch-wiki/api/k/glossary');
    expect(answer.status).toBe(200);
    expect(answer.body.terms.map((term: { title: string }) => term.title)).toEqual(['Capture', 'Manifest', 'Payment token']);
    const manifest = answer.body.terms.find((term: { title: string }) => term.title === 'Manifest');
    expect(manifest).toMatchObject({ synonyms: ['manifests', 'kinds file'], code: ['madarch/kinds.yaml'], path: 'docs/glossary.md', line: 3 });
    expect(answer.body.terms.find((term: { title: string }) => term.title === 'Payment token').ambiguous).toContain('vault reference');
    expect(answer.body.resolutions['madarch:doc:docs/reference.md#manifest']).toMatchObject({ state: 'ok' });
    expect(answer.body.resolutions['madarch:doc:docs/reference.md#question']).toMatchObject({ state: 'ok' });
  });

  test('a term is a page with its definition block, its links resolved on the page', async () => {
    const id = encodeURIComponent('doc:docs/glossary.md#payment-token');
    const page = await get(busy, `/products/madarch-wiki/api/k/page?id=${id}`);
    expect(page.status).toBe(200);
    const term = page.body.blocks.find((block: { type: string }) => block.type === 'term');
    expect(term).toMatchObject({ type: 'term', definition: 'The proof a provider returns when it captured money.' });
    expect(term.ambiguous).toContain('open question');
    expect(page.body.resolutions['madarch:doc:docs/reference.md#question']).toMatchObject({ state: 'ok' });
  });

  test('the role is asked once: unasked, then kept in the madarch home for every product; a role outside the list is refused', async () => {
    expect((await get(busy, '/products/my-product/api/k/settings')).body).toMatchObject({ role: 'everything', asked: false });
    const chosen = await get(busy, '/products/my-product/api/k/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'developer' }) });
    expect(chosen.body).toMatchObject({ role: 'developer', asked: true });
    expect(JSON.parse(readFileSync(join(madarchHome, 'settings.json'), 'utf8'))).toMatchObject({ role: 'developer', roleAsked: true });
    // Another product, another server: the same machine, the same answer.
    expect((await get(empty, '/products/madarch-wiki/api/k/settings')).body).toMatchObject({ role: 'developer', asked: true });
    const refused = await get(busy, '/products/my-product/api/k/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'janitor' }) });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('"janitor"');
    const crossSite = await get(busy, '/products/my-product/api/k/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ role: 'tester' }) });
    expect(crossSite.status).toBe(403);
    expect(readFileSync(join(madarchHome, 'settings.json'), 'utf8')).toContain('developer');
  });

  test('a settings file that cannot be read is told with its path, not answered as a default', async () => {
    const file = join(madarchHome, 'settings.json');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, '{broken');
    try {
      const answer = await get(busy, '/products/my-product/api/k/settings');
      expect(answer.status).toBe(500);
      expect(answer.body.message).toContain(file);
    } finally {
      writeFileSync(file, good);
    }
  });
});

describe('the training repository\'s glossary', () => {
  test('lists the terms of its documents with the place each is stated at, and the term the agent found, "payment token", is flagged ambiguous with its question', async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-training-glossary-'));
    const home = join(work, 'home');
    mkdirSync(home);
    const repository = generateTrainingRepository(join(work, 'repo'));
    const product = makeProduct(home, 'shop', repository);
    mkdirSync(join(product, 'docs', 'questions'), { recursive: true });
    writeFileSync(join(product, 'docs', 'glossary.md'), [
      '# Terms the agent found',
      '',
      '- **Payment token** - What the documents call the value Checkout sends to Payments.',
      '  - Also called: payment tokens',
      '  - In code: `CardToken`, `PaymentToken`',
      '  - Ambiguous: the architecture says "payment token" for the card reference, while the code\'s `PaymentToken` is the provider\'s proof of capture; see [the open question](madarch:doc:docs/questions/payment-token.md#question)',
      '',
    ].join('\n'));
    writeFileSync(join(product, 'docs', 'questions', 'payment-token.md'), '# Payment token\n\n## Question {#question}\n\nDoes the document term mean CardToken or PaymentToken?\n');
    const app = join(work, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
    const server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined, env: { MADARCH_HOME: join(work, 'madarch-home') } });
    try {
      const answer = await (await fetch(`${server.url}/products/shop/api/k/glossary`)).json() as { terms: { title: string; repo: string | null; path: string; line: number; ambiguous: string | null; code: string[] }[]; resolutions: Record<string, { state: string }> };
      const titles = answer.terms.map((term) => term.title);
      for (const expected of ['Order', 'Outbox', 'Idempotency key', 'CardToken', 'PaymentToken', 'Capture', 'Zero-rated', 'Payment token']) expect(titles).toContain(expected);
      const stated = answer.terms.find((term) => term.title === 'Outbox')!;
      expect(stated).toMatchObject({ repo: 'training', path: 'docs/glossary.md' });
      expect(stated.line).toBeGreaterThan(0);
      const token = answer.terms.find((term) => term.title === 'Payment token')!;
      expect(token).toMatchObject({ repo: null, path: 'docs/glossary.md', code: ['CardToken', 'PaymentToken'] });
      expect(token.ambiguous).toContain('open question');
      expect(answer.terms.filter((term) => term.ambiguous !== null).map((term) => term.title)).toEqual(['Payment token']);
      expect(answer.resolutions['madarch:doc:docs/questions/payment-token.md#question']).toMatchObject({ state: 'ok' });
    } finally {
      await server.stop();
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
