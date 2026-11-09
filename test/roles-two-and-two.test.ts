/**
 * Two api instances and two fill instances against one store (madarch-8bdc.9, the owner's separation of roles): the api
 * roles serve the pages and the press and read the store directly, the fill roles take the pressed job from the store's
 * queue, and the queue hands each job to exactly one of them. Every unit of the fill is published once, and both api
 * instances answer pages from what the fill wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { generateTrainingRepository, makeProduct, PAY } from './knowledge-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';

const skip = process.env['MADARCH_SKIP_PERF'] === '1';

let work: string;
let storeRoot: string;
let api: StartedServer[] = [];
let fills: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), 'madarch-roles-'));
  const repository = generateTrainingRepository(join(work, 'training'));
  const home = join(work, 'home');
  mkdirSync(home);
  makeProduct(home, 'shop', repository, 'training');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  storeRoot = join(work, 'store');
  // Two api instances: neither fills in its own process.
  for (let instance = 1; instance <= 2; instance += 1) {
    api.push(await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: storeRoot, fillProcess: false, log: () => undefined, errorLog: () => undefined }));
  }
  // Two fill instances: the same binary, the same products home and the same knowledge root, as two machines of a server run.
  const script = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
  for (let instance = 1; instance <= 2; instance += 1) {
    fills.push(Bun.spawn([process.execPath, script, '--role', 'fill', '--home', home], {
      env: { ...process.env, MADARCH_KNOWLEDGE_ROOT: storeRoot },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    }));
  }
}, 120_000);

afterAll(async () => {
  if (skip) return;
  for (const child of fills) { try { child.kill(); } catch { /* already gone */ } }
  // The children first, waited for, then the servers: a fill role killed with its store still open leaves the store's
  // PostgreSQL server running, and the server that closes after it is the one that stops it (madarch-8bdc.12). The store
  // a child left behind is stopped here too, so the file leaves nothing behind when it passes or fails.
  await Promise.all(fills.map(async (child) => await child.exited.catch(() => undefined)));
  for (const instance of api) await instance.stop().catch(() => undefined);
  for (const pid of postmastersUnder(storeRoot)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  fills = [];
  api = [];
  rmSync(work, { recursive: true, force: true });
}, 120_000);

/** The pid of every PostgreSQL server a store under `root` left running, from the `postmaster.pid` each keeps. */
function postmastersUnder(root: string): number[] {
  const found: number[] = [];
  const walk = (folder: string): void => {
    let names: string[];
    try { names = readdirSync(folder); } catch { return; }
    for (const name of names) {
      const path = join(folder, name);
      if (name === 'postmaster.pid') {
        try {
          const pid = Number(readFileSync(path, 'utf8').split('\n')[0]?.trim());
          if (Number.isInteger(pid) && pid > 1) found.push(pid);
        } catch { /* gone between the listing and the read */ }
        continue;
      }
      if (name === 'pgdata' || name === 'graph' || name === 'read' || folder === root) walk(path);
    }
  };
  walk(root);
  return found;
}

describe.skipIf(skip)('two api and two fill instances against one store', () => {
  test('one press fills the product once, every unit publishes once, and both api instances answer from it', async () => {
    const base = (instance: StartedServer): string => `${instance.url}/products/shop`;
    // The wiki is open before the press, as a reader's browser has it: a page that the fill has not written yet answers 404.
    for (const path of ['/api/k/status', '/api/k/entities?kind=code.file&limit=100', `/api/k/page?id=${encodeURIComponent(PAY)}`]) {
      const response = await fetch(base(api[0]!) + path);
      const body = await response.text();
      expect([200, 404], `${path}: ${body}`).toContain(response.status);
    }
    // The press goes to the first api instance; the fill is claimed by one of the two fill processes.
    const press = await fetch(`${base(api[0]!)}/api/k/fill`, { method: 'POST' });
    expect(press.status).toBe(202);
    const started = Date.now();
    // The other instance answers "idle" until the fill process has written the run: the press answers before the run
    // exists, so every answer but a settled one keeps the poll going.
    let state = 'idle';
    while (state !== 'done' && state !== 'failed' && Date.now() - started < 600_000) {
      await new Promise((rest) => setTimeout(rest, 250));
      // The second api instance answers the status: the fill's state is the store's, not the pressing process's.
      const status = await (await fetch(`${base(api[1]!)}/api/k/status`)).json() as { fill: { state: string } };
      state = status.fill.state;
    }
    expect(state, `the fill did not end within 10 minutes: ${JSON.stringify(state)}`).toBe('done');
    // Every unit of the run published exactly once: no job was lost to the second fill instance and none was taken twice.
    // The store's folder is named by the product's id under the knowledge root, as every other caller resolves it.
    const owner = await createTestDatabaseOwner({ store: storeDatabasePath(productStoreFolder(join(work, 'home', 'shop'), storeRoot)), btreeGist: true });
    try {
      const published = await owner.run(async (tx) => await tx.query<{ unit_id: string; publications: string }>(
        'SELECT unit_id, count(*)::text AS publications FROM fill_publication GROUP BY unit_id ORDER BY unit_id',
      ));
      expect(published.rows.length).toBeGreaterThan(0);
      expect(published.rows.filter((row) => row.publications !== '1').map((row) => `${row.unit_id}: ${row.publications}`)).toEqual([]);
      // Every unit of the run stands published, each with the one publication counted above.
      const units = await owner.run(async (tx) => await tx.query<{ unit_id: string; generation: string; state: string }>('SELECT unit_id, generation::text AS generation, state FROM fill_unit_generation ORDER BY unit_id'));
      expect(units.rows.filter((unit) => unit.state !== 'published').map((unit) => `${unit.unit_id}: ${unit.state}`)).toEqual([]);
      expect(units.rows.map((unit) => unit.unit_id)).toEqual(published.rows.map((row) => row.unit_id));
    } finally {
      await owner.close();
    }
    // Both api instances answer the pages the fill published, and they answer the same thing: the pages themselves are
    // identical byte for byte, and the status answers the same kinds and repository (the moment each process learned of
    // the run is its own, so the fill's own timestamps are not compared).
    for (const path of ['/api/k/entities?kind=code.file&limit=100', '/api/k/entities?kind=code.symbol&limit=100', '/api/k/documents']) {
      const first = await fetch(base(api[0]!) + path);
      const second = await fetch(base(api[1]!) + path);
      expect(first.status, path).toBe(200);
      expect(second.status, path).toBe(200);
      expect(await first.text(), path).toBe(await second.text());
    }
    const statuses = await Promise.all(api.map(async (instance) => await (await fetch(`${base(instance)}/api/k/status`)).json() as { fill: { state: string }; kinds: unknown; repository: unknown }));
    for (const status of statuses) expect(status.fill.state).toBe('done');
    expect(statuses[1]!.kinds).toEqual(statuses[0]!.kinds);
    expect(statuses[1]!.repository).toEqual(statuses[0]!.repository);
  }, 900_000);
});
