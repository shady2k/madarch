
/**
 * The meter of a plugin's agent part (madarch-stm0.4, decision 0035, item 22): every model call is counted from the
 * agent's own reports — the model, the tokens in and out and the cost — per plugin run, kind and field; the run stops
 * with the reason when a bound its product declared or the fill's settings declared is crossed; what it spent is in the
 * store's mechanism tables the kind's page reads; and each turn's increment is one span of the run's trace.
 *
 * Nothing here runs a real model or a real agent: the agent is the fake ACP agent of `test/fixtures/acp-fake-agent`, a
 * program of the test's own that speaks ACP over stdio and reports the usage the script tells it to.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { KIND_USAGE_RUNS, readAgentUsageRows, readKindUsage, recordAgentUsage, type AgentUsageRecord } from '../src/adapters/agent-usage.js';
import { connectAcpAgent, type AcpConnection, type AcpSession } from '../src/fill/acp.js';
import { AgentMeter, AgentRunBudget } from '../src/fill/agent-meter.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { SCHEMA_REVISION } from '../src/adapters/schemas/graph-definition.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { closeTrace, openTrace } from '../src/obs/trace.js';
import { readTraceSpans, renderTraceReport, traceReportOf, TraceSpanReader, agentUsageOf, type AgentUsageReport } from '../src/obs/trace-report.js';
import { createTestDatabaseOwner } from './test-database.js';

const FAKE_AGENT = join(import.meta.dir, 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts');

const scratch: string[] = [];
const connections: AcpConnection[] = [];
const owners: DatabaseOwner[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close().catch(() => undefined);
  for (const owner of owners.splice(0)) await owner.close().catch(() => undefined);
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), 'madarch-agent-meter-'));
  scratch.push(made);
  return made;
}

/** One scripted step, as the fake agent's `script` scenario reads it. */
interface Step {
  readonly say?: string;
  readonly thought?: string;
  readonly usage?: { readonly used?: number; readonly size?: number; readonly cost?: { readonly amount: number; readonly currency: string } };
  readonly end?: { readonly stopReason?: string; readonly usage?: unknown };
  readonly wait?: boolean;
}

/**
 * A session of the fake agent running `steps` for every prompt, and answering a prompt that names `byPrompt`'s match
 * with that entry's steps. The agent reports what the script says, which is the only usage this test will ever see.
 */
async function sessionOf(script: { readonly steps?: readonly Step[]; readonly byPrompt?: readonly { readonly matches: string; readonly steps: readonly Step[] }[] }): Promise<AcpSession> {
  const where = folder();
  const file = join(where, 'script.json');
  writeFileSync(file, JSON.stringify(script));
  const connection = await connectAcpAgent({ id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'script', '--script', file] }, { cwd: where });
  connections.push(connection);
  await connection.initialize();
  return await connection.newSession({ cwd: where });
}

/** The meter of one unit, saving nowhere unless a case names its store. */
function meterOf(options: Partial<ConstructorParameters<typeof AgentMeter>[0]> = {}): AgentMeter {
  return new AgentMeter({ run: 'fill-test', unit: 'glossary:doc.term', plugin: 'glossary', pluginVersion: '1.0.0', kind: 'doc.term', ...options });
}

/** The tokens a turn's streamed text estimates, at four code points a token (owner's decision, 2026-11-15). */
const estimatedTokens = (text: string): number => Math.ceil([...text].length / 4);

/**
 * The run's usage as the api role reads it while the fill works: its trace file, flushed as it grows (`TraceSpanReader`
 * leaves an unterminated line for the next read). The wait is for the flush, not the machine: the answer must stand
 * before the bound, whatever the box's speed.
 */
async function untilUsage(file: string, done: (usage: AgentUsageReport) => boolean, ms = 10_000): Promise<AgentUsageReport> {
  const reader = new TraceSpanReader();
  const start = Date.now();
  let usage = agentUsageOf([]);
  while (Date.now() - start < ms) {
    usage = agentUsageOf(existsSync(file) ? reader.read(file) : []);
    if (done(usage)) return usage;
    await Bun.sleep(25);
  }
  return usage;
}

/** One `session/update` as the meter reads it from the connection: a text chunk of the turn. */
function chunk(kind: 'message' | 'thought', text: string): import('../src/fill/acp.js').AcpUpdate {
  return { kind, text, sessionUpdate: kind === 'message' ? 'agent_message_chunk' : 'agent_thought_chunk', at: new Date().toISOString(), raw: { text } };
}

const USAGE = { totalTokens: 1000, inputTokens: 800, outputTokens: 200 };

describe('the meter counts what the agent reports', () => {
  test('a cumulative report is counted once: the second turn adds the difference, per field and model', async () => {
    const session = await sessionOf({
      byPrompt: [
        { matches: 'field:definition', steps: [{ usage: { used: 100, size: 200_000, cost: { amount: 0.02, currency: 'USD' } } }, { end: { stopReason: 'end_turn', usage: USAGE } }] },
        { matches: 'field:name', steps: [{ usage: { used: 150, size: 200_000, cost: { amount: 0.05, currency: 'USD' } } }, { end: { stopReason: 'end_turn', usage: { totalTokens: 2500, inputTokens: 2000, outputTokens: 500 } } }] },
      ],
    });
    const meter = meterOf();
    await meter.runTurn(session, 'field:definition', { field: 'definition', model: 'sonnet' });
    await meter.runTurn(session, 'field:name', { field: 'name', model: 'sonnet' });
    const rows = meter.rows();
    expect(rows.map((row) => [row.field, row.inputTokens, row.outputTokens, row.totalTokens, row.cost?.amount, row.turns, row.reported])).toEqual([
      ['definition', 800, 200, 1000, 0.02, 1, true],
      ['name', 1200, 300, 1500, 0.03, 1, true],
    ]);
    expect(meter.spent()).toEqual({ tokens: 2500, inputTokens: 2000, outputTokens: 500, cachedWriteTokens: 0, cachedReadTokens: 0, totalTokens: 2500, cost: [{ amount: 0.05, currency: 'USD' }] });
    // The context the adapter updated is kept beside the spend, for the trace.
    expect(meter.context()).toEqual({ used: 150, size: 200_000 });
  });

  test('a report that fell below the last restarted the total: the reading itself is the increment', async () => {
    const session = await sessionOf({ steps: [{ end: { stopReason: 'end_turn', usage: USAGE } }] });
    const meter = meterOf();
    await meter.runTurn(session, 'first', { field: 'name' });
    // A second session's cumulative reading starts from its own zero.
    meter.beginSession();
    await meter.endTurn({ usage: { totalTokens: 400, inputTokens: 300, outputTokens: 100 } });
    expect(meter.spent().tokens).toBe(1400);
    expect(meter.rows()[0]?.turns).toBe(2);
  });

  test('cache reads are counted and shown, and a token cap counts input, output and cache writes only', async () => {
    // The owner's decision of 2026-11-15 («Только токены без кэша»): an agent re-sends a large prompt from its cache at
    // every step, and those reads are shown beside the other three and never spent against the cap.
    const session = await sessionOf({ steps: [{ end: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50, cachedWriteTokens: 30, cachedReadTokens: 1_000_000, totalTokens: 1_000_180 } } }] });
    const meter = meterOf({ budget: new AgentRunBudget({ tokens: 200 }) });
    const turn = await meter.runTurn(session, 'a turn that re-reads its cache', { field: 'definition' });
    expect(turn.stop).toBeUndefined();
    expect(meter.spent()).toEqual({
      tokens: 180, inputTokens: 100, outputTokens: 50, cachedWriteTokens: 30, cachedReadTokens: 1_000_000, totalTokens: 1_000_180,
      cost: [],
    });
    expect(meter.rows()[0]).toMatchObject({ inputTokens: 100, outputTokens: 50, cachedWriteTokens: 30, cachedReadTokens: 1_000_000, stopped: null });
    // Four fifths of the cap are spent: the agent is told, once, to finish with what it has.
    const notice = meter.wrapNotice();
    expect(notice).toContain('spent 180 tokens of the fill run\'s 200-token cap (90%)');
    expect(notice).toContain('Finish with what you have');
    expect(meter.overBudget()).toBeUndefined();
  });

  test('input, output and cache writes cross the cap even when the cache reads are counted nowhere', async () => {
    const session = await sessionOf({ steps: [{ end: { stopReason: 'end_turn', usage: { inputTokens: 400, outputTokens: 150, cachedWriteTokens: 0, cachedReadTokens: 2_000_000, totalTokens: 2_000_550 } } }] });
    const budget = new AgentRunBudget({ tokens: 500 });
    const meter = meterOf({ budget });
    const turn = await meter.runTurn(session, 'a turn past the cap', { field: 'definition' });
    expect(turn.stop).toMatchObject({ scope: 'run', bound: 'tokens', spent: 550, limit: 500 });
    expect(turn.stop?.message).toContain('550 tokens (input, output and cache writes; cache reads are not counted)');
    expect(budget.tokens).toBe(550);
    // A later unit of the same run asks for no prompt past the cap: its own meter reads the shared counter.
    expect(meterOf({ budget }).overBudget()).toMatchObject({ scope: 'run', bound: 'tokens', spent: 550, limit: 500 });
  });

  test('a turn that streams text is counted live: the cap stops it before the turn ends, by estimate', async () => {
    // ACP gives no token counts until the turn ends, and this agent reports its usage only on completion: the cap must
    // be held by what the stream carries, each chunk's tokens estimated from its text (owner's decision, 2026-11-15).
    const session = await sessionOf({
      steps: [
        { say: 'word '.repeat(2_000) },
        { end: { stopReason: 'end_turn', usage: { inputTokens: 10_100, outputTokens: 0, totalTokens: 10_100 } } },
      ],
    });
    const budget = new AgentRunBudget({ tokens: 100 });
    const meter = meterOf({ budget });
    const turn = await meter.runTurn(session, 'a long answer', { field: 'definition' });
    expect(turn.result.stopReason).toBe('cancelled');
    expect(turn.stop).toMatchObject({ scope: 'run', bound: 'tokens', limit: 100 });
    expect(turn.stop?.message).toContain('by estimate');
    expect(budget.tokens).toBeGreaterThanOrEqual(100);
    expect(meter.rows()[0]?.stopped).toBe('tokens');
  });

  test('a cache-only report spends nothing against the cap: capped tokens are input, output and cache writes', async () => {
    const budget = new AgentRunBudget({ tokens: 100 });
    const meter = meterOf({ budget });
    const stop = await meter.endTurn({ usage: { inputTokens: 0, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 1000, totalTokens: 1000 } });
    expect(stop).toBeUndefined();
    expect(meter.spent().tokens).toBe(0);
    expect(meter.spent().cachedReadTokens).toBe(1000);
    expect(budget.tokens).toBe(0);
  });

  test('an agent that reports no usage is a row that says so, its spend the estimate of what it streamed', async () => {
    const where = folder();
    const connection = await connectAcpAgent({ id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'no-usage'] }, { cwd: where });
    connections.push(connection);
    await connection.initialize();
    const session = await connection.newSession({ cwd: where });
    const meter = meterOf();
    await meter.runTurn(session, 'a turn that reports nothing', { field: 'definition', model: 'sonnet' });
    const [row] = meter.rows();
    // The row says its numbers are not a report (`reported: false`), and its spend is what the streamed text estimates:
    // an agent that never reports is still counted, never a silent zero.
    expect(row).toMatchObject({ field: 'definition', model: 'sonnet', outputTokens: 0, cost: null, turns: 1, reported: false });
    expect(row?.inputTokens).toBeGreaterThan(0);
    expect(row?.totalTokens).toBe(row?.inputTokens);
  });

  test('a model the agent switches to is a row of its own', async () => {
    const session = await sessionOf({
      byPrompt: [
        { matches: 'on sonnet', steps: [{ end: { stopReason: 'end_turn', usage: USAGE } }] },
        { matches: 'on opus', steps: [{ end: { stopReason: 'end_turn', usage: { totalTokens: 2500, inputTokens: 2000, outputTokens: 500 } } }] },
      ],
    });
    const meter = meterOf();
    await meter.runTurn(session, 'a turn on sonnet', { field: 'name', model: 'sonnet' });
    await meter.runTurn(session, 'a turn on opus', { field: 'name', model: 'opus' });
    expect(meter.rows().map((row) => [row.model, row.inputTokens, row.outputTokens])).toEqual([['sonnet', 800, 200], ['opus', 1200, 300]]);
  });
});

describe('a bound the product or the fill declared stops the run', () => {
  test('the plugin\'s token bound ends the turn that crossed it, and the words name the unit and the bound', async () => {
    const session = await sessionOf({ steps: [{ end: { stopReason: 'end_turn', usage: { totalTokens: 5000, inputTokens: 4000, outputTokens: 1000 } } }] });
    const meter = meterOf({ bounds: { tokens: 4000 } });
    const turn = await meter.runTurn(session, 'a turn that spends past its bound', { field: 'definition' });
    expect(turn.result.stopReason).toBe('end_turn');
    expect(turn.stop).toMatchObject({ scope: 'plugin', bound: 'tokens', spent: 5000, limit: 4000 });
    expect(turn.stop?.message).toContain('src/fill/agent-meter.ts:AgentMeter: the plugin run glossary:doc.term spent 5,000 tokens (input, output and cache writes; cache reads are not counted) in the kind doc.term');
    expect(turn.stop?.message).toContain("past the 4,000-token bound the product's manifest declares for one run of the plugin");
    expect(meter.rows()[0]?.stopped).toBe('tokens');
  });

  test('a cost report mid-turn cancels the turn at once, and the turn ends as cancelled', async () => {
    const session = await sessionOf({ steps: [{ usage: { used: 100, size: 200_000, cost: { amount: 0.5, currency: 'USD' } } }, { wait: true }] });
    const meter = meterOf({ bounds: { cost: { amount: 0.1, currency: 'USD' } } });
    const turn = await meter.runTurn(session, 'a turn whose cost passes its bound', { field: 'definition' });
    expect(turn.result.stopReason).toBe('cancelled');
    expect(turn.stop).toMatchObject({ scope: 'plugin', bound: 'cost', spent: 0.5, limit: 0.1, currency: 'USD' });
    expect(meter.rows()[0]?.stopped).toBe('cost');
  });

  test('the fill run\'s cap is one counter its plugin runs share, and the second run stops on it', async () => {
    const session = await sessionOf({ steps: [{ end: { stopReason: 'end_turn', usage: USAGE } }] });
    const budget = new AgentRunBudget({ tokens: 1500 });
    const first = meterOf({ unit: 'glossary:doc.term', budget });
    const second = meterOf({ unit: 'sections:doc.term', plugin: 'sections', budget });
    expect((await first.runTurn(session, 'the first unit', {})).stop).toBeUndefined();
    const crossing = await second.runTurn(session, 'the second unit', {});
    expect(crossing.stop).toMatchObject({ scope: 'run', bound: 'tokens', spent: 2000, limit: 1500 });
    expect(crossing.stop?.message).toContain("past the 1,500-token cap the fill's settings declare for the whole run");
    expect(budget.tokens).toBe(2000);
  });

  test('a run under its bounds is not stopped and writes no stop', async () => {
    const session = await sessionOf({ steps: [{ end: { stopReason: 'end_turn', usage: USAGE } }] });
    const meter = meterOf({ bounds: { tokens: 4000, cost: { amount: 1, currency: 'USD' } }, budget: new AgentRunBudget({ tokens: 4000 }) });
    const turn = await meter.runTurn(session, 'a turn inside its bounds', {});
    expect(turn.stop).toBeUndefined();
    expect(meter.rows()[0]?.stopped).toBeNull();
  });
});

describe('the spend in the store\'s mechanism tables', () => {
  function row(overrides: Partial<AgentUsageRecord> = {}): AgentUsageRecord {
    return {
      run: 'fill-1', unit: 'glossary:doc.term', plugin: 'glossary', pluginVersion: '1.0.0', kind: 'doc.term', field: 'definition',
      model: 'sonnet', inputTokens: 800, outputTokens: 200, cachedWriteTokens: 50, cachedReadTokens: 4_000, totalTokens: 1000, cost: { amount: 0.02, currency: 'USD' },
      turns: 1, reported: true, stopped: null, ...overrides,
    };
  }

  test('a kind\'s page reads every run counted, the newest runs listed with their plugin runs, fields and models', async () => {
    const owner = await createTestDatabaseOwner();
    owners.push(owner);
    await recordAgentUsage(owner, [
      row({ run: 'fill-1', field: 'name', inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: { amount: 0.01, currency: 'USD' } }),
      row(),
      row({ run: 'fill-2', unit: 'sections:doc.term', plugin: 'sections', pluginVersion: '2.0.0', model: null, inputTokens: 2000, outputTokens: 500, totalTokens: 2500, cost: null, reported: true, stopped: 'tokens' }),
      row({ kind: 'code.file', field: 'path' }),
    ]);
    const usage = await readKindUsage(owner, 'doc.term');
    expect(usage.kind).toBe('doc.term');
    expect(usage.total).toEqual({ inputTokens: 2900, outputTokens: 750, cachedWriteTokens: 150, cachedReadTokens: 12_000, totalTokens: 3650, cost: [{ amount: 0.03, currency: 'USD' }], runs: 2 });
    expect(usage.moreRuns).toBe(false);
    // The newest run first: it was written last.
    expect(usage.runs.map((run) => run.run)).toEqual(['fill-2', 'fill-1']);
    expect(usage.runs[0]).toMatchObject({ stopped: 'tokens', inputTokens: 2000, outputTokens: 500 });
    expect(usage.runs[0]?.rows[0]).toMatchObject({ plugin: 'sections', model: null, stopped: 'tokens' });
    expect(usage.runs[1]?.rows.map((line) => [line.plugin, line.field, line.model])).toEqual([['glossary', 'definition', 'sonnet'], ['glossary', 'name', 'sonnet']]);
    // One row per identity: writing it again replaces its numbers rather than adding a second row.
    await recordAgentUsage(owner, [row({ inputTokens: 900, totalTokens: 1100 })]);
    expect((await readKindUsage(owner, 'doc.term')).runs[0]?.rows[0]?.inputTokens).toBe(900);
  });

  test('the page lists the newest runs and says the total counts the older ones', async () => {
    const owner = await createTestDatabaseOwner();
    owners.push(owner);
    for (let at = 1; at <= KIND_USAGE_RUNS + 2; at += 1) await recordAgentUsage(owner, [row({ run: `fill-${String(at).padStart(2, '0')}` })]);
    const usage = await readKindUsage(owner, 'doc.term');
    expect(usage.runs.length).toBe(KIND_USAGE_RUNS);
    expect(usage.moreRuns).toBe(true);
    expect(usage.total.runs).toBe(KIND_USAGE_RUNS + 2);
  });

  test('the spend is a schema of its own: the graph\'s revision and its tables are untouched', async () => {
    const owner = await createTestDatabaseOwner();
    owners.push(owner);
    await createOneGraphSchema(owner);
    const before = await owner.run(async (tx) => await tx.query<{ name: string; stamp: string }>("SELECT name, stamp FROM madarch_meta.schema_stamp WHERE name LIKE 'one-graph%' ORDER BY name"));
    await recordAgentUsage(owner, [row()]);
    const stamps = await owner.run(async (tx) => await tx.query<{ name: string; stamp: string }>('SELECT name, stamp FROM madarch_meta.schema_stamp ORDER BY name'));
    expect(stamps.rows.map((entry) => entry.name)).toContain('agent-usage');
    expect(stamps.rows.find((entry) => entry.name === 'one-graph-revision')?.stamp).toBe(String(SCHEMA_REVISION));
    expect(stamps.rows.filter((entry) => entry.name.startsWith('one-graph'))).toEqual(before.rows);
    const tables = await owner.run(async (tx) => await tx.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'agent_usage'"));
    expect(tables.rows.length).toBe(1);
  });

  test('the meter writes its rows through the save callback, one row per field and model', async () => {
    const owner = await createTestDatabaseOwner();
    owners.push(owner);
    const session = await sessionOf({ steps: [{ end: { stopReason: 'end_turn', usage: USAGE } }] });
    const meter = meterOf({ run: 'fill-trace', save: async (rows) => await recordAgentUsage(owner, rows) });
    await meter.runTurn(session, 'a turn', { field: 'definition', model: 'sonnet' });
    const usage = await readKindUsage(owner, 'doc.term');
    expect(usage.runs[0]?.run).toBe('fill-trace');
    expect(usage.runs[0]?.rows[0]).toMatchObject({ field: 'definition', model: 'sonnet', inputTokens: 800, outputTokens: 200 });
  });
});

describe('the run\'s trace', () => {
  test('each turn is one agent.usage span, and the report and its words state the spend and the stop', async () => {
    const where = folder();
    const session = await sessionOf({ steps: [{ usage: { used: 100, size: 200_000, cost: { amount: 0.5, currency: 'USD' } } }, { wait: true }] });
    const trace = openTrace({ store: where, runId: 'fill-traced' });
    const meter = meterOf({ run: 'fill-traced', bounds: { cost: { amount: 0.1, currency: 'USD' } } });
    try {
      await meter.runTurn(session, 'a turn that passes its cost bound', { field: 'definition', model: 'sonnet' });
    } finally {
      closeTrace(trace);
    }
    const spans = readTraceSpans(trace.file);
    const usage = spans.filter((span) => span.name === 'agent.usage');
    expect(usage.length).toBe(1);
    expect(usage[0]?.attributes).toMatchObject({
      'agent.run': 'fill-traced', 'agent.unit': 'glossary:doc.term', 'agent.plugin': 'glossary', 'agent.kind': 'doc.term',
      'agent.field': 'definition', 'agent.model': 'sonnet', 'agent.cost.USD': 0.5,
      'agent.bound.stop': 'cost', 'agent.bound.scope': 'plugin', 'agent.context.used': 100, 'agent.context.size': 200_000,
    });
    const report = traceReportOf(spans, trace.file);
    expect(report.agentUsage.turns).toBe(1);
    expect(report.agentUsage.cost).toEqual([{ currency: 'USD', amount: 0.5 }]);
    expect(report.agentUsage.lines[0]).toMatchObject({ kind: 'doc.term', field: 'definition', model: 'sonnet', plugin: 'glossary', stopped: { bound: 'cost', scope: 'plugin' } });
    expect(renderTraceReport(report)).toContain('Agent usage: 1 prompt turns, 0 tokens in, 0 out, 0 written to cache, 0 read from cache, 0 total, cost 0.5 USD');
  });

  test('a turn that reports no usage states its estimate in the span: the page shows the row\'s spend, not zero', async () => {
    const where = folder();
    const connection = await connectAcpAgent({ id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'no-usage'] }, { cwd: where });
    connections.push(connection);
    await connection.initialize();
    const session = await connection.newSession({ cwd: where });
    const trace = openTrace({ store: where, runId: 'fill-unreported' });
    const meter = meterOf({ run: 'fill-unreported' });
    try {
      await meter.runTurn(session, 'a turn that reports nothing', { field: 'definition', model: 'sonnet' });
    } finally {
      closeTrace(trace);
    }
    const [row] = meter.rows();
    // The row keeps the estimate the stream charged, and the span states that same increment: the run page reads the
    // spans, so a span of zeros would show a fill spending nothing while its row and the run's cap say it spent
    // (madarch-rcyu: the owner's walk read 0 tokens while the agent worked).
    expect(row?.reported).toBe(false);
    expect(row?.totalTokens).toBeGreaterThan(0);
    const spans = readTraceSpans(trace.file).filter((span) => span.name === 'agent.usage');
    // The stream's charges are provisional spans of the turn that states them, and the turn's own span answers it: the
    // reader counts the turn once, at the row's figure (madarch-rcyu, review ALX-2032).
    expect(spans.filter((span) => span.attributes['agent.estimate'] === true).length).toBeGreaterThan(0);
    const answered = spans.filter((span) => span.attributes['agent.estimate'] !== true);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.attributes).toMatchObject({ 'agent.tokens.input': row!.inputTokens, 'agent.tokens.total': row!.totalTokens, 'agent.reported': false, 'agent.turns': 1 });
    expect(traceReportOf(readTraceSpans(trace.file), trace.file).agentUsage).toMatchObject({ inputTokens: row!.inputTokens, totalTokens: row!.totalTokens, turns: 1 });
  });

  test('a cost the adapter reports before the turn answers stays in the completed trace, stated once', async () => {
    const where = folder();
    const session = await sessionOf({
      steps: [
        // The order the owner's walk met: the adapter's cost arrives before the stream and the answer that settles the turn.
        { usage: { used: 100, size: 200_000, cost: { amount: 0.5, currency: 'USD' } } },
        { thought: 'x'.repeat(400) },
        { end: { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 214 } } },
      ],
    });
    const trace = openTrace({ store: where, runId: 'fill-cost-live' });
    const meter = meterOf({ run: 'fill-cost-live' });
    try {
      await meter.runTurn(session, 'a turn that reports its cost before it answers', { field: 'definition', model: 'sonnet' });
    } finally {
      closeTrace(trace);
    }
    // The row keeps the charge the adapter reported, and the run's trace states that same charge once: the provisional
    // span of the open turn describes its token charge only, and the span that answers it states the cost, so the report
    // that replaces the provisional turn by its answer keeps the charge instead of dropping it (madarch-rcyu).
    expect(meter.rows()[0]).toMatchObject({ cost: { amount: 0.5, currency: 'USD' }, turns: 1 });
    const report = traceReportOf(readTraceSpans(trace.file), trace.file).agentUsage;
    expect(report).toMatchObject({ inputTokens: 120, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 214, turns: 1 });
    expect(report.cost).toEqual([{ currency: 'USD', amount: 0.5 }]);
  });

  test('a turn that is still open states its estimate in a provisional span, and its answer reconciles it exactly once', async () => {
    const where = folder();
    const budget = new AgentRunBudget({ tokens: 100_000 });
    const trace = openTrace({ store: where, runId: 'fill-open' });
    const meter = meterOf({ run: 'fill-open', budget });
    try {
      meter.beginTurn({ field: 'definition', model: 'sonnet' });
      // 400 code points, four a token: the charge the stream makes before the turn answers.
      meter.meterSessionUpdate(chunk('thought', 'x'.repeat(400)));
      // The run page reads the trace: a turn that has not answered yet states what it already spent, and the run's cap
      // holds exactly that figure — the review's finding was a page reading zero here.
      const live = await untilUsage(trace.file, (usage) => usage.totalTokens > 0);
      expect(live).toMatchObject({ inputTokens: 100, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, totalTokens: 100, turns: 0 });
      expect(budget.tokens).toBe(100);
      const open = readTraceSpans(trace.file).filter((span) => span.name === 'agent.usage');
      expect(open).toHaveLength(1);
      expect(open[0]?.attributes).toMatchObject({ 'agent.estimate': true, 'agent.tokens.input': estimatedTokens('x'.repeat(400)), 'agent.tokens.total': 100, 'agent.turns': 0 });
      // The turn answers with its own report: the estimate is taken back out of the row and the cap, and the report stands
      // once — not the estimate plus the report.
      await meter.endTurn({ usage: { inputTokens: 120, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 214 } });
      const settled = await untilUsage(trace.file, (usage) => usage.turns === 1);
      expect(settled).toMatchObject({ inputTokens: 120, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 214, turns: 1 });
      // The cap counts input, output and cache writes, never the cache reads (owner's decision, 2026-11-15).
      expect(budget.tokens).toBe(120 + 20 + 14);
      expect(meter.spent()).toMatchObject({ inputTokens: 120, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 214, tokens: 154 });
    } finally {
      closeTrace(trace);
    }
  });

  test('a retried unit counts both attempts once in its row, the kind and the cap, and one trace per attempt', async () => {
    const owner = await createTestDatabaseOwner();
    owners.push(owner);
    const budget = new AgentRunBudget({ tokens: 100_000 });
    const save = async (rows: readonly AgentUsageRecord[]): Promise<void> => await recordAgentUsage(owner, rows);
    const trace = openTrace({ store: folder(), runId: 'fill-retry' });
    try {
      // The first attempt streams its answer and is refused as invalid: it ends with the estimate the stream charged.
      const first = meterOf({ run: 'fill-retry', budget, save });
      first.beginTurn({ field: 'definition', model: 'sonnet' });
      first.meterSessionUpdate(chunk('thought', 'x'.repeat(400)));
      await first.endTurn({});
      expect([...first.rows()].map((row) => [row.inputTokens, row.turns, row.reported])).toEqual([[100, 1, false]]);
      expect(budget.tokens).toBe(100);
      // The retry is a meter of its own, and it adopts what the unit's row already holds: one row is the unit's spend.
      const adopted = await readAgentUsageRows(owner, 'fill-retry', 'glossary:doc.term');
      expect(adopted).toMatchObject([{ inputTokens: 100, outputTokens: 0, totalTokens: 100, turns: 1, reported: false }]);
      const second = meterOf({ run: 'fill-retry', budget, save, adopted });
      second.beginTurn({ field: 'definition', model: 'sonnet' });
      second.meterSessionUpdate(chunk('thought', 'x'.repeat(400)));
      await second.endTurn({ usage: { inputTokens: 120, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 214 } });
      expect([...second.rows()].map((row) => [row.inputTokens, row.outputTokens, row.cachedWriteTokens, row.cachedReadTokens, row.totalTokens, row.turns])).toEqual([[220, 20, 14, 60, 314, 2]]);
      // Published again — a retry republishing the same snapshot — the row stands at the unit's whole spend, never twice it.
      await second.flush();
      const kind = await readKindUsage(owner, 'doc.term');
      expect(kind.runs).toHaveLength(1);
      expect(kind.runs[0]?.rows).toHaveLength(1);
      expect(kind.runs[0]?.rows[0]).toMatchObject({ inputTokens: 220, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 314, turns: 2 });
      expect(kind.total).toMatchObject({ inputTokens: 220, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 314, runs: 1 });
      // The run's cap counts both attempts' capped tokens once — input, output and cache writes, never the cache reads.
      expect(budget.tokens).toBe(100 + 154);
      // The trace states the same figure as the row, in the two attempts' own turns.
      const usage = traceReportOf(readTraceSpans(trace.file), trace.file).agentUsage;
      expect(usage).toMatchObject({ inputTokens: 220, outputTokens: 20, cachedWriteTokens: 14, cachedReadTokens: 60, totalTokens: 314, turns: 2 });
    } finally {
      closeTrace(trace);
    }
  });

  test('a turn\'s tokens are the increment the trace adds, never the run\'s cumulative report twice', async () => {
    const where = folder();
    const session = await sessionOf({
      byPrompt: [
        { matches: 'first', steps: [{ end: { stopReason: 'end_turn', usage: USAGE } }] },
        { matches: 'second', steps: [{ end: { stopReason: 'end_turn', usage: { totalTokens: 2500, inputTokens: 2000, outputTokens: 500 } } }] },
      ],
    });
    const trace = openTrace({ store: where, runId: 'fill-sum' });
    const meter = meterOf({ run: 'fill-sum' });
    try {
      await meter.runTurn(session, 'first', { field: 'name', model: 'sonnet' });
      await meter.runTurn(session, 'second', { field: 'name', model: 'sonnet' });
    } finally {
      closeTrace(trace);
    }
    const report = traceReportOf(readTraceSpans(trace.file), trace.file);
    expect(report.agentUsage).toMatchObject({ inputTokens: 2000, outputTokens: 500, totalTokens: 2500, turns: 2 });
    expect(report.agentUsage.lines.length).toBe(1);
  });
});

describe('the bounds a product declares for its plugins', () => {
  const CONTRACT = { id: 'g', version: '1.0.0', reads: 'whole-graph', outputs: { vertices: [{ kind: 'doc.term', key: ['name'], fields: [{ name: 'name', type: 'text', meaning: 'the term', example: 'x', required: true }] }], edges: [] } };

  function product(bounds: string): { folder: string; text: string } {
    const where = folder();
    mkdirSync(join(where, 'templates'), { recursive: true });
    mkdirSync(join(where, 'madarch'), { recursive: true });
    mkdirSync(join(where, 'plugins', 'g'), { recursive: true });
    writeFileSync(join(where, 'templates', 't.liquid'), '{% block lead %}{% endblock %}\n');
    writeFileSync(join(where, 'plugins', 'g', 'contract.json'), JSON.stringify(CONTRACT));
    writeFileSync(join(where, 'madarch', 'plugins.lock'), `plugins:\n  - { id: g, version: 1.0.0, closure: ${'a'.repeat(64)}, path: plugins/g }\n`);
    const text = [
      'kinds:',
      '  doc.term:',
      '    ',
      '    source: document',
      '    terms: ["**/glossary*.md"]',
      '    semantics: term',
      '    fields:',
      '      - { name: name, type: text, binding: "g@1.name" }',
      '    key: [name]',
      '    derives-from: []',
      'plugins:',
      `  - { id: g, version: 1, path: plugins/g, inputs: [doc.term], outputs: [doc.term], closure: [plugins/g/contract.json]${bounds} }`,
      '',
    ].join('\n');
    return { folder: where, text };
  }

  test('a plugin\'s declared token, cost and time bounds are read as its own, with no finding', () => {
    const { folder: where, text } = product(', bounds: { tokens: 200000, cost: { amount: 1.50, currency: USD }, minutes: 45 }');
    const read = parseKinds(text, 'madarch/catalog.yaml', where);
    expect(read.findings).toEqual([]);
    expect(read.plugins?.get('g')?.bounds).toEqual({ tokens: 200_000, cost: { amount: 1.5, currency: 'USD' }, minutes: 45 });
  });

  test('a bound the engine cannot hold a run to is the manifest\'s error, named with its line, and no plugin is loaded with it', () => {
    const cases: readonly [string, string][] = [
      [', bounds: { tokens: 0 }', '"bounds.tokens" is the most tokens one run may spend'],
      [', bounds: { tokens: 1.5 }', '"bounds.tokens" is the most tokens one run may spend'],
      [', bounds: { cost: { amount: 0, currency: USD } }', '"bounds.cost" is { amount: <a positive number>, currency: <the unit the agent reports> }'],
      [', bounds: { cost: { amount: 1 } }', '"bounds.cost" is'],
      [', bounds: { tokens: 10, mood: yes }', '"mood" is not a bound'],
      [', bounds: { minutes: 0 }', '"bounds.minutes" is the most wall-clock minutes one agent unit may take'],
      [', bounds: {}', '"bounds" declares no bound'],
      [', bounds: 7', '"bounds" is { tokens: <whole number>'],
    ];
    for (const [bounds, message] of cases) {
      const { folder: where, text } = product(bounds);
      const read = parseKinds(text, 'madarch/catalog.yaml', where);
      expect(read.findings.map((finding) => finding.message).join('\n'), bounds).toContain(message);
      expect(read.findings.every((finding) => finding.line > 0), bounds).toBe(true);
      expect(read.findings.some((finding) => finding.file === 'madarch/catalog.yaml'), bounds).toBe(true);
    }
  });
});
