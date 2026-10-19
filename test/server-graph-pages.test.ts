/**
 * The graph's pages over the background server (madarch-tzte.23.1; decision 0026,
 * "Pages"): `GET /api/graph/pages`, `GET /api/graph/page` and the live channel
 * `GET /api/graph/events`, served by a real server over a real fill service and its
 * PGlite store.
 *
 * The task's bar is the values here: the page set and one page's model answer from
 * the fact store, a publication wakes a subscribed client without any polling and
 * only for the pages it touched, a publication that adds one module makes that
 * module's page appear within the same second, and an empty graph answers an empty
 * page set with the what-to-do message, never an error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { startServer, type StartedServer } from '../src/index.js';
import { startServer as startServerDirect } from '../src/server/http.js';
import { makeNodeFact, type Fact } from '../src/fill/facts.js';
import { createGraphPagesPart, type GraphPagesSource } from '../src/server/graph-pages.js';
import { pageAddress } from '../src/fill/graph-pages.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { writeOf, graphFacts, LATER_COMMIT, openGraphFixture, PRODUCT, provenance, type GraphFixtureFacts, type GraphFixtureWorld } from './graph-pages-fixture.js';

/** A stage whose unit publishes a package and never runs again: the page a later publication must not touch. */
function staticStage(packaged: () => Fact): FillStage {
  return {
    id: 'graph-static',
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'static-facts', schemaVersion: 1, scope: 'repository' }],
    configSchema: Type.Object({}),
    defaults: DEFAULT_STAGE_DEFAULTS,
    plan: () => ({ units: [{ id: 'lib', scope: 'lib' }], coverage: 'planned' }),
    execute: (_unit, context) => {
      context.draft.write(writeOf(packaged()));
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}

let world: GraphFixtureWorld | undefined;
let server: StartedServer | undefined;
let facts: GraphFixtureFacts;
let packaged: Fact;
let url = '';
let appFolder = '';
/** The lines the graph routes' own failures are logged on: the cause, never the browser's copy. */
const lines: string[] = [];
/** The facts the fixture's drafting stage publishes at each run: symbols first, then a module added beside them. */
let held: readonly Fact[] = [];

/** The app's built files: minimal stand-ins for the wiki app's build, which the server only serves. */
function builtApp(): string {
  appFolder = mkdtempSync(join(tmpdir(), 'madarch-graph-pages-app-'));
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>fixture wiki</title>');
  return appFolder;
}

beforeAll(async () => {
  facts = graphFacts();
  packaged = makeNodeFact({ kind: 'package', value: { repository: 'acme-shop', name: '@acme/checkout', form: 'package', ecosystem: 'npm' }, provenance: provenance('package.json', { startLine: 1, endLine: 6 }), layer: 'extracted' });
  // The first run publishes the symbols and their call: no module has a page yet.
  let published = [facts.placed, facts.total, facts.calls];
  world = await openGraphFixture({
    drafts: () => published.map((fact) => writeOf(fact)),
    extraStages: [staticStage(() => packaged)],
  });
  held = published;
  const first = await world.service.run({ product: { name: PRODUCT, folder: world.folder }, runId: 'run-server-1' });
  if (first.ok === false) throw new Error(`the fixture's first run was refused: ${first.code}: ${first.reason}`);
  builtApp();
  server = await startServer({
    productFolder: world.folder,
    appFolder,
    port: 0,
    graphPages: (folder) => world!.service.pages(folder),
    log: () => undefined,
    errorLog: (line: string) => lines.push(line),
  });
  url = server.url;
  // The second run adds one module: what the live channel's test subscribes before.
  published = [facts.module, facts.placed, facts.total, facts.calls];
}, 180_000);

afterAll(async () => {
  await server?.stop();
  server = undefined;
  if (appFolder !== '') rmSync(appFolder, { recursive: true, force: true });
  await world?.close();
});

/** One answer's JSON, or the failure naming the status and the body. */
async function answered(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}${path}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

describe('the page set over HTTP', () => {
  test('GET /api/graph/pages answers the product\'s pages and the moment it was read', async () => {
    const body = await answered('/api/graph/pages');
    expect(body.product).toBe(PRODUCT);
    expect(body.total).toBe(3);
    expect((body.pages as { kind: string }[]).map((page) => page.kind)).toEqual(['package', 'symbol', 'symbol']);
    expect(body.message).toBeNull();
    expect(typeof body.changeSeq).toBe('number');
    expect(body.changeSeq as number).toBeGreaterThan(0);
    expect(typeof body.readAt).toBe('number');
  });

  test('GET /api/graph/page answers one page\'s model and refuses what has none, naming it', async () => {
    const page = await answered(`/api/graph/page?id=${encodeURIComponent(facts.placed.id)}`);
    expect((page.node as { id: string }).id).toBe(facts.placed.id);
    expect((page.facts as unknown[]).length).toBe(1);
    expect((page.relations as { out: unknown[] }).out.length).toBe(1);
    expect((page.counts as { facts: number }).facts).toBe(1);

    const missing = await fetch(`${url}/api/graph/page?id=${encodeURIComponent(`module:${'f'.repeat(64)}`)}`);
    expect(missing.status).toBe(404);
    const refusal = (await missing.json()) as { message: string; error: { field?: string; code?: string } };
    expect(refusal.message).toContain(`module:${'f'.repeat(64)}`);
    expect(refusal.error.field).toBe('id');
    // The refusal carries its own code, so a client can tell a page that disappeared from an id it malformed.
    expect(refusal.error.code).toBe('graph-pages/no-such-node');

    const notAPage = await fetch(`${url}/api/graph/page?id=${encodeURIComponent(facts.file.id)}`);
    expect(notAPage.status).toBe(404);
    expect(((await notAPage.json()) as { message: string }).message).toContain('"file"');

    // An id that is no fact id at all is a wrong value: 400, with the field and the code that says what is wrong.
    const malformed = await fetch(`${url}/api/graph/page?id=module%3Anot-a-digest`);
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as { message: string; error: { field?: string; code?: string } };
    expect(malformedBody.error.field).toBe('id');
    expect(malformedBody.error.code).toBe('graph-pages/not-a-fact-id');
    expect(malformedBody.message).toContain('module:not-a-digest');

    const asked = await fetch(`${url}/api/graph/page`);
    expect(asked.status).toBe(400);
    expect(((await asked.json()) as { message: string }).message).toContain('"id" is required');

    // The address a page set hands out is a route the app answers: the page opens, and the app reads its id from it.
    const shell = await fetch(`${url}${pageAddress(facts.placed.id)}`);
    expect(pageAddress(facts.placed.id)).toBe(`/p/graph/${facts.placed.id}`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect(await shell.text()).toContain('fixture wiki');
  });

  test('the live channel refuses a sequence number that is none, an empty one included, naming it', async () => {
    for (const asked of ['soon', '']) {
      const response = await fetch(`${url}/api/graph/events?after=${encodeURIComponent(asked)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { message: string; error: { field?: string } };
      expect(body.error.field).toBe('after');
      expect(body.message).toContain('"after"');
    }
    // A sequence number it knows is a stream, and one that names no number starts where the client stands.
    const asking = new AbortController();
    const stream = await fetch(`${url}/api/graph/events?after=0`, { signal: asking.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    asking.abort();
  });
});

/** The reader of one stream, and the text it has read and not yet handed over: one reader per stream, held between reads. */
interface StreamReader {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  text: string;
}

/** A stream's reader, opened once: a stream read through two readers at once is a stream no test can read. */
function streamOf(response: Response): StreamReader {
  return { reader: response.body!.getReader(), text: '' };
}

/** One complete event of a stream, or undefined when none arrived inside the bound. */
async function nextEvent(stream: StreamReader, ms: number): Promise<string | undefined> {
  const { reader } = stream;
  const decoder = new TextDecoder();
  const done = new Promise<string | undefined>((resolve) => {
    const tick = setTimeout(() => resolve(undefined), ms);
    void (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          stream.text += decoder.decode(next.value, { stream: true });
          const index = stream.text.indexOf('\n\n');
          if (index >= 0) {
            const event = stream.text.slice(0, index);
            stream.text = stream.text.slice(index + 2);
            clearTimeout(tick);
            resolve(event);
            return;
          }
        }
      } catch {
        // A stream the test ended is a stream with no more events.
      }
      clearTimeout(tick);
      resolve(undefined);
    })();
  });
  const answer = await done;
  return answer;
}

describe('the live channel', () => {
  test('a publication that adds one module makes its page appear for a subscribed client within the same second, and no other page is announced', async () => {
    // The client reads the set it holds now, and subscribes from the store's own sequence number of that read.
    const set = await answered('/api/graph/pages');
    const after = set.changeSeq as number;
    const asking = new AbortController();
    const response = await fetch(`${url}/api/graph/events?after=${after}`, { signal: asking.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    try {
      const stream = streamOf(response);
      const first = await nextEvent(stream, 2_000);
      expect(first).toBe('retry: 3000');
      // The publication the test is about, and the moment it is asked for.
      const started = Date.now();
      // The drafting stage's input moves, so its unit publishes again — this time holding the module as well.
      world!.repin(LATER_COMMIT);
      const run = await world!.service.run({ product: { name: PRODUCT, folder: world!.folder }, runId: 'run-server-2' });
      if (run.ok === false) throw new Error(`the fixture's second run was refused: ${run.code}: ${run.reason}`);
      let event = await nextEvent(stream, 1_000);
      while (event !== undefined && event.startsWith(':') && event.includes('event: pages') === false) event = await nextEvent(stream, 1_000);
      const elapsed = Date.now() - started;
      expect(event).toBeDefined();
      expect(event!).toContain('event: pages');
      const data = JSON.parse(event!.split('data: ')[1]!.split('\n')[0]!) as { seq: number; nodes: string[]; unit: string; generation: number; publication: string };
      expect(elapsed).toBeLessThan(1_000);
      // The module's page is the one that appeared, and the symbols whose facts the publication repeats come with it.
      expect(data.nodes).toContain(facts.module.id);
      expect(data.nodes).toContain(facts.placed.id);
      expect(data.unit).toBe('graph-fixture/src');
      expect(data.generation).toBe(2);
      expect(data.seq).toBeGreaterThan(after);
      // The package's page no publication of this run touched: the client is not asked to read it again.
      expect(data.nodes).not.toContain(packaged.id);
      // And the page the event named is really there now.
      const appeared = await answered(`/api/graph/page?id=${encodeURIComponent(facts.module.id)}`);
      expect((appeared.node as { label: string }).label).toBe('checkout');
    } finally {
      asking.abort();
    }
  }, 30_000);

  test('a stream asked for no sequence number starts from the product\'s latest change and replays nothing', async () => {
    const asking = new AbortController();
    const response = await fetch(`${url}/api/graph/events`, { signal: asking.signal });
    try {
      const stream = streamOf(response);
      const first = await nextEvent(stream, 2_000);
      expect(first).toBe('retry: 3000');
      // Nothing was published since, so the stream says nothing but its retry line: the next thing it holds is the
      // keep-alive comment or a publication, and the test ends here rather than waiting for one.
      const quiet = await nextEvent(stream, 300);
      expect(quiet).toBeUndefined();
    } finally {
      asking.abort();
    }
  }, 20_000);
});

describe('a stream whose changes cannot be read', () => {
  const makers = {
    json: (status: number, body: unknown) => Response.json(body, { status }),
    refused: (status: number, error: { message: string; field?: string }) => ({ response: Response.json({ message: error.message, error }, { status }) }),
    errorLog: (line: string) => lines.push(line),
  };

  /** A source whose change read always fails, with a cause that names a file, a line and a table. */
  const failing: GraphPagesSource = {
    pageSet: async () => ({ product: PRODUCT, pages: [], counts: [], total: 0, changeSeq: 0, readAt: 0, message: null }),
    page: async () => ({ ok: false, code: 'graph-pages/no-such-node', message: 'nothing' }),
    diagrams: async () => ({ ok: false, code: 'graph-pages/no-such-node', message: 'nothing' }),
    changes: async () => { throw new Error('/tmp/madarch-runtime/work/src/fill/graph-pages.ts:741:2: the changes failed on fill_page_change'); },
    subscribe: () => () => undefined,
  };

  test('a stream that was given a place to start logs the cause and writes a comment that names no path', async () => {
    lines.length = 0;
    const part = createGraphPagesPart(makers, failing);
    const asking = new AbortController();
    const handled = await part.events(new Request('http://127.0.0.1:1/api/graph/events?after=0', { signal: asking.signal }));
    // The stream is held open (it is a live channel): read what it wrote and hang up.
    const reader = handled.response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let read = 0; read < 4 && !text.includes('could not be read now'); read += 1) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    asking.abort();
    expect(text.startsWith('retry: 3000')).toBe(true);
    expect(text).toContain(': the changes after 0 could not be read now');
    expect(text).not.toContain('/tmp/');
    expect(lines.join('\n')).toContain('/tmp/madarch-runtime/work/src/fill/graph-pages.ts:741');
  });

  test('a stream asked for no place to start is refused with a 503 rather than replaying the product\'s whole history', async () => {
    lines.length = 0;
    const part = createGraphPagesPart(makers, failing);
    const handled = await part.events(new Request('http://127.0.0.1:1/api/graph/events', { signal: new AbortController().signal }));
    expect(handled.response.status).toBe(503);
    const body = (await handled.response.json()) as { message: string; error: { field?: string } };
    expect(body.error.field).toBe('after');
    expect(body.message).toContain('no place to start');
    expect(body.message).not.toContain('/tmp/');
    expect(lines.join('\n')).toContain('/tmp/madarch-runtime/work/src/fill/graph-pages.ts:741');
  });
});

describe('a server that holds no fill\'s graph', () => {
  test('answers the empty page set with the message saying where the pages are served, never an error', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-graph-pages-nograph-'));
    const app = builtApp();
    try {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: 3f6d2dc8-b16e-4bf0-9d3a-2c9c00b5287d\nname: No Graph\n');
      writeFileSync(join(folder, 'docs', 'vision.md'), '# Vision\n\nA product whose graph nobody filled.\n');
      const bare = await startServerDirect({ productFolder: folder, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
      try {
        const response = await fetch(`${bare.url}/api/graph/pages`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { pages: unknown[]; total: number; message: string };
        expect(body.pages).toEqual([]);
        expect(body.total).toBe(0);
        expect(body.message).toContain('no fill\'s graph');
        expect(body.message).toContain('madarch start');
        const page = await fetch(`${bare.url}/api/graph/page?id=${encodeURIComponent(`module:${'f'.repeat(64)}`)}`);
        expect(page.status).toBe(404);
        expect(((await page.json()) as { message: string }).message).toContain('no fill\'s graph');
      } finally {
        await bare.stop();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      if (app !== appFolder) rmSync(app, { recursive: true, force: true });
    }
  }, 30_000);
});
