import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/index.js';
import { Database } from 'bun:sqlite';

const DAY = (day: number) => Date.UTC(2026, 8, day); // September 2026

function element(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], ...extra };
}

interface SentModel {
  schemaVersion: number;
  elements: Record<string, unknown>[];
  [field: string]: unknown;
}

function model(elements: Record<string, unknown>[]): SentModel {
  return { schemaVersion: 1, elements, interfaces: [], relations: [], categories: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
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
async function sourcesOf(response: Response): Promise<{ source: string; commit: string; committedAt: string; storedAt: string }[]> {
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error(`expected an array of sources, got ${JSON.stringify(body)}`);
  const out: { source: string; commit: string; committedAt: string; storedAt: string }[] = [];
  for (const each of body) {
    if (typeof each !== 'object' || each === null) throw new Error(`expected a source object, got ${JSON.stringify(each)}`);
    for (const field of ['source', 'commit', 'committedAt', 'storedAt'] as const) {
      if (!(field in each) || typeof each[field] !== 'string') throw new Error(`expected a string "${field}", got ${JSON.stringify(each)}`);
    }
    out.push({ source: each.source, commit: each.commit, committedAt: each.committedAt, storedAt: each.storedAt });
  }
  return out;
}

let folder: string | undefined;
let server: StartedServer | undefined;
let lines: string[];
let errors: string[];
const clockNow = { value: DAY(10) };

afterEach(() => {
  server?.stop();
  server = undefined;
  if (folder !== undefined) {
    rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  }
});

/** A server on a free port over a scratch folder, with a held clock and captured logs; returns its base URL. */
function start(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-server-http-'));
  lines = [];
  errors = [];
  server = startServer({
    dataFolder: folder,
    port: 0,
    clock: { now: () => clockNow.value },
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line),
  });
  return server.url;
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${server!.url}${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

function send(source: string, commit: string, committedAt: string, elements: Record<string, unknown>[]): Promise<Response> {
  return post('/models', { source, commit, committedAt, model: model(elements) });
}

describe('POST /models', () => {
  test('a new model is stored, answering 201 with the source and the commit', async () => {
    start();
    const response = await send('github.com/shady2k/nocx', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toStartWith('application/json');
    expect(await response.json()).toEqual({ stored: true, source: 'github.com/shady2k/nocx', commit: 'c1' });
  });

  test('sending the same commit again answers already stored and changes nothing', async () => {
    start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const sourcesBefore = await (await fetch(`${server!.url}/sources`)).text();

    const response = await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: false, reason: 'already stored', source: 'shop', commit: 'c1' });

    const sourcesAfter = await (await fetch(`${server!.url}/sources`)).text();
    expect(sourcesAfter).toBe(sourcesBefore);
  });

  test('the same commit with another time is refused with 409 naming the commit', async () => {
    start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const response = await send('shop', 'c1', '2026-09-02T12:00:00Z', [element('a')]);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain('c1');
  });

  test('the same commit with another model is refused with 409 naming the commit', async () => {
    start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const response = await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a'), element('b')]);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain('c1');
  });

  test('a model whose element lacks kind is refused naming the element path and kind, and the source is not stored', async () => {
    start();
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
    start();
    const sent = model([element('a')]);
    sent.elements[0]!.oops = 1;
    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: sent });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('/elements/0/oops');
  });

  test('a kind of another spelling is refused naming what kind accepts', async () => {
    start();
    const response = await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a', { kind: 'Service' })]);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('/elements/0/kind');
    expect(error.message).toContain('"service"');
  });

  test('a model that is not an object is refused naming its type, never its value', async () => {
    start();
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
    start();
    const response = await post('/models', { model: model([element('a')]) });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('"source"');
    expect(error.message).toContain('"commit"');
    expect(error.message).toContain('"committedAt"');
    expect(error.message).not.toContain('"model"');
  });

  test('a committedAt without an offset is refused naming the field and what is accepted', async () => {
    start();
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
    start();
    const response = await send('shop', 'c1', '2026-09-01T14:30:00+02:00', [element('a')]);
    expect(response.status).toBe(201);
    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.committedAt).toBe('2026-09-01T12:30:00.000Z');
  });

  test('a body that is not JSON, or not an object, is refused', async () => {
    start();
    const notJson = await post('/models', '{not json');
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).message).toContain('not valid JSON');

    const array = await post('/models', [1, 2]);
    expect(array.status).toBe(400);
    expect((await errorOf(array)).message).toContain('JSON object');
  });

  test('a body past the size limit is refused with 413 naming the limit', async () => {
    start();
    const response = await post('/models', 'x'.repeat(51 * 1024 * 1024));
    expect(response.status).toBe(413);
    expect((await errorOf(response)).message).toContain('50 MB');
  });

  test('a source whose name would make a too-long file name is refused naming the limit', async () => {
    start();
    const response = await send('x'.repeat(201), 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('200');
  });

  test('a source name with separators is stored inside the data folder, never outside', async () => {
    start();
    const response = await send('../../outside', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    expect(response.status).toBe(201);
    expect(await Bun.file(join(folder!, '..%2F..%2Foutside.sqlite')).exists()).toBe(true);
  });
});

describe('unknown request fields', () => {
  test('a store request holding a field the server does not take is refused naming it and what is accepted', async () => {
    start();
    const response = await post('/models', { source: 'shop', format: 'mermaid', depht: 2, commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: model([element('a')]) });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('"depht"');
    expect(error.message).toContain('"format"');
    expect(error.message).toContain('accepted fields are source, commit, committedAt, model');
  });

  test('a view request with a misspelled field is refused, not answered as the landscape', async () => {
    start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    const response = await post('/views', { source: 'shop', formatt: 'mermaid' });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.message).toContain('"formatt"');
    expect(error.message).toContain('accepted fields are source, element, depth, format');
  });
});
describe('two sources that both declare core', () => {
  test('both are stored, each in its own graph, and both are listed in code point order', async () => {
    start();
    await send('github.com/b/second', 'c2', '2026-09-02T12:00:00Z', [element('core')]);
    await send('github.com/a/first', 'c1', '2026-09-01T12:00:00Z', [element('core')]);

    const sources = await sourcesOf(await fetch(`${server!.url}/sources`));
    expect(sources.map((s) => s.source)).toEqual(['github.com/a/first', 'github.com/b/second']);
    expect(sources[0]).toEqual({ source: 'github.com/a/first', commit: 'c1', committedAt: '2026-09-01T12:00:00.000Z', storedAt: '2026-09-10T00:00:00.000Z' });
    expect(sources[1]!.storedAt).toBe('2026-09-10T00:00:00.000Z');
  });
});

describe('unknown paths and methods', () => {
  test('an unknown path is 404 saying what the server offers', async () => {
    start();
    const response = await fetch(`${server!.url}/nope`);
    expect(response.status).toBe(404);
    const message = (await errorOf(response)).message;
    expect(message).toContain('/nope');
    expect(message).toContain('POST /models');
    expect(message).toContain('GET /sources');
  });

  test('a wrong method on a known path is 405 saying what answers it', async () => {
    start();
    const get = await fetch(`${server!.url}/models`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await errorOf(get)).message).toContain('POST');

    const posted = await post('/sources', {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET');
  });
});

describe('restart on the same data folder', () => {
  test('the sources are listed the same after a stop and a new start on the same port', async () => {
    start();
    await send('github.com/shady2k/nocx', 'c1', '2026-09-01T12:00:00Z', [element('a')]);
    await send('github.com/acme/shop', 'c2', '2026-09-02T12:00:00Z', [element('b')]);
    const before = await (await fetch(`${server!.url}/sources`)).text();
    const port = server!.port;
    server?.stop();
    server = undefined;

    server = startServer({
      dataFolder: folder!,
      port,
      clock: { now: () => clockNow.value },
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line),
    });
    expect(server.port).toBe(port);
    const after = await (await fetch(`${server.url}/sources`)).text();
    expect(after).toBe(before);
  });
});

describe('the log', () => {
  test('one line per request: method, path, status, source and milliseconds', async () => {
    start();
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
    start();
    lines = [];
    await send('shop', 'c1', 'not a time', [element('a')]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^POST \/models 400 source="shop" \d+ms: /);
    expect(lines[0]).toContain('ISO 8601');
  });

  test('a source name holding a control character is refused, and the log stays one line per request', async () => {
    start();
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
    start();
    lines = [];
    const sent = model([element('a', { kind: 'secret-kind' })]);
    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: sent });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('secret-kind');
    expect(lines.join('\n')).not.toContain('secret-kind');
    expect(lines[0]).toContain('/elements/0/kind');
  });

  test('an unknown field name holding a newline leaves exactly one log line', async () => {
    start();
    lines = [];
    const response = await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: model([element('a')]), 'a\nb': 1 });
    expect(response.status).toBe(400);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('a\\nb');
    expect(lines[0]!.includes('\n')).toBe(false);
  });

  test('a commit id holding a newline is named in the 409 and still leaves exactly one log line', async () => {
    start();
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
    start();
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
    start();
    await send('shop', 'c1', '2026-09-01T12:00:00Z', [element('a')]);

    // A row written outside the store: the read's clash safety net
    // refuses the source's model, and the view cannot be answered.
    const raw = new Database(join(folder!, 'shop.sqlite'));
    raw.run(
      `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
       VALUES ('shop', 'element', 'a', ?, ?, NULL, 'outside', NULL, ?, NULL)`,
      [JSON.stringify({ id: 'a', kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'], technology: 'injected' }), DAY(1), DAY(1)],
    );
    raw.close();

    errors = [];
    const response = await post('/views', { source: 'shop', format: 'mermaid' });
    expect(response.status).toBe(500);
    expect((await errorOf(response)).message).toContain('could not be read');
    expect(errors.join('\n')).toContain('could not be read');
  });
});
