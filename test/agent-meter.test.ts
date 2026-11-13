
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { KIND_USAGE_RUNS, readKindUsage, recordAgentUsage, type AgentUsageRecord } from '../src/adapters/agent-usage.js';
import { connectAcpAgent, type AcpConnection, type AcpSession } from '../src/fill/acp.js';
import { AgentMeter, AgentRunBudget } from '../src/fill/agent-meter.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { SCHEMA_REVISION } from '../src/adapters/schemas/graph-definition.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { closeTrace, openTrace } from '../src/obs/trace.js';
import { readTraceSpans, renderTraceReport, traceReportOf } from '../src/obs/trace-report.js';
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
    expect(meter.spent()).toEqual({ tokens: 2500, cost: [{ amount: 0.05, currency: 'USD' }] });
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

  test('an agent that reports no usage is a row that says so, never a zero', async () => {
    const where = folder();
    const connection = await connectAcpAgent({ id: 'fake', command: process.execPath, args: [FAKE_AGENT, '--scenario', 'no-usage'] }, { cwd: where });
    connections.push(connection);
    await connection.initialize();
    const session = await connection.newSession({ cwd: where });
    const meter = meterOf();
    await meter.runTurn(session, 'a turn that reports nothing', { field: 'definition', model: 'sonnet' });
    const [row] = meter.rows();
    expect(row).toMatchObject({ field: 'definition', model: 'sonnet', inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: null, turns: 1, reported: false });
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
    expect(turn.stop?.message).toContain('src/fill/agent-meter.ts:AgentMeter: the plugin run glossary:doc.term spent 5,000 tokens in the kind doc.term');
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
      model: 'sonnet', inputTokens: 800, outputTokens: 200, totalTokens: 1000, cost: { amount: 0.02, currency: 'USD' },
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
    expect(usage.total).toEqual({ inputTokens: 2900, outputTokens: 750, totalTokens: 3650, cost: [{ amount: 0.03, currency: 'USD' }], runs: 2 });
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
    expect(renderTraceReport(report)).toContain('Agent usage: 1 prompt turns, 0 tokens in, 0 out, 0 total, cost 0.5 USD');
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

  test('a plugin\'s declared token and cost bounds are read as its own, with no finding', () => {
    const { folder: where, text } = product(', bounds: { tokens: 200000, cost: { amount: 1.50, currency: USD } }');
    const read = parseKinds(text, 'madarch/catalog.yaml', where);
    expect(read.findings).toEqual([]);
    expect(read.plugins?.get('g')?.bounds).toEqual({ tokens: 200_000, cost: { amount: 1.5, currency: 'USD' } });
  });

  test('a bound the engine cannot hold a run to is the manifest\'s error, named with its line, and no plugin is loaded with it', () => {
    const cases: readonly [string, string][] = [
      [', bounds: { tokens: 0 }', '"bounds.tokens" is the most tokens one run may spend'],
      [', bounds: { tokens: 1.5 }', '"bounds.tokens" is the most tokens one run may spend'],
      [', bounds: { cost: { amount: 0, currency: USD } }', '"bounds.cost" is { amount: <a positive number>, currency: <the unit the agent reports> }'],
      [', bounds: { cost: { amount: 1 } }', '"bounds.cost" is'],
      [', bounds: { tokens: 10, mood: yes }', '"mood" is not a bound'],
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
