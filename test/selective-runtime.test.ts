import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgePart } from '../src/server/knowledge.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';

const folder = mkdtempSync(join(tmpdir(), 'madarch-selected-agent-'));
mkdirSync(join(folder, 'madarch'));
mkdirSync(join(folder, 'templates'));
writeFileSync(join(folder, 'templates/summary.liquid'), '{{ title }}');
writeFileSync(join(folder, 'madarch/kinds.yaml'), 'kinds:\n  probe.summary: {description: {en: A summary}, template: templates/summary.liquid, source: graph, derives-from: []}\n');
afterAll(() => rmSync(folder, { recursive: true, force: true }));

test('a selected fill forwards agent and cap to the run without starting an adapter', async () => {
  const parsed = readKinds(folder);
  if (parsed.present) expect(parsed.manifest.findings).toEqual([]);
  const presses: unknown[] = [];
  const product = { folder, startFill: async (press: unknown) => { presses.push(press); return { started: true, fill: { state: 'running' } }; } } as unknown as KnowledgeProduct;
  const part = createKnowledgePart({ json: (status, body) => Response.json(body, { status }), refused: (status, error) => ({ response: Response.json({ error }, { status }) }), errorLog: () => undefined }, product, () => []);
  const response = await part.fillSelected(new Request('http://wiki.test/api/fill-selected', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected: ['probe.summary'], agent: 'scripted', tokenCap: 200 }) }));
  const body = await response.response.json();
  expect(body).not.toHaveProperty('error');
  expect(response.response.status).toBe(202);
  expect(presses).toEqual([{ agent: 'scripted', tokenCap: 200, targets: { kinds: ['probe.summary'] } }]);
});
