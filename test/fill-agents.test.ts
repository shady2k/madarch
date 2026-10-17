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
    const omp=agentCommand('omp','/source','inspect',{model:'shady2k-gateway/glm-5.3-flash-auto',extension:'/tmp/gateway.js',executable:'/tmp/omp'});
    expect(omp).toEqual({command:'/tmp/omp',cwd:'/source',args:['-p','--no-session','--no-extensions','-e','/tmp/gateway.js','--model','shady2k-gateway/glm-5.3-flash-auto','--mode','json','--tools','read,grep,glob','inspect']});
    expect(()=>agentCommand('omp','/source','inspect')).toThrow(/explicit --model/); expect(()=>agentCommand('omp','/source','inspect',{model:'m',extension:'e',tools:'bash'})).toThrow(/not allowed/);
    const codex = agentCommand('codex', '/tmp/code', 'inspect');
    expect(codex.args).toEqual(['exec', '--json', '--sandbox', 'read-only', '--cd', '/tmp/code', 'inspect']);
    expect(() => agentCommand('claude', '', 'inspect')).toThrow();
  });
  test('runs OMP via a fake process with configured model, extension and safe tools',async()=>{
    let invoked:any; const executor=createHeadlessAgentExecutor({kind:'omp',snapshot:'/source',promptFor:()=>'{\"claims\":[]}',settings:{model:'shady2k-gateway/glm-5.3-flash-auto',extension:'/tmp/gateway.js'},onEvent:()=>{},spawn:((command:string,args:string[],options:any)=>{invoked={command,args,options};return fakeProcess(0,'{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"{\\\"claims\\\":[]}\"}],\"usage\":{\"input\":19,\"cacheRead\":6,\"output\":4}}}\n');}) as never});
    const result=await executor.execute(unit,new AbortController().signal,async()=>{}); expect(invoked.command).toBe('omp'); expect(invoked.args).toContain('shady2k-gateway/glm-5.3-flash-auto'); expect(invoked.args).toContain('read,grep,glob'); expect(result.agentUsage?.elapsedMs).toBeGreaterThanOrEqual(0); expect(result.agentUsage?.inputTokens).toBe(25); expect(result.agentUsage?.outputTokens).toBe(4);
  });
  test('normalizes JSONL provider events and redacts credential-like summary text', () => {
    expect(normalizeAgentEvent('{"type":"assistant","message":"token=secret-value"}', unit, '2026-01-01T00:00:00Z')).toEqual({ unitId: 'unit-1', stage: 'claims', type: 'assistant', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'assistant', summary: '[REDACTED]', data: { type: 'assistant', message: '[REDACTED]' } } });
    expect(normalizeAgentEvent('not json', unit)).toBeUndefined();
    const credential = normalizeAgentEvent('{"type":"result","api_key":"abc","data":{"password":"secret"}}', unit)!;
    expect(credential.payload).toMatchObject({ data: { api_key: '[REDACTED]', data: { password: '[REDACTED]' } } });
    const camel = normalizeAgentEvent('{"type":"result","apiKey":"abc","accessToken":"xyz"}', unit)!;
    expect(camel.payload).toMatchObject({ data: { apiKey: '[REDACTED]', accessToken: '[REDACTED]' } });
    const envSecrets = normalizeAgentEvent('{"type":"result","OPENAI_API_KEY":"key1","GITHUB_TOKEN":"key2","AWS_SECRET_ACCESS_KEY":"key3"}', unit)!;
    expect(envSecrets.payload).toMatchObject({ data: { OPENAI_API_KEY: '[REDACTED]', GITHUB_TOKEN: '[REDACTED]', AWS_SECRET_ACCESS_KEY: '[REDACTED]' } });
    expect(normalizeAgentEvent('{"type":"message","text":"AWS_SECRET_ACCESS_KEY=abc123"}', unit)?.payload).toMatchObject({ summary: '[REDACTED]' });
  });
  test('propagates asynchronous event persistence failures to the unit executor', async () => {
    const executor = createHeadlessAgentExecutor({ kind: 'codex', snapshot: '/source', promptFor: () => 'inspect', onEvent: async () => { throw undefined; }, spawn: (() => fakeProcess(0, '{"type":"item.completed"}\n')) as never });
    await expect(executor.execute(unit, new AbortController().signal, async () => undefined)).rejects.toThrow('Could not persist agent event');
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
