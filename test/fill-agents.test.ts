import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { agentCommand, createHeadlessAgentExecutor, normalizeAgentEvent } from '../src/product/fill-agents.js';
import type { FillUnit } from '../src/product/fill-runtime.js';

const unit: FillUnit = { id: 'unit-1', stage: 'claims', inputHashes: {}, status: 'running', outputPaths: [], attempt: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
function fakeProcess(code: number, stdout: string) {
  const child = { stdout: new PassThrough(), stderr: new PassThrough(), once: (event: string, callback: (...args: any[]) => void) => { if (event === 'close') queueMicrotask(() => { child.stdout.end(stdout); callback(code); }); return child; }, kill: () => true };
  return child;
}

describe('headless agent adapters', () => {
  test('uses constrained Claude and Codex commands in the read-only snapshot', () => {
    const claude = agentCommand('claude', '/tmp/code snapshot', 'inspect');
    expect(claude.command).toBe('claude'); expect(claude.cwd).toBe('/tmp/code snapshot');
    expect(claude.args).toEqual(['-p', '--output-format', 'stream-json', '--permission-mode', 'plan', '--permission-prompts', 'none', '--add-dir', '/tmp/code snapshot', 'inspect', '--disallowed-tools', 'Write', 'Edit', 'Bash']);
    const codex = agentCommand('codex', '/tmp/code', 'inspect');
    expect(codex.args).toEqual(['exec', '--json', '--sandbox', 'read-only', '--cd', '/tmp/code', 'inspect']);
    expect(() => agentCommand('claude', '', 'inspect')).toThrow();
  });
  test('normalizes JSONL provider events and redacts credential-like summary text', () => {
    expect(normalizeAgentEvent('{"type":"assistant","message":"token=secret-value"}', unit, '2026-01-01T00:00:00Z')).toEqual({ unitId: 'unit-1', stage: 'claims', type: 'assistant', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'assistant', summary: '[REDACTED]', data: { type: 'assistant', message: '[REDACTED]' } } });
    expect(normalizeAgentEvent('not json', unit)).toBeUndefined();
    const credential = normalizeAgentEvent('{"type":"result","api_key":"abc","data":{"password":"secret"}}', unit)!;
    expect(credential.payload).toMatchObject({ data: { api_key: '[REDACTED]', data: { password: '[REDACTED]' } } });
    const camel = normalizeAgentEvent('{"type":"result","apiKey":"abc","accessToken":"xyz"}', unit)!;
    expect(camel.payload).toMatchObject({ data: { apiKey: '[REDACTED]', accessToken: '[REDACTED]' } });
  });
  test('executes fake child process and emits normalized progress without a real agent call', async () => {
    const seen: unknown[] = [];
    const executor = createHeadlessAgentExecutor({ kind: 'codex', snapshot: '/source', promptFor: () => 'inspect', onEvent: (event) => { seen.push(event); }, spawn: (() => fakeProcess(0, '{"type":"item.completed","usage":{"input_tokens":7}}\n')) as never });
    const result = await executor.execute(unit, new AbortController().signal, async () => undefined);
    expect(seen).toHaveLength(1);
    expect(result.outputPaths).toEqual([]);
    expect(result.agentUsage?.inputTokens).toBe(7);
  });
});
