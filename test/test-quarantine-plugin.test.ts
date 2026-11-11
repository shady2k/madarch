import { describe, expect, test } from 'bun:test';
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
const file = { kind: 'code.file', key: { repository: 'repo', path: 'test/example.test.ts' } };
function context(content: string): ExtractContext {
  return {
    signal: new AbortController().signal, heartbeat() {}, progress() {},
    graph: {
      async files(pattern) { expect(['**/*.test.*', '**/quarantine-results.json']).toContain(pattern); return pattern === '**/*.test.*' ? [file] : []; },
      async value<T>(kind: string, key: Readonly<Record<string, string | number>>, field: string): Promise<T> {
        expect(kind).toBe(file.kind); expect(key).toEqual(file.key); expect(field).toBe('content');
        return content as T;
      },
      async unresolved() { return { rows: [] }; }, async removedEnds() { return { rows: [] }; }, async unevidenced() { return { rows: [] }; },
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
    expect(result.vertices).toHaveLength(2);
    expect(result.vertices?.[0]).toMatchObject({
      kind: 'code.test-quarantine', key: { ...file.key, name: 'outer suite first' },
      values: { test: { file: file.key.path, name: 'outer suite first', lines: [3, 3] }, task: 'madarch-64o5.17', quarantine_reason: 'slow', since },
      evidence: { ...file.key, lineStart: 3, lineEnd: 3 },
    });
    expect(result.vertices?.[0]?.values).not.toHaveProperty('latest_result');
    expect(result.edges?.map(edge => edge.kind)).toEqual(['quarantines', 'fixedBy', 'quarantines', 'fixedBy']);
    const replacement = await extract(unit, context(`test('repaired', () => {});`));
    expect(replacement).toEqual({ vertices: [], edges: [], end: { state: 'complete' } });
  });
  test('reads matching CI reports from host file content and excludes stale marker results', async () => {
    const ctx = context(source);
    const report = { kind: 'code.file', key: { repository: 'repo', path: 'madarch/quarantine-results.json' } };
    const result = { file: file.key.path, name: 'outer suite first', task: 'madarch-64o5.17', since, result: 'PASS', commit: 'a'.repeat(40), finishedAt: '2026-11-11T20:00:00Z' };
    ctx.graph.files = async pattern => pattern === '**/*.test.*' ? [file] : [report];
    ctx.graph.value = async <T>(_kind: string, key: Readonly<Record<string, string | number>>): Promise<T> => (key['path'] === report.key.path ? JSON.stringify({ cases: [result, { ...result, since: 'b'.repeat(40), result: 'FAIL', finishedAt: '2026-11-11T21:00:00Z' }] }) : source) as T;
    const extracted = await extract(unit, ctx);
    expect(extracted.vertices?.[0]?.values?.['latest_result']).toEqual(result);
    expect(extracted.vertices?.[1]?.values).not.toHaveProperty('latest_result');
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
    const host = new PluginHost({ pluginFolder: folder, repository: work, workRoot: work,
      trust: 'validation', closure, graph: { async files(pattern) { return pattern === '**/*.test.*' ? [file] : []; }, async value() { return content; } },
    });
    try {
      const session = await host.open();
      try {
        const first = await session.runUnit(unit);
        expect(first.state).toBe('extracted');
        if (first.state !== 'extracted') throw new Error(JSON.stringify(first));
        expect(first.result.vertices).toHaveLength(2);
        content = `test('repaired', () => {});`;
        const second = await session.runUnit({ ...unit, unitId: 'after-repair' });
        expect(second.state).toBe('extracted');
        if (second.state !== 'extracted') throw new Error(JSON.stringify(second));
        expect(second.result.vertices).toEqual([]);
      } finally { await session.close(); }
    } finally {
      if (previous === undefined) delete process.env['MADARCH_PLUGIN_SANDBOX']; else process.env['MADARCH_PLUGIN_SANDBOX'] = previous;
      rmSync(work, { recursive: true, force: true });
    }
  });
});
