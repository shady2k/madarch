
/**
 * The Sources listing (the frame's Sources page): a document is projected by its explicit semantic role, grouped by
 * the repository it was read from; its entity page is addressed by the uid the graph read gives it.
 */
import { describe, expect, test } from 'bun:test';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import type { GraphReader } from '../src/knowledge/graph-read.js';
import { sourcesListing } from '../src/knowledge/sources.js';

const manifest = {
  file: '/product/catalog.yaml',
  semanticBindings: new Map([
    ['document', { kind: 'demo.doc', line: 1, fields: { path: 'path', content: 'markdown', anchors: 'sections' }, edges: { repository: { kind: 'in-vault', direction: 'from', line: 1 } } }],
    ['repository', { kind: 'vault', line: 1, fields: { name: 'name' } }],
  ]),
  kinds: new Map([
    ['demo.doc', { name: 'demo.doc', fields: [{ name: 'markdown' }, { name: 'path' }], key: ['repository', 'path'] }],
    ['demo.other', { name: 'demo.other', fields: [{ name: 'name' }], key: ['name'] }],
  ]),
} as unknown as KindsManifest;

const graph = {
  async relationEdges() { return { rows: [{ from: { uid: 'uid-2' }, to: { uid: 'repo' } }], total: 1 }; },
  async list(kind: string) {
    if (kind === 'vault') return { rows: [{ uid: 'repo', key: 'repository', properties: { name: 'app' } }], next: null };
    if (kind !== 'demo.doc') return { rows: [], next: null, total: 0 };
    return {
      rows: [
        { key: 'demo.doc:/docs/guide.md', uid: 'uid-1', kind: 'demo.doc', label: 'Guide', properties: { repository: null, path: 'docs/guide.md', markdown: '# Guide', sections: {} }, nodeIds: ['1'], scope: '' },
        { key: 'demo.doc:app/README.md', uid: 'uid-2', kind: 'demo.doc', label: 'README', properties: { repository: 'app', path: 'README.md', markdown: '# README', sections: {} }, nodeIds: ['2'], scope: '' },
      ],
      next: null,
      total: 2,
    };
  },
} as unknown as GraphReader;

describe('the Sources listing', () => {
  test('lists a markdown kind, groups by repository and keeps each entity uid', async () => {
    const listing = await sourcesListing(manifest, graph, [{ name: null, present: true, filled: true }, { name: 'app', present: false, filled: false }]);
    expect(listing.documents).toEqual([
      { repo: null, path: 'docs/guide.md', title: 'Guide', kind: 'demo.doc', id: 'uid-1' },
      { repo: 'app', path: 'README.md', title: 'README', kind: 'demo.doc', id: 'uid-2' },
    ]);
    expect(listing.repositories).toHaveLength(2);
    expect(listing.truncated).toEqual([]);
  });
});
