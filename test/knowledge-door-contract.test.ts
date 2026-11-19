import { describe, expect, test } from 'bun:test';
import { commandRequests, queryRequests } from '../src/server/knowledge-contract.js';
import { parseRequest } from '../src/graph/door-contract.js';
import { GraphRefusal } from '../src/graph/validation.js';

describe('HTTP command contracts', () => {
  test.each([
    ['save the answer', { question: 'q', text: 'answer', extra: true }, '/extra'],
    ['read the product settings', { language: 'en', tokenCap: -1 }, '/tokenCap'],
    ['choose the agent', { agent: null, install: 'yes' }, '/install'],
    ['fill the selected entities', { selected: ['demo.file'], pluginsOnly: 'true' }, '/pluginsOnly'],
    ['start over', { preview: { store: [] } }, '/preview/agentPages'],
    ['propose the task of an answer', { question: 'q', choice: 'code', language: 'de' }, '/language'],
  ])('refuses %s', (command, body, path) => {
    try { parseRequest(commandRequests[command]!, body); throw new Error('accepted malformed input'); }
    catch (error) {
      expect(error).toBeInstanceOf(GraphRefusal);
      expect((error as GraphRefusal).toJSON()).toMatchObject({ code: 'SCHEMA_INVALID', path, retryable: false });
    }
  });
  test('refuses unknown read selectors', () => {
    expect(() => parseRequest(queryRequests['read the run']!, { run: 'r', field: 'missing' })).toThrow(GraphRefusal);
    expect(() => parseRequest(queryRequests['read the graph verdicts']!, { limit: '-2' })).toThrow(GraphRefusal);
  });
});


import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { readPluginsUnconfined } from '../src/knowledge/settings.js';

test('HTTP refuses malformed commands before any effect and unknown kind reads', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'door-http-'));
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'madarch/catalog.yaml'), 'name: demo\n');
  let effects = 0;
  const product = {
    folder,
    setLanguage: async () => { effects++; return { ok: true }; },
    setDefaultTokenCap: async () => { effects++; return { ok: true }; },
    kindUsage: async () => { effects++; return {}; },
  } as unknown as KnowledgeProduct;
  const part = createKnowledgePart({
    json: (status, value) => Response.json(value, { status }),
    refused: (status, error) => ({ response: Response.json({ error }, { status }) }),
    errorLog: () => undefined,
  }, product, () => []);
  for (const body of [{ language: 'en', extra: true }, { language: 'en', tokenCap: -1 }]) {
    const answer = await part.productSettings(new Request('http://localhost/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect(answer).not.toBeNull();
    const response = answer!.response;
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'SCHEMA_INVALID', retryable: false });
  }
  const answer = await part.kindUsage(new Request('http://localhost/kind-usage?kind=missing.kind'));
  expect(answer!.response.status).toBe(400);
  expect((await answer!.response.json()).error).toMatchObject({ code: 'SCHEMA_INVALID', path: '/kind', actual: 'missing.kind' });
  expect(effects).toBe(0);
});

test('the settings command saves the isolation answer the preparation page presses', async () => {
  const home = mkdtempSync(join(tmpdir(), 'door-settings-'));
  try {
    const env = { ...process.env, MADARCH_HOME: home };
    const product = { folder: join(home, 'product'), declaredRoles: async () => ['architect'] } as unknown as KnowledgeProduct;
    const part = createKnowledgePart({
      json: (status, value) => Response.json(value, { status }),
      refused: (status, error) => ({ response: Response.json({ error }, { status }) }),
      errorLog: () => undefined,
    }, product, () => [], env);
    const post = async (body: unknown) => await part.settings(new Request('http://localhost/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const isolation = await post({ pluginsUnconfined: true });
    expect(isolation.response.status).toBe(200);
    expect(await isolation.response.json()).toMatchObject({ pluginsUnconfined: true });
    expect(readPluginsUnconfined(env)).toBe(true);
    // The role answer stands beside it, and the closed envelope refuses another shape before anything is written.
    const role = await post({ role: 'architect' });
    expect(role.response.status).toBe(200);
    expect(await role.response.json()).toMatchObject({ role: 'architect' });
    for (const body of [{ pluginsUnconfined: 'yes' }, {}, { role: 'architect', pluginsUnconfined: true }]) {
      const refused = await post(body);
      expect(refused.response.status).toBe(400);
      expect((await refused.response.json()).error).toMatchObject({ code: 'SCHEMA_INVALID', retryable: false });
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
