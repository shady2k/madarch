import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { AsyncQueryDatabase } from '../src/query/types.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, createPGliteQueryDatabase, startServer, type DatabaseOwner, type StartedServer } from '../src/index.js';
import { createGraphs } from '../src/server/graphs.js';
import { createHandler } from '../src/server/http.js';
import { createSourceStores, type SourceStores } from '../src/server/sources.js';
import { PGlite } from '@electric-sql/pglite';
import { canonicalJsonDigest } from '../src/model/canonical.js';

const DAY = (day: number) => Date.UTC(2026, 8, day); // September 2026

function element(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], ...extra };
}

interface SentModel {
  schemaVersion: number;
  elements: Record<string, unknown>[];
  [field: string]: unknown;
}

function model(elements: Record<string, unknown>[], extra: Partial<Pick<SentModel, 'entities' | 'scenarios'>> = {}): SentModel {
  return { schemaVersion: 1, elements, interfaces: [], relations: [], categories: [], entities: [], scenarios: [], zones: [], environments: [], states: [{ id: 'as-is' }], ...extra };
}

/** A compiled model whose content must never appear in the logs. */
const SECRET_ELEMENT = 'very-secret-element-name';

/** The refusal body the server answers with, narrowed for real: a test handed anything else fails saying so. */
async function errorOf(response: Response): Promise<{ message: string; field?: string; accepted?: string }> {
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    throw new Error(`expected an {"error":{...}} body, got ${JSON.stringify(body)}`);
  }
  const error: unknown = body.error;
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') {
    throw new Error(`expected error.message to be a string, got ${JSON.stringify(error)}`);
  }
  const out: { message: string; field?: string; accepted?: string } = { message: error.message };
  if ('field' in error && typeof error.field === 'string') out.field = error.field;
  if ('accepted' in error && typeof error.accepted === 'string') out.accepted = error.accepted;
  return out;
}

/** The sources listing, narrowed the same way. */
async function sourcesOf(response: Response): Promise<{ source: string; id: string; commit: string; committedAt: string; storedAt: string }[]> {
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error(`expected an array of sources, got ${JSON.stringify(body)}`);
  const out: { source: string; id: string; commit: string; committedAt: string; storedAt: string }[] = [];
  for (const each of body) {
    if (typeof each !== 'object' || each === null) throw new Error(`expected a source object, got ${JSON.stringify(each)}`);
    for (const field of ['source', 'id', 'commit', 'committedAt', 'storedAt'] as const) {
      if (!(field in each) || typeof each[field] !== 'string') throw new Error(`expected a string "${field}", got ${JSON.stringify(each)}`);
    }
    out.push({ source: each.source, id: each.id, commit: each.commit, committedAt: each.committedAt, storedAt: each.storedAt });
  }
  return out;
}

let folder: string | undefined;
let server: StartedServer | undefined;
let lines: string[];
let errors: string[];
const clockNow = { value: DAY(10) };

/**
 * The bound of a case that starts a server and sends it a model: the server
 * keeps each source as a file-backed PGlite of its own (`src/server/sources.ts`)
 * beside the query projection the case is lent, and one PGlite is 1.66 s to boot
 * on the 2-CPU pod the tests run on (measured 2026-10-20, madarch-cznn), so a
 * case here takes 2.3-6 s where a case without a server takes half a second.
 */
const SERVER_MS = 15_000;

/**
 * The file's query database, one PGlite for every case: it holds the graphs'
 * projection, and each server the cases start is lent a database on it. One
 * PGlite is 1.66 s to boot on the 2-CPU pod the tests run on (measured
 * 2026-10-20, madarch-cznn: a bare instance 1.66 s, a schema 0.07 s more), and
 * a case's own projection is replaced source by source at every rebuild
 * (`sql-query-database.ts`'s `rebuild` replaces its scoped sources), so no case
 * reads another case's rows: no case asks a source it did not send or build.
 * The owner is closed after the file, as decision 0027 says the caller that
 * opened it does.
 */
let sharedQueryOwner: DatabaseOwner | undefined;

/** The file's query owner, opened on the first case that needs it (decision 0027: the caller that opened the owner closes it, never the adapters lent it). */
function queryOwner(): DatabaseOwner {
  sharedQueryOwner ??= createPGliteDatabaseOwner({ vector: true });
  return sharedQueryOwner;
}

afterAll(async () => {
  await sharedQueryOwner?.close();
  sharedQueryOwner = undefined;
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (folder !== undefined) {
    rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  }
});

/** Test/local composition explicitly selects PGlite and injects the shared query owner. */
async function startLocalServer(options: Omit<Parameters<typeof startServer>[0], 'queryDatabase'>): Promise<StartedServer> {
  return startServer({ ...options, queryDatabase: await createPGliteQueryDatabase({ owner: queryOwner(), clock: options.clock }) });
}

/** A history-only query owner that fails if a source-history test accidentally starts a graph query. */
function historyOnlyQueryDatabase(): AsyncQueryDatabase {
  return {
    forSources: () => { throw new Error('history-only server test unexpectedly opened a graph query'); },
    vectorIndexForSources: () => { throw new Error('history-only server test unexpectedly opened a vector index'); },
    close: async () => {},
  };
}

/** A server on a free port over a scratch folder, with a held clock and captured logs; returns its base URL. */
async function start(queryDatabase?: AsyncQueryDatabase): Promise<string> {
  folder = mkdtempSync(join(tmpdir(), 'madarch-server-http-'));
  lines = [];
  errors = [];
  const options = {
    dataFolder: folder,
    port: 0,
    clock: { now: () => clockNow.value },
    log: (line: string) => lines.push(line),
    errorLog: (line: string) => errors.push(line),
  };
  server = queryDatabase === undefined
    ? await startLocalServer(options)
    : await startServer({ ...options, queryDatabase });
  return server.url;
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${server!.url}${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(Array.isArray(body) || body === null ? body : { protocol: 1, ...(body as Record<string, unknown>) }), headers: { 'content-type': 'application/json' } });
}

function send(source: string, commit: string, committedAt: string, elements: Record<string, unknown>[]): Promise<Response> {
  return post('/models', { protocol: 1, source, commit, committedAt, model: model(elements) });
}

describe('server query database owner', () => {
  test('an invalid startup option closes the injected shared query database', async () => {
    const database = await createPGliteQueryDatabase({ owner: queryOwner() });
    let closed = false;
    const queryDatabase = {
      forSources(sources: readonly string[]) { return database.forSources(sources); },
      vectorIndexForSources(sources: readonly string[]) { return database.vectorIndexForSources(sources); },
      async close() { closed = true; await database.close(); },
    };

    await expect(startServer({ queryDatabase, port: 0 })).rejects.toThrow('neither a data folder nor a product folder');
    expect(closed).toBe(true);
  }, SERVER_MS);

  test('model routes require an explicitly injected shared query database', async () => {
    folder = mkdtempSync(join(tmpdir(), 'madarch-server-http-no-query-db-'));
    await expect(startServer({ dataFolder: folder, port: 0 })).rejects.toThrow('pass queryDatabase explicitly');
  });

  test('startup validation closes the injected shared query database', async () => {
    folder = mkdtempSync(join(tmpdir(), 'madarch-server-http-invalid-product-'));
    const database = await createPGliteQueryDatabase({ owner: queryOwner() });
    let closed = false;
    const queryDatabase = {
      forSources(sources: readonly string[]) { return database.forSources(sources); },
      vectorIndexForSources(sources: readonly string[]) { return database.vectorIndexForSources(sources); },
      async close() { closed = true; await database.close(); },
    };

    await expect(startServer({ dataFolder: folder, productFolder: folder, queryDatabase, port: 0 })).rejects.toThrow('cannot be served as a wiki');
    expect(closed).toBe(true);
  });

  test('model routes use and close the injected shared query database', async () => {
    folder = mkdtempSync(join(tmpdir(), 'madarch-server-http-query-db-'));
    const database = await createPGliteQueryDatabase({ owner: queryOwner() });
    let facadeCount = 0;
    let closeCount = 0;
    const queryDatabase = {
      forSources(sources: readonly string[]) {
        facadeCount++;
        return database.forSources(sources);
      },
      vectorIndexForSources(sources: readonly string[]) {
        return database.vectorIndexForSources(sources);
      },
      async close() {
        closeCount++;
        await database.close();
      },
    };
    server = await startServer({ dataFolder: folder, queryDatabase, port: 0, log: () => {}, errorLog: () => {} });
    expect((await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')])).status).toBe(201);
    expect((await post('/views', { source: 'shop', format: 'mermaid' })).status).toBe(200);
    expect(facadeCount).toBeGreaterThan(0);
    await server.stop();
    server = undefined;
    expect(closeCount).toBe(1);
  }, SERVER_MS);
});

describe('protocol versions', () => {
  test('version 1 requests are served and every answer names the server version', async () => {
    await start();
    const stored = await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(stored.status).toBe(201);
    expect(stored.headers.get('protocol')).toBe('1');
    const listed = await fetch(`${server!.url}/sources`);
    expect(listed.headers.get('protocol')).toBe('1');
    const viewed = await post('/views', { source: 'shop', format: 'mermaid' });
    expect(viewed.headers.get('protocol')).toBe('1');
  });

  test('version 0 is refused before other fields are checked or stored', async () => {
    await start();
    lines = [];
    const response = await post('/models', { protocol: 0, unknown: true });
    expect(response.status).toBe(400);
    expect(response.headers.get('protocol')).toBe('1');
    const error = await errorOf(response);
    expect(error.field).toBe('protocol');
    expect(error.accepted).toBe('[1, 1]');
    expect(error.message).not.toContain('unknown');
    expect(await sourcesOf(await fetch(`${server!.url}/sources`))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('POST /models'))).toHaveLength(1);
  });

  test('a missing protocol is refused naming the field', async () => {
    await start();
    const response = await fetch(`${server!.url}/models`, {
      method: 'POST',
      body: JSON.stringify({ source: 'shop' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).field).toBe('protocol');
  });
});
describe('POST /models', () => {
  test('a new model is stored, answering 201 with the source and the commit', async () => {
    await start();
    const response = await send('github.com/acme/shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toStartWith('application/json');
    expect(await response.json()).toEqual({ stored: true, source: 'github.com/acme/shop', commit: 'c1' });
  });

  test('sending the same commit again answers already stored and changes nothing', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const sourcesBefore = await (await fetch(`${server!.url}/sources`)).text();

    const response = await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: false, reason: 'already stored', source: 'shop', commit: 'c1' });

    const sourcesAfter = await (await fetch(`${server!.url}/sources`)).text();
    expect(sourcesAfter).toBe(sourcesBefore);
  });

  test('the same commit with another time is refused with 409 naming the commit', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const response = await send('shop', 'c1', '2026-09-02T12:00:00Z', [element('a')]);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain('c1');
  });

  test('the same commit with another model is refused with both canonical digests and leaves the stored model unchanged', async () => {
    await start();
    const storedModel = model([element('a')]);
    const incomingModel = model([element('a'), element('b')]);
    await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: storedModel });
    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: incomingModel });
    expect(response.status).toBe(409);
    const message = (await errorOf(response)).message;
    expect(message).toContain('shop');
    expect(message).toContain('c1');
    expect(message).toContain(canonicalJsonDigest(storedModel));
    expect(message).toContain(canonicalJsonDigest(incomingModel));
    expect((await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: storedModel })).status).toBe(200);
  });
  test('a resent model with reordered arrays is refused even when its assertions are unchanged', async () => {
    await start();
    const storedModel = model([element('a'), element('b')]);
    const incomingModel = model([element('b'), element('a')]);
    await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: storedModel });

    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: incomingModel });

    expect(response.status).toBe(409);
    const message = (await errorOf(response)).message;
    expect(message).toContain(canonicalJsonDigest(storedModel));
    expect(message).toContain(canonicalJsonDigest(incomingModel));
  });

  test('a model whose element lacks kind is refused naming the element path and kind, and the source is not stored', async () => {
    await start();
    const response = await send('shop', 'c1', '2026-09-01T12:00:00Z', [{ id: 'a', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] }]);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('/elements/0');
    expect(error.message).toContain('kind');
    expect(error.field).toBe('model');

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toEqual([]);
  });

  test('a model with an unknown field is refused naming the field path', async () => {
    await start();
    const sent = model([element('a')]);
    sent.elements[0]!.oops = 1;
    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: sent });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('/elements/0/oops');
  });

  test('a kind of another spelling is refused naming what kind accepts', async () => {
    await start();
    const response = await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a', { kind: 'Service' })]);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('/elements/0/kind');
    expect(error.message).toContain('"service"');
  });

  test('a model that is not an object is refused naming its type, never its value', async () => {
    await start();
    lines = [];
    for (const bad of [['secret'], 'secret', 7, true, null]) {
      const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: bad });
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.field).toBe('model');
      expect(error.message).toMatch(/of type (array|string|number|boolean|null)/);
      expect(error.message).not.toContain('secret');
    }
    expect(lines.join('\n')).not.toContain('secret');
  });

  test('several missing fields are refused together, not stopped at the first', async () => {
    await start();
    const response = await post('/models', { model: model([element('a')]) });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('"source"');
    expect(error.message).toContain('"commit"');
    expect(error.message).toContain('"committedAt"');
    expect(error.message).not.toContain('"model"');
  });

  test('a committedAt without an offset is refused naming the field and what is accepted', async () => {
    await start();
    for (const bad of ['2026-09-01', '2026-09-01T12:00:00', 'yesterday', '2026-13-01T12:00:00Z', '2026-09-01T25:00:00Z']) {
      const response = await send('shop', 'c1', bad, [element('a')]);
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.field).toBe('committedAt');
      expect(error.accepted).toContain('ISO 8601');
      expect(error.message).toContain(JSON.stringify(bad));
    }
  });

  test('a committedAt with an offset is stored at its UTC time', async () => {
    await start();
    const response = await send('shop', 'c1', '2026-09-01T14:30:00+02:00', [element('a')]);
    expect(response.status).toBe(201);
    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.committedAt).toBe('2026-09-01T12:30:00.000Z');
  });

  test('a body that is not JSON, or not an object, is refused', async () => {
    await start();
    const notJson = await post('/models', '{not json');
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).message).toContain('not valid JSON');

    const array = await post('/models', [1, 2]);
    expect(array.status).toBe(400);
    expect((await errorOf(array)).field).toBe('protocol');
  });

  test('a body past the size limit is refused with 413 naming the limit', async () => {
    await start();
    const response = await post('/models', 'x'.repeat(51 * 1024 * 1024));
    expect(response.status).toBe(413);
    expect((await errorOf(response)).message).toContain('50 MB');
  });

  test('a source whose name would make a too-long file name is refused naming the limit', async () => {
    await start();
    const response = await send('x'.repeat(201), 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('200');
  });

  test('a source name with separators is stored inside the data folder, never outside', async () => {
    await start();
    const response = await send('../../outside', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(201);
    expect(existsSync(join(folder!, '..%2F..%2Foutside.pglite'))).toBe(true);
  });
});

describe('unknown request fields', () => {
  test('a store request holding a field the server does not take is refused naming it and what is accepted', async () => {
    await start();
    const response = await post('/models', { source: 'shop', format: 'mermaid', depht: 2, commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: model([element('a')]) });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('"depht"');
    expect(error.message).toContain('"format"');
    expect(error.message).toContain('accepted fields are protocol, source, commit, committedAt, model');
  });

  test('a view request with a misspelled field is refused, not answered as the landscape', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const response = await post('/views', { source: 'shop', formatt: 'mermaid' });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('"formatt"');
    expect(error.message).toContain('accepted fields are protocol, source, element, depth, format');
  });
});
describe('two sources that both declare core', () => {
  test('both are stored, each in its own graph, and both are listed in code point order', async () => {
    await start();
    await send('github.com/acme/second', 'c2', '2026-09-02T12:00:00Z', [element('core')]);
    await send('github.com/acme/first', 'c1', '2026-09-01T12:00:00Z', [element('core')]);

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources.map((s) => s.source)).toEqual(['github.com/acme/first', 'github.com/acme/second']);
    expect(sources[0]).toEqual({ id: expect.any(String), source: 'github.com/acme/first', commit: 'c1', committedAt: '2026-09-01T12:00:00.000Z', storedAt: '2026-09-10T00:00:00.000Z' });
    expect(sources[1]!.storedAt).toBe('2026-09-10T00:00:00.000Z');
  }, SERVER_MS);
});

describe('source ids', () => {
  test('GET /sources lists the id beside the name, and two sources hold different ids', async () => {
    await start();
    await send('github.com/acme/first', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    await send('github.com/acme/second', 'c2', '2026-09-02T12:00:00Z', [element('b')]);

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    for (const each of sources) {
      expect(each.id.length).toBeGreaterThan(0);
      expect(each.id).not.toBe(each.source);
      expect(each.id).not.toContain(each.source);
    }
    expect(sources[0]!.id).not.toBe(sources[1]!.id);
  }, SERVER_MS);

  test('a source keeps its id across sends and a restart', async () => {
    await start();
    await send('github.com/acme/shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    await send('github.com/acme/shop', 'c2', '2026-09-02T12:00:00Z', [element('b')]);
    const id = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!.id;
    const port = server!.port;
    await server?.stop();
    server = undefined;

    server = await startLocalServer({
      dataFolder: folder!,
      port,
      clock: { now: () => clockNow.value },
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line),
    });
    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.source).toBe('github.com/acme/shop');
    expect(sources[0]!.id).toBe(id);
  });
});

describe('POST /sources — the rename claim', () => {
  test('a claim binds a new name to the existing id, and the listing keeps the head', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const id = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!.id;

    const response = await post('/sources', { id, source: 'github.com/acme/shop' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ renamed: true, source: 'github.com/acme/shop', formerSource: 'shop', id });

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toEqual([{ id, source: 'github.com/acme/shop', commit: 'c1', committedAt: '2026-09-01T12:00:00.000Z', storedAt: '2026-09-10T00:00:00.000Z' }]);
  });

  test('a claim for an unknown id is refused naming it and what the server holds', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const id = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!.id;

    const response = await post('/sources', { id: 'no-such-id', source: 'moved' });
    expect(response.status).toBe(404);
    const error = await errorOf(response);
    expect(error.field).toBe('id');
    expect(error.message).toContain('no-such-id');
    expect(error.message).toContain(id);
    expect(error.message).toContain('"shop"');
  });

  test('a claim whose new name is another source\'s name is refused naming both, and nothing moves', async () => {
    await start();
    await send('github.com/acme/first', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    await send('github.com/acme/second', 'c1', '2026-09-01T12:00:00Z', [element('b')]);
    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    const first = sources.find((each) => each.source === 'github.com/acme/first')!;

    const response = await post('/sources', { id: first.id, source: 'github.com/acme/second' });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('github.com/acme/first');
    expect(error.message).toContain('github.com/acme/second');

    expect((await sourcesOf(await fetch(`${server!.url}/sources`))).map((each) => each.source)).toEqual(['github.com/acme/first', 'github.com/acme/second']);
  }, SERVER_MS);

  test('a claim repeating the source\'s own name answers already the name and changes nothing', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;
    const before = await (await fetch(`${server!.url}/sources`)).text();

    const response = await post('/sources', { id, source: 'shop' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ renamed: false, reason: 'already the name', source: 'shop', id });

    expect(await (await fetch(`${server!.url}/sources`)).text()).toBe(before);
  }, SERVER_MS);
  test('retrying a rename after its sidecar write failed repairs the sidecar and rebuilds views', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;
    expect((await post('/views', { source: 'shop', format: 'mermaid' })).status).toBe(200);
    mkdirSync(join(folder!, 'renamed.json.tmp'));

    expect((await post('/sources', { id, source: 'renamed' })).status).toBe(500);
    rmdirSync(join(folder!, 'renamed.json.tmp'));
    const retry = await post('/sources', { id, source: 'renamed' });

    expect(retry.status).toBe(200);
    expect(JSON.parse(readFileSync(join(folder!, 'renamed.json'), 'utf8'))).toEqual({
      source: 'renamed',
      id,
      commit: 'c1',
      committedAt: Date.parse('2026-09-01T12:00:00Z'),
      storedAt: DAY(10),
      formerNames: ['shop'],
    });
    expect((await post('/views', { source: 'renamed', format: 'mermaid' })).status).toBe(200);
  });

  test('missing and unknown fields are refused like on every request', async () => {
    await start();
    const missing = await post('/sources', {});
    expect(missing.status).toBe(400);
    const missingError = await errorOf(missing);
    expect(missingError.message).toContain('"id"');
    expect(missingError.message).toContain('"source"');

    const unknown = await post('/sources', { id: 'x', source: 'y', rename: true });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).message).toContain('accepted fields are protocol, id, source');
  });

  test('a new name that cannot be a source name is refused naming the field', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;

    const response = await post('/sources', { id, source: 'a\nb' });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('control character');
  });

  test('after a claim the views answer under the new name, byte-identical to the old name\'s answers', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a'), element('b'), element('c')]);
    const viewOf = async (source: string, body: Record<string, unknown>) => await (await post('/views', { source, ...body })).text();
    const mermaidBefore = await viewOf('shop', { format: 'mermaid' });
    const likec4Before = await viewOf('shop', { format: 'likec4', element: 'b', depth: 2 });
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;

    expect((await post('/sources', { id, source: 'moved' })).status).toBe(200);

    expect(await viewOf('moved', { format: 'mermaid' })).toBe(mermaidBefore);
    expect(await viewOf('moved', { format: 'likec4', element: 'b', depth: 2 })).toBe(likec4Before);
  });

  test('sending under the old name after the claim is refused explaining the rename, and creates no second source', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;
    expect((await post('/sources', { id, source: 'moved' })).status).toBe(200);

    const response = await send('shop', 'c2', '2026-09-02T12:00:00Z', [element('b')]);
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('"shop"');
    expect(error.message).toContain('"moved"');

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toEqual([{ id, source: 'moved', commit: 'c1', committedAt: '2026-09-01T12:00:00.000Z', storedAt: '2026-09-10T00:00:00.000Z' }]);
  });

  test('a view under the old name after the claim is refused explaining the rename', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;
    expect((await post('/sources', { id, source: 'moved' })).status).toBe(200);

    const response = await post('/views', { source: 'shop', format: 'mermaid' });
    expect(response.status).toBe(404);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('"moved"');
  });

  test('a claim whose new name was renamed away from another source is refused naming both', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    await send('other', 'c1', '2026-09-01T12:00:00Z', [element('b')]);
    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    const shop = sources.find((each) => each.source === 'shop')!;
    const other = sources.find((each) => each.source === 'other')!;
    expect((await post('/sources', { id: shop.id, source: 'moved' })).status).toBe(200);

    const response = await post('/sources', { id: other.id, source: 'shop' });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.message).toContain('"shop"');
    expect(error.message).toContain('"moved"');
    expect(error.message).toContain(shop.id);
  });

  test('a claim giving a source one of its own former names back renames it again', async () => {
    await start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;
    expect((await post('/sources', { id, source: 'moved' })).status).toBe(200);
    expect((await post('/sources', { id, source: 'again' })).status).toBe(200);

    const back = await post('/sources', { id, source: 'shop' });
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ renamed: true, source: 'shop', formerSource: 'again', id });

    expect((await sourcesOf(await fetch(`${server!.url}/sources`))).map((each) => each.source)).toEqual(['shop']);
    for (const old of ['moved', 'again']) {
      const refused = await send(old, 'c9', '2026-09-09T12:00:00Z', [element('z')]);
      expect(refused.status).toBe(409);
      expect((await errorOf(refused)).message).toContain('"shop"');
    }
  }, SERVER_MS);

  test('one source renamed several times: every former name explains the rename to the newest', async () => {
    await start();
    await send('a', 'c1', '2026-09-01T12:00:00Z', [element('x')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;
    expect((await post('/sources', { id, source: 'b' })).status).toBe(200);
    expect((await post('/sources', { id, source: 'c' })).status).toBe(200);

    for (const old of ['a', 'b']) {
      const refused = await send(old, 'c2', '2026-09-02T12:00:00Z', [element('y')]);
      expect(refused.status).toBe(409);
      expect((await errorOf(refused)).message).toContain('"c"');
    }
    expect((await sourcesOf(await fetch(`${server!.url}/sources`))).map((each) => each.source)).toEqual(['c']);
  }, SERVER_MS);

  test('the rename survives a restart: the new name and the id stay, the old name stays retired', async () => {
    await start(historyOnlyQueryDatabase());
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const { id } = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!;
    expect((await post('/sources', { id, source: 'moved' })).status).toBe(200);
    const port = server!.port;
    await server?.stop();
    server = undefined;

    server = await startServer({
      dataFolder: folder!,
      port,
      clock: { now: () => clockNow.value },
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line),
      queryDatabase: historyOnlyQueryDatabase(),
    });

    expect(await sourcesOf(await fetch(`${server!.url}/sources`))).toEqual([
      { id, source: 'moved', commit: 'c1', committedAt: '2026-09-01T12:00:00.000Z', storedAt: '2026-09-10T00:00:00.000Z' },
    ]);
    const underOld = await send('shop', 'c2', '2026-09-02T12:00:00Z', [element('b')]);
    expect(underOld.status).toBe(409);
    expect((await errorOf(underOld)).message).toContain('"moved"');
  }, SERVER_MS);
});

describe('unknown paths and methods', () => {
  test('an unknown path is 404 saying what the server offers', async () => {
    await start();
    const response = await fetch(`${server!.url}/nope`);
    expect(response.status).toBe(404);
    const message = (await errorOf(response)).message;
    expect(message).toContain('/nope');
    expect(message).toContain('POST /models');
    expect(message).toContain('GET /sources');
  });

  test('a wrong method on a known path is 405 saying what answers it', async () => {
    await start();
    const get = await fetch(`${server!.url}/models`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await errorOf(get)).message).toContain('POST');

    const posted = await fetch(`${server!.url}/sources`, { method: 'DELETE' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('POST, GET');
  });
});

describe('restart on the same data folder', () => {
  test('the sources are listed the same after a stop and a new start on the same port', async () => {
    await start();
    await send('github.com/acme/shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    await send('github.com/acme/shop', 'c2', '2026-09-02T12:00:00Z', [element('b')]);
    const before = await (await fetch(`${server!.url}/sources`)).text();
    const port = server!.port;
    await server?.stop();
    server = undefined;

    server = await startLocalServer({
      dataFolder: folder!,
      port,
      clock: { now: () => clockNow.value },
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line),
    });
    expect(server.port).toBe(port);
    const after = await (await fetch(`${server.url}/sources`)).text();
    expect(after).toBe(before);
  }, { timeout: 15_000 });
});

describe('a retry after a failed sidecar write', () => {
  test('the repaired head carries the original store\'s moment, never the retry\'s clock, and the source keeps its id', async () => {
    await start();
    expect((await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')])).status).toBe(201);
    const idBefore = (await sourcesOf(await fetch(`${server!.url}/sources`)))[0]!.id;

    // Sabotage at the file-system boundary: the sidecar's own temporary
    // path is a folder, so the history stores the commit and the sidecar
    // write then fails.
    mkdirSync(join(folder!, 'shop.json.tmp'));
    expect((await send('shop', 'c2', '2026-09-02T12:00:00Z', [element('b')])).status).toBe(500);
    rmdirSync(join(folder!, 'shop.json.tmp'));

    clockNow.value = DAY(20);
    const retry = await send('shop', 'c2', '2026-09-02T12:00:00Z', [element('b')]);
    expect(retry.status).toBe(200);

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toEqual([
      { id: idBefore, source: 'shop', commit: 'c2', committedAt: '2026-09-02T12:00:00.000Z', storedAt: '2026-09-10T00:00:00.001Z' },
    ]);
  });

  test('older send after the first sidecar failure leaves the history head listed', async () => {
    await start();
    mkdirSync(join(folder!, 'shop.json.tmp'));

    expect((await send('shop', 'c2', '2026-09-02T12:00:00Z', [element('newer')])).status).toBe(500);
    rmdirSync(join(folder!, 'shop.json.tmp'));
    expect((await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('older')])).status).toBe(201);

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toHaveLength(1);
    expect(sources[0]?.commit).toBe('c2');
    expect(sources[0]?.committedAt).toBe('2026-09-02T12:00:00.000Z');
  });
});


describe('the log', () => {
  test('one line per request: method, path, status, source and milliseconds', async () => {
    await start();
    lines = [];
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element(SECRET_ELEMENT)]);
    await fetch(`${server!.url}/sources`);
    await fetch(`${server!.url}/nope`);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^POST \/models 201 source="shop" \d+ms$/);
    expect(lines[1]).toMatch(/^GET \/sources 200 \d+ms$/);
    expect(lines[2]).toMatch(/^GET \/nope 404 \d+ms/);
    expect(lines.join('\n')).not.toContain(SECRET_ELEMENT);
  });

  test('a refusal adds its message to the line', async () => {
    await start();
    lines = [];
    await send('shop', 'c1', 'not a time', [element('a')]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^POST \/models 400 source="shop" \d+ms: /);
    expect(lines[0]).toContain('ISO 8601');
  });

  test('a source name holding a control character is refused, and the log stays one line per request', async () => {
    await start();
    lines = [];
    const response = await send('a\nb', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('control character');

    expect(lines).toHaveLength(1);
    expect(lines[0]!.includes('\n')).toBe(false);
    expect(lines[0]).toContain('source="a\\nb"');
  });

  test('a refusal about the model keeps its values out of the log line', async () => {
    await start();
    lines = [];
    const sent = model([element('a', { kind: 'secret-kind' })]);
    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: sent });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('secret-kind');
    expect(lines.join('\n')).not.toContain('secret-kind');
    expect(lines[0]).toContain('/elements/0/kind');
  });

  test('an unknown field name holding a newline leaves exactly one log line', async () => {
    await start();
    lines = [];
    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: model([element('a')]), 'a\nb': 1 });
    expect(response.status).toBe(400);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('a\\nb');
    expect(lines[0]!.includes('\n')).toBe(false);
  });

  test('a commit id holding a newline is named in the 409 and still leaves exactly one log line', async () => {
    await start();
    await send('shop', 'c\n1', '2026-09-01T12:00:00Z', [element('a')]);
    lines = [];

    const response = await send('shop', 'c\n1', '2026-09-02T12:00:00Z', [element('a')]);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain('c\n1');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('c\\n1');
    expect(lines[0]!.includes('\n')).toBe(false);
  });

  test('an error-level line is one physical line too, its stack escaped', async () => {
    await start();
    mkdirSync(join(folder!, 'shop.json.tmp')); // the sidecar write fails; the history stored the commit
    errors = [];
    const response = await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.includes('\n')).toBe(false);
    expect(errors[0]).toContain('\\n');
    rmdirSync(join(folder!, 'shop.json.tmp'));
  });
});

describe('a failing history read', () => {
  test('answers 500 and reaches the error log with its cause', async () => {
    await start(historyOnlyQueryDatabase());
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);

    // A row written outside the store: the read's clash safety net
    // refuses the source's model, and the view cannot be answered.
    const dataFolder = folder!;
    await server!.stop();
    server = undefined;
    const raw = new PGlite(join(dataFolder, 'shop.pglite'));
    await raw.waitReady;
    await raw.query(
      `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
       VALUES ('shop', 'element', 'a', $1, $2, NULL, 'outside', NULL, $3, NULL)`,
      [JSON.stringify({ id: 'a', kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], technology: 'injected' }), DAY(1), DAY(1)],
    );
    await raw.close();
    server = await startServer({ dataFolder, port: 0, clock: { now: () => clockNow.value }, log: (line) => lines.push(line), errorLog: (line) => errors.push(line), queryDatabase: historyOnlyQueryDatabase() });

    errors = [];
    const response = await post('/views', { source: 'shop', format: 'mermaid' });
    expect(response.status).toBe(500);
    expect((await errorOf(response)).message).toContain('could not be read');
    expect(errors.join('\n')).toContain('could not be read');
  });
});


describe('concurrent model and view requests', () => {
  test('a view waits for a stored model to reach its graph before reading', async () => {
    const dataFolder = mkdtempSync(join(tmpdir(), 'madarch-server-http-race-'));
    let now = DAY(10);
    const clock = { now: () => now };
    const realSources = await createSourceStores({ dataFolder, clock, log: () => {} });
    let releaseStore!: () => void;
    const storeGate = new Promise<void>((resolve) => { releaseStore = resolve; });
    let signalStored!: () => void;
    const storedAtGate = new Promise<void>((resolve) => { signalStored = resolve; });
    const sources: SourceStores = {
      ...realSources,
      async store(input) {
        const stored = await realSources.store(input);
        if (input.commit === 'c2') {
          // Hold after the history/head update but before the handler applies the graph report.
          signalStored();
          await storeGate;
        }
        return stored;
      },
    };
    const queryDatabase = await createPGliteQueryDatabase({ owner: queryOwner() });
    const graphs = createGraphs({ historyOf: (source) => realSources.historyOf(source), database: queryDatabase });
    const handler = createHandler({ sources, graphs, log: () => {}, errorLog: () => {} });
    let pendingStore: Promise<Response> | undefined;
    let pendingView: Promise<Response> | undefined;
    const request = (path: string, body: Record<string, unknown>) => new Request(`http://test${path}`, {
      method: 'POST',
      body: JSON.stringify({ protocol: 1, ...body }),
      headers: { 'content-type': 'application/json' },
    });
    try {
      const initial = await handler(request('/models', {
        source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: model([element('a')]),
      }));
      expect(initial.status).toBe(201);
      const before = await handler(request('/views', { source: 'shop', format: 'mermaid' }));
      expect(before.status).toBe(200);
      const beforeText = await before.text();

      now = DAY(11);
      pendingStore = handler(request('/models', {
        source: 'shop', commit: 'c2', committedAt: '2026-09-02T12:00:00Z', model: model([element('b')]),
      }));
      await storedAtGate;

      let viewBodyRead = false;
      const viewBody = JSON.stringify({ protocol: 1, source: 'shop', format: 'mermaid' });
      const viewRequest = new Request('http://test/views', {
        method: 'POST', body: viewBody, headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(viewRequest, 'text', {
        value: async () => { viewBodyRead = true; return viewBody; },
      });
      pendingView = handler(viewRequest);
      expect(viewBodyRead).toBe(false);

      releaseStore();
      const [stored, viewed] = await Promise.all([pendingStore, pendingView]);
      expect(stored.status).toBe(201);
      expect(viewed.status).toBe(200);
      const current = await realSources.historyOf('shop').read({ source: 'shop', valid: now, known: now });
      expect(current.model?.elements.map((each) => each.id)).toEqual(['b']);
      const afterText = await (await handler(request('/views', { source: 'shop', format: 'mermaid' }))).text();
      expect(await viewed.text()).toBe(afterText);
      expect(afterText).not.toBe(beforeText);
    } finally {
      releaseStore();
      await Promise.allSettled([...(pendingStore === undefined ? [] : [pendingStore]), ...(pendingView === undefined ? [] : [pendingView])]);
      await handler.drain();
      await graphs.close();
      await queryDatabase.close();
      await realSources.close();
      rmSync(dataFolder, { recursive: true, force: true });
    }
  });
});
