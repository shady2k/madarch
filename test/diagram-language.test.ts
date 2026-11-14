import { expect, test } from 'bun:test';
import { diagramGraphOf } from '../src/render/diagram.js';
import type { DiagramNeighbourhood } from '../src/graph/graphql-read.js';

test('diagram relation words follow the requested entity language', () => {
  const root = { nodeId: '1', uid: 'root', kind: 'sample', key: {}, typeName: 'Sample', lang: 'en' };
  const hood: DiagramNeighbourhood = {
    entity: root, nodes: new Map([['root', root]]), links: [], labels: new Map(),
    groups: [{ relation: 'manifest.depends-on', side: 'out', kind: 'sample', total: 20, nodes: [] }],
    kindWords: new Map(), kindPages: new Map(), truncated: false,
  };
  expect(diagramGraphOf(hood, 1, 12).edges[0]?.label).toBe('depends on');
  expect(diagramGraphOf({ ...hood, entity: { ...root, lang: 'ru' } }, 1, 12).edges[0]?.label).toBe('зависит от');
});
