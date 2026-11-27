import { createHash } from 'node:crypto';
import type { ExtractContext, Unit, UnitResult, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
import { quarantinedTests } from './parser.js';

/** Source bytes come only from host graph reads; this plugin opens no repository or tracker. */

/**
 * One file's text, by the blob id the graph names: the host routes the read to the core plugin that owns git (decision
 * 0037, decision 0038). Absent when the graph names no blob or the blob is no text.
 */
async function textOf(context: ExtractContext, file: import('madarch-plugin-sdk').EntityRef): Promise<string | undefined> {
  const blob = await context.graph.value<string | null>(file.kind, file.key, 'blob', file.keyEdges);
  if (typeof blob !== 'string' || blob === '') return undefined;
  const repository = file.keyEdges?.['code.file-repository']?.key['name'];
  if (typeof repository !== 'string') throw new Error('plugins/test-quarantine/main.ts:15: file lacks its repository key edge');
  const read = await context.read({ repository, blob });
  return read.binary ? undefined : read.text;
}
export async function extract(_unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const files = await context.graph.files('**/*.test.*');
  const vertices: VertexResult[] = [];
  const blobVertices: VertexResult[] = [];
  const edges: EdgeResult[] = [];
  const problems: string[] = [];
  const reports: { repository: string; entry: Record<string, unknown> }[] = [];
  for (const report of await context.graph.files('**/quarantine-results.json')) {
    const content = await textOf(context, report);
    if (typeof content !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { cases?: unknown }).cases)) throw new Error('expected {cases: [...]}');
      for (const entry of (parsed as { cases: unknown[] }).cases) {
        if (entry !== null && typeof entry === 'object') reports.push({ repository: String(report.keyEdges?.['code.file-repository']?.key['name'] ?? ''), entry: entry as Record<string, unknown> });
      }
    } catch (error) {
      problems.push(`${String(report.key['path'])}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const file of files) {
    if (context.signal.aborted) throw new Error('Extraction cancelled');
    const repositoryRef = file.keyEdges?.['code.file-repository'];
    if (repositoryRef === undefined) throw new Error(`/work/madarch-64o5.74/plugins/test-quarantine/main.ts:29: file ${String(file.key['path'])} lacks repository identity`);
    const repository = String(repositoryRef.key['name']);
    const path = String(file.key['path'] ?? '');
    if (!/\.test\.[cm]?[jt]sx?$/.test(path)) continue;
    const source = await textOf(context, file);
    if (typeof source !== 'string') continue;
    const digest = createHash('sha256').update(source).digest('hex');
    blobVertices.push({ kind: 'code.blob', key: { digest }, values: { content: source } });
    edges.push({ kind: 'code.blob-about', from: { kind: 'code.blob', key: { digest } }, to: file });
    try {
      for (const test of quarantinedTests(source, path)) {
        const key = { path, name: test.name };
        const from = { kind: 'code.test-quarantine', key, keyEdges: { 'code.test-quarantine-repository': repositoryRef } };
        const target = {kind:'code.test-case',key:{name:test.name},keyEdges:{'code.test-case-file':file}};
        const results = reports.filter(report => report.repository === repository && report.entry['file'] === path && report.entry['name'] === test.name && report.entry['task'] === test.task && report.entry['since'] === test.since && ['PASS', 'FAIL'].includes(String(report.entry['result'])) && typeof report.entry['commit'] === 'string');
        const latest = results.sort((a, b) => String(b.entry['finishedAt'] ?? '').localeCompare(String(a.entry['finishedAt'] ?? '')))[0]?.entry;
        vertices.push({ ...from, values: {
          quarantine_reason: test.reason,
        }, evidence: { target: { kind: 'code.blob', key: { digest } }, digest, path, lineStart: test.lineStart, lineEnd: test.lineEnd } });
        edges.push({kind:'code.test-quarantine-test',from,to:target});
        edges.push({kind:'code.test-quarantine-since',from,to:{kind:'code.commit',key:{hash:test.since}}});
        if (latest !== undefined && typeof latest['id'] === 'string') edges.push({kind:'code.test-quarantine-latest-result',from,to:{kind:'test-result',key:{id:latest['id']}}});
        edges.push({ kind: 'code.test-quarantine-task', from, to: { kind: 'task', key: { id: test.task } } });
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { vertices: [...new Map(blobVertices.map(blob => [blob.key['digest'], blob])).values(), ...vertices], edges, end: problems.length ? { state: 'partial', cause: problems.join('\n') } : { state: 'complete' } };
}
