/**
 * Who the wiki is for (decision 0031): the manifest's roles, the term fields the
 * writer's document stages read, the user's settings on the machine, and the
 * products-home server with madarch's own wiki beside the products (what the root
 * opens, the selector's flag, the status of the own wiki, the settings route, and
 * the glossary the fill does not fill yet). The own wiki is a fixture repository
 * on disk.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/knowledge/kinds.js';
import { readKinds } from '../src/knowledge/kinds.js';
import { choosableRoles, readSettings, settingsPath, writeRole } from '../src/knowledge/settings.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { installOwnWiki } from '../src/product/own-wiki.js';
import { makeWikiRepository, ownGit } from './own-wiki-fixture.js';

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

  test('a role the engine never heard of is the product\'s own, while a block outside the library and a group not declared are findings with the file and line', () => {
    // A role's name is data (decision 0033, item 12): a product declares the roles it reads as, and the engine holds none.
    const manifest = parseKinds(MANIFEST('roles:\n  janitor: { lead: [code] }\n  tester: { open: [nothing] }\n  analyst: { lead: [elsewhere] }\n  architect: { lead: [code, product] }\n'), 'kinds.yaml', folder);
    expect(manifest.findings.map((finding) => [finding.line, finding.message.split(':')[0]])).toEqual([[11, 'role "tester"'], [12, 'role "analyst"']]);
    expect(manifest.findings[0]!.message).toContain('"nothing" is not a block of the library');
    expect(manifest.findings[1]!.message).toContain('"elsewhere" is not a group');
    expect([...manifest.roles.keys()]).toEqual(['janitor', 'architect']);
  });

  test('"everything" is every role at once and is not declared, and a role\'s name is one word', () => {
    const manifest = parseKinds(MANIFEST('roles:\n  everything: { lead: [code] }\n  "security engineer": { lead: [code] }\n  security-engineer: { lead: [code, product] }\n'), 'kinds.yaml', folder);
    expect(manifest.findings.map((finding) => [finding.line, finding.message])).toEqual([
      [10, 'role "everything": "everything" is every role at once and is not declared'],
      [11, 'role "security engineer": a role\'s name is one word without whitespace'],
    ]);
    expect([...manifest.roles.keys()]).toEqual(['security-engineer']);
  });

  test('the starter manifest declares sensible roles of its own', () => {
    const starter = makeWikiRepository(mkdtempSync(join(tmpdir(), 'madarch-roles-starter-')));
    try {
      const read = readKinds(starter);
      expect(read.present && read.manifest.findings).toEqual([]);
      if (!read.present) return;
      expect([...read.manifest.roles.keys()]).toEqual(['product', 'analyst', 'architect', 'developer', 'operations', 'tester', 'designer', 'security-engineer', 'platform-devops', 'product-lead']);
      expect(read.manifest.roles.get('developer')!.open).toContain('source');
      expect(read.manifest.roles.get('product')!.open).not.toContain('source');
    } finally {
      rmSync(starter, { recursive: true, force: true });
    }
  });
});

/** The roles the fixture product declares, as a product's manifest declares them; "everything" is every role at once. */
const ROLES = choosableRoles(['product', 'analyst', 'architect', 'developer', 'operations', 'tester']);

describe('the user\'s settings on the machine', () => {
  test('nobody asked is "everything" and not yet asked; a chosen role is kept in the madarch home and read back, other keys kept', () => {
    const home = mkdtempSync(join(tmpdir(), 'madarch-settings-'));
    try {
      const env = { MADARCH_HOME: home };
      expect(readSettings(env, ROLES)).toEqual({ role: 'everything', asked: false });
      writeFileSync(settingsPath(env), '{"other":1}\n');
      expect(writeRole(env, 'developer', ROLES)).toEqual({ role: 'developer', asked: true });
      expect(readSettings(env, ROLES)).toEqual({ role: 'developer', asked: true });
      expect(JSON.parse(readFileSync(settingsPath(env), 'utf8'))).toEqual({ other: 1, role: 'developer', roleAsked: true });
      expect(() => writeRole(env, 'janitor', ROLES)).toThrow('the roles are product, analyst, architect, developer, operations, tester, everything');
      // A role the product does not declare is not a role of it, however well it reads.
      expect(() => writeRole(env, 'designer', ROLES)).toThrow('"designer" is not a role');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the temporary file is a new one: a link at a guessable name is not written through, and none is left behind', () => {
    const home = mkdtempSync(join(tmpdir(), 'madarch-settings-'));
    try {
      const env = { MADARCH_HOME: home };
      const outside = join(home, 'outside.txt');
      writeFileSync(outside, 'untouched\n');
      for (const name of [`settings.json.${process.pid}.tmp`, 'settings.json.tmp']) symlinkSync(outside, join(home, name));
      writeRole(env, 'architect', ROLES);
      expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
      expect(readdirSync(home).filter((name) => name.endsWith('.tmp') && !lstatSync(join(home, name)).isSymbolicLink())).toEqual([]);
      expect(readSettings(env, ROLES).role).toBe('architect');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a settings file that is not JSON is an error naming the file, never read as a default', () => {
    const home = mkdtempSync(join(tmpdir(), 'madarch-settings-'));
    try {
      const env = { MADARCH_HOME: home };
      writeFileSync(settingsPath(env), '{broken');
      expect(() => readSettings(env, ROLES)).toThrow(settingsPath(env));
      expect(() => writeRole(env, 'tester', ROLES)).toThrow(settingsPath(env));
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
  const errors: string[] = [];
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
    writeFileSync(join(app, 'index.html'), '<!doctype html><link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin><title>app</title><div id="root"></div><script src="/assets/index.js"></script>');
    emptyHome = join(work, 'empty-home');
    mkdirSync(emptyHome);
    busyHome = join(work, 'busy-home');
    mkdirSync(busyHome);
    const mine = makeWikiRepository(join(busyHome, 'my-product'), { 'docs/extra.md': '# Extra\n' });
    writeFileSync(join(mine, 'workspace.yaml'), 'schemaVersion: 1\nid: 2ed7a5e0-3aa5-4e9a-9d3c-76d0a0c5c0aa\nname: My product\n');
    const common = { appFolder: app, port: 0, log: () => undefined, errorLog: (line: string) => { errors.push(line); }, env: { MADARCH_HOME: madarchHome }, ownWiki: { folder: installed.folder } };
    empty = await startServer({ ...common, productHome: emptyHome, knowledgeRoot: join(work, 'store-a') });
    busy = await startServer({ ...common, productHome: busyHome, knowledgeRoot: join(work, 'store-b') });
    // The first page of a product waits for its reader to start (a process of its own): the tests below do not.
    for (const [server, path] of [[empty, '/products/madarch-wiki/api/k/status'], [busy, '/products/madarch-wiki/api/k/status'], [busy, '/products/my-product/api/k/status']] as const) {
      for (let tries = 0; ; tries += 1) {
        if ((await fetch(`${server.url}${path}`)).ok) break;
        if (tries > 60) throw new Error(`the status at ${path} never answered; the server said:\n${errors.join('\n')}`);
        await new Promise((rest) => setTimeout(rest, 500));
      }
    }
  }, 120_000);

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
    expect(Object.keys(own.body.roles)).toEqual(['product', 'analyst', 'architect', 'developer', 'operations', 'tester', 'designer', 'security-engineer', 'platform-devops', 'product-lead']);
    expect((await get(busy, '/products/my-product/api/k/status')).body.own).toBeUndefined();
    // Serving the wiki writes nothing into it, so the refresh can fast-forward it.
    expect(ownGit(join(madarchHome, 'madarch-wiki'), ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  test('reading the own wiki does not make it the product the root opens next', async () => {
    const page = await fetch(`${busy.url}/products/madarch-wiki/`, { headers: { accept: 'text/html' } });
    expect(page.headers.get('set-cookie')).toBeNull();
    const mine = await fetch(`${busy.url}/products/my-product/`, { headers: { accept: 'text/html' } });
    expect(mine.headers.get('set-cookie')).toContain('madarch-last-product=my-product');
  });

  test('the page preloads the face the stylesheet names, at the address the stylesheet names it, while its scripts take the product\'s prefix', async () => {
    const html = await (await fetch(`${busy.url}/products/my-product/`, { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('href="/fonts/InterVariable.woff2"');
    expect(html).toContain('src="/products/my-product/assets/index.js"');
  });

  test('the own wiki is documentation: no fill, no start over', async () => {
    const fill = await get(busy, '/products/madarch-wiki/api/k/fill', { method: 'POST' });
    expect(fill.status).toBe(409);
    expect(fill.body.message).toContain('documentation');
    expect((await get(busy, '/products/madarch-wiki/api/k/reset', { method: 'POST' })).status).toBe(403);
  });

  test('the glossary reads only the store: no fill stage writes its terms yet, so it answers none', async () => {
    const answer = await get(busy, '/products/madarch-wiki/api/k/glossary');
    if (answer.status !== 200) throw new Error(`the glossary answered ${answer.status} ${JSON.stringify(answer.body)}; the server said:\n${errors.join('\n')}`);
    // The answer carries a count, never the list (madarch-8bdc.2.5): no stage writes a term, so the count is zero.
    expect(answer.body).toEqual({ terms: [], resolutions: {}, findingCount: 0 });
  });

  test('a document section is no page: no fill stage reads the products documents at request time', async () => {
    const id = encodeURIComponent('doc:docs/glossary.md#payment-token');
    const page = await get(busy, `/products/madarch-wiki/api/k/page?id=${id}`);
    expect(page.status).toBe(404);
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
