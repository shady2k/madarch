/** Read-only headless adapters for code-derived fill units. */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { FillUnit, FillUnitExecutor } from './fill-runtime.js';

export type AgentKind = 'claude' | 'codex' | 'omp';
/**
 * The environment variable each agent's own client reads an API key from, for
 * a person who pays with a key instead of their subscription. madarch keeps
 * the name and never the key: it is not asked for, not read and not stored,
 * and the agent's client reads whatever the person put in madarch's
 * environment (the owner's decision of 2026-10-19 on madarch-tzte.6). omp has
 * no such variable madarch knows: it takes a model and a gateway extension
 * from this machine instead.
 */
export const AGENT_API_KEY_ENV: Readonly<Record<AgentKind, string | undefined>> = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', omp: undefined };
export interface AgentSettings { model?: string; executable?: string; extension?: string; tools?: string; }
export type AgentEvent = { unitId: string; stage: FillUnit['stage']; type: string; timestamp: string; payload: unknown };
type Child = Pick<ChildProcessWithoutNullStreams, 'stdout' | 'stderr' | 'once' | 'kill'>;
type Spawn = (command: string, args: string[], options: { cwd: string; stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }) => Child;

/** Build an argument vector; extraction is read-only and never receives the product writer's worktree. */
export function agentCommand(kind: AgentKind, snapshot: string, prompt: string, settings: AgentSettings = {}): { command: string; args: string[]; cwd: string } {
  if (!snapshot.trim()) throw new Error('The code snapshot path is required');
  if (!prompt.trim()) throw new Error('The extraction prompt is required');
  if (kind === 'omp') { const model=settings.model; const extension=settings.extension; if(!model?.trim()) throw new Error('OMP requires an explicit --model'); if(!extension?.trim()) throw new Error('OMP requires a configured gateway extension path'); const safeTools=new Set(['read','grep','glob','find','ls']); const requested=(settings.tools??'read,grep,glob').split(',').map(tool=>tool.trim()).filter(Boolean); const unsafe=requested.filter(tool=>!safeTools.has(tool)); if(unsafe.length) throw new Error(`OMP tool is not allowed in read-only extraction: ${unsafe.join(', ')}`); const tools=requested.join(','); return {command:settings.executable??'omp',cwd:snapshot,args:['-p','--no-session','--no-extensions','-e',extension,'--model',model,'--mode','json','--tools',tools,prompt]}; }
  if (kind === 'claude') return {
    command: 'claude', cwd: snapshot,
    args: ['-p', '--output-format', 'stream-json', '--permission-mode', 'plan', '--permission-prompts', 'none', '--add-dir', snapshot, prompt, '--disallowed-tools', 'Write', 'Edit', 'Bash'],
  };
  return { command: 'codex', cwd: snapshot, args: ['exec', '--json', '--sandbox', 'read-only', '--cd', snapshot, prompt] };
}

const safeText = (text: string): string => text.replace(/(?:sk-ant-[A-Za-z0-9_-]{8,}|(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET(?:[_-]ACCESS[_-]KEY)?|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY))[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+|(?:api[_-]?key|token|secret)[=: ]+[^\s,;]+|Bearer\s+[^\s]+)/gi, '[REDACTED]').slice(0, 500);
const redact = (value: unknown): unknown => {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|secret|password|credential|private[_-]?key|client[_-]?secret|_token$)/i.test(key) ? key : key, /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|secret|password|credential|private[_-]?key|client[_-]?secret|_token$)/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
};
const safeSummary = (value: unknown): string => safeText(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
/** Turn one provider JSONL record into a stable, provider-neutral event. */
export function normalizeAgentEvent(line: string, unit: Pick<FillUnit, 'id' | 'stage'>, timestamp = new Date().toISOString()): AgentEvent | undefined {
  let payload: unknown;
  try { payload = JSON.parse(line); } catch { return undefined; }
  if (payload === null || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const type = String(record.type ?? record.event ?? 'message');
  return { unitId: unit.id, stage: unit.stage, type, timestamp, payload: { type, summary: safeSummary(record.message ?? record.summary ?? record.text ?? record.type), data: redact(record) } };
}

/** Run one extraction in the pinned source snapshot. Product writes are intentionally a separate controlled apply operation. */
export function createHeadlessAgentExecutor(options: {
  kind: AgentKind; snapshot: string; promptFor: (unit: FillUnit) => string; settings?: AgentSettings;
  onEvent: (event: AgentEvent) => Promise<void> | void;
  /** Store the unmodified provider line in the unit's private raw log. */
  onRawLine?: (unit: FillUnit, line: string) => Promise<void> | void;
  spawn?: Spawn;
}): FillUnitExecutor {
  const spawn = options.spawn ?? (nodeSpawn as unknown as Spawn);
  return {
    async execute(unit, signal, progress) {
      const startedAt=Date.now();
      const invocation = agentCommand(options.kind, options.snapshot, options.promptFor(unit), options.settings);
      if (signal.aborted) throw new Error('Agent invocation aborted before start');
      const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
      let stdout = '';
      let stderr = '';
      let callbackQueue = Promise.resolve();
      let callbackError: unknown;
      let callbackFailed = false;
      let settled = false;
      const terminate = (): void => { if (!settled) child.kill('SIGTERM'); };
      signal.addEventListener('abort', terminate, { once: true });
      const lines = createInterface({ input: child.stdout });
      const done = new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once('error', (error: Error) => resolve({ code: null, error }));
        child.once('close', (code: number | null) => resolve({ code }));
      });
      lines.on('line', (line) => {
        stdout += line + '\n';
        callbackQueue = callbackQueue.then(async () => {
          await options.onRawLine?.(unit, line);
          const event = normalizeAgentEvent(line, unit);
          if (event) {
            await options.onEvent(event);
            const content = (event.payload as { summary?: string }).summary;
            await progress(content ?? 'Agent event');
          }
        }).catch((error: unknown) => { callbackFailed = true; callbackError ??= error; child.kill('SIGTERM'); });
      });
      child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
      const result = await done;
      await callbackQueue;
      settled = true;
      signal.removeEventListener('abort', terminate);
      lines.close();
      if (signal.aborted) throw new Error('Agent invocation aborted');
      if (callbackFailed) throw new Error(`Could not persist agent event: ${safeSummary(callbackError instanceof Error ? callbackError.message : callbackError)}`);
      if (result.error) throw new Error(`${invocation.command} could not start: ${safeSummary(result.error.message)}`);
      if (result.code !== 0) throw new Error(`${invocation.command} exited with ${String(result.code)}${stderr ? `: ${safeSummary(stderr)}` : ''}`);
      return { outputPaths: unit.outputPaths, agentUsage: { elapsedMs: Date.now()-startedAt, inputTokens: options.kind==='omp' ? (parseUsage(stdout,'input')??0)+(parseUsage(stdout,'cacheRead')??0) : parseUsage(stdout,'input_tokens'), outputTokens: parseUsage(stdout, options.kind==='omp'?'output':'output_tokens') } };
    },
  };
}
function parseUsage(lines: string, key: string): number | undefined {
  let total = 0;
  let found = false;
  for (const line of lines.split('\n')) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const usage = (record.usage ?? (record.message as Record<string,unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
      const value = usage?.[key] ?? (key==='input'?usage?.inputTokens:key==='output'?usage?.outputTokens:undefined);
      if (typeof value === 'number' && Number.isFinite(value)) { total += value; found = true; }
    } catch { /* non-JSON stdout is not an event */ }
  }
  return found ? total : undefined;
}
