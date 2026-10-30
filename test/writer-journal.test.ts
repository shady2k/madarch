/**
 * The core's journal of the writer's agent (madarch-m38l.13): one record per call the agent makes to a unit's tools
 * and one per request madarch refuses, whatever the agent was. The agent here is the hand-written fake ACP agent
 * driven by a script; the tools are the writer's own `UnitTools`, so a count of records is compared with the count
 * the progress block shows (`UnitOutcome.calls`). No model is involved and no graph is needed: the calls below are
 * the ones the tools answer before they read anything.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STAGE_LIMITS } from '../src/fill/stage.js';
import { acpUnitAgent } from '../src/writer/acp-agent.js';
import { fileJournal, journalOfUnit, MAX_RESPONSE_CHARACTERS, memoryJournal, newRunId, NO_COUNTERS, readJournalFile, recordOf } from '../src/writer/journal.js';
import type { ToolClient } from '../src/writer/run.js';
import { memorySink } from '../src/writer/run.js';
import { UnitTools, WRITER_TOOLS, type UnitSpec } from '../src/writer/tools.js';
import type { GraphView } from '../src/writer/view.js';

const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');
const folders: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-journal-'));
  folders.push(folder);
  return folder;
}

/** One turn: the script is the whole of the agent's work, and the unit is not asked again. */
const ONE_TURN = { ...DEFAULT_STAGE_LIMITS, maxTurns: 1 };

const UNIT: UnitSpec = { kind: 'product', id: 'product:tiny', path: 'docs/product.md', name: 'Tiny' };

/** The writer's real tools without a graph: the calls used here are answered before any read. */
function realTools(maxCalls = 80): { tools: UnitTools; client: ToolClient } {
  const tools = new UnitTools(null as unknown as GraphView, UNIT, memorySink(), [], { maxWriteAttempts: 5, maxCalls });
  return { tools, client: { definitions: tools.tools, call: (tool, args) => tools.call(tool, args), finished: () => tools.finished } };
}

function fakeAgent(folder: string, steps: unknown, journal: ReturnType<typeof memoryJournal>) {
  const script = join(folder, 'script.json');
  writeFileSync(script, JSON.stringify(steps));
  const agent = acpUnitAgent({ spec: { id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', script] }, limits: ONE_TURN, journal });
  closers.push(() => agent.close());
  return agent;
}

describe('a journal record', () => {
  test('keeps the whole arguments and the response, with its size, and says when it cut the response', () => {
    const context = { run: 'run-a', unit: 'domain:x', agent: 'fake', model: 'm', session: 's' };
    const entry = { kind: 'tool-call' as const, tool: 'read_file', arguments: { path: 'a.md', startLine: 1 }, response: 'é'.repeat(MAX_RESPONSE_CHARACTERS + 10), isError: false, outcome: 'ok' as const, reason: null, startedAt: new Date('2026-10-23T10:00:00.000Z'), durationMs: 12.6 };
    const record = recordOf(context, entry);
    expect(record.arguments).toEqual({ path: 'a.md', startLine: 1 });
    expect(record.truncated).toBe(true);
    expect(record.response!.length).toBe(MAX_RESPONSE_CHARACTERS);
    expect(record.responseBytes).toBe((MAX_RESPONSE_CHARACTERS + 10) * 2);
    expect(record.durationMs).toBe(13);
    expect(record.time).toBe('2026-10-23T10:00:00.000Z');
    expect(record.attributes).toMatchObject({ 'gen_ai.tool.name': 'read_file', 'gen_ai.agent.name': 'fake', 'gen_ai.request.model': 'm', 'gen_ai.conversation.id': 's', 'madarch.run': 'run-a', 'madarch.unit': 'domain:x' });
    const whole = recordOf(context, { ...entry, response: '{"a":1}' });
    expect(whole.truncated).toBe(false);
    expect(whole.response).toBe('{"a":1}');
    expect(whole.responseBytes).toBe(7);
  });

  test('a file journal appends lines, reads back, and names the file and line of one it cannot read', () => {
    const folder = scratch();
    const run = newRunId(new Date('2026-10-23T10:00:00.000Z'));
    expect(run).toMatch(/^run-20261023T100000000Z-[0-9a-f]{4}$/);
    const journal = fileJournal(join(folder, 'journal'), run);
    const context = { run, unit: 'product:tiny', agent: 'fake', model: null, session: null };
    const at = new Date('2026-10-23T10:00:00.000Z');
    journal.record(context, { kind: 'tool-call', tool: 'overview', arguments: {}, response: '{}', isError: false, outcome: 'ok', reason: null, startedAt: at, durationMs: 1 });
    journal.record({ ...context, unit: 'domain:other' }, { kind: 'refusal', tool: 'fs/read_text_file', arguments: { path: '/x' }, response: 'no', isError: true, outcome: 'rejected', reason: 'no', startedAt: at, durationMs: 0 });
    appendFileSync(journal.file, 'not json\n');
    const read = readJournalFile(journal.file);
    expect(read.records.map((record) => record.tool)).toEqual(['overview', 'fs/read_text_file']);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toContain(`${journal.file}:3:`);
    const mine = journalOfUnit(join(folder, 'journal'), 'product:tiny');
    expect(mine.run).toBe(run);
    expect(mine.runs).toEqual([run]);
    expect(mine.records.map((record) => record.tool)).toEqual(['overview']);
    expect(journalOfUnit(join(folder, 'journal'), 'product:none').run).toBeNull();
    expect(journalOfUnit(join(folder, 'missing'), 'product:tiny')).toEqual({ run: null, runs: [], records: [], totals: NO_COUNTERS, problems: [] });
  });

  test('a journal that cannot be written raises with its file named', () => {
    const folder = scratch();
    writeFileSync(join(folder, 'taken'), 'a file where the folder should be');
    const journal = fileJournal(join(folder, 'taken'), 'run-x');
    expect(() => journal.record({ run: 'run-x', unit: 'u', agent: 'a', model: null, session: null }, { kind: 'tool-call', tool: 't', arguments: null, response: null, isError: false, outcome: 'ok', reason: null, startedAt: new Date(), durationMs: 0 })).toThrow(/src\/writer\/journal\.ts: the journal .*run-x\.jsonl cannot be written/);
  });
});

describe('the journal of a unit driven over ACP', () => {
  test('holds one record per tool call, the count the progress block shows, and every refusal', async () => {
    const folder = scratch();
    const journal = memoryJournal('run-test');
    const { tools, client } = realTools();
    const agent = fakeAgent(folder, {
      steps: [
        { call: { tool: 'write_page', arguments: {} } },
        { call: { tool: 'ask_question', arguments: { type: 'gap' } } },
        { call: { tool: 'shell', arguments: { command: 'ls' } } },
        { call: { tool: 'write_page', arguments: { markdown: '' } } },
        { refused: 'fs-read' },
        { refused: 'fs-write' },
        { refused: 'permission' },
        { refused: 'terminal' },
        { end: { stopReason: 'end_turn' } },
      ],
    }, journal);
    await agent.run({ id: UNIT.id, prompt: 'WRITE', tools: client });
    const outcome = tools.outcome();
    const calls = journal.records.filter((record) => record.kind === 'tool-call');
    // The progress block's "tool calls: N" is the tools' own count; the journal holds exactly those calls.
    expect(calls.length).toBe(outcome.calls);
    expect(outcome.calls).toBe(3);
    expect(calls.map((record) => record.tool)).toEqual(['write_page', 'ask_question', 'write_page']);
    expect(calls.map((record) => record.outcome)).toEqual(['refused', 'refused', 'refused']);
    expect(calls[0]!.arguments).toEqual({});
    expect(calls[1]!.arguments).toEqual({ type: 'gap' });
    // A product unit's write_page takes the home page's fields beside the domains it declares (madarch-ztyq.7):
    // arguments with neither are refused before anything is read, and the refusal is what the journal holds.
    expect(calls[0]!.reason).toContain('domains');
    expect(calls[1]!.reason).toContain('bad-question');
    expect(calls[2]!.reason).toContain('domains');
    expect(JSON.parse(calls[1]!.response!)).toMatchObject({ error: { code: 'bad-question' } });
    expect(calls[1]!.responseBytes).toBe(Buffer.byteLength(calls[1]!.response!, 'utf8'));
    expect(calls.every((record) => record.isError && !record.truncated)).toBe(true);
    // Who, with what: the run, the unit, the agent, the model and the session the agent reported.
    for (const record of journal.records) {
      expect(record).toMatchObject({ run: 'run-test', unit: UNIT.id, agent: 'fake', model: 'fake-model-1' });
      expect(record.session).toMatch(/^fake-session-/);
      expect(Number.isNaN(Date.parse(record.time))).toBe(false);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
    // Refusals are records too: a tool the unit does not have, a file read and write, a permission, a terminal.
    const refusals = journal.records.filter((record) => record.kind === 'refusal');
    expect(refusals.map((record) => record.tool)).toEqual(['shell', 'fs/read_text_file', 'fs/write_text_file', 'session/request_permission', 'terminal/create']);
    expect(refusals.every((record) => record.outcome === 'rejected' && record.isError && record.reason !== null)).toBe(true);
    expect(refusals[0]!.arguments).toEqual({ command: 'ls' });
    expect(refusals[0]!.reason).toContain('no tool of this unit');
    expect(refusals[1]!.reason).toContain('code is read through the session');
    expect(refusals[3]!.reason).toContain('cancelled');
    expect(refusals[4]!.reason).toContain('no terminal');
  });

  test('a call the tools refuse because the unit used its calls is a record, and counts', async () => {
    const folder = scratch();
    const journal = memoryJournal('run-limit');
    const { tools, client } = realTools(2);
    const agent = fakeAgent(folder, { steps: [{ call: { tool: 'write_page', arguments: {} } }, { call: { tool: 'write_page', arguments: {} } }, { call: { tool: 'write_page', arguments: {} } }, { end: { stopReason: 'end_turn' } }] }, journal);
    await agent.run({ id: UNIT.id, prompt: 'WRITE', tools: client });
    const calls = journal.records.filter((record) => record.kind === 'tool-call');
    expect(calls.length).toBe(tools.outcome().calls);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.reason).toContain('call-limit');
    expect(calls[2]!.outcome).toBe('refused');
  });

  test('the journal records the selected model after saved preferences are applied', async () => {
    const folder = scratch();
    const journal = memoryJournal('run-preference');
    const { tools, client } = realTools();
    const script = join(folder, 'script.json');
    writeFileSync(script, JSON.stringify({ steps: [{ call: { tool: 'write_page', arguments: {} } }, { end: { stopReason: 'end_turn' } }] }));
    const agent = acpUnitAgent({ spec: { id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--models', '--scenario', 'script', '--script', script] }, limits: ONE_TURN, journal, preferences: { model: 'opus' } });
    closers.push(() => agent.close());
    await agent.run({ id: UNIT.id, prompt: 'WRITE', tools: client });
    expect(journal.records[0]!.model).toBe('opus');
    expect(journal.records[0]!.attributes['gen_ai.request.model']).toBe('opus');
  }, 30_000);

  test('a unit with no journal runs as before', async () => {
    const folder = scratch();
    const { tools, client } = realTools();
    const script = join(folder, 'script.json');
    writeFileSync(script, JSON.stringify({ steps: [{ call: { tool: 'write_page', arguments: {} } }, { refused: 'fs-read' }, { end: { stopReason: 'end_turn' } }] }));
    const agent = acpUnitAgent({ spec: { id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', script] }, limits: ONE_TURN });
    closers.push(() => agent.close());
    await agent.run({ id: UNIT.id, prompt: 'WRITE', tools: client });
    expect(tools.outcome().calls).toBe(1);
  });
});

describe('the journal over the wiki\'s product', () => {
  test('is written under the product\'s store by a run, read per page, and counts what the progress block says', async () => {
    const { KnowledgeProduct } = await import('../src/knowledge/product.js');
    const { execFileSync } = await import('node:child_process');
    const { gitEnv } = await import('./git-env.js');
    const { SAMPLE_IDENTITY, makeProduct } = await import('./knowledge-fixture.js');
    const root = scratch();
    const repository = join(root, 'repo');
    mkdirSync(join(repository, 'src'), { recursive: true });
    const env = gitEnv(SAMPLE_IDENTITY);
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repository, env }); };
    git('init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'one', '--date', '2026-03-01T10:00:00Z');
    const home = join(root, 'home');
    mkdirSync(home);
    const productFolder = makeProduct(home, 'tiny', repository, 'tiny');
    const store = join(root, 'store');

    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const lines = (async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })();
    const say = (message: unknown): void => { queue.push(JSON.stringify(message)); wake?.(); };
    const toWorker: { type: string; callId?: number; name?: string }[] = [];
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    let handled = 0;
    const worker = {
      send: (message: { type: string; callId?: number; name?: string }) => {
        toWorker.push(message);
        // The worker answers every tool call like the writer's tools do: a refusal until a page is written.
        if (message.type === 'tool') {
          handled += 1;
          say({ type: 'tool-result', callId: message.callId, answer: { answer: { error: { code: 'bad-argument', message: 'nothing to read here' } }, isError: true }, finished: false });
        }
      },
      lines, exited, stderr: () => '', kill: () => undefined,
    };
    const script = join(root, 'script.json');
    writeFileSync(script, JSON.stringify({ steps: [{ call: { tool: 'overview', arguments: {} } }, { call: { tool: 'find_nodes', arguments: { kind: 'code.service' } } }, { refused: 'fs-read' }, { end: { stopReason: 'end_turn' } }] }));
    const product = new KnowledgeProduct({
      productFolder, storeRoot: store, env: { HOME: join(root, 'user'), PATH: join(root, 'none') },
      workerFactory: () => worker as never,
      agentFactory: (_id, journal) => {
        const agent = acpUnitAgent({ spec: { id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', script] }, limits: ONE_TURN, journal });
        closers.push(() => agent.close());
        return agent;
      },
    });
    try {
      const identity = product.product() as { id: string };
      mkdirSync(join(store, identity.id), { recursive: true });
      writeFileSync(join(store, identity.id, 'writer.json'), '{"agent":"claude-code"}\n');
      expect((await product.startFill()).started).toBe(true);
      const until = async (done: () => boolean, what: string): Promise<void> => {
        for (let tries = 0; tries < 300 && !done(); tries += 1) await new Promise((rest) => setTimeout(rest, 50));
        if (!done()) throw new Error(`timed out waiting for ${what}`);
      };
      await until(() => toWorker.some((message) => message.type === 'start'), 'the start message');
      say({ type: 'agent-wanted' });
      await until(() => toWorker.some((message) => message.type === 'agent-ready'), 'the agent');
      say({ type: 'unit-start', unit: 'product:tiny', path: 'docs/product.md' });
      say({ type: 'unit', id: 'product:tiny', prompt: 'WRITE', definitions: WRITER_TOOLS });
      await until(() => toWorker.some((message) => message.type === 'unit-end'), 'the unit to end');
      say({ type: 'unit-outcome', outcome: { unit: 'product:tiny', status: 'failed', writeAttempts: 0, calls: handled, refusals: [], domains: [] } });
      say({ type: 'writer', state: 'done' });
      say({ type: 'fill', state: 'done', gaps: 0 });
      ended = true;
      wake?.();
      exit(0);
      await product.settled();
      const shown = product.writerState().units.find((unit) => unit.unit === 'product:tiny');
      const journal = product.journalOf('product:tiny');
      expect(journal.run).toMatch(/^run-/);
      const calls = journal.records.filter((record) => record.kind === 'tool-call');
      // The progress block's "tool calls" and the journal's count are one number.
      expect(shown?.calls).toBe(2);
      expect(calls.length).toBe(shown?.calls as number);
      expect(calls.map((record) => record.tool)).toEqual(['overview', 'find_nodes']);
      expect(journal.records.filter((record) => record.kind === 'refusal').map((record) => record.tool)).toEqual(['fs/read_text_file']);
      // It lives in the product's machine-local store, not in the product repository.
      expect(readFileSync(join(store, identity.id, 'journal', `${journal.run}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(3);
      // A page no run wrote answers with an empty journal instead of a refusal: which pages the store holds is its own
      // files' answer, and a reader asking about a page that has none is told so, not turned away (madarch-m38l.23).
      expect(product.journalOf('question:x')).toEqual({ run: null, runs: [], records: [], totals: { sourceBytes: { served: 0, repeated: 0 }, evidence: 0, unresolvedJoins: 0, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } }, problems: [] });
      expect(product.journalOf('domain:never').run).toBeNull();
    } finally {
      await product.close();
    }
  }, 90_000);
});
