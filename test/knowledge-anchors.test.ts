import { describe, expect, test } from 'bun:test';
import { documentSections, graphDocument } from '../src/knowledge/anchors.js';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';
import { Resolver } from '../src/knowledge/resolve.js';

const section = { title: 'Producer title', start: 17, end: 19, markdown: 'Producer excerpt, not inferred from headings.' };
const document = (repository: string | null = null): GraphEntity => ({ key: `guide:${repository ?? 'product'}`, kind: 'guide', label: 'Guide', scope: '', nodeIds: [], properties: { repository, path: 'guide.md', markdown: '# Unrelated heading', anchors: { chosen: section } } });
const reader = (rows: GraphEntity[]): GraphReader => ({ list: async (kind: string) => ({ rows: rows.filter((row) => row.kind === kind), next: null }) }) as unknown as GraphReader;
const resolver = (graph: GraphReader) => new Resolver({ graph, documentKinds: ['guide'], markdown: new Map(), declared: () => false, repositories: () => ['code'], locate: () => undefined });

describe('structured document anchors', () => {
  test('the manifest supplies kinds and repository identities are exact', async () => {
    const graph = reader([document('code')]);
    expect(await graphDocument(graph, null, 'guide.md', ['guide'])).toBeUndefined();
    expect(await graphDocument(graph, 'code', 'guide.md', ['other'])).toBeUndefined();
    expect((await graphDocument(graph, 'code', 'guide.md', ['guide']))?.key).toBe('guide:code');
  });

  test('lookup walks every page and declared kind', async () => {
    const calls: unknown[] = [];
    const graph = { list: async (kind: string, options: { after?: string }) => {
      calls.push([kind, options.after]);
      return kind === 'guide' && options.after === 'later' ? { rows: [document()], next: null } : { rows: [], next: kind === 'guide' ? 'later' : null };
    } } as unknown as GraphReader;
    expect((await graphDocument(graph, null, 'guide.md', ['other', 'guide']))?.key).toBe('guide:product');
    expect(calls).toEqual([['other', undefined], ['guide', undefined], ['guide', 'later']]);
  });

  test('ranges, titles and excerpts come only from the structured opinion', () => {
    expect(documentSections(document())).toEqual([{ anchor: 'chosen', ...section }]);
  });

  test('document links resolve structured anchors, never headings in source bytes', async () => {
    const links = resolver(reader([document('code')]));
    expect(await links.resolve('madarch:doc:@code/guide.md#chosen')).toMatchObject({ state: 'ok', href: '/doc?repo=code&path=guide.md#chosen' });
    expect(await links.resolve('madarch:doc:guide.md#unrelated-heading')).toMatchObject({ state: 'broken', why: { code: 'no-section' } });
    expect(await links.resolve('madarch:doc:missing.md')).toMatchObject({ state: 'broken', why: { code: 'no-document' } });
    expect(await links.resolve('madarch:doc:guide.md')).toMatchObject({ state: 'ok' });
    expect(await links.resolve('madarch:doc:')).toMatchObject({ state: 'broken', why: { code: 'no-path' } });
  });

  test('malformed anchors are refused without reducing the result', () => {
    for (const anchors of [undefined, [], { chosen: null }, { chosen: 17 }, { chosen: { ...section, start: 0 } }, { chosen: { ...section, end: 16 } }, { chosen: { ...section, start: 1.5 } }, { chosen: { ...section, title: null } }, { chosen: { ...section, markdown: null } }]) {
      const entity = document();
      entity.properties['anchors'] = anchors;
      expect(() => documentSections(entity)).toThrow('guide.md:1: document guide:product');
    }
  });
});
