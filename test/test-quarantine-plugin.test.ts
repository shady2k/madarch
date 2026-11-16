import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { quarantinedTests } from '../plugins/test-quarantine/parser.js';
import { extract } from '../plugins/test-quarantine/main.js';
import type { ExtractContext } from '../src/plugin-sdk.js';
import { closureOf } from '../src/plugin/closure.js';
import { PluginHost } from '../src/plugin/host.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const since = '3ec0f2b1d7923fa81901d0293e2e92d34df300a8';
const marker = `quarantined('madarch-64o5.17', describe, 'slow', '${since}')`;
const source = [
  `describe('outer', () => {`,
  `  ${marker}('suite', () => {`,
  `    test('first', () => {});`,
  `    describe('nested', () => {`,
  `      it('second', () => {`,
  `        expect(true).toBe(true);`,
  `      });`,
  `    });`,
  `  });`,
  `});`,
].join('\n');
const repository = { kind: 'code.repository', key: { name: 'repo' } };
const file = { kind: 'code.file', key: { path: 'test/example.test.ts' }, keyEdges: { 'code.file-repository': repository } };
function context(content: string): ExtractContext {
  return {
    facts: { async apply() { throw new Error("pure extraction must return one atomic operation"); } },
    signal: new AbortController().signal, heartbeat() {}, progress() {},
      async agent() { throw new Error('this extraction does not request an agent'); },
    graph: {
      async removedEnds() { throw new Error('unexpected consistency read'); },
      async unevidenced() { throw new Error('unexpected consistency read'); },
      async files(pattern) { expect(['**/*.test.*', '**/quarantine-results.json']).toContain(pattern); return pattern === '**/*.test.*' ? [file] : []; },
      async value<T>(kind: string, key: Readonly<Record<string, string | number | boolean>>, field: string, keyEdges?: Readonly<Record<string, import('../src/plugin-sdk.js').EntityRef>>): Promise<T> {
        expect(kind).toBe(file.kind); expect(key).toEqual(file.key); expect(keyEdges).toEqual(file.keyEdges); expect(field).toBe('content');
        return content as T;
      },
    },
  };
}
const unit = { unitId: 'quarantine', kind: 'code.test-quarantine', key: {} };

describe('test quarantine extraction', () => {
  test('expands suite leaves with qualified names and precise lines', () => {
    expect(quarantinedTests(source, file.key.path)).toEqual([
      { task: 'madarch-64o5.17', reason: 'slow', since, name: 'outer suite first', lineStart: 3, lineEnd: 3 },
      { task: 'madarch-64o5.17', reason: 'slow', since, name: 'outer suite nested second', lineStart: 5, lineEnd: 7 },
    ]);
  });
  test('ignores comments, string contents and ordinary skipped tests', () => {
    expect(quarantinedTests(`// ${marker}('comment', () => {});\nconst text = ${JSON.stringify(`${marker}('text', () => {});`)};\ntest.skip('ordinary', () => {});`, file.key.path)).toEqual([]);
  });
  test('refuses dynamic marker metadata and parent names instead of guessing', () => {
    expect(() => quarantinedTests(`quarantined('madarch-64o5.17', test, reason, '${since}')('case', () => {});`, file.key.path)).toThrow('literal reason');
    expect(() => quarantinedTests(`describe(dynamic, () => { ${marker}('suite', () => { test('case', () => {}); }); });`, file.key.path)).toThrow('literal names');
  });
  test('reads only host files and content, emits references and evidence, and replacement has no stale cases', async () => {
    const result = await extract(unit, context(source));
    expect(result.end).toEqual({ state: 'complete' });
    const cases = result.vertices?.filter(vertex => vertex.kind === 'code.test-quarantine');
    const blob = { kind: 'code.blob', key: { digest: createHash('sha256').update(source).digest('hex') } };
    expect(cases).toHaveLength(2);
    expect(result.vertices?.filter(vertex => vertex.kind === 'code.blob')).toEqual([{ ...blob, values: { content: source } }]);
    expect(result.edges?.filter(edge => edge.kind === 'code.blob-about')).toEqual([{ kind: 'code.blob-about', from: blob, to: file }]);
    expect(cases?.[0]).toMatchObject({
      kind: 'code.test-quarantine', key: { ...file.key, name: 'outer suite first' }, keyEdges: { 'code.test-quarantine-repository': repository },
      values: { quarantine_reason: 'slow' },
      evidence: { target: blob, digest: blob.key.digest, ...file.key, lineStart: 3, lineEnd: 3 },
    });
    expect(cases?.[0]?.values).not.toHaveProperty('latest_result');
    expect(result.edges?.filter(edge => edge.kind !== 'code.blob-about').map(edge => edge.kind)).toEqual(['code.test-quarantine-test', 'code.test-quarantine-since', 'code.test-quarantine-task', 'code.test-quarantine-test', 'code.test-quarantine-since', 'code.test-quarantine-task']);
    const replacement = await extract(unit, context(`test('repaired', () => {});`));
    const repaired = `test('repaired', () => {});`;
    const repairedBlob = { kind: 'code.blob', key: { digest: createHash('sha256').update(repaired).digest('hex') } };
    expect(replacement).toEqual({ vertices: [{ ...repairedBlob, values: { content: repaired } }], edges: [{ kind: 'code.blob-about', from: repairedBlob, to: file }], end: { state: 'complete' } });
  });
  test('reads matching CI reports from host file content and excludes stale marker results', async () => {
    const ctx = context(source);
    const report = { kind: 'code.file', key: { path: 'madarch/quarantine-results.json' }, keyEdges: file.keyEdges };
    const result = { id: 'result-one', file: file.key.path, name: 'outer suite first', task: 'madarch-64o5.17', since, result: 'PASS', commit: 'a'.repeat(40), finishedAt: '2026-11-11T20:00:00Z' };
    ctx.graph.files = async pattern => pattern === '**/*.test.*' ? [file] : [report];
    ctx.graph.value = async <T>(_kind: string, key: Readonly<Record<string, string | number>>): Promise<T> => (key['path'] === report.key.path ? JSON.stringify({ cases: [result, { ...result, since: 'b'.repeat(40), result: 'FAIL', finishedAt: '2026-11-11T21:00:00Z' }] }) : source) as T;
    const extracted = await extract(unit, ctx);
    const cases = extracted.vertices!.filter(vertex => vertex.kind === 'code.test-quarantine');
    const first = cases[0]!;
    expect(extracted.edges?.filter(edge => edge.kind === 'code.test-quarantine-latest-result')).toEqual([{
      kind: 'code.test-quarantine-latest-result',
      from: { kind: first.kind, key: first.key, keyEdges: first.keyEdges },
      to: { kind: 'test-result', key: { id: result.id } },
    }]);
    expect(cases[1]?.values).not.toHaveProperty('latest_result');
  });
  test('reports malformed source as partial rather than claiming a complete empty inventory', async () => {
    const result = await extract(unit, context('test('));
    expect(result.end.state).toBe('partial');
  });
  test('the real plugin protocol reads host bytes and returns the same leaves on repeated units', async () => {
    const folder = resolve('plugins/test-quarantine');
    const closure = closureOf(folder);
    const work = mkdtempSync(join(tmpdir(), 'madarch-quarantine-'));
    const previous = process.env['MADARCH_PLUGIN_SANDBOX'];
    process.env['MADARCH_PLUGIN_SANDBOX'] = 'off';
    let content = source;
    const operations: import('../src/plugin-sdk.js').FactsOperation[] = [];
    const host = new PluginHost({ pluginFolder: folder, repository: work, workRoot: work,
      trust: 'validation', closure, operations: { async apply(_unitId, _key, operation) { operations.push(operation as import('../src/plugin-sdk.js').FactsOperation); return {accepted:true}; } }, graph: { async files(pattern) { return pattern === '**/*.test.*' ? [file] : []; }, async value() { return content; } },
    });
    try {
      const session = await host.open();
      try {
        const first = await session.runUnit(unit);
        expect(first.state).toBe('extracted');
        if (first.state !== 'extracted') throw new Error(JSON.stringify(first));
        expect(operations).toHaveLength(1);
        expect(operations[0]!.vertices).toHaveLength(3);
        expect(operations[0]!.vertices?.filter(vertex => vertex.kind === 'code.test-quarantine')).toHaveLength(2);
        expect(operations[0]!.edges).toHaveLength(7);
        expect(first.result).not.toHaveProperty('vertices');
        content = `test('repaired', () => {});`;
        const second = await session.runUnit({ ...unit, unitId: 'after-repair' });
        expect(second.state).toBe('extracted');
        if (second.state !== 'extracted') throw new Error(JSON.stringify(second));
        expect(operations).toHaveLength(2);
        expect(operations[1]!.vertices?.filter(vertex => vertex.kind === 'code.test-quarantine')).toHaveLength(0);
        expect(operations[1]!.vertices).toEqual([{ kind: 'code.blob', key: { digest: createHash('sha256').update(content).digest('hex') }, values: { content } }]);
        expect(second.result).not.toHaveProperty('vertices');
      } finally { await session.close(); }
    } finally {
      if (previous === undefined) delete process.env['MADARCH_PLUGIN_SANDBOX']; else process.env['MADARCH_PLUGIN_SANDBOX'] = previous;
      rmSync(work, { recursive: true, force: true });
    }
  });
});
