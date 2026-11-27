import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setManifestPublicationState } from '../src/product/manifest-publication-state.js';
import { startServer, type StartedServer } from '../src/server/http.js';

let root = '';
let product = '';
let server: StartedServer;
let choicesFailure: string | Error = '';
const requests: string[] = [];
const failures: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-wiki-refusal-'));
  product = join(root, 'product');
  mkdirSync(product);
  server = await startServer({
    productFolder: product, allowNoManifest: true, appFolder: root, port: 0,
    log: (line) => requests.push(line), errorLog: (line) => failures.push(line),
    knowledgeChoicesQuery: async () => {
      if (choicesFailure instanceof Error) throw choicesFailure;
      return { ok: false, message: choicesFailure };
    },
  });
});

afterAll(async () => {
  try { await server?.stop(); }
  finally { if (root !== '') rmSync(root, { recursive: true, force: true }); }
});

test('wiki refusals keep engine locations in the log and product locations in the response', async () => {
  const detail = 'the fixture could not list models';
  const productLocation = `${join(product, 'madarch', 'catalog.yaml')}:11`;
  for (const [location, shown] of [
    [`${join(import.meta.dir, '..', 'src', 'server', 'knowledge.ts')}:123:4`, detail],
    [`${join(import.meta.dir, '..', 'scripts', 'madarch.ts')}:1`, detail],
    ['/$bunfs/root/madarch-linux-x64:123:4', detail],
    ['B:\\~BUN\\root\\madarch.exe:123:4', detail],
    [productLocation, `${productLocation}: ${detail}`],
  ]) {
    const full = `${location}: ${detail}`;
    choicesFailure = full;
    const response = await fetch(`${server.url}/api/agent-choices?agent=codex`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: shown, error: { message: shown } });
    expect(requests.some((line) => line.endsWith(full))).toBe(true);
  }
});

test('an unexpected wiki API failure sends a plain 500 and logs the stack', async () => {
  const cause = '/$bunfs/root/madarch-linux-x64:123:4: the model request failed';
  choicesFailure = new Error(cause);
  const response = await fetch(`${server.url}/api/agent-choices?agent=codex`);
  const message = "the wiki could not ask the agent for its models; the cause is in the server's log";
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ message, error: { message } });
  expect(failures.at(-1)).toContain(cause);
  expect(failures.at(-1)).toContain(' at ');
});

test('publication 503s keep their status and retry headers with client-safe messages', async () => {
  const url = `${server.url}/graphql`;
  const query = () => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ navigation { kinds { kind } } }' }),
  });
  setManifestPublicationState(product, { status: 'pending' });
  try {
    const pending = await query();
    expect(pending.status).toBe(503);
    expect(pending.headers.get('cache-control')).toBe('no-store');
    expect(pending.headers.get('retry-after')).toBe('1');
    expect(await pending.json()).toEqual({
      publication: 'pending', message: 'The catalogue is being published. Please wait; no catalogue is available yet.',
    });

    const detail = 'the catalogue declaration failed';
    const productLocation = `${join(product, 'madarch', 'catalog.yaml')}:11`;
    for (const [location, shown] of [
      [`${join(import.meta.dir, '..', 'src', 'graph', 'manifest-publication.ts')}:22`, detail],
      ['/$bunfs/root/madarch-linux-x64:123:4', detail],
      ['Error: /$bunfs/root/madarch-linux-x64:123:4', detail],
      [productLocation, `${productLocation}: ${detail}`],
    ]) {
      const full = `${location}: ${detail}`;
      setManifestPublicationState(product, { status: 'failed', message: full });
      const failed = await query();
      expect(failed.status).toBe(503);
      expect(failed.headers.get('cache-control')).toBe('no-store');
      expect(failed.headers.get('retry-after')).toBeNull();
      expect(await failed.json()).toEqual({ publication: 'failed', message: `The catalogue could not be published: ${shown}` });
      expect(requests.some((line) => line.endsWith(full))).toBe(true);
    }
  } finally {
    setManifestPublicationState(product, { status: 'published' });
  }
});
