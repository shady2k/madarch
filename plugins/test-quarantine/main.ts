import type { ExtractContext, Unit, UnitResult, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
import { quarantinedTests } from './parser.js';

/** Source bytes come only from host graph reads; this plugin opens no repository or tracker. */
export async function extract(_unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const files = await context.graph.files('**/*.test.*');
  const vertices: VertexResult[] = [];
  const edges: EdgeResult[] = [];
  const problems: string[] = [];
  const reports: { repository: string; entry: Record<string, unknown> }[] = [];
  for (const report of await context.graph.files('**/quarantine-results.json')) {
    const content = await context.graph.value<string | null>(report.kind, report.key, 'content');
    if (typeof content !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { cases?: unknown }).cases)) throw new Error('expected {cases: [...]}');
      for (const entry of (parsed as { cases: unknown[] }).cases) {
        if (entry !== null && typeof entry === 'object') reports.push({ repository: String(report.key['repository'] ?? ''), entry: entry as Record<string, unknown> });
      }
    } catch (error) {
      problems.push(`${String(report.key['path'])}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const file of files) {
    if (context.signal.aborted) throw new Error('Extraction cancelled');
    const repository = String(file.key['repository'] ?? '');
    const path = String(file.key['path'] ?? '');
    if (!/\.test\.[cm]?[jt]sx?$/.test(path)) continue;
    const source = await context.graph.value<string | null>(file.kind, file.key, 'content');
    if (typeof source !== 'string') continue;
    try {
      for (const test of quarantinedTests(source, path)) {
        const key = { repository, path, name: test.name };
        const from = { kind: 'code.test-quarantine', key };
        const results = reports.filter(report => report.repository === repository && report.entry['file'] === path && report.entry['name'] === test.name && report.entry['task'] === test.task && report.entry['since'] === test.since && ['PASS', 'FAIL'].includes(String(report.entry['result'])) && typeof report.entry['commit'] === 'string');
        const latest = results.sort((a, b) => String(b.entry['finishedAt'] ?? '').localeCompare(String(a.entry['finishedAt'] ?? '')))[0]?.entry;
        vertices.push({ ...from, values: {
          test: { kind: 'code.test-case', key, repository, file: path, name: test.name, lines: [test.lineStart, test.lineEnd], lineStart: test.lineStart, lineEnd: test.lineEnd },
          task: test.task, quarantine_reason: test.reason, since: test.since,
          ...(latest === undefined ? {} : { latest_result: latest }),
        }, evidence: { repository, path, lineStart: test.lineStart, lineEnd: test.lineEnd } });
        edges.push({ kind: 'quarantines', from, to: { kind: 'code.test-case', key } });
        edges.push({ kind: 'fixedBy', from, to: { kind: 'task', key: { id: test.task } } });
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { vertices, edges, end: problems.length ? { state: 'partial', cause: problems.join('\n') } : { state: 'complete' } };
}
