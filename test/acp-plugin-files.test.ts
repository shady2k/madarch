import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAcpAgent, type AcpConnection, type AcpRefusal, type AcpUpdate, type ConnectAcpOptions } from '../src/fill/acp.js';

const folders: string[] = [];
const connections: AcpConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// The fake implements wire framing independently from the client's SDK.
const FAKE = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let next = 0;
const pending = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = 'file-' + ++next; pending.set(id, resolve); send({ id, method, params }); });
let sessions = 0;
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  appendFileSync(process.argv[2], line + '\\n');
  if (!m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'session-' + ++sessions } });
  if (m.method === 'session/prompt') {
    const sessionId = m.params.sessionId;
    const read = await ask('fs/read_text_file', { sessionId, path: '/virtual/input.txt', line: 2, limit: 3 });
    const write = await ask('fs/write_text_file', { sessionId, path: '/virtual/output.txt', content: 'result\\n' });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 19, size: 100 } } });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ read, write }) } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
});
`;

async function connect(options: Partial<ConnectAcpOptions> = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-acp-files-'));
  folders.push(folder);
  const program = join(folder, 'fake.ts');
  const record = join(folder, 'record.jsonl');
  writeFileSync(program, FAKE);
  writeFileSync(record, '');
  const connection = await connectAcpAgent({ id: 'fake-files', command: process.execPath, args: [program, record] }, { cwd: folder, ...options });
  connections.push(connection);
  await connection.initialize();
  return { connection, folder, record, messages: () => readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
}

test('host callbacks receive the complete file requests and the agent receives their answers', async () => {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const updates: AcpUpdate[] = [];
  const { connection, folder, messages } = await connect({
    onUpdate: (update) => updates.push(update),
    files: {
      readTextFile: async (params) => { reads.push(params); return { content: 'two\nthree\nfour' }; },
      writeTextFile: async (params) => { writes.push(params); },
    },
  });
  const first = await connection.newSession({ cwd: folder });
  const second = await connection.newSession({ cwd: folder });
  for (const session of [first, second]) {
    const answer = await session.prompt('files');
    const replies = JSON.parse(answer.text);
    expect(replies.read.result).toEqual({ content: 'two\nthree\nfour' });
    expect(replies.write.result).toEqual({});
    expect(session.usage().context).toEqual({ used: 19, size: 100 });
  }
  expect(reads).toEqual(['session-1', 'session-2'].map((sessionId) => ({ sessionId, path: '/virtual/input.txt', line: 2, limit: 3 })));
  expect(writes).toEqual(['session-1', 'session-2'].map((sessionId) => ({ sessionId, path: '/virtual/output.txt', content: 'result\n' })));
  expect(updates.filter((update) => update.kind === 'usage').map((update) => update.sessionId)).toEqual(['session-1', 'session-2']);
  expect(messages()[0].params.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: false });
}, 30_000);

test('without callbacks both file capabilities stay off and both methods are refused and logged', async () => {
  const refusals: AcpRefusal[] = [];
  const { connection, folder, messages } = await connect({ onRefused: (refusal) => refusals.push(refusal) });
  const session = await connection.newSession({ cwd: folder });
  const replies = JSON.parse((await session.prompt('files')).text);
  expect(JSON.stringify(replies.read.error)).toContain('does not offer');
  expect(JSON.stringify(replies.write.error)).toContain('does not offer');
  expect(refusals.map((refusal) => [refusal.method, refusal.sessionId])).toEqual([['fs/read_text_file', session.sessionId], ['fs/write_text_file', session.sessionId]]);
  expect(messages()[0].params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
}, 30_000);

test('each callback advertises independently and a host error is returned with agent context and logged', async () => {
  const refusals: AcpRefusal[] = [];
  const { connection, folder, messages } = await connect({
    files: { readTextFile: async () => { throw new Error('/virtual/input.txt:2: host denied this read'); } },
    onRefused: (refusal) => refusals.push(refusal),
  });
  const session = await connection.newSession({ cwd: folder });
  const replies = JSON.parse((await session.prompt('files')).text);
  expect(JSON.stringify(replies.read.error)).toContain('/virtual/input.txt:2: host denied this read');
  expect(JSON.stringify(replies.read.error)).toContain(`fake-files (${process.execPath}) in ${folder}`);
  expect(JSON.stringify(replies.read.error)).toContain(refusals[0]!.message);
  expect(refusals[1]?.method).toBe('fs/write_text_file');
  expect(messages()[0].params.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: false }, terminal: false });
}, 30_000);


test('a write-only host advertises only writes and write failures retain their location', async () => {
  const refusals: AcpRefusal[] = [];
  const { connection, folder, messages } = await connect({
    files: { writeTextFile: async () => { throw new Error('/virtual/output.txt:1: host denied this write'); } },
    onRefused: (refusal) => refusals.push(refusal),
  });
  const session = await connection.newSession({ cwd: folder });
  const replies = JSON.parse((await session.prompt('files')).text);
  expect(JSON.stringify(replies.write.error)).toContain('/virtual/output.txt:1: host denied this write');
  expect(JSON.stringify(replies.write.error)).toContain(refusals[1]!.message);
  expect(refusals.map((refusal) => refusal.method)).toEqual(['fs/read_text_file', 'fs/write_text_file']);
  expect(messages()[0].params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: true }, terminal: false });
}, 30_000);


test('a supervised transport bypasses spawn and its lifecycle closes once', async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let stopped!: () => void;
  let closes = 0;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const received: { method: string }[] = [];
  const transport = {
    input: new WritableStream<Uint8Array>({ write(chunk) {
      for (const line of decoder.decode(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        received.push(request);
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: 'confined' };
        output.enqueue(encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
      }
    } }),
    output: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
    stderr: () => 'confined runner tail',
    exited: new Promise<void>((settle) => { stopped = settle; }),
    async close() { closes += 1; stopped(); try { output.close(); } catch { /* SDK may have cancelled its reader. */ } },
  };
  // This path cannot spawn; success proves only the supplied transport is used.
  const connection = await connectAcpAgent({ id: 'supervised', command: '/no-such-acp-program' }, { cwd: '/', transport });
  connections.push(connection);
  await connection.initialize();
  expect((await connection.newSession({ cwd: '/' })).sessionId).toBe('confined');
  expect(connection.stderr()).toBe('confined runner tail');
  await Promise.all([connection.close(), connection.close()]);
  expect(closes).toBe(1);
  expect(received.map((request) => request.method)).toEqual(['initialize', 'session/new']);
}, 30_000);
