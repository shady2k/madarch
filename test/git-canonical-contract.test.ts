import { describe, expect, test } from 'bun:test';
import { generatedTableName } from '../src/graph/contract.js';
import { declaredKindReads, graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { keyUid } from '../src/graph/uid.js';
import { repositoryManifest, repositoryContract } from './repository-contract-fixture.js';

describe('ordinary repository declarations retain canonical storage identities', () => {
  test('declared fields and additional opinions use one table and key', () => {
    const kind = repositoryManifest.kinds.get('code.file')!;
    const kinds = new Map(repositoryManifest.kinds);
    kinds.set(kind.name, { ...kind, fields: [...kind.fields!, { name: 'state_machines', type: 'json', nullable: true }] });
    const manifest = { ...repositoryManifest, kinds };
    const contract = graphContractOf(manifest);
    const file = contract.vertex.find(vertex => vertex.name === 'code.file')!;
    expect(file.table).toBe(generatedTableName('code.file', 'vertex'));
    expect(file.key).toEqual(['repository', 'path']);
    expect(file.fields.map(field => field.name)).toEqual([
      ...repositoryContract.vertex.find(vertex => vertex.name === 'code.file')!.fields.map(field => field.name), 'state_machines',
    ]);
    expect(declaredKindReads(manifest).get('code.file')).toMatchObject({ table: file.table, key: file.key, columns: file.fields.filter(field => !file.key.includes(field.name)).map(field => field.name) });
  });

  test('plugin drafts use the declared canonical name and scalar repository key', () => {
    const file = repositoryContract.vertex.find(vertex => vertex.name === 'code.file')!;
    const key = { repository: 'app', path: 'src/schema.ts' };
    expect(file.name).toBe('code.file');
    expect(file.key.map(field => key[field as keyof typeof key])).toEqual(['app', 'src/schema.ts']);
    expect(keyUid(file.name, [JSON.stringify(key)])).toBe(keyUid('code.file', [JSON.stringify({ repository: 'app', path: 'src/schema.ts' })]));
    expect(repositoryContract.vertex.some(vertex => vertex.name === 'file')).toBe(false);
  });

  test('a similarly named declaration remains independent without a native alias', () => {
    const kind = repositoryManifest.kinds.get('code.file')!;
    const kinds = new Map(repositoryManifest.kinds);
    kinds.set('file', { ...kind, name: 'file', capability: undefined });
    const contract = graphContractOf({ ...repositoryManifest, kinds });
    expect(contract.vertex.find(vertex => vertex.name === 'file')?.table).toBe(generatedTableName('file', 'vertex'));
    expect(contract.vertex.find(vertex => vertex.name === 'code.file')?.table).not.toBe(generatedTableName('file', 'vertex'));
  });
});
