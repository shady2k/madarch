/**
 * The one read of madarch's logs (madarch-64o5.88): every source parses into one entry shape, filters and pages are one
 * answer, and what a record holds beside its message never carries a secret. The route that serves it is read here too,
 * against a store of logs written by this file.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentExchangeRecorder } from '../src/fill/agent-exchange.js';
import { agentExchangeFolder, pluginLogFolder, recordFileName } from '../src/fill/run-records.js';
import { DEFAULT_LOG_SOURCES, LOG_SOURCES, logRuns, readLogs } from '../src/knowledge/logs.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createKnowledgePart } from '../src/server/knowledge.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** A store and the knowledge root above it, with one record of every source. */
function fixture(): { store: string; knowledgeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-logs-'));
  roots.push(root);
  const knowledgeRoot = join(root, 'knowledge');
  const store = join(knowledgeRoot, 'shop');
  const traces = join(store, 'traces');
  mkdirSync(traces, { recursive: true });
  const log = (path: string, records: readonly Record<string, unknown>[]): void => { writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8'); };
  mkdirSync(join(knowledgeRoot, 'traces'), { recursive: true });
  log(join(knowledgeRoot, 'traces', 'server-77.log.jsonl'), [
    { time: '2026-11-15T09:00:00.000Z', level: 'info', message: 'the server opened the product' },
  ]);
  log(join(traces, 'fill-a.log.jsonl'), [
    { time: '2026-11-15T09:41:01.000Z', level: 'info', message: 'fill started', runId: 'fill-a', unitId: 'disk:code.file' },
    { time: '2026-11-15T09:41:02.500Z', level: 'warn', message: 'the plugin read a file its parser does not know', path: '/work/product/repos/app/notes.txt', token: 'secret-token-123' },
    { time: '2026-11-15T09:41:03.000Z', level: 'error', message: 'src/plugin/host.ts:1: the plugin session failed: the plugin is pinned to bun 1.4.2', file: 'madarch/plugins.lock', error: { name: 'Error', message: 'the plugin is pinned to bun 1.4.2', stack: 'Error: the plugin is pinned to bun 1.4.2\n    at startPluginProcess (src/plugin/sandbox.ts:210:11)' } },
  ]);
  mkdirSync(pluginLogFolder(traces, 'fill-a'), { recursive: true });
  writeFileSync(join(pluginLogFolder(traces, 'fill-a'), recordFileName('disk:code.file', 'log')), 'reading src/index.ts\ncould not parse line 4\n', 'utf8');
  const exchange = new AgentExchangeRecorder({ folder: agentExchangeFolder(traces, 'fill-a'), run: 'fill-a', unit: 'agent-fill:doc.term', agent: 'fixture' });
  exchange.setGiven({ prompt: 'Fill the term from its documents.', task: { kind: 'doc.term' }, files: ['repo/docs/a.md'] });
  exchange.answer('{"vertices":[],"end":{"state":"complete"}}', 'end_turn');
  exchange.finish();
  writeFileSync(join(traces, 'fill-a.jsonl'), `${JSON.stringify({ name: 'plugin.unit', startTimeUnixNano: '1763199661000000000', endTimeUnixNano: '1763199661500000000', status: { code: 'STATUS_CODE_UNSET' }, attributes: [{ key: 'madarch.plugin.unit', value: { stringValue: 'disk:code.file' } }, { key: 'api_key', value: { stringValue: 'secret-key' } }] })}\n`, 'utf8');
  writeFileSync(join(store, 'postgres.log'), 'database system is ready to accept connections\n', 'utf8');
  return { store, knowledgeRoot };
}

describe('every log in one read', () => {
  test('every source parses into one shape, oldest first, with the place an error stands at and no secret', () => {
    const { store, knowledgeRoot } = fixture();
    const page = readLogs({ store, knowledgeRoot }, { sources: [...LOG_SOURCES] });
    expect(page.truncated).toBe(false);
    const sources = new Set(page.entries.map((entry) => entry.source));
    expect([...sources].sort()).toEqual([...LOG_SOURCES].sort());
    // A read that names no source takes every log; a run's spans are asked for, since they are many and not a log.
    expect(new Set(readLogs({ store, knowledgeRoot }).entries.map((entry) => entry.source))).toEqual(new Set(DEFAULT_LOG_SOURCES));
    const times = page.entries.map((entry) => entry.at ?? Number.MAX_SAFE_INTEGER);
    expect(times).toEqual([...times].sort((left, right) => left - right));
    const error = page.entries.find((entry) => entry.level === 'error' && entry.source === 'fill');
    expect(error).toMatchObject({ file: 'host.ts', line: 1, run: 'fill-a' });
    expect(error?.detail).toContain('at startPluginProcess (src/plugin/sandbox.ts:210:11)');
    const warn = page.entries.find((entry) => entry.level === 'warn');
    expect(warn?.path).toBe('/work/product/repos/app/notes.txt');
    // A field that could hold a secret is dropped from the context, and it stands in no other part of the entry.
    expect(warn?.fields['token']).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain('secret-token-123');
    expect(JSON.stringify(page)).not.toContain('secret-key');
    // The plugin's own output is kept as its lines, and the agent's exchange as what it was given, did and returned.
    expect(page.entries.filter((entry) => entry.source === 'plugin').map((entry) => entry.message)).toEqual(['reading src/index.ts', 'could not parse line 4']);
    expect(page.entries.filter((entry) => entry.source === 'agent').map((entry) => entry.level)).toEqual(['info', 'info']);
    expect(page.entries.find((entry) => entry.source === 'agent' && entry.message.includes('was given'))?.detail).toBe('Fill the term from its documents.');
    const trace = page.entries.find((entry) => entry.source === 'trace');
    expect(trace?.message).toBe('plugin.unit 500 ms');
    expect(trace?.fields).toEqual({ 'madarch.plugin.unit': 'disk:code.file' });
  });

  test('filters read one source, one level, one run, one text and one window; a page keeps the newest and says what it left', () => {
    const { store, knowledgeRoot } = fixture();
    expect(readLogs({ store, knowledgeRoot }, { sources: ['fill'] }).entries.every((entry) => entry.source === 'fill')).toBe(true);
    expect(readLogs({ store, knowledgeRoot }, { level: 'warn' }).entries.every((entry) => entry.level === 'warn' || entry.level === 'error')).toBe(true);
    const oneRun = readLogs({ store, knowledgeRoot }, { run: 'fill-a' }).entries;
    expect(oneRun.every((entry) => entry.run === 'fill-a')).toBe(true);
    expect(oneRun.some((entry) => entry.source === 'store')).toBe(false);
    expect(readLogs({ store, knowledgeRoot }, { q: 'PINNED' }).entries.map((entry) => entry.level)).toEqual(['error']);
    const since = Date.parse('2026-11-15T09:41:03.000Z');
    expect(readLogs({ store, knowledgeRoot }, { since: Date.parse('2026-11-15T09:41:01.000Z') }).entries.every((entry) => (entry.at ?? 0) > Date.parse('2026-11-15T09:41:01.000Z'))).toBe(true);
    const before = readLogs({ store, knowledgeRoot }, { before: since }).entries;
    expect(before.every((entry) => (entry.at ?? 0) < since)).toBe(true);
    const page = readLogs({ store, knowledgeRoot }, { limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.more).toBe(true);
    expect(logRuns(store)).toContain('fill-a');
  });

  test('the route answers one page, and refuses a source or a level it does not know', async () => {
    const { store, knowledgeRoot } = fixture();
    const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
    Object.assign(product as unknown as Record<string, unknown>, { storeFolder: () => store, options: { productFolder: join(store, '..'), storeRoot: knowledgeRoot } });
    const part = createKnowledgePart({ json: (status, body) => Response.json(body, { status }), refused: (status, error) => ({ response: Response.json({ error }, { status }) }), errorLog: () => undefined }, product, () => []);
    const answered = await part.logs(new Request('http://wiki.test/api/logs?source=fill&level=warn&run=fill-a&limit=5'));
    expect(answered.response.status).toBe(200);
    const body = await answered.response.json() as { entries: { source: string }[]; sources: string[]; levels: string[]; runs: string[] };
    expect(body.sources).toEqual([...LOG_SOURCES]);
    expect(body.levels).toEqual(['debug', 'info', 'warn', 'error']);
    expect(body.runs).toContain('fill-a');
    // The source's error stands beside its warning: the quietest-level filter keeps both (warn and above).
    expect(body.entries.map((entry) => entry.source)).toEqual(['fill', 'fill']);
    const badSource = await part.logs(new Request('http://wiki.test/api/logs?source=everything'));
    expect(badSource.response.status).toBe(400);
    expect(((await badSource.response.json()) as { error: { message: string } }).error.message).toContain('everything');
    const badLevel = await part.logs(new Request('http://wiki.test/api/logs?level=shout'));
    expect(badLevel.response.status).toBe(400);
  });
});
