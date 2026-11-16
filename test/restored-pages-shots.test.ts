import { afterAll, expect, test } from 'bun:test';
import type { KeyValueDraft } from '../src/graph/contract.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf } from '../src/product/store.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { publishFixtureOpinions } from './knowledge-page-opinions.js';
import { resolveBrowserExecutable } from '../scripts/chromium.js';

const enabled = process.env['MADARCH_135_SHOTS'] === '1';
let root = '';
let home = '';
let productFolder = '';
const output = process.env['MADARCH_135_SHOTS_DIR'] ?? join(import.meta.dir, '../docs/changes/madarch-64o5.135/mockups');
let server: Awaited<ReturnType<typeof startPreparedServer>> | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
afterAll(async () => { await browser?.close(); await server?.stop(); if (root !== '') rmSync(root, { recursive: true, force: true }); });

const run = enabled ? test : test.skip;
run('graph-backed restored pages render at desktop and mobile in both color schemes', async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-135-pages-'));
  home = join(root, 'products');
  const draft = createDraft({ home, name: 'pages', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  productFolder = draft.folder;
  server = await startPreparedServer({ productFolder, knowledgeRoot: knowledgeRootOf(home), appFolder: join(import.meta.dir, '../wiki/app/dist'), port: 0, log: () => undefined, errorLog: () => undefined });
  const knowledge = knowledgeRootOf(home);
  const opinions: { kind: string; key: Record<string, KeyValueDraft>; values: Record<string, unknown> }[] = [
    { kind: 'code.repository', key: { name: 'sample-repo' }, values: { url: 'https://example.test/repo' } },
    { kind: 'code.directory', key: { repository: 'sample-repo', path: 'src' }, values: {} },
    { kind: 'code.file', key: { repository: 'sample-repo', path: 'src/index.ts' }, values: { language: 'TypeScript', lines: 12, bytes: 210, blob: 'fixture-blob' } },
    { kind: 'code.symbol', key: { repository: 'sample-repo', path: 'src/index.ts', name: 'sample.answer' }, values: {} },
    { kind: 'code.contract', key: { repository: 'sample-repo', path: 'api/openapi.yaml' }, values: {} },
    { kind: 'code.operation', key: { repository: 'sample-repo', path: 'api/openapi.yaml', name: 'GET /items' }, values: {} },
    { kind: 'code.route', key: {}, values: { label: 'GET /items' } },
    { kind: 'code.database', key: { name: 'sample-db' }, values: { repository: 'sample-repo' } },
    { kind: 'code.table', key: { database: 'sample-db', name: 'items' }, values: { schema: 'public' } },
  ];
  await publishFixtureOpinions(productFolder, knowledge, opinions);
  const bootstrapResponse = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ templateFindings { file line path message } bootstrap { recordTemplates { kind template } } }' }) });
  expect(bootstrapResponse.status).toBe(200);
  const bootstrap = await bootstrapResponse.json() as { data?: { templateFindings?: unknown[]; bootstrap?: { recordTemplates?: { kind: string; template: string }[] } } };
  expect(bootstrap.data?.templateFindings).toEqual([]);
  const recordBindings = bootstrap.data?.bootstrap?.recordTemplates ?? [];
  expect(['code.repository','code.directory','code.file','code.symbol','code.contract','code.operation','code.route','code.database','code.table'].every((kind) => recordBindings.some((binding) => binding.kind === kind))).toBe(true);
  browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  mkdirSync(output, { recursive: true });
  const kinds = ['repository','directory','file','symbol','contract','operation','route','database','table'];
  const page = await browser.newPage();
  const errors: string[] = [];
  let screenshots = 0;
  page.on('pageerror', (error) => errors.push(String(error)));
  for (const kind of kinds) {
    const query = `{ allCode${kind[0]!.toUpperCase()}${kind.slice(1)}(first: 1) { edges { node { id } } } }`;
    const found = await (await fetch(`${server.url}/graphql`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({query}) })).json() as { data?: Record<string, { edges?: { node?: { id?: string } }[] }> ; errors?: { message: string }[] };
    const id = found.data?.[`allCode${kind[0]!.toUpperCase()}${kind.slice(1)}`]?.edges?.[0]?.node?.id;
    if (!id) throw new Error(`${kind} fixture was not readable: ${JSON.stringify(found.errors ?? found).slice(0,500)}`);
    for (const dark of [false,true]) {
      await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:dark?'dark':'light'}]);
      for (const width of [1440,390]) {
        await page.setViewport({width,height:width===390?844:1000,deviceScaleFactor:1});
        await page.goto(`${server.url}/e/code.${kind}/${encodeURIComponent(id)}`,{waitUntil:'domcontentloaded',timeout:60000});
        await page.waitForFunction(()=>document.querySelector('h1')!==null||document.querySelector('[data-testid=role-first]')!==null,{timeout:30000}); if(await page.$('[data-testid=role-first]')){await page.click('[data-testid=role-first-continue]');} await page.waitForSelector('h1',{timeout:30000});
        await new Promise(resolve=>setTimeout(resolve,500));
        await page.screenshot({path:join(output,`${kind}-${width}-${dark?'dark':'light'}.png`),fullPage:true});
        screenshots += 1;
        const measure = await page.evaluate(()=>({title:document.querySelector('h1')?.textContent?.trim()??'',scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,sections:document.querySelectorAll('main section').length}));
        console.info('PAGE_SHOT',kind,width,dark,JSON.stringify(measure));
        expect(measure.title).not.toBe('');
        expect(measure.scroll).toBeLessThanOrEqual(measure.client+1);
      }
    }
  }
  expect(screenshots).toBe(kinds.length * 2 * 2);
  expect(errors).toEqual([]);
  await page.close();
}, 300_000);
