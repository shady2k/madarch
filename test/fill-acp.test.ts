import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcpError,
  connectAcpAgent,
  describeUsage,
  normalizeUpdate,
  resolveExecutable,
  toMcpServers,
  type AcpConnection,
  type AcpSession,
  type AcpUpdate,
} from '../src/fill/acp.js';

/** The fake agent, started the way a real adapter is: a program on this machine speaking ACP over stdio. */
const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');
/** A program of its own that connects, closes and returns — the shape a command has. */
const CLOSE_AND_RETURN = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'close-and-return.ts');

const scratch: string[] = [];
const connections: AcpConnection[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close().catch(() => undefined);
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function scratchFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-acp-'));
  scratch.push(folder);
  return folder;
}

/** Whether the process is still there to be signalled. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The first whole number a file holds, once it holds one; `undefined` while it does not. */
function firstNumber(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Wait for a condition the machine reaches on its own, rather than for a fixed sleep. */
async function waitFor<T>(check: () => T | undefined, what: string, bound = 10_000): Promise<T> {
  const deadline = Date.now() + bound;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`the test waited ${bound} ms in vain for ${what}`);
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

/** A connection to the fake agent in one of its scenarios, with its recording file. */
async function connect(scenario: string, options: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ connection: AcpConnection; record: string; pid: string; messages: () => { method?: string; params?: Record<string, unknown>; argv?: string[] }[] }> {
  const folder = scratchFolder();
  const record = join(folder, 'record.jsonl');
  const pid = join(folder, 'pid');
  writeFileSync(record, '');
  const connection = await connectAcpAgent(
    { id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', scenario, '--record', record, '--pid-file', pid] },
    { cwd: process.cwd(), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.env === undefined ? {} : { env: options.env }) },
  );
  connections.push(connection);
  return {
    connection,
    record,
    pid,
    messages: () => readFileSync(record, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }),
  };
}

describe('the ACP client starts an agent and initializes the connection', () => {
  test('initialize sends protocol version 1 and advertises no file system and no terminal', async () => {
    const { connection, messages } = await connect('default');
    const initialized = await connection.initialize();
    expect(initialized.protocolVersion).toBe(1);
    expect(initialized.agentInfo).toEqual({ name: 'fake-agent', title: 'Fake ACP agent', version: '1.0.0' });
    expect(initialized.authMethods).toEqual([{ id: 'local', name: 'Local credentials', description: 'Use the credentials on this machine' }]);
    const request = messages().find((message) => message.method === 'initialize');
    expect(request?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'madarch' },
    });
  });

  test('a program that is not on this machine fails naming it and the PATH searched', async () => {
    const empty = scratchFolder();
    await expect(connectAcpAgent({ id: 'ghost', command: 'no-such-acp-agent' }, { cwd: process.cwd(), env: { PATH: empty } }))
      .rejects.toThrow(/src\/fill\/acp\.ts:connectAcpAgent: the agent ghost cannot be started: no program named "no-such-acp-agent" is executable on this machine \(PATH ".*"\)/);
  });

  test('a program the system cannot run fails naming why it would not start', async () => {
    // The exec bit is there but the interpreter its directive names is not:
    // only starting it shows that, and the failure has to say so.
    const program = join(scratchFolder(), 'broken-agent');
    writeFileSync(program, '#!/no-such-interpreter\n');
    chmodSync(program, 0o755);
    const connection = await connectAcpAgent({ id: 'broken', command: program }, { cwd: process.cwd() });
    connections.push(connection);
    await expect(connection.initialize()).rejects.toThrow(new RegExp(`src/fill/acp\\.ts:initialize: the agent broken \\(${program.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) in .* failed: .*the process could not start: .*ENOENT`));
  });

  test('an agent that answers an unknown protocol version is refused after naming both versions', async () => {
    const { connection } = await connect('old-protocol');
    await expect(connection.initialize()).rejects.toThrow(/src\/fill\/acp\.ts:initialize: the agent fake \(.*\) in .* failed: it answered protocol version 99; madarch speaks version 1/);
  });

  test('an agent that never answers initialize is given up on at the bound, naming the method', async () => {
    const { connection } = await connect('hang', { timeoutMs: 250 });
    await expect(connection.initialize()).rejects.toThrow(/src\/fill\/acp\.ts:initialize: the agent fake \(.*\) in .* did not answer within 250 ms/);
  });

  test('an answer that arrives after the bound is given up on, and the connection still closes', async () => {
    // The bound wins the race and the answer then settles with nothing waiting
    // for it: that must not become an unhandled failure in this process.
    const { connection } = await connect('late-initialize', { timeoutMs: 100 });
    await expect(connection.initialize()).rejects.toThrow(/src\/fill\/acp\.ts:initialize: the agent fake \(.*\) in .* did not answer within 100 ms/);
    await new Promise((settle) => setTimeout(settle, 500));
    await connection.close();
    await connection.closed;
  });

  test('an agent that dies before answering names its exit and what it wrote on standard error', async () => {
    const { connection } = await connect('crash');
    await expect(connection.initialize()).rejects.toThrow(/src\/fill\/acp\.ts:initialize: the agent fake \(.*\) in .* failed: /);
    await connection.closed;
    expect(connection.stderr()).toContain('fake agent: the credentials are missing');
  });

  test('resolveExecutable answers a full path on PATH, an absolute one, and nothing for a missing program', () => {
    const folder = scratchFolder();
    const program = join(folder, 'an-agent');
    writeFileSync(program, '#!/bin/sh\nexit 0\n');
    chmodSync(program, 0o755);
    expect(resolveExecutable('an-agent', folder)).toBe(program);
    expect(resolveExecutable(program, '')).toBe(program);
    expect(resolveExecutable('an-agent', scratchFolder())).toBeUndefined();
    expect(resolveExecutable(join(folder, 'absent'), '')).toBeUndefined();
  });
});

describe('a session is created with the unit\'s MCP servers', () => {
  test('session/new carries the absolute folder and each MCP server in its protocol shape', async () => {
    const { connection, messages } = await connect('default');
    await connection.initialize();
    // The unit's MCP server is a program this test writes: a path some
    // machines happen to carry (`/bin/true`, say) is not on every machine.
    const program = join(scratchFolder(), 'unit-mcp');
    writeFileSync(program, '#!/bin/sh\nexit 0\n');
    chmodSync(program, 0o755);
    const session = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [
        { name: 'unit', command: program, args: ['--serve'], env: { MADARCH_UNIT: 'u1' } },
        { name: 'graph', url: 'http://127.0.0.1:7357/mcp', headers: { Authorization: 'Bearer none' } },
      ],
    });
    expect(session.sessionId).toBe('fake-session-1');
    expect(session.modes).toEqual({ currentModeId: 'ask' });
    const request = messages().find((message) => message.method === 'session/new');
    expect(request?.params).toEqual({
      cwd: process.cwd(),
      mcpServers: [
        { name: 'unit', command: program, args: ['--serve'], env: [{ name: 'MADARCH_UNIT', value: 'u1' }] },
        { name: 'graph', url: 'http://127.0.0.1:7357/mcp', type: 'http', headers: [{ name: 'Authorization', value: 'Bearer none' }] },
      ],
    });
  });

  test('toMcpServers resolves a command to the path this machine runs, defaults an http server to that transport and refuses an empty or absent one', () => {
    // A bare name is looked up on PATH: resolving it against madarch's own
    // folder would name a program the agent cannot start.
    const bin = scratchFolder();
    const program = join(bin, 'unit-mcp');
    writeFileSync(program, '#!/bin/sh\nexit 0\n');
    chmodSync(program, 0o755);
    const resolved = toMcpServers([{ name: 'local', command: 'unit-mcp', args: ['--flag'] }], bin);
    expect(resolved).toEqual([{ name: 'local', command: program, args: ['--flag'], env: [] }]);
    // A folder that carries the name is no program: it resolves to nothing.
    const impostorBin = scratchFolder();
    mkdirSync(join(impostorBin, 'unit-mcp'));
    expect(() => toMcpServers([{ name: 'local', command: 'unit-mcp' }], impostorBin)).toThrow(/cannot be started/);
    expect(toMcpServers([{ name: 'remote', url: 'http://127.0.0.1:1/mcp', type: 'sse' }])).toEqual([{ name: 'remote', url: 'http://127.0.0.1:1/mcp', type: 'sse', headers: [] }]);
    expect(() => toMcpServers([{ name: 'bare', command: '  ' }])).toThrow(/src\/fill\/acp\.ts:toMcpServers: the MCP server "bare" has no command to run/);
    expect(() => toMcpServers([{ name: 'bare', url: '' }])).toThrow(/src\/fill\/acp\.ts:toMcpServers: the MCP server "bare" has no url/);
    expect(() => toMcpServers([{ name: 'absent', command: 'no-such-mcp-server' }], scratchFolder())).toThrow(/src\/fill\/acp\.ts:toMcpServers: the MCP server "absent" cannot be started: no program named "no-such-mcp-server" is executable on this machine/);
  });

  test('an MCP transport the agent did not advertise is refused, naming the agent, the transport and the server', async () => {
    const { connection } = await connect('no-http-mcp');
    await connection.initialize();
    await expect(connection.newSession({ cwd: process.cwd(), mcpServers: [{ name: 'graph', url: 'http://127.0.0.1:7357/mcp' }] }))
      .rejects.toThrow(/src\/fill\/acp\.ts:newSession: the agent fake \(.*\) did not advertise the http MCP transport, so the MCP server "graph" cannot be attached over http/);
  });

  test('a session is refused before initialize, and a folder other than the connection\'s is the folder the agent is sent', async () => {
    const { connection, messages } = await connect('default');
    await expect(connection.newSession({ cwd: process.cwd() })).rejects.toThrow(/src\/fill\/acp\.ts:newSession: the connection to fake \(.*\) must be initialized before a session is created/);
    await connection.initialize();
    const other = scratchFolder();
    const session = await connection.newSession({ cwd: other });
    expect(session.sessionId).toBe('fake-session-1');
    const request = messages().find((message) => message.method === 'session/new');
    expect(request?.params).toMatchObject({ cwd: other, mcpServers: [] });
  });

  test('session/new without an id is a failure naming the agent', async () => {
    const { connection } = await connect('no-session-id');
    await connection.initialize();
    await expect(connection.newSession({ cwd: process.cwd() })).rejects.toThrow(/src\/fill\/acp\.ts:session\/new: the agent fake \(.*\) in .* failed: it answered session\/new without a session id/);
  });
});

describe('a prompt turn streams its updates and its usage', () => {
  test('messages, thoughts, tool calls and context usage arrive in order, and the turn ends with its stop reason', async () => {
    const { connection } = await connect('default');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const seen: AcpUpdate[] = [];
    const result = await session.prompt('inspect the repository', { onUpdate: (update) => seen.push(update) });

    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('echo: inspect the repository done');
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12, totalTokens: 42 });
    expect(seen.map((update) => update.kind)).toEqual(['thought', 'message', 'message', 'tool-call', 'tool-call-update', 'usage']);
    expect(seen[0]?.text).toBe('thinking');
    expect(seen[3]).toMatchObject({ kind: 'tool-call', toolCallId: 'call-1', title: 'Read graph', status: 'pending', toolKind: 'read' });
    expect(seen[4]).toMatchObject({ kind: 'tool-call-update', toolCallId: 'call-1', status: 'completed' });
    expect(seen[5]).toMatchObject({ kind: 'usage', contextUsed: 1000, contextSize: 200000, cost: { amount: 0.5, currency: 'USD' } });
  });

  test('the session keeps the reported tokens and the context window as the agent gave them', async () => {
    const { connection } = await connect('default');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    expect(session.usage()).toEqual({ reported: false, turns: 0, reports: 0 });
    expect(describeUsage(session.usage())).toBe('token usage not reported: no turn ran in this session');
    await session.prompt('first');
    expect(session.usage()).toEqual({ reported: true, turns: 1, reports: 1, inputTokens: 30, outputTokens: 12, totalTokens: 42, context: { used: 1000, size: 200000 } });
    expect(describeUsage(session.usage())).toBe('input 30, output 12, total 42');
  });

  test('a second turn replaces the figures with its own report, and both turns are counted', async () => {
    const { connection } = await connect('two-turns');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    await session.prompt('first');
    await session.prompt('second');
    expect(session.usage()).toEqual({ reported: true, turns: 2, reports: 2, inputTokens: 75, outputTokens: 20, totalTokens: 95 });
  });

  test('a session whose agent reports no tokens says "not reported" instead of inventing numbers', async () => {
    const { connection } = await connect('no-usage');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const result = await session.prompt('first');
    expect(result.usage).toBeUndefined();
    expect(session.usage()).toEqual({ reported: false, turns: 1, reports: 0 });
    expect(describeUsage(session.usage())).toBe('token usage not reported: the agent gave none in 1 turn');
  });

  test('a schema-valid update kind madarch does not name is kept as other, never dropped', async () => {
    const { connection } = await connect('extended');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const result = await session.prompt('first');
    expect(result.updates.some((update) => update.kind === 'other' && update.sessionUpdate === 'session_info_update')).toBe(true);
  });

  test('an update outside the protocol schema does not end the turn', async () => {
    const { connection } = await connect('unknown');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const result = await session.prompt('first');
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('echo: first done');
    expect(result.updates.some((update) => update.sessionUpdate === 'brand_new_variant')).toBe(false);
  });

  test('an empty prompt and a second prompt in flight are refused', async () => {
    const { connection } = await connect('cancellable');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    await expect(session.prompt('   ')).rejects.toThrow(/src\/fill\/acp\.ts:prompt: the prompt for session fake-session-1 of fake \(.*\) is empty/);
    const first = session.prompt('hold the turn');
    await expect(session.prompt('and another')).rejects.toThrow(/src\/fill\/acp\.ts:prompt: session fake-session-1 of fake \(.*\) already has a prompt in flight/);
    await session.cancel();
    expect((await first).stopReason).toBe('cancelled');
    expect(session.running()).toBe(false);
  });
});

describe('the agent keeps no way around the unit\'s MCP server', () => {
  test('a file read the agent asks the client for is refused with an error, and the turn still ends', async () => {
    const { connection } = await connect('fs-call');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const result = await session.prompt('read a file');
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toContain('the agent called fs/read_text_file, which madarch does not offer');
    expect(result.text).toContain('code is read through the session\'s MCP server');
  });

  test('a file write the agent asks the client for is refused too, naming the method', async () => {
    const { connection } = await connect('fs-write-call');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const result = await session.prompt('write a file');
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toContain('the agent called fs/write_text_file, which madarch does not offer');
    expect(result.text).toContain('writes go through the session\'s MCP server');
  });

  test('a permission request is answered cancelled', async () => {
    const { connection } = await connect('permission');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const result = await session.prompt('write a file');
    expect(result.text).toBe('permission {"outcome":{"outcome":"cancelled"}}');
  });
});

describe('cancelling a turn', () => {
  test('session/cancel ends the turn in flight with the cancelled stop reason', async () => {
    const { connection, messages } = await connect('cancellable');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const running = session.prompt('a long turn');
    await session.cancel();
    const result = await running;
    expect(result.stopReason).toBe('cancelled');
    const cancel = messages().find((message) => JSON.parse(JSON.stringify(message)).method === 'session/cancel');
    expect(cancel?.params).toEqual({ sessionId: 'fake-session-1' });
  });
});

describe('a prompt turn is not cut short by the bound that guards the handshake', () => {
  test('a turn still running past timeoutMs ends with its own stop reason', async () => {
    const { connection } = await connect('slow-turn', { timeoutMs: 150 });
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const result = await session.prompt('a slow turn');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 1, totalTokens: 5 });
    expect(session.usage().turns).toBe(1);
  });

  test('a turn that fails counts no turn and invents no tokens', async () => {
    const { connection } = await connect('dies-mid-turn');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    await expect(session.prompt('a turn the agent dies in')).rejects.toThrow(/src\/fill\/acp\.ts:session\/prompt: the agent fake \(.*\) in .* failed: /);
    expect(session.usage()).toEqual({ reported: false, turns: 0, reports: 0 });
    expect(describeUsage(session.usage())).toBe('token usage not reported: no turn ran in this session');
  });
});

describe('the protocol\'s error codes are read for what they mean', () => {
  test('a turn the agent cancels with protocol error -32800 ends as cancelled', async () => {
    const { connection } = await connect('cancel-error');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const running = session.prompt('a long turn');
    await session.cancel();
    expect((await running).stopReason).toBe('cancelled');
  });

  test('a session the agent refuses for want of authentication names that, with its code', async () => {
    const { connection } = await connect('auth-required');
    await connection.initialize();
    await expect(connection.newSession({ cwd: process.cwd() })).rejects.toThrow(/src\/fill\/acp\.ts:session\/new: the agent fake \(.*\) in .* failed: Authentication required \(protocol error -32000: the agent requires authentication\)/);
  });
});

describe('normalizeUpdate', () => {
  const at = '2026-01-01T00:00:00.000Z';

  test('names the protocol\'s variants and keeps their fields', () => {
    expect(normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, at)).toMatchObject({ kind: 'message', text: 'hi', at });
    expect(normalizeUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }, at)).toMatchObject({ kind: 'thought', text: 'hmm' });
    expect(normalizeUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'asked' } }, at)).toMatchObject({ kind: 'user-message', text: 'asked' });
    expect(normalizeUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', kind: 'edit', status: 'pending' }, at)).toMatchObject({ kind: 'tool-call', toolCallId: 'c', title: 't', toolKind: 'edit', status: 'pending' });
    expect(normalizeUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'failed' }, at)).toMatchObject({ kind: 'tool-call-update', status: 'failed' });
    expect(normalizeUpdate({ sessionUpdate: 'plan', entries: [] }, at).kind).toBe('plan');
    expect(normalizeUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'code' }, at).kind).toBe('mode');
    expect(normalizeUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] }, at).kind).toBe('commands');
    expect(normalizeUpdate({ sessionUpdate: 'config_option_update', configOptions: [] }, at).kind).toBe('config');
    expect(normalizeUpdate({ sessionUpdate: 'usage_update', used: 10, size: 20 }, at)).toMatchObject({ kind: 'usage', contextUsed: 10, contextSize: 20 });
  });

  test('a message chunk that is not text carries no text rather than a guess', () => {
    const update = normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA' } }, at);
    expect(update.kind).toBe('message');
    expect(update.text).toBeUndefined();
  });

  test('a variant this client does not know is other, with the payload kept as received', () => {
    const raw = { sessionUpdate: 'compaction_update', id: 'c1', status: 'start' };
    expect(normalizeUpdate(raw, at)).toEqual({ kind: 'other', sessionUpdate: 'compaction_update', at, raw });
    expect(normalizeUpdate(undefined, at)).toEqual({ kind: 'other', sessionUpdate: 'unknown', at, raw: undefined });
  });

  test('a usage update names its cost only when the agent gave both amount and currency', () => {
    expect(normalizeUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 3 } }, at).cost).toBeUndefined();
    expect(normalizeUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 3, currency: 'EUR' } }, at).cost).toEqual({ amount: 3, currency: 'EUR' });
  });
});

describe('closing the connection', () => {
  test('closing ends the agent process, and a second close is harmless', async () => {
    const { connection, pid: pidFile } = await connect('default');
    await connection.initialize();
    const session: AcpSession = await connection.newSession({ cwd: process.cwd() });
    expect(session.running()).toBe(false);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await connection.close();
    await connection.closed;
    await connection.close();
    // The process is gone: signal 0 finds nothing to signal.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test('closing during a turn ends it as cancelled, not as a failure', async () => {
    const { connection } = await connect('cancellable');
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const running = session.prompt('a turn madarch ends');
    // The close alone ends the turn: nothing cancels it first.
    await connection.close();
    expect((await running).stopReason).toBe('cancelled');
  });

  test('closing ends the helper the agent started, and does not wait for it to inherit the pipes', async () => {
    const helperRecord = join(scratchFolder(), 'helpers.txt');
    // The fake agent records its helper's pid in the folder this test names, in
    // the child's own environment: nothing of the suite's process is changed.
    const { connection } = await connect('helper', { env: { ACP_FAKE_HELPER_RECORD: helperRecord } });
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    const running = session.prompt('start a helper');
    const helper = await waitFor(() => firstNumber(helperRecord), 'the agent to start its helper');
    expect(alive(helper)).toBe(true);
    await connection.close();
    expect((await running).stopReason).toBe('cancelled');
    await waitFor(() => (alive(helper) ? undefined : true), `helper ${helper} to end`);
    expect(alive(helper)).toBe(false);
  });

  test('closing ends the helper an agent left when the agent itself had already ended', async () => {
    // The agent starts a helper holding the connection's pipes and then exits
    // on its own: the close must still end that helper, or the pipes keep
    // madarch's event loop alive after the agent is gone.
    const helperRecord = join(scratchFolder(), 'helpers.txt');
    const { connection, pid: pidFile } = await connect('exit-with-helper', { env: { ACP_FAKE_HELPER_RECORD: helperRecord } });
    await connection.initialize();
    await connection.closed;
    const agent = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(agent)).toBe(false);
    const helper = await waitFor(() => firstNumber(helperRecord), 'the agent to start its helper');
    expect(alive(helper)).toBe(true);
    await connection.close();
    await waitFor(() => (alive(helper) ? undefined : true), `helper ${helper} to end`);
    expect(alive(helper)).toBe(false);
  });

  test('a program that connects, closes and returns exits by itself, even with a helper holding its pipes', async () => {
    const folder = scratchFolder();
    const record = join(folder, 'record.jsonl');
    const pid = join(folder, 'pid');
    const helperRecord = join(folder, 'helpers.txt');
    writeFileSync(record, '');
    const run = spawnSync(process.execPath, [CLOSE_AND_RETURN, FAKE_AGENT, record, pid, helperRecord], {
      cwd: process.cwd(),
      timeout: 20_000,
      encoding: 'utf8',
      env: { ...process.env, ACP_FAKE_HELPER_RECORD: helperRecord },
    });
    // A program held open by an inherited pipe would be killed at the bound
    // with a signal and no status, so its own exit is what this asks for.
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    const helper = Number(/helper (\d+)/.exec(run.stdout)?.[1] ?? '0');
    expect(helper).toBeGreaterThan(0);
    await waitFor(() => (alive(helper) ? undefined : true), `helper ${helper} to end`);
    expect(alive(helper)).toBe(false);
  });
});
