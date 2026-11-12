import { describe, expect, test } from 'bun:test';
import type { KindDecl, KindsManifest } from '../src/product/manifest/kinds.js';
import { canonicalGitEntityRef, canonicalGitKind, GIT_CONTRACT, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { declaredKindReads, graphContractOf } from '../src/fill/stages/plugin-contract.js';

function manifest(): KindsManifest {
  const repository: KindDecl = { name: 'code.repository', title: 'label', relations: [], line: 1, template: 'repository.liquid', source: 'graph', capability: 'git', key: ['name'], derivesFrom: [], fields: [{ name: 'name', type: 'text' }] };
  const file: KindDecl = { name: 'code.file', title: 'label', relations: [], line: 2, template: 'file.liquid', source: 'graph', capability: 'git', key: ['repository', 'path'], derivesFrom: ['code.repository'], fields: [
    { name: 'repository', type: 'text', reference: 'code.repository' },
    { name: 'path', type: 'text' },
    { name: 'state_machines', type: 'json', nullable: true },
    { name: 'content', type: 'text', nullable: true },
  ] };
  return { file: 'madarch/kinds.yaml', kinds: new Map([[repository.name, repository], [file.name, file]]), roles: new Map(), properties: new Map(), groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] };
}

describe('git-backed declarations share one storage identity', () => {
  test('native fields and additional declared opinions use one table and key', () => {
    const held = manifest();
    const contract = graphContractOf(held);
    expect(contract.vertex.map((vertex) => vertex.name)).toEqual(['repository', 'file']);
    const file = contract.vertex.find((vertex) => vertex.name === 'file')!;
    expect(file.table).toBe(GIT_TABLES.file);
    expect(file.key).toEqual(['repository', 'path']);
    expect(file.fields.map((field) => field.name)).toEqual([
      ...GIT_CONTRACT.vertex.find((vertex) => vertex.name === 'file')!.fields.map((field) => field.name),
      'state_machines', 'content',
    ]);
    expect(declaredKindReads(held).get('code.file')).toMatchObject({ table: file.table, key: file.key, columns: file.fields.filter((field) => !file.key.includes(field.name)).map((field) => field.name) });
  });

  test('draft identity and nested references match the native producer declaration', () => {
    const held = manifest();
    const expected = { kind: 'file', key: { repository: { kind: 'repository', key: { name: 'app' } }, path: 'src/schema.ts' } };
    expect(canonicalGitEntityRef(held, { kind: 'code.file', key: { repository: 'app', path: 'src/schema.ts' } })).toEqual(expected);
    expect(canonicalGitEntityRef(held, { kind: 'code.file', key: { repository: { kind: 'code.repository', key: { name: 'app' } }, path: 'src/schema.ts' } })).toEqual(expected);
    expect(canonicalGitEntityRef(held, expected)).toEqual(expected);
  });

  test('a similarly named kind without the capability binding remains independent', () => {
    const held = manifest();
    const kinds = new Map(held.kinds);
    kinds.set('code.file', { ...kinds.get('code.file')!, capability: undefined });
    const independent = { ...held, kinds };
    expect(canonicalGitKind(independent, 'code.file')).toBe('code.file');
    expect(canonicalGitEntityRef(independent, { kind: 'code.file', key: { repository: 'app', path: 'x' } })).toEqual({ kind: 'code.file', key: { repository: 'app', path: 'x' } });
    expect(graphContractOf(independent).vertex.some((vertex) => vertex.name === 'code.file')).toBe(true);
  });
});
