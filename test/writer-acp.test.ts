/**
 * The writer's real-agent driver over a fake ACP agent (the hand-written one of
 * test/fixtures/acp-fake-agent): the unit's tools are served to the agent as an
 * HTTP MCP endpoint bound to one token, the agent calls them as an agent does,
 * and the unit's limits stop a turn that crosses them. No model is involved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STAGE_LIMITS } from '../src/fill/stage.js';
import { acpUnitAgent, serveTools } from '../src/writer/acp-agent.js';
import { WRITER_TOOLS } from '../src/writer/tools.js';
import type { ToolClient } from '../src/writer/run.js';

const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');
const folders: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-writer-acp-'));
  folders.push(folder);
  return folder;
}

/** A tool client that records its calls and answers like the writer's tools: finished once a write_page came. */
function stub(): ToolClient & { readonly calls: { tool: string; args: unknown }[] } {
  const calls: { tool: string; args: unknown }[] = [];
  let wrote = false;
  return {
    calls,
    definitions: WRITER_TOOLS,
    call: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'write_page' || tool === 'write_localized_source') wrote = true;
      return { answer: { written: wrote, echo: tool }, isError: false };
    },
    finished: () => wrote,
  };
}

function agentOf(folder: string, steps: unknown, extra: Partial<Parameters<typeof acpUnitAgent>[0]> = {}) {
  const script = join(folder, 'script.json');
  writeFileSync(script, JSON.stringify(steps));
  const record = join(folder, 'record.jsonl');
  const agent = acpUnitAgent({ spec: { id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', script, '--record', record] }, ...extra });
  closers.push(() => agent.close());
  const messages = (): { method?: string; params?: Record<string, unknown> }[] => readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  return { agent, messages };
}

describe('the unit endpoint', () => {
  test('answers the Model Context Protocol for this unit\'s tools, only with its token', async () => {
    const tools = stub();
    const endpoint = await serveTools(tools, 'secret');
    closers.push(endpoint.close);
    const post = (body: unknown, token = 'secret'): Promise<Response> => fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'other')).status).toBe(401);
    expect((await fetch(endpoint.url, { method: 'GET', headers: { authorization: 'Bearer secret' } })).status).toBe(405);
    const listed = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(['overview', 'find_nodes', 'get_node', 'neighbors', 'read_file', 'write_page', 'ask_question']);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const called = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'overview', arguments: {} } })).json() as { result: { content: { text: string }[]; isError: boolean } };
    expect(JSON.parse(called.result.content[0]!.text)).toEqual({ written: false, echo: 'overview' });
    const unknown = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shell', arguments: {} } })).json() as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
    expect(tools.calls.map((c) => c.tool)).toEqual(['overview']);
  });
});

describe('a unit driven over ACP', () => {
  test('the agent gets the prompt, the unit\'s tools as an HTTP MCP server, and no file system', async () => {
    const folder = scratch();
    const tools = stub();
    const { agent, messages } = agentOf(folder, { steps: [{ call: { tool: 'overview', arguments: {} } }, { call: { tool: 'write_page', arguments: { markdown: 'x' } } }, { say: 'done' }, { end: { stopReason: 'end_turn' } }] });
    await agent.run({ id: 'domain:payments', prompt: 'WRITE THE PAGE', tools });
    expect(tools.calls).toEqual([{ tool: 'overview', args: {} }, { tool: 'write_page', args: { markdown: 'x' } }]);
    const sent = messages();
    const session = sent.find((m) => m.method === 'session/new')!;
    const servers = session.params!['mcpServers'] as { type: string; url: string; headers: { name: string; value: string }[] }[];
    expect(servers).toHaveLength(1);
    expect(servers[0]!.type).toBe('http');
    expect(servers[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(servers[0]!.headers[0]!.name).toBe('Authorization');
    expect(servers[0]!.headers[0]!.value).toMatch(/^Bearer [0-9a-f]{48}$/);
    const prompts = sent.filter((m) => m.method === 'session/prompt');
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0]!.params)).toContain('WRITE THE PAGE');
    // The client offers the agent no file system and no terminal.
    const initialize = sent.find((m) => m.method === 'initialize')!;
    expect(JSON.stringify(initialize.params)).not.toContain('"readTextFile":true');
    // The unit's endpoint is gone once the unit ends.
    await expect(fetch(servers[0]!.url, { method: 'POST' })).rejects.toBeDefined();
  });

  test('a unit whose page is not written is asked again, within the turn limit', async () => {
    const folder = scratch();
    const tools = stub();
    const notes: string[] = [];
    const { agent, messages } = agentOf(folder, { steps: [{ say: 'thinking' }, { end: { stopReason: 'end_turn' } }] }, { limits: { ...DEFAULT_STAGE_LIMITS, maxTurns: 3 }, progress: (line) => notes.push(line) });
    await agent.run({ id: 'product:shop', prompt: 'WRITE', tools });
    const prompts = messages().filter((m) => m.method === 'session/prompt').map((m) => JSON.stringify(m.params));
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('The page is not written yet');
    expect(tools.calls).toEqual([]);
    expect(notes.join('\n')).toContain('turn limit');
  });

  test('an unfinished localized-source turn is prompted to retry its own write tool', async () => {
    const folder = scratch();
    const base = stub();
    const tools: ToolClient & { readonly calls: { tool: string; args: unknown }[] } = {
      ...base,
      definitions: [{ name: 'write_localized_source', description: 'Write a localized source statement.', inputSchema: { type: 'object', properties: { statement: { type: 'string' } }, required: ['statement'] } }],
      call: async (tool, args) => {
        if (tool === 'write_localized_source' && base.calls.length === 0) {
          base.calls.push({ tool, args });
          return { answer: { refused: [{ rule: 'localized-language', message: 'write a Russian statement' }] }, isError: true };
        }
        return base.call(tool, args);
      },
    };
    const { agent, messages } = agentOf(folder, {
      steps: [{ call: { tool: 'write_localized_source', arguments: { statement: 'Токен.' } } }, { end: { stopReason: 'end_turn' } }],
      byPrompt: [{ matches: 'Call write_localized_source', steps: [{ call: { tool: 'write_localized_source', arguments: { statement: 'Токен.' } } }, { end: { stopReason: 'end_turn' } }] }],
    }, { limits: { ...DEFAULT_STAGE_LIMITS, maxTurns: 3 } });
    await agent.run({ id: 'localized-source:doc:test', prompt: 'WRITE', tools });
    const prompts = messages().filter((m) => m.method === 'session/prompt').map((m) => JSON.stringify(m.params));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('write_localized_source');
    expect(prompts[1]).not.toContain('write_page');
    expect(tools.calls.map((call) => call.tool)).toEqual(['write_localized_source', 'write_localized_source']);
  });

  test('only an explicit complete authored comparison enables the fake retry, using current candidate ids', async () => {
    for (const mode of ['complete', 'missing', 'duplicate', 'blank', 'no-candidates', 'none'] as const) {
      const folder = scratch();
      const calls: { tool: string; args: unknown }[] = [];
      let wrote = false;
      const tools: ToolClient = {
        definitions: WRITER_TOOLS, finished: () => wrote,
        call: async (tool, args) => {
          calls.push({ tool, args });
          if (tool === 'write_page') { wrote = true; return { answer: { written: true }, isError: false }; }
          if ((args as { comparison?: unknown }).comparison !== undefined) return { answer: { asked: false, id: 'question:fresh-fixture-id' }, isError: false };
          return { answer: { error: { code: 'question-comparison-required' }, ...(mode === 'no-candidates' ? {} : { candidates: [{ id: 'question:fresh-fixture-id', question: 'Which retention duration applies?' }] }) }, isError: true };
        },
      };
      const notes: string[] = [];
      const authored = { question: 'Which retention duration applies?', same: true, reason: mode === 'blank' ? ' ' : 'Both fixture proposals ask the retention duration.' };
      const compareQuestions = mode === 'missing' ? [] : mode === 'duplicate' ? [authored, authored] : [authored];
      const { agent } = agentOf(folder, { steps: [
        { call: { tool: 'ask_question', arguments: { title: 'How long are orders kept?' }, ...(mode === 'none' ? {} : { compareQuestions }) } },
        { call: { tool: 'write_page', arguments: { markdown: 'x' } } }, { end: { stopReason: 'end_turn' } },
      ] }, { progress: (line) => notes.push(line) });
      await agent.run({ id: 'domain:orders', prompt: 'WRITE', tools });
      const asks = calls.filter((call) => call.tool === 'ask_question');
      expect(asks).toHaveLength(mode === 'complete' ? 2 : 1);
      if (mode === 'complete') expect(asks[1]!.args).toMatchObject({ comparison: [{ id: 'question:fresh-fixture-id', same: true, reason: 'Both fixture proposals ask the retention duration.' }] });
      if (mode !== 'complete') expect(asks.some((call) => (call.args as { comparison?: unknown }).comparison !== undefined)).toBe(false);
    }
  }, 30_000);

  test('a turn that crosses the context stop is cancelled and the unit ends there', async () => {
    const folder = scratch();
    const tools = stub();
    const notes: string[] = [];
    const { agent, messages } = agentOf(folder, { steps: [{ usage: { used: 230_000, size: 272_000 } }, { wait: true }] }, { progress: (line) => notes.push(line) });
    await agent.run({ id: 'product:shop', prompt: 'WRITE', tools });
    expect(notes.join('\n')).toContain('stopped at its context window');
    // The cancel is a notification the agent reads a moment later: wait for it rather than for a fixed time.
    const deadline = Date.now() + 5000;
    while (messages().filter((m) => m.method === 'session/cancel').length === 0 && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 25));
    expect(messages().filter((m) => m.method === 'session/cancel')).toHaveLength(1);
    expect(messages().filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  });
});
