import { describe, expect, test } from 'bun:test';
import { generatedTableName } from '../src/graph/contract.js';
import { declaredKindReads, graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { keyUid } from '../src/graph/uid.js';
import { repositoryManifest, repositoryContract } from './repository-contract-fixture.js';

describe('ordinary repository declarations retain canonical storage identities', () => {
  test('declared fields and additional opinions use one table and key', () => {
    const kind = repositoryManifest.kinds.get('code.file')!;
    const kinds = new Map(repositoryManifest.kinds);
    kinds.set(kind.name, { ...kind, fields: [...kind.fields!, { name: 'state_machines', type: 'json', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', items: { type: 'string' } }, nullable: true }] });
    const manifest = { ...repositoryManifest, kinds };
    const contract = graphContractOf(manifest);
    const file = contract.vertex.find(vertex => vertex.name === 'code.file')!;
    expect(file.table).toBe(generatedTableName('code.file', 'vertex'));
    expect(file.key).toEqual(['path']);
    expect(file.keyEdges).toEqual([expect.objectContaining({role:'code.file-repository',edge:'code.file-repository',direction:'from',onDelete:'restrict'})]);
    expect(file.fields.map(field => field.name)).toEqual([
      ...repositoryContract.vertex.find(vertex => vertex.name === 'code.file')!.fields.map(field => field.name), 'state_machines',
    ]);
    expect(declaredKindReads(manifest).get('code.file')).toMatchObject({ table: file.table, key: file.key, columns: file.fields.filter(field => !file.key.includes(field.name)).map(field => field.name) });
  });

  test('plugin references use the declared canonical name and repository key-edge', () => {
    const file = repositoryContract.vertex.find(vertex => vertex.name === 'code.file')!;
    const key = { path: 'src/schema.ts' };
    const keyEdges = {'code.file-repository':{kind:'code.repository',key:{name:'app'}}};
    expect(file.name).toBe('code.file');
    expect(file.key.map(field => key[field as keyof typeof key])).toEqual(['src/schema.ts']);
    expect(file.keyEdges?.[0]?.role).toBe('code.file-repository');
    expect(keyUid(file.name, [JSON.stringify({key,keyEdges})])).toBe(keyUid('code.file', [JSON.stringify({key:{path:'src/schema.ts'},keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'app'}}}})]));
    expect(keyUid(file.name,[JSON.stringify({key,keyEdges})])).not.toBe(keyUid(file.name,[JSON.stringify({key,keyEdges:{'code.file-repository':{kind:'code.repository',key:{name:'other'}}}})]));
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
