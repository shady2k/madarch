import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AcpConnection, AcpSession, ConnectAcpOptions } from '../src/fill/acp.js';
import { PluginAgentBridge, type PluginAgentOptions } from '../src/plugin/agent.js';
import { AgentMeter, AgentRunBudget } from '../src/fill/agent-meter.js';
import type { PluginUnitResult } from '../src/plugin/protocol.js';

const outputs = { vertices: [{ kind: 'summary', key: ['id'], fields: [{ name: 'title', type: 'text' as const, required: false, meaning: 'title', example: 'A' }] }], edges: [] };
const graph = {
  files: async () => [{ kind: 'file', key: { repository: 'repo', path: 'docs/a.md' } }, { kind: 'file', key: { repository: 'repo', path: 'private/b.md' } }],
  // The graph names each file's blob; the text is asked of the host by that blob (decision 0037).
  value: async (_kind: string, key: Readonly<Record<string, string | number>>, field: string) => field === 'blob' ? `blob-${String(key['path'])}` : null,
};
/** The one blob read the host answers: a file's text, by blob id and line range. */
const readFile = async (request: { readonly repository: string; readonly blob: string; readonly from?: number; readonly limit?: number }): Promise<string> => {
  const lines = ['first', 'second'];
  if (request.blob !== 'blob-docs/a.md') throw new Error(`no text for ${request.blob}`);
  const from = (request.from ?? 1) - 1;
  return lines.slice(from, request.limit === undefined ? undefined : from + request.limit).join('\n');
};
const result: PluginUnitResult = { unitId: 'ignored', vertices: [{ kind: 'summary', key: { id: 'a' }, values: { title: 'A' }, evidence: { repository: 'repo', path: 'docs/a.md', lineStart: 1, lineEnd: 2 } }], end: { state: 'complete' } };
function setup(turn: (options: ConnectAcpOptions, signal?: AbortSignal) => Promise<unknown>, extra: Partial<PluginAgentOptions> = {}, writeRoots: string[] = [], roots: string[] = ['repo/docs']) {
  const state = { closed: 0, frozen: 0, thawed: 0 };
  const bridge = new PluginAgentBridge({ prompt: 'extract', roots, writeRoots }, {
    adapter: { id: 'fake', command: 'fake', env: { SECRET: 'must not pass' } }, readFile, ...extra,
    connect: async (spec, options) => {
      expect(spec.env).toEqual({ SECRET: 'must not pass' });
      expect(options.env).toEqual(extra.environment);
      expect(options.exactEnv).toBeUndefined();
      const session = {
        sessionId: 'session', model: 'fake-model', configOptions: [], models: null,
        usage: () => ({ reported: false, turns: 1, reports: 0 }),
        prompt: async (_text: string, opts?: { signal?: AbortSignal }) => ({ usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, stopReason: 'end_turn', text: JSON.stringify(await turn(options, opts?.signal)), updates: [] }),
      } as unknown as AcpSession;
      return { initialize: async () => ({}), newSession: async () => session, close: async () => { state.closed++; }, freeze: () => { state.frozen++; }, thaw: () => { state.thawed++; } } as unknown as AcpConnection & { freeze(): void; thaw(): void };
    },
  }, graph, outputs);
  return { bridge, state };
}

describe('plugin agent graph bridge', () => {
  test('one run cap counts scripted turns from different plugin agents', async () => {
    const budget = new AgentRunBudget({ tokens: 150 });
    const make = (plugin: string) => new AgentMeter({ run: 'fill', unit: plugin, plugin, pluginVersion: '1', kind: 'summary', budget });
    const first = make('first');
    const second = make('second');
    await setup(async () => result, { meter: first }).bridge.run('first', {});
    await expect(setup(async () => result, { meter: second }).bridge.run('second', {})).rejects.toThrow('200 tokens');
    expect(budget.tokens).toBe(200);
    expect(second.stop()?.scope).toBe('run');
  });
  test('meters the real prompt with host-owned kind and model, and enforces the unit bound', async () => {
    const meter = new AgentMeter({ run: 'fill', unit: 'unit', plugin: 'extract', pluginVersion: '1', kind: 'summary', bounds: { tokens: 90 } });
    const { bridge, state } = setup(async () => result, { meter });
    await expect(bridge.run('unit', { kind: 'made-up', field: 'title' })).rejects.toThrow('100 tokens');
    expect(meter.rows()).toMatchObject([{ kind: 'summary', field: '', model: 'fake-model', inputTokens: 80, outputTokens: 20, totalTokens: 100, turns: 1, stopped: 'tokens' }]);
    expect(state.closed).toBe(1);
  });

  test('meters an invalid answer before validation refuses it and does not replace its error', async () => {
    const meter = new AgentMeter({ run: 'fill', unit: 'unit', plugin: 'extract', pluginVersion: '1', kind: 'summary' });
    const { bridge } = setup(async () => ({ ...result, vertices: [{ ...result.vertices![0], kind: 'other' }] }), { meter });
    await expect(bridge.run('unit', {})).rejects.toThrow('declares');
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

  test('refuses missing, outside-root and out-of-range evidence rather than shortening the result', async () => {
    for (const evidence of [undefined, { repository: 'repo', path: 'docs/a.md' }, { repository: 'repo', path: 'docs/a.md', lineStart: 1 }, { repository: 'repo', path: 'private/b.md' }, { repository: 'repo', path: 'docs/a.md', lineStart: 2, lineEnd: 3 }]) {
      const { bridge, state } = setup(async () => ({ ...result, vertices: [{ ...result.vertices![0], evidence }] }));
      await expect(bridge.run('unit', {})).rejects.toThrow('evidence');
      expect(state.closed).toBe(1);
    }
  });

  test('refuses undeclared outputs', async () => {
    const { bridge } = setup(async () => ({ ...result, vertices: [{ ...result.vertices![0], kind: 'other' }] }));
    await expect(bridge.run('unit', {})).rejects.toThrow('declares');
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
