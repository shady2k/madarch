import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpConnection, AcpSession, ConnectAcpOptions } from '../src/fill/acp.js';
import { PluginAgentBridge, type PluginAgentOptions } from '../src/plugin/agent.js';
import type { PluginUnitResult } from '../src/plugin/protocol.js';

const outputs = { vertices: [{ kind: 'summary', key: ['id'], fields: [{ name: 'title', type: 'text' as const, required: false, meaning: 'title', example: 'A' }] }], edges: [] };
const graph = {
  files: async () => [{ kind: 'file', key: { repository: 'repo', path: 'docs/a.md' } }, { kind: 'file', key: { repository: 'repo', path: 'private/b.md' } }],
  value: async () => 'first\nsecond',
};
const result: PluginUnitResult = { unitId: 'ignored', vertices: [{ kind: 'summary', key: { id: 'a' }, values: { title: 'A' }, evidence: { repository: 'repo', path: 'docs/a.md', lineStart: 1, lineEnd: 2 } }], end: { state: 'complete' } };
function setup(turn: (options: ConnectAcpOptions, signal?: AbortSignal) => Promise<unknown>, extra: Partial<PluginAgentOptions> = {}, writeRoots: string[] = [], roots: string[] = ['repo/docs']) {
  const state = { closed: 0, frozen: 0, thawed: 0 };
  const bridge = new PluginAgentBridge({ prompt: 'extract', roots, writeRoots }, {
    adapter: { id: 'fake', command: 'fake', env: { SECRET: 'must not pass' } }, ...extra,
    connect: async (spec, options) => {
      expect(spec.env).toEqual({ SECRET: 'must not pass' });
      expect(options.env).toEqual(extra.environment);
      expect(options.exactEnv).toBeUndefined();
      const session = {
        sessionId: 'session', model: 'fake-model', configOptions: [], models: null,
        usage: () => ({ reported: false, turns: 1, reports: 0 }),
        prompt: async (_text: string, opts?: { signal?: AbortSignal }) => ({ stopReason: 'end_turn', text: JSON.stringify(await turn(options, opts?.signal)), updates: [] }),
      } as unknown as AcpSession;
      return { initialize: async () => ({}), newSession: async () => session, close: async () => { state.closed++; }, freeze: () => { state.frozen++; }, thaw: () => { state.thawed++; } } as unknown as AcpConnection & { freeze(): void; thaw(): void };
    },
  }, graph, outputs);
  return { bridge, state };
}

describe('plugin agent graph bridge', () => {
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

  test('writes only granted host roots and never follows a symlink', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'agent-write-'));
    const outside = mkdtempSync(join(tmpdir(), 'agent-outside-'));
    mkdirSync(join(folder, 'docs'));
    symlinkSync(outside, join(folder, 'docs', 'escape'));
    try {
      const { bridge } = setup(async (options) => {
        await expect(options.files!.writeTextFile!({ sessionId: 'session', path: '/repo/private/a.md', content: 'x' })).rejects.toThrow('denied');
        await expect(options.files!.writeTextFile!({ sessionId: 'session', path: '/repo/docs/escape/a.md', content: 'x' })).rejects.toThrow('unsafe');
        await options.files!.writeTextFile!({ sessionId: 'session', path: '/repo/docs/new.md', content: 'ok' });
        return result;
      }, { repositories: { repo: folder } }, ['repo/docs']);
      await bridge.run('unit', {});
    } finally { rmSync(folder, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
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
