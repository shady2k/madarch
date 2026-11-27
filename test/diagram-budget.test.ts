/**
 * The depth-1 diagram's budget (the owner's words, 2026-11-14): the neighbourhood is read and counted in one statement,
 * folded before anything is laid out, and laid out in a process of its own. The fixture here is the shape a folder of
 * 1 324 children has: the folder, its parent, 34 child folders and 1 290 files, all but the parent folded into one node
 * per group. The measurement is collect (the fixture's own read), fold and layout.
 */
import { expect, test } from 'bun:test';
import { diagramGraphOf, likec4PictureOf, type DiagramGraph } from '../src/render/diagram.js';
import type { DiagramNeighbourhood } from '../src/graph/graphql-read.js';

const entity = (uid: string, kind: string, label: string): never => ({ nodeId: uid, uid, kind, key: { path: label }, typeName: 'X', lang: 'ru' } as never);

/** The folder, its parent and two groups above the fold: what the read answers for a folder of 1 324 children. */
function folderHood(): DiagramNeighbourhood {
  const root = entity('1', 'code.directory', 'catalog');
  const parent = entity('2', 'code.directory', 'catalog');
  return {
    entity: root,
    nodes: new Map([['1', root], ['2', parent]]),
    links: [],
    labels: new Map([['1', 'catalog'], ['2', 'catalog']]),
    groups: [
      { relation: 'code.contains', label: 'содержится в', side: 'in', kind: 'code.directory', total: 1, nodes: ['2'] },
      { relation: 'code.contains', label: 'содержит', side: 'out', kind: 'code.directory', total: 34, nodes: [] },
      { relation: 'code.contains', label: 'содержит', side: 'out', kind: 'code.file', total: 1290, nodes: [] },
    ],
    kindWords: new Map([['code.directory', 'Папки'], ['code.file', 'Файлы']]),
    kindPages: new Map([['code.file', '/e/catalogue/x'], ['code.directory', '/e/catalogue/y']]),
    truncated: true,
  };
}

test('a folder of 1 324 children folds to four nodes, and fold and layout fit the budget', async () => {
  const hood = folderHood();
  const started = performance.now();
  const graph = diagramGraphOf(hood, 1, 12);
  const folded = performance.now() - started;
  expect(graph.nodes.map((node) => node.label)).toEqual(['catalog', 'catalog', 'Папки · 34', 'Файлы · 1290'].sort());
  // The folded nodes open the list of what they stand for, and only they carry a count.
  for (const node of graph.nodes) if (node.count !== undefined) expect(node.href).toBeDefined();
  // The layout engine's own cost, measured warm: the first call reads its module graph.
  await likec4PictureOf(graph as DiagramGraph);
  const laid = performance.now();
  await likec4PictureOf(graph as DiagramGraph);
  const layout = performance.now() - laid;
  console.log(`diagram budget: fold ${folded.toFixed(1)} ms, layout ${layout.toFixed(0)} ms, nodes ${String(graph.nodes.length)}`);
  // No user requirement was found for the 5 ms or the 400 ms bound: both arrived in commit 105a9f597 with no source.
  // They are the GitHub ubuntu-24.04, 4 vCPU runner's shape, and MADARCH_SKIP_PERF drops them where that shape is not
  // the machine under test; madarch-x9a7 settles their disposition.
  if (process.env['MADARCH_SKIP_PERF'] === undefined) {
    expect(folded).toBeLessThan(5);
    expect(folded + layout).toBeLessThan(400);
  }
}, 120_000);
