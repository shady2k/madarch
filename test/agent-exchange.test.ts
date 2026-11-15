/**
 * The record of an agent unit's whole exchange (madarch-64o5.88): madarch keeps what it handed the agent, every step it
 * streamed, the files it opened, the answer, the tokens and the time, beside the run's trace — bounded, and never a
 * secret of the adapter's environment.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentExchangeRecorder, MAX_STEPS, agentExchangeFile, agentExchangeFolder, readRunAgentExchanges } from '../src/fill/agent-exchange.js';
import type { AcpConnection, AcpAgentSpec, AcpSession, ConnectAcpOptions } from '../src/fill/acp.js';
import { PluginAgentBridge, type PluginAgentOptions } from '../src/plugin/agent.js';
import type { PluginUnitResult } from '../src/plugin/protocol.js';

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agent-exchange-'));
  roots.push(root);
  return root;
}
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const outputs = { vertices: [{ kind: 'summary', key: ['id'], fields: [{ name: 'title', type: 'text' as const, required: false, meaning: 'title', example: 'A' }] }], edges: [] };
const graph = {
  files: async () => [{ kind: 'file', key: { repository: 'repo', path: 'docs/a.md' } }],
  value: async () => 'first\nsecond',
};
const result = { vertices: [{ kind: 'summary', key: { id: 'a' }, values: { title: 'A' }, evidence: { repository: 'repo', path: 'docs/a.md', lineStart: 1, lineEnd: 2 } }], end: { state: 'complete' as const } };

/** A connection whose one session streams a thought, a tool call and a message, and reads one graph file. */
function scripted(): (spec: AcpAgentSpec, options: ConnectAcpOptions) => Promise<AcpConnection> {
  return async (spec, options) => {
    const session = {
      sessionId: 'session-1', model: 'fixture-model', configOptions: [], models: null,
      usage: () => ({ reported: true, turns: 1, reports: 1, inputTokens: 80, outputTokens: 20, totalTokens: 100, context: { used: 1200, size: 200_000 } }),
      prompt: async () => {
        const at = new Date().toISOString();
        options.onUpdate?.({ at, kind: 'thought', sessionUpdate: 'agent_thought_chunk', text: 'reading the document', raw: {} });
        options.onUpdate?.({ at, kind: 'tool-call', sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read docs/a.md', status: 'completed', toolKind: 'read', raw: { locations: [{ path: '/repo/docs/a.md' }], rawInput: { path: 'repo/docs/a.md' } } });
        await options.files!.readTextFile!({ sessionId: 'session-1', path: '/repo/docs/a.md' });
        options.onUpdate?.({ at, kind: 'message', sessionUpdate: 'agent_message_chunk', text: JSON.stringify(result), raw: {} });
        return { stopReason: 'end_turn', text: JSON.stringify(result), updates: [] };
      },
    } as unknown as AcpSession;
    return {
      spec,
      executable: '/fixture/agent',
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
      newSession: async () => session,
      stderr: () => '',
      close: async () => undefined,
      closed: new Promise<void>(() => undefined),
    } as unknown as AcpConnection;
  };
}

describe('the agent unit exchange', () => {
  test('one unit records what it was given, did, opened and returned, and never the adapter environment', async () => {
    const traces = join(scratch(), 'traces');
    const bridge = new PluginAgentBridge({ prompt: 'Fill the kind from the documents.', roots: ['repo/docs'] }, {
      adapter: { id: 'fixture-agent', command: 'fixture', env: { API_TOKEN: 'secret-token-123' } },
      environment: { API_TOKEN: 'secret-token-123' },
      exchange: { run: 'fill-1', traces },
      connect: scripted(),
    } as PluginAgentOptions, graph, outputs);
    const answer = await bridge.run('agent-fill:summary', { kind: 'summary', fields: ['title'] });
    expect((answer as PluginUnitResult).end).toEqual({ state: 'complete' });

    const read = readRunAgentExchanges(traces, 'fill-1');
    expect(read.problems).toEqual([]);
    expect(read.units).toHaveLength(1);
    const unit = read.units[0]!;
    expect(unit).toMatchObject({
      schema: 'madarch.agent-exchange@1', run: 'fill-1', unit: 'agent-fill:summary', agent: 'fixture-agent',
      model: 'fixture-model', session: 'session-1', state: 'turned', stop: 'end_turn', failure: null,
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, turns: 1, reported: true, context: { used: 1200, size: 200000 } },
      returned: { text: JSON.stringify(result) },
      opened: [{ repository: 'repo', path: 'docs/a.md', bytes: 12 }],
    });
    expect(unit.durationMs).toBeGreaterThanOrEqual(0);
    // What it was given: the prompt as sent, the task object and the files it could open.
    expect(unit.given.prompt).toContain('Fill the kind from the documents.');
    expect(unit.given.prompt).toContain('Task: {"kind":"summary","fields":["title"]}');
    expect(unit.given.task).toEqual({ kind: 'summary', fields: ['title'] });
    expect(unit.given.files).toEqual(['repo/docs/a.md']);
    expect(unit.given.filesTotal).toBe(1);
    // What it did: the thought, the tool call with the path it named, and the message.
    expect(unit.steps.map((step) => step.kind)).toEqual(['thought', 'tool-call', 'message']);
    expect(unit.steps[1]).toMatchObject({ title: 'Read docs/a.md', tool: 'read', status: 'completed', path: '/repo/docs/a.md' });
    expect(unit.steps[2]?.text).toBe(JSON.stringify(result));
    // The file madarch wrote says the same, and no value the adapter was started with is in it.
    const file = readFileSync(agentExchangeFile(agentExchangeFolder(traces, 'fill-1'), 'agent-fill:summary'), 'utf8');
    expect(JSON.parse(file)).toEqual(unit as unknown as Record<string, unknown>);
    expect(file).not.toContain('secret-token-123');
  });

  test('the prompt, the steps and the answer are cut at the record bounds and the cut is said', () => {
    const traces = scratch();
    const recorder = new AgentExchangeRecorder({ folder: agentExchangeFolder(traces, 'fill-2'), run: 'fill-2', unit: 'agent-fill:summary', agent: 'fixture' });
    recorder.setGiven({ prompt: 'p'.repeat(200_000), task: { kind: 'summary' }, files: [] });
    const at = new Date().toISOString();
    for (let step = 0; step < MAX_STEPS + 10; step += 1) recorder.step({ at, kind: 'message', sessionUpdate: 'agent_message_chunk', text: `step ${String(step)}`, raw: {} });
    recorder.answer('a'.repeat(20_000), 'end_turn');
    recorder.finish();
    const unit = readRunAgentExchanges(traces, 'fill-2').units[0]!;
    expect(unit.given.cut).toBe(true);
    expect(unit.given.bytes).toBe(200_000);
    expect(unit.given.prompt.length).toBeLessThan(200_000);
    expect(unit.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(unit.stepsDropped).toBeGreaterThanOrEqual(10);
    expect(unit.returned?.cut).toBe(true);
    expect(unit.returned?.bytes).toBe(20_000);
  });

  test('a unit that failed keeps why it failed, and a folder that is not there reads as no exchange', () => {
    const traces = scratch();
    const recorder = new AgentExchangeRecorder({ folder: agentExchangeFolder(traces, 'fill-3'), run: 'fill-3', unit: 'agent-fill:desk', agent: 'fixture' });
    recorder.setGiven({ prompt: 'work', task: null, files: [] });
    recorder.failed(new Error('src/plugin/agent.ts:1: the agent ended with cancelled'));
    recorder.finish();
    const unit = readRunAgentExchanges(traces, 'fill-3').units[0]!;
    expect(unit.state).toBe('failed');
    expect(unit.failure).toContain('the agent ended with cancelled');
    expect(readRunAgentExchanges(traces, 'fill-unknown')).toEqual({ units: [], problems: [] });
  });

  test('a record file that is not one is reported, and every other record still reads', () => {
    const traces = scratch();
    const folder = agentExchangeFolder(traces, 'fill-4');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'broken.json'), '{"schema":"other"}\n');
    const recorder = new AgentExchangeRecorder({ folder, run: 'fill-4', unit: 'agent-fill:summary', agent: 'fixture' });
    recorder.finish();
    const read = readRunAgentExchanges(traces, 'fill-4');
    expect(read.units).toHaveLength(1);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toContain('broken.json');
  });
});
