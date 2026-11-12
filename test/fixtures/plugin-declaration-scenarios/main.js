import { definePlugin } from 'madarch-plugin-sdk';
import { contract, mode, files } from './scenario.js';

// One ordinary plugin has independently scoped outputs. No native stage or model.
await definePlugin({
  name: 'scenarios', version: '1.0.0', graph: true, graphReads: ['value'], contract,
  async extract(unit, context) {
    const evidence = { repository: 'repo', path: 'source.md', lineStart: 1, lineEnd: 1 };
    if (unit.kind === 'Files') {
      const vertices = files.map(file => ({ kind: 'Files', key: { path: file.path },
        values: { content: file.content, description: file.description },
        evidence: { repository: 'repo', path: file.path, lineStart: 1, lineEnd: 1 } }));
      if (mode === 'unselected-write') vertices.push({ kind: 'Summary', key: { id: 'forbidden' }, values: { text: 'must not publish' }, evidence });
      return { vertices, end: { state: 'complete' } };
    }
    if (unit.kind === 'X' || unit.kind === 'Y') return {
      vertices: [{ kind: unit.kind, key: { id: 'source' }, values: { text: 'authored ' + unit.kind }, evidence }],
      end: { state: 'complete' },
    };
    const input = unit.kind === 'A' ? 'X' : unit.kind === 'B' ? 'Y' : 'Files';
    const field = input === 'Files' ? 'description' : 'text';
    const key = input === 'Files' ? { path: files[0].path } : { id: 'source' };
    const text = await context.graph.value(mode === 'undeclared-read' ? 'Y' : input, key, field);
    return { vertices: [{ kind: unit.kind, key: { id: 'result' }, values: { text }, evidence }], end: { state: 'complete' } };
  },
});
