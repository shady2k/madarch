import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AcpSession, ConnectAcpOptions } from '../src/fill/acp.js';
import { PluginAgentBridge, type PluginAgentOptions } from '../src/plugin/agent.js';
import { AgentMeter, AgentRunBudget } from '../src/fill/agent-meter.js';
import type { PluginContractDeclaration, PluginEntityRef } from '../src/plugin/protocol.js';

const outputs: PluginContractDeclaration = { vertices: [{ kind: 'summary', key: ['id'], fields: [{ name: 'title', type: 'text' as const, required: false, meaning: 'title', example: 'A' }] }], edges: [] };
const content = 'first\nsecond';
const evidenceTarget = { kind: 'fixture.evidence', key: { digest: createHash('sha256').update(content).digest('hex') } };
const graph = {
  files: async (): Promise<readonly PluginEntityRef[]> => [{ kind: 'code.file', key: { path: 'orphan.md' } }, { kind: 'code.file', key: { path: 'unbound.md' }, keyEdges: {} }, { kind: 'code.file', key: { path: 'docs/a.md' }, keyEdges: { 'code.file-repository': { kind: 'code.repository', key: { name: 'repo' } } } }, { kind: 'code.file', key: { path: 'private/b.md' }, keyEdges: { 'code.file-repository': { kind: 'code.repository', key: { name: 'repo' } } } }],
  value: async (kind: string, key: PluginEntityRef['key'], field: string) => kind === 'fixture.evidence' ? (key['digest'] === evidenceTarget.key.digest ? content : null) : field === 'blob' ? `blob-${String(key['path'])}` : null,
};
/** The one blob read the host answers: a file's text, by blob id and line range. */
const readFile = async (request: { readonly repository: string; readonly blob: string; readonly from?: number; readonly limit?: number }): Promise<string> => {
  const lines = ['first', 'second'];
  if (request.blob !== 'blob-docs/a.md') throw new Error(`no text for ${request.blob}`);
  const from = (request.from ?? 1) - 1;
  return lines.slice(from, request.limit === undefined ? undefined : from + request.limit).join('\n');
};
const result: Awaited<ReturnType<PluginAgentBridge['run']>> = { unitId: 'ignored', vertices: [{ kind: 'summary', key: { id: 'a' }, values: { title: 'A' }, evidence: { target: evidenceTarget, path: 'docs/a.md', lineStart: 1, lineEnd: 2 } }], end: { state: 'complete' } };
function setup(turn: (options: ConnectAcpOptions, signal?: AbortSignal) => Promise<unknown>, extra: Partial<PluginAgentOptions> = {}, writeRoots: string[] = [], roots: string[] = ['repo/docs']) {
  const state = { closed: 0, frozen: 0, thawed: 0 };
  const bridge = new PluginAgentBridge({ prompt: 'extract', roots, writeRoots }, {
    adapter: { id: 'fake', command: 'fake', env: { SECRET: 'must not pass' } }, readFile,
    evidenceContracts: [{ name: 'fixture.evidence', evidence: { immutable: true, digestField: 'digest', contentField: 'content', digestAlgorithm: 'sha256' } }], ...extra,
    connect: async (spec, options) => {
      expect(spec.env).toEqual({ SECRET: 'must not pass' });
      expect(options.env).toEqual(extra.environment);
      expect(options.exactEnv).toBeUndefined();
      const session: AcpSession = {
        sessionId: 'session', model: 'fake-model', configOptions: [], models: null, modes: null,
        setConfigOption: async () => { throw new Error('No fixture config options'); },
        setModel: async () => { throw new Error('No fixture models'); },
        cancel: async () => undefined, running: () => false,
        usage: () => ({ reported: false, turns: 1, reports: 0 }),
        prompt: async (_text: string, opts?: { signal?: AbortSignal }) => ({ usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, stopReason: 'end_turn', text: JSON.stringify(await turn(options, opts?.signal)), updates: [] }),
      };
      return { spec, executable: '/fixture', stderr: () => '', closed: new Promise<void>(() => undefined), initialize: async () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }), newSession: async () => session, close: async () => { state.closed++; }, freeze: () => { state.frozen++; }, thaw: () => { state.thawed++; } };
    },
  }, graph, outputs);
  return { bridge, state };
}

describe('plugin agent graph bridge', () => {
  test('one run cap counts scripted turns from different plugin agents, and the answer produced under it stands', async () => {
    const budget = new AgentRunBudget({ tokens: 150 });
    const make = (plugin: string) => new AgentMeter({ run: 'fill', unit: plugin, plugin, pluginVersion: '1', kind: 'summary', budget });
    const first = make('first');
    const second = make('second');
    await setup(async () => result, { meter: first }).bridge.run('first', {});
    // The second turn crosses the shared cap while it works: the owner's rule keeps what the agent produced, and the
    // meter states that the run's cap stopped it (owner's decision, 2026-11-15).
    const kept = await setup(async () => result, { meter: second }).bridge.run('second', {});
    expect(kept.vertices).toHaveLength(1);
    expect(budget.tokens).toBe(200);
    expect(second.stop()?.scope).toBe('run');
  });
  test('meters the real prompt with host-owned kind and model, and states the unit bound it crossed', async () => {
    const meter = new AgentMeter({ run: 'fill', unit: 'unit', plugin: 'extract', pluginVersion: '1', kind: 'summary', bounds: { tokens: 90 } });
    const { bridge, state } = setup(async () => result, { meter });
    // The bound is checked before a prompt, never after one: this turn was asked under a fresh meter, crossed the bound
    // while it worked, and its answer stands; the next prompt under this meter is refused.
    const kept = await bridge.run('unit', { kind: 'made-up', field: 'title' });
    expect(kept.vertices).toHaveLength(1);
    expect(meter.rows()).toMatchObject([{ kind: 'summary', field: '', model: 'fake-model', inputTokens: 80, outputTokens: 20, totalTokens: 100, turns: 1, stopped: 'tokens' }]);
    await expect(bridge.run('unit', {})).rejects.toThrow('100 tokens');
    expect(state.closed).toBe(2);
  });

  test('meters an answer it cannot take before leaving its entries out, and does not replace its error', async () => {
    const meter = new AgentMeter({ run: 'fill', unit: 'unit', plugin: 'extract', pluginVersion: '1', kind: 'summary' });
    const { bridge } = setup(async () => ({ ...result, vertices: [{ ...result.vertices![0], kind: 'other' }] }), { meter });
    // The entry is left out and named; the answer beside it holds nothing, so the unit's end says it was partial.
    const kept = await bridge.run('unit', {});
    expect(kept.vertices).toEqual([]);
    expect(kept.end).toMatchObject({ state: 'partial' });
    expect(String((kept.end as { cause?: string }).cause)).toContain('declares');
    expect(meter.rows()[0]).toMatchObject({ totalTokens: 100, turns: 1, stopped: null });
  });

  test('new agent sessions count their full usage even when their reports have the same total', async () => {
    const meter = new AgentMeter({ run: 'fill', unit: 'unit', plugin: 'extract', pluginVersion: '1', kind: 'summary' });
    const { bridge } = setup(async () => result, { meter });
    await bridge.run('unit', {});
    await bridge.run('unit', {});
    expect(meter.rows()[0]).toMatchObject({ totalTokens: 200, turns: 2 });
  });

  test('retains failed prompt errors and counts the attempted turn', async () => {
    const meter = new AgentMeter({ run: 'fill', unit: 'unit', plugin: 'extract', pluginVersion: '1', kind: 'summary' });
    const failure = new Error('adapter disconnected');
    const { bridge } = setup(async () => { throw failure; }, { meter });
    await expect(bridge.run('unit', {})).rejects.toBe(failure);
    expect(meter.rows()[0]).toMatchObject({ totalTokens: 0, turns: 1, reported: false });
  });

  test('reads only allowed graph files, validates output and keeps credentials host-side', async () => {
    const { bridge, state } = setup(async (options) => {
      expect(await options.files!.readTextFile!({ sessionId: 'session', path: '/repo/docs/a.md', line: 2, limit: 1 })).toEqual({ content: 'second' });
      await expect(options.files!.readTextFile!({ sessionId: 'session', path: '/repo/private/b.md' })).rejects.toThrow('denied');
      await expect(options.files!.readTextFile!({ sessionId: 'session', path: '/repo/docs/../private/b.md' })).rejects.toThrow('non-canonical');
      await expect(options.files!.readTextFile!({ sessionId: 'other', path: '/repo/docs/a.md' })).rejects.toThrow('active');
      return result;
    }, { environment: { TOKEN: 'allowed' } });
    expect((await bridge.run('unit', {})).unitId).toBe('unit');
    expect(state.closed).toBe(1);
  });

  test('accepts dot, slash, trailing-slash, exact-file and union roots; empty roots deny', async () => {
    for (const roots of [['.'], ['/'], ['repo/docs/'], ['repo/docs/a.md'], ['repo/private', 'repo/docs']]) {
      const { bridge } = setup(async (options) => {
        expect(await options.files!.readTextFile!({ sessionId: 'session', path: '/repo/docs/a.md' })).toEqual({ content: 'first\nsecond' });
        return result;
      }, {}, [], roots);
      await bridge.run('unit', {});
    }
    const { bridge } = setup(async (options) => {
      await expect(options.files!.readTextFile!({ sessionId: 'session', path: '/repo/docs/a.md' })).rejects.toThrow('denied');
      return { end: { state: 'complete' } };
    }, {}, [], []);
    await bridge.run('empty', {});
  });

  test('leaves out an entry whose evidence the graph cannot take, names the place, and shortens nothing else', async () => {
    // The owner's rule (2026-11-15): a produced result is kept entry by entry. An entry whose evidence is missing, outside
    // the graph or outside its lines is left out and named; the answers beside it stand.
    for (const evidence of [undefined, { target: result.vertices![0]!.evidence!.target, path: 'docs/a.md' }, { target: result.vertices![0]!.evidence!.target, path: 'docs/a.md', lineStart: 1 }, { target: { kind: 'code.file', key: { path: 'private/b.md' }, keyEdges: { 'code.file-repository': { kind: 'code.repository', key: { name: 'repo' } } } }, path: 'private/b.md' }, { target: result.vertices![0]!.evidence!.target, path: 'docs/a.md', lineStart: 2, lineEnd: 3 }]) {
      const { bridge, state } = setup(async () => ({ ...result, vertices: [{ ...result.vertices![0], evidence }] }));
      const kept = await bridge.run('unit', {});
      expect(kept.vertices).toEqual([]);
      expect(kept.end).toMatchObject({ state: 'partial' });
      expect(String((kept.end as { cause?: string }).cause)).toMatch(/evidence/);
      expect(state.closed).toBe(1);
    }
  });

  test('leaves out an entry whose kind the plugin does not declare, and keeps the entries beside it', async () => {
    const { bridge } = setup(async () => ({ ...result, vertices: [{ ...result.vertices![0], kind: 'other' }, result.vertices![0]] }));
    const kept = await bridge.run('unit', {});
    expect(kept.vertices).toHaveLength(1);
    expect(kept.end).toMatchObject({ state: 'partial' });
    expect(String((kept.end as { cause?: string }).cause)).toContain('declares');
  });

  test('keeps the valid entries when another entry\'s immutable evidence is unavailable', async () => {
    // Unavailable immutable evidence refuses only its entry; the independently cited entry still stands.
    const { bridge } = setup(async () => ({
      unitId: 'ignored',
      vertices: [
        result.vertices![0]!,
        { ...result.vertices![0], key: { id: 'b' }, evidence: { target: { kind: 'fixture.evidence', key: { digest: 'missing' } }, path: 'docs/../a.md', lineStart: 1, lineEnd: 1 } },
      ],
      end: { state: 'complete' },
    }));
    const kept = await bridge.run('unit', {});
    expect(kept.vertices?.map((vertex) => vertex.key)).toEqual([{ id: 'a' }]);
    expect(kept.end).toMatchObject({ state: 'partial' });
    expect(String((kept.end as { cause?: string }).cause)).toContain('vertices[1]');
  });

  test('keeps one entry of a duplicate pair and names the other', async () => {
    const { bridge } = setup(async () => ({
      unitId: 'ignored',
      vertices: [result.vertices![0]!, { ...result.vertices![0], values: { title: 'B' } }],
      end: { state: 'complete' },
    }));
    const kept = await bridge.run('unit', {});
    expect(kept.vertices).toHaveLength(1);
    expect(kept.vertices![0]!.values).toMatchObject({ title: 'A' });
    expect(kept.end).toMatchObject({ state: 'partial' });
    expect(String((kept.end as { cause?: string }).cause)).toMatch(/duplicate/i);
  });

  test('a malformed collection is a malformed answer, never an empty complete one', async () => {
    const { bridge } = setup(async () => ({ unitId: 'ignored', vertices: 'malformed', edges: [], end: { state: 'complete' } }));
    await expect(bridge.run('unit', {})).rejects.toThrow('vertices');
  });

  test('the agent gets no workspace and no write handler: an empty folder, its file read and nothing else', async () => {
    // Owner's rule (2026-11-15; decision 0038): the agent runs with no workspace, writes nothing and runs no shell. Its
    // one file read is a blob the graph names; a path that is no graph file, a write and a terminal ask are refused.
    let seen: ConnectAcpOptions | undefined;
    const { bridge } = setup(async (options) => {
      seen = options;
      expect(options.files!.writeTextFile).toBeUndefined();
      await expect(options.files!.readTextFile!({ sessionId: 'session', path: '/etc/hostname' })).rejects.toThrow('denied');
      return result;
    });
    await bridge.run('unit', {});
    const workspace = seen!.cwd;
    expect(workspace!.startsWith(tmpdir())).toBe(true);
    expect(existsSync(workspace!)).toBe(false);
  });

  test('propagates pause, resume and cancellation to a held agent turn', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { bridge, state } = setup(async (_options, signal) => {
      started();
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return result;
    });
    const pending = bridge.run('unit', {});
    await ready;
    bridge.pause(); bridge.resume();
    expect(state.frozen).toBe(1); expect(state.thawed).toBe(1);
    const refused = pending.catch((error: Error) => error);
    await bridge.close();
    expect((await refused as Error).message).toContain('cancelled');
    await expect(bridge.run('again', {})).rejects.toThrow('closed');
  });
});
