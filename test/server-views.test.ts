import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCE_SYSTEM, REFERENCE_TIME } from '../scripts/render-views.js';
import { checkLikeC4Workspaces, type LikeC4CheckResult } from '../scripts/likec4-check.js';
import {
  compileModel,
  createLadybugEngine,
  createSqliteHistory,
  loadAndCompileModel,
  loadModel,
  renderOneViewMermaid,
  renderOneViewLikeC4,
  startServer,
  type LikeC4Result,
  type CompiledElement,
  type CompiledModel,
  type HistoryStore,
  type QueryEngine,
  type StartedServer,
} from '../src/index.js';

/**
 * The server capability's view and explains requirements
 * (docs/changes/server-views/capabilities/server.md): `POST /views`
 * answers with the one-view renderer's own text for the source's graph,
 * and explains a request it cannot answer instead of drawing an empty
 * diagram. Every request here goes through a real server on a free port
 * over a temporary data folder, removed when the test ends; the expected
 * texts come from the one-view renderer asked directly of an engine built
 * independently of the server's, never from the server's own answer.
 */
const DAY = (day: number) => Date.UTC(2026, 8, day); // September 2026

/** After every commit the tests send, so the server's "current time" reads each history's latest version. */
const NOW = DAY(30);

/** The server's held clock, at `NOW` unless a test moves it by hand: a second store under a frozen clock records 1 ms later, and a view asked before that ms sees the older version. */
const clockNow = { value: NOW };

/** The source the reference system is sent as, and the commit and time its version carries. */
const REFERENCE_SOURCE = 'reference-system';
const REFERENCE_COMMIT = 'working-tree';
const REFERENCE_COMMITTED_AT = new Date(REFERENCE_TIME).toISOString();

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

let folder: string | undefined;
let server: StartedServer | undefined;
let lines: string[];
let errors: string[];

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
  folder = mkdtempSync(join(tmpdir(), 'madarch-server-views-'));
  lines = [];
  errors = [];
  clockNow.value = NOW;
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
  return fetch(`${server!.url}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

/** Restarts the server on the same data folder and port, as a restart on kept data is. */
function restart(): void {
  const port = server!.port;
  server?.stop();
  server = startServer({
    dataFolder: folder!,
    port,
    clock: { now: () => clockNow.value },
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line),
  });
}

/** The compiled reference system, loaded and compiled once for the whole file. */
let referenceCompiled: CompiledModel | undefined;
function referenceModel(): CompiledModel {
  if (referenceCompiled === undefined) {
    const { model, errors } = loadAndCompileModel(REFERENCE_SYSTEM);
    expect(errors).toEqual([]);
    referenceCompiled = model!;
  }
  return referenceCompiled;
}

/** Sends the reference system to the server as the send requirement stores it. */
function sendReference(): Promise<Response> {
  return post('/models', { source: REFERENCE_SOURCE, commit: REFERENCE_COMMIT, committedAt: REFERENCE_COMMITTED_AT, model: referenceModel() });
}

/** An engine built independently of the server: the same model stored in a history of its own. */
function independentEngine(model: CompiledModel, at: number): { engine: QueryEngine; history: HistoryStore; close(): void } {
  const history = createSqliteHistory({ clock: { now: () => at } });
  expect(history.store({ source: 'independent', commit: 'v1', committedAt: at, model }).errors).toEqual([]);
  const engine = createLadybugEngine();
  engine.rebuild(history.assertions());
  return { engine, history, close: () => { engine.close(); history.close(); } };
}

/** The drill-down fixture, the model the views capability's own scenarios use. */
function drillDownModel(): CompiledModel {
  const { model, errors } = loadModel(fileURLToPath(new URL('./fixtures/views-drill-down', import.meta.url)));
  expect(errors).toEqual([]);
  return compileModel(model!);
}

/** Sends the drill-down model under a source name of its own (each source is its own graph). */
function sendDrillDown(source: string): Promise<Response> {
  return post('/models', { source, commit: 'c1', committedAt: '2026-09-20T12:00:00Z', model: drillDownModel() });
}

/** Writes one workspace into a folder of its own and validates it with the real `likec4`. */
function validate(workspace: string): LikeC4CheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'madarch-server-views-c4-'));
  try {
    writeFileSync(join(dir, 'model.c4'), workspace);
    return checkLikeC4Workspaces([dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The render the server's answer is held to, asked directly of the independent engine at the model's own time. */
function renderMermaid(element: string | undefined, depth: number | undefined): string {
  const independent = independentEngine(referenceModel(), REFERENCE_TIME);
  try {
    const request: Record<string, unknown> = {};
    if (element !== undefined) request.element = element;
    if (depth !== undefined) request.depth = depth;
    const rendered = renderOneViewMermaid(independent.engine, referenceModel(), request, { valid: REFERENCE_TIME, known: REFERENCE_TIME });
    expect(rendered.errors).toEqual([]);
    return rendered.page!;
  } finally {
    independent.close();
  }
}

describe('POST /views of the reference system', () => {
  test('the landscape and the view of ordering at depth 1 are text/markdown equal to renderOneViewMermaid for the same model', async () => {
    start();
    expect((await sendReference()).status).toBe(201);

    // Depth 2 pins the plumbing: the asked depth reaches the renderer, it is not answered at the default.
    for (const request of [
      { source: REFERENCE_SOURCE, format: 'mermaid' },
      { source: REFERENCE_SOURCE, element: 'ordering', depth: 1, format: 'mermaid' },
      { source: REFERENCE_SOURCE, element: 'ordering', depth: 2, format: 'mermaid' },
    ]) {
      const response = await post('/views', request);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      const body = await response.text();
      expect(body).toBe(renderMermaid('element' in request ? request.element : undefined, 'depth' in request ? request.depth : undefined));
      expect(body).toContain('```mermaid');
    }
  });

  test('the LikeC4 answers are text/plain and pass likec4 validate on their own', async () => {
    start();
    expect((await sendReference()).status).toBe(201);

    for (const request of [{ source: REFERENCE_SOURCE, format: 'likec4' }, { source: REFERENCE_SOURCE, element: 'ordering', format: 'likec4' }]) {
      const response = await post('/views', request);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const workspace = await response.text();
      expect(workspace).toContain('views {');
      expect(validate(workspace).errors).toEqual([]);
    }
  });

  test('the same request twice, and after a restart on the same data folder, gives byte-identical text', async () => {
    start();
    expect((await sendReference()).status).toBe(201);

    const first = {
      mermaid: await (await post('/views', { source: REFERENCE_SOURCE, element: 'ordering', format: 'mermaid' })).text(),
      likec4: await (await post('/views', { source: REFERENCE_SOURCE, format: 'likec4' })).text(),
    };
    const second = {
      mermaid: await (await post('/views', { source: REFERENCE_SOURCE, element: 'ordering', format: 'mermaid' })).text(),
      likec4: await (await post('/views', { source: REFERENCE_SOURCE, format: 'likec4' })).text(),
    };
    expect(second).toEqual(first);

    restart();
    const after = {
      mermaid: await (await post('/views', { source: REFERENCE_SOURCE, element: 'ordering', format: 'mermaid' })).text(),
      likec4: await (await post('/views', { source: REFERENCE_SOURCE, format: 'likec4' })).text(),
    };
    expect(after).toEqual(first);
  });

  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)(
    'a view answers in under one second once its engine is built',
    async () => {
    start();
    expect((await sendReference()).status).toBe(201);
    // The first request builds the source's engine; the requirement measures an answer over a built one.
    expect((await post('/views', { source: REFERENCE_SOURCE, element: 'ordering', format: 'mermaid' })).status).toBe(200);

    const started = performance.now();
    const response = await post('/views', { source: REFERENCE_SOURCE, element: 'ordering', format: 'mermaid' });
    const elapsed = performance.now() - started;
    expect(response.status).toBe(200);
    if (process.env['CI']) {
      // eslint-disable-next-line no-console
      console.log(`a view of the reference system over a built engine: ${Math.round(elapsed)}ms`);
    } else {
      expect(elapsed).toBeLessThan(1_000);
    }
  },
  60_000,
  );

  test('the log line names the source, and a refusal adds its message', async () => {
    start();
    expect((await sendReference()).status).toBe(201);
    lines = [];

    expect((await post('/views', { source: REFERENCE_SOURCE, element: 'ordering', format: 'mermaid' })).status).toBe(200);
    const missing = await post('/views', { source: 'github.com/acme/shop', format: 'mermaid' });
    expect(missing.status).toBe(404);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^POST \/views 200 source="reference-system" \d+ms$/);
    expect(lines[1]).toMatch(/^POST \/views 404 source="github\.com\/acme\/shop" \d+ms: no model has been sent/);
  });
});

describe('a view after a store that failed once', () => {
  /** One compiled model of exactly one element: the smallest two versions can differ by. */
  function oneElementModel(id: string): CompiledModel {
    const element: CompiledElement = { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
    return { schemaVersion: 1, elements: [element], interfaces: [], relations: [], categories: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
  }

  /** The mermaid landscape the server must answer with for one model, asked of an engine built independently of the server's own. */
  function expectedLandscape(model: CompiledModel, at: number): string {
    const independent = independentEngine(model, at);
    try {
      const rendered = renderOneViewMermaid(independent.engine, model, {}, { valid: at, known: at });
      expect(rendered.errors).toEqual([]);
      return rendered.page!;
    } finally {
      independent.close();
    }
  }

  test('a store that failed after its commit leaves no engine answering the older model: the retry says already stored, the next view reflects the new commit', async () => {
    start();
    const first = oneElementModel('old-only');
    const second = oneElementModel('new-only');
    expect((await post('/models', { source: 'shop', commit: 'c1', committedAt: '2026-09-01T12:00:00Z', model: first })).status).toBe(201);
    // The first view builds the source's engine at c1.
    const atFirst = await post('/views', { source: 'shop', format: 'mermaid' });
    expect(atFirst.status).toBe(200);
    expect(await atFirst.text()).toBe(expectedLandscape(first, NOW));

    // Sabotage at the file-system boundary: the sidecar's own temporary
    // path is a folder, so the history stores the commit and the sidecar
    // write then fails — the store answers 500 after the commit landed.
    mkdirSync(join(folder!, 'shop.json.tmp'));
    expect((await post('/models', { source: 'shop', commit: 'c2', committedAt: '2026-09-02T12:00:00Z', model: second })).status).toBe(500);
    rmdirSync(join(folder!, 'shop.json.tmp'));

    const retry = await post('/models', { source: 'shop', commit: 'c2', committedAt: '2026-09-02T12:00:00Z', model: second });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ stored: false, reason: 'already stored', source: 'shop', commit: 'c2' });

    // The failed store recorded its rows 1 ms past the then-frozen clock
    // (it closed c1's row); move real time past that, as a running
    // server would, before asking the view — in this same process, with
    // no restart.
    clockNow.value = DAY(40);
    const answer = await post('/views', { source: 'shop', format: 'mermaid' });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(expectedLandscape(second, DAY(40)));
  });
});

describe('POST /views names the relations LikeC4 cannot draw', () => {
  /** The fixture whose model holds relations LikeC4 cannot draw, compiled. */
  function notDrawnModel(): CompiledModel {
    const { model, errors } = loadModel(fileURLToPath(new URL('./fixtures/views-likec4-not-drawn', import.meta.url)));
    expect(errors).toEqual([]);
    return compileModel(model!);
  }

  /** The renderer's own answer for a model, asked of an independent engine at the version's own time. */
  function renderExpected(model: CompiledModel, at: number): LikeC4Result {
    const independent = independentEngine(model, at);
    try {
      const rendered = renderOneViewLikeC4(independent.engine, model, {}, { valid: at, known: at });
      expect(rendered.errors).toEqual([]);
      return rendered;
    } finally {
      independent.close();
    }
  }

  test('the answer opens with one comment line per not-drawn relation, in code point order of relation id, and still validates', async () => {
    start();
    const model = notDrawnModel();
    expect((await post('/models', { source: 'not-drawn', commit: 'c1', committedAt: '2026-09-02T00:00:00Z', model })).status).toBe(201);

    const response = await post('/views', { source: 'not-drawn', format: 'likec4' });
    expect(response.status).toBe(200);
    const answer = await response.text();

    // The fixture's own relations in code point order of id, read off the model, not off the renderer.
    const expected = renderExpected(model, DAY(2));
    expect(expected.notDrawn!.map((relation) => relation.relationId)).toEqual(['loop-retries', 'shop-runs-cart', 'ui-reports-to-shop']);

    const lines = answer.split('\n');
    for (const [index, relation] of expected.notDrawn!.entries()) {
      expect(lines[index]).toBe(`// not drawn: ${relation.message}`);
    }
    expect(lines.slice(expected.notDrawn!.length).join('\n')).toBe(expected.workspace!);
    expect(validate(answer).errors).toEqual([]);
  });

  test('a model with no relation LikeC4 cannot draw is answered unchanged: the workspace alone, no comment line', async () => {
    start();
    expect((await sendReference()).status).toBe(201);

    const response = await post('/views', { source: REFERENCE_SOURCE, format: 'likec4' });
    expect(response.status).toBe(200);
    const answer = await response.text();

    const expected = renderExpected(referenceModel(), REFERENCE_TIME);
    expect(expected.notDrawn).toEqual([]);
    expect(answer).toBe(expected.workspace!);
  });
});

describe('POST /views explains', () => {
  test('a source never sent is answered 404 saying so, listing the sources held in code point order and the send command', async () => {
    start();
    expect((await sendDrillDown('shop')).status).toBe(201);
    expect((await sendDrillDown('a-first')).status).toBe(201);

    const response = await post('/views', { source: 'github.com/acme/shop', format: 'mermaid' });
    expect(response.status).toBe(404);
    const error = await errorOf(response);
    expect(error.field).toBe('source');
    expect(error.message).toContain('no model has been sent');
    expect(error.message).toContain('"github.com/acme/shop"');
    expect(error.message).toContain('a-first, shop');
    expect(error.message).toContain('bun scripts/send-model.ts <repository> --server');
  });

  test('a server holding nothing says so too', async () => {
    start();
    const response = await post('/views', { source: 'github.com/acme/shop', format: 'mermaid' });
    expect(response.status).toBe(404);
    const error = await errorOf(response);
    expect(error.message).toContain('holds no source');
    expect(error.message).toContain('bun scripts/send-model.ts <repository> --server');
  });

  test('an element that does not exist in the source is answered 404 naming the element and the source', async () => {
    start();
    expect((await sendDrillDown('shop')).status).toBe(201);

    const response = await post('/views', { source: 'shop', element: 'billing', format: 'mermaid' });
    expect(response.status).toBe(404);
    const error = await errorOf(response);
    expect(error.field).toBe('element');
    expect(error.message).toContain('"billing"');
    expect(error.message).toContain('"shop"');
  });

  test('a bad depth or format, or a missing source or format, is answered 400 naming the field and what is accepted', async () => {
    start();
    expect((await sendDrillDown('shop')).status).toBe(201);

    const bad: { body: Record<string, unknown>; field: string; fragments: string[]; accepted?: string[] }[] = [
      { body: { format: 'mermaid' }, field: 'source', fragments: ['"source" is required'] },
      { body: { source: 'shop' }, field: 'format', fragments: ['"format" is required'], accepted: ['mermaid', 'likec4'] },
      { body: { source: 'shop', format: 'plantuml' }, field: 'format', fragments: ['"plantuml"'], accepted: ['mermaid', 'likec4'] },
      { body: { source: 'shop', format: 'mermaid', depth: 0 }, field: 'depth', fragments: ['0', 'whole number'], accepted: ['whole number from 1'] },
      { body: { source: 'shop', format: 'mermaid', depth: 1.5 }, field: 'depth', fragments: ['1.5', 'whole number'], accepted: ['whole number from 1'] },
      { body: { source: 'shop', format: 'mermaid', depth: '2' }, field: 'depth', fragments: ['"2"', 'whole number'], accepted: ['whole number from 1'] },
      { body: { source: 'shop', format: 'mermaid', element: 42 }, field: 'element', fragments: ['42'] },
    ];
    for (const { body, field, fragments, accepted } of bad) {
      const response = await post('/views', body);
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.field).toBe(field);
      for (const fragment of fragments) expect(error.message).toContain(fragment);
      if (accepted !== undefined) {
        expect(error.accepted).toBeDefined();
        for (const fragment of accepted) expect(error.accepted).toContain(fragment);
      }
    }

    // Several broken fields are named together, not stopped at the first; and a broken
    // format is answered before any question about the source it named.
    const both = await post('/views', { format: 'plantuml' });
    expect(both.status).toBe(400);
    const error = await errorOf(both);
    expect(error.message).toContain('"source"');
    expect(error.message).toContain('"format"');
  });

  test('a valid request answers 200: the landscape, an element, a depth, in both formats', async () => {
    start();
    expect((await sendDrillDown('shop')).status).toBe(201);

    for (const request of [
      { source: 'shop', format: 'mermaid' },
      { source: 'shop', element: 'shop', format: 'mermaid' },
      { source: 'shop', element: 'shop', depth: 2, format: 'mermaid' },
      { source: 'shop', format: 'likec4' },
      { source: 'shop', element: 'shop', format: 'likec4' },
    ]) {
      const response = await post('/views', request);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(request.format === 'mermaid' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8');
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  test('a body that is not JSON is refused, and GET /views is not offered', async () => {
    start();
    const notJson = await fetch(`${server!.url}/views`, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).message).toContain('not valid JSON');

    const get = await fetch(`${server!.url}/views`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });
});
