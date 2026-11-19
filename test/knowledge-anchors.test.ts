import { describe, expect, test } from 'bun:test';
import { documentSections, graphDocument, documentOpinions, type DocumentOpinion } from '../src/knowledge/anchors.js';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';
import { Resolver } from '../src/knowledge/resolve.js';

const section = { title: 'Producer title', start: 17, end: 19, markdown: 'Producer excerpt, not inferred from headings.' };
const document = (repository: string | null = null): DocumentOpinion => ({ key: `guide:${repository ?? 'product'}`, kind: 'guide', label: 'Guide', scope: '', nodeIds: [], properties: { repository, commit: null, path: 'guide.md', content: '# Unrelated heading', anchors: { chosen: section } } });
const reader = (rows: GraphEntity[]): GraphReader => ({ list: async (kind: string) => ({ rows: rows.filter((row) => row.kind === kind), next: null }) }) as unknown as GraphReader;
const resolver = (graph: GraphReader) => new Resolver({ graph, documents: [document(), document('code')], markdown: new Map(), declared: () => false, repositories: () => ['code'], locate: () => undefined });

describe('structured document anchors', () => {
  test('the manifest supplies kinds and repository identities are exact', async () => {
    expect(graphDocument([document('code')], null, 'guide.md')).toBeUndefined();
    expect(graphDocument([], 'code', 'guide.md')).toBeUndefined();
    expect((graphDocument([document('code')], 'code', 'guide.md'))?.key).toBe('guide:code');
  });

  test('explicit bindings project renamed values and resolve repository UID edges', async () => {
    const calls: unknown[] = [];
    const graph = { list: async (kind: string, options: { after?: string }) => {
      calls.push([kind, options.after]);
      if (kind === 'vault') return { rows: [{ uid: 'repo-uid', key: 'r', properties: { alias: 'code' } }], next: null };
      return options.after === 'later' ? { rows: [{ ...document(), uid: 'doc-uid', properties: { location: 'guide.md', body: 'text', sections: { chosen: section } } }], next: null } : { rows: [], next: 'later' };
    }, relationEdges: async () => ({ rows: [{ from: { uid: 'doc-uid' }, to: { uid: 'repo-uid' } }], total: 1 }) } as unknown as GraphReader;
    const manifest = { file: '/product/catalog.yaml', semanticBindings: new Map([
      ['document', { kind: 'guide', fields: { path: 'location', content: 'body', anchors: 'sections' }, edges: { repository: { kind: 'belongs', direction: 'from', line: 1 } }, line: 1 }],
      ['repository', { kind: 'vault', fields: { name: 'alias' }, line: 1 }],
    ]) } as unknown as import('../src/product/manifest/kinds.js').KindsManifest;
    const documents = await documentOpinions(graph, manifest);
    expect(graphDocument(documents, 'code', 'guide.md')?.uid).toBe('doc-uid');
    expect(documentSections(documents[0]!)).toEqual([{ anchor: 'chosen', ...section }]);
    expect(calls).toEqual([['guide', undefined], ['guide', 'later'], ['vault', undefined]]);
    await expect(documentOpinions(graph, { ...manifest, semanticBindings: new Map() })).rejects.toThrow('semantic role "document" is required');
  });

  test('source relationships resolve only declared UID targets and never scalar aliases', async () => {
    let endpoints = ['repo'];
    let alias: string | null | undefined = 'code';
    const graph = { list: async (kind: string) => ({ rows: kind === 'text' ? [{ uid: 's', key: 's', properties: { location: 'a.ts', bytes: 'text', repository: 'ignored', commit: 'ignored' } }] : kind === 'vault' ? [{ uid: 'repo', key: 'r', properties: alias === undefined ? {} : { alias } }] : [{ uid: 'c', key: 'c', properties: { digest: 'hash' } }], next: null }),
      relationEdges: async (kind: string) => ({ rows: (kind === 'in-vault' ? endpoints : ['c']).map((uid) => ({ from: { uid: 's' }, to: { uid } })), total: kind === 'in-vault' ? endpoints.length : 1 }),
    } as unknown as GraphReader;
    const manifest = { file: '/product/catalog.yaml', semanticBindings: new Map([
      ['source', { kind: 'text', fields: { path: 'location', content: 'bytes' }, edges: { repository: { kind: 'in-vault', direction: 'from', line: 1 }, commit: { kind: 'at-revision', direction: 'from', line: 1 } }, line: 1 }],
      ['repository', { kind: 'vault', fields: { name: 'alias' }, line: 1 }],
      ['commit', { kind: 'revision', fields: { hash: 'digest' }, line: 1 }],
    ]) } as unknown as import('../src/product/manifest/kinds.js').KindsManifest;
    expect((await documentOpinions(graph, manifest, 'source'))[0]?.properties).toEqual({ path: 'a.ts', content: 'text', repository: 'code', commit: 'hash' });
    endpoints = [];
    expect((await documentOpinions(graph, manifest, 'source'))[0]?.properties['repository']).toBeNull();
    endpoints = ['repo'];
    alias = null;
    expect((await documentOpinions(graph, manifest, 'source'))[0]?.properties['repository']).toBeNull();
    const repositoryBinding = manifest.semanticBindings!.get('repository')!;
    const incomplete = { ...manifest, semanticBindings: new Map(manifest.semanticBindings) };
    incomplete.semanticBindings.set('repository', { ...repositoryBinding, fields: {} });
    await expect(documentOpinions(graph, incomplete, 'source')).rejects.toThrow('/product/catalog.yaml:1: r: semantic role "repository" requires name');
    alias = 'code';
    endpoints = ['missing'];
    await expect(documentOpinions(graph, manifest, 'source')).rejects.toThrow('/product/catalog.yaml:1: s: semantic role "source" repository endpoint missing');
    endpoints = ['repo', 'other'];
    await expect(documentOpinions(graph, manifest, 'source')).rejects.toThrow('requires at most one repository endpoint');
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
      (entity as GraphEntity).properties['anchors'] = anchors;
      expect(() => documentSections(entity)).toThrow('guide.md:1: document guide:product');
    }
  });
});
