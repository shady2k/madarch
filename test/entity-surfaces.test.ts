import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { entityCommand } from '../src/product/entity-cli.js';
import { mcpCommand } from '../src/mcp/cli.js';

import { authoredFixture, authoredEnv as env } from './authored-fixture.js';
let root: string;
let home: string;
let folder: string;
const cli = async (...args: string[]) => {
  let out = ''; let error = '';
  const exit = await entityCommand([...args, '--product', folder, '--home', home, '--json'], { env,
    stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { error += text; } },
  });
  return { exit, body: JSON.parse(out), error };
};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-entity-surfaces-'));
  home = join(root, 'products');
  folder = await authoredFixture(home, 'notes');
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

test('entity CLI creates, reads, updates, lists and deletes with stable uid and typed fields', async () => {
  const created = await cli('create', 'note', '--title', 'A note', '--field', 'count=3', '--words', '  original words  ');
  expect(created.error).toBe(''); expect(created.exit).toBe(0);
  const uid = created.body.entity.uid;
  expect(created.body.entity.values).toEqual({ title: 'A note', count: 3 });
  expect(created.body.guidance.product).toBe('notes');
  const updated = await cli('update', 'note', uid, '--title=Changed');
  expect(updated.exit).toBe(0); expect(updated.body.entity.uid).toBe(uid);
  expect((await cli('show', 'note', uid)).body.entity.values.title).toBe('Changed');
  expect((await cli('list', 'note')).body.entities.map((row: { uid: string }) => row.uid)).toContain(uid);
  expect((await cli('schema', 'note')).body.fields).toBeDefined();
  expect((await cli('delete', 'note', uid)).exit).toBe(0);
  expect((await cli('show', 'note', uid)).exit).toBe(2);
}, 60_000);

test('madarch dispatches entity commands from the executable entry', async () => {
  const child = Bun.spawn([process.execPath, 'scripts/madarch.ts', 'entity', 'list', 'note', '--product', folder, '--home', home, '--json'], { cwd: import.meta.dir + '/..', env, stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(error).toBe('');
  expect(JSON.parse(text).guidance.product).toBe('notes');
}, 60_000);

test('entity import dispatches the explicit migration and refuses unused words', async () => {
  const result = await cli('import');
  expect(result.exit).toBe(0);
  expect(result.body.imported).toEqual([]);
  expect(result.body.errors).toEqual([]);
  expect(result.body.guidance.product).toBe('notes');
  expect((await cli('import', 'note')).exit).toBe(2);
  expect((await cli('import', '--words', 'ignored')).exit).toBe(2);
}, 60_000);

test('CLI errors explain the next action and never discard malformed arguments', async () => {
  for (const args of [['create', 'note', '--field', 'broken'], ['update', 'note'], ['show', 'note', 'no-such-uid', '--title', 'bad'], ['create', 'note', '--title', 'A', '--title', 'B']]) {
    const result = await cli(...args);
    expect(result.exit).toBe(2); expect(result.body.error.message).toBeTruthy(); expect(result.body.guidance.next).toBeTruthy();
  }
});

test('product MCP exposes four authored operations and persists across calls without filling', async () => {
  let output = '';
  const requests = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_entity', arguments: { kind: 'note', values: { title: 'MCP note', count: 7 } } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_entity', arguments: { kind: 'note' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_entity', arguments: { kind: 'note' } } },
  ];
  const exit = await mcpCommand(['--product', folder, '--home', home], { env,
    input: (async function* () {
      for (const request of requests) yield JSON.stringify(request) + '\n';
      const madeResponse = output.trim().split('\n').map((line) => JSON.parse(line)).find((response) => response.id === 2);
      const uid = JSON.parse(madeResponse.result.content[0].text).entity.uid;
      for (const [id, name, values] of [[5, 'update_entity', { title: 'MCP changed' }], [6, 'read_entity', undefined], [7, 'delete_entity', undefined], [8, 'read_entity', undefined]] as const) {
        yield JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { kind: 'note', uid, ...(values === undefined ? {} : { values }) } } }) + '\n';
      }
    })(),
    stdout: { write: (text) => { output += text; } },
  });
  expect(exit).toBe(0);
  const allResponses = output.trim().split('\n').map((line) => JSON.parse(line));
  expect(allResponses[0].result.protocolVersion).toBe('2025-06-18');
  const responses = allResponses.slice(1);
  expect(responses[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual(['create_entity', 'read_entity', 'update_entity', 'delete_entity']);
  const made = JSON.parse(responses[1].result.content[0].text);
  expect(made.entity.values).toEqual({ title: 'MCP note', count: 7 });
  expect(made.guidance.product).toBe('notes');
  expect(JSON.parse(responses[2].result.content[0].text).entities.some((row: { uid: string }) => row.uid === made.entity.uid)).toBe(true);
  expect(responses[3].result.isError).toBe(true);
  expect(JSON.parse(responses[3].result.content[0].text).guidance.next).toBeTruthy();
  expect(JSON.parse(responses[4].result.content[0].text).entity.values.title).toBe('MCP changed');
  expect(JSON.parse(responses[5].result.content[0].text).entity.uid).toBe(made.entity.uid);
  expect(responses[6].result.isError).toBe(false);
  expect(responses[7].result.isError).toBe(true);
}, 60_000);

test.each(['123', '"Queue"', 'null'])('CLI text fields preserve raw %s exactly like MCP', async (title) => {
    const created = await cli('create', 'note', '--title', title);
    expect(created.exit).toBe(0);
    expect(created.body.entity.values.title).toBe(title);
    expect((await cli('show', 'note', created.body.entity.uid)).body.entity.values.title).toBe(title);
    let output = '';
    await mcpCommand(['--product', folder, '--home', home], { env,
      input: (async function* () { yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_entity', arguments: { kind: 'note', values: { title } } } }) + '\n'; })(),
      stdout: { write: (text) => { output += text; } },
    });
    const response = JSON.parse(output.trim());
    expect(response.result.isError).toBe(false);
    expect(JSON.parse(response.result.content[0].text).entity.values.title).toBe(title);
}, 60_000);

test('CLI and MCP forward revision conflicts without losing current values or authors', async () => {
  const created = await cli('create', 'note', '--title', 'Before');
  const { uid, revision } = created.body.entity;
  expect(typeof revision).toBe('string');
  const updated = await cli('update', 'note', uid, '--title', 'Current', '--if-revision', revision);
  expect(updated.exit).toBe(0);
  const refused = await cli('update', 'note', uid, '--title', 'Stale', '--if-revision', revision);
  expect(refused.exit).toBe(2);
  expect(refused.body.error.field).toBe('title');
  expect(refused.body.error.conflict.current).toBe('Current');
  expect(refused.body.error.conflict.author).toContain('person:');
  expect((await cli('show', 'note', uid)).body.entity.revision).toBe(updated.body.entity.revision);
  let output = '';
  await mcpCommand(['--product', folder, '--home', home], { env,
    input: (async function* () { yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_entity', arguments: { kind: 'note', uid, values: { title: 'Stale MCP' }, ifRevision: revision } } }) + '\n'; })(),
    stdout: { write: (text) => { output += text; } },
  });
  const response = JSON.parse(output.trim());
  expect(response.result.isError).toBe(true);
  expect(JSON.parse(response.result.content[0].text).error).toEqual(refused.body.error);
  expect((await cli('show', 'note', uid)).body.entity.values.title).toBe('Current');
}, 60_000);
