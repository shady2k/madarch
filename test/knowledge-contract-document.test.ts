import {describe, expect, test} from 'bun:test';
import {contractDocument, ContractReadError} from '../src/knowledge/contract-document.js';
import {protoDocument} from '../src/knowledge/proto-document.js';
const read = (files: Record<string, string>) => async (path: string): Promise<string | undefined> => files[path];
const full = (path: string): string => `/fixture/repos/catalog/${path}`;

describe('complete local contract documentation', () => {
  test('keeps every line and bundles external and circular local references', async () => {
    const files = {'api.yaml': `openapi: 3.0.3\ninfo: {title: Catalogue, version: 1.0.0}\ncomponents:\n  schemas:\n    Item: {$ref: './models.yaml#/Item'}\n${'# complete\n'.repeat(500)}`, 'models.yaml': 'Item: {type: object, properties: {parent: {$ref: "#/Item"}}}'};
    const result = await contractDocument('api.yaml', read(files), full);
    expect(result.text).toBe(files['api.yaml']);
    expect(JSON.stringify(result.document)).toContain('#/x-madarch-references/file0/Item');
    expect(JSON.stringify(result.document)).toContain('parent');
  });
  test('remote, escaped, absent and malformed definitions are source-located refusals', async () => {
    for (const ref of ['https://invalid.example/schema.json', '../outside.yaml', './missing.yaml']) {
      try { await contractDocument('api.yaml', read({'api.yaml': `openapi: 3.0.3\nx: {$ref: "${ref}"}`}), full); throw new Error('accepted invalid reference'); }
      catch (error) { expect(error).toBeInstanceOf(ContractReadError); const held = error as ContractReadError; expect(held.diagnostic.fullPath).toStartWith('/fixture/repos/catalog/'); expect(held.diagnostic.line).toBeGreaterThan(0); }
    }
    await expect(contractDocument('bad.yaml', read({'bad.yaml': 'x: [broken'}), full)).rejects.toThrow('bad.yaml:1');
  });
  test('recursive YAML aliases are explicit bounded source errors', async () => {
    try {
      await contractDocument('api.yaml', read({'api.yaml': 'openapi: 3.0.3\ninvalid: &recursive {self: *recursive}'}), full);
      throw new Error('accepted a recursive alias');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractReadError);
      expect((error as ContractReadError).diagnostic).toMatchObject({path: 'api.yaml', fullPath: '/fixture/repos/catalog/api.yaml', code: 'parse'});
    }
  });
  test('protobuf documents streaming, nested messages, maps, enums, oneofs and imports', async () => {
    const files = {'api.proto': 'syntax="proto3"; package catalog; import "types.proto"; service Catalog { rpc List(stream Request) returns (stream Response); } message Request { oneof choice { string name = 1; int32 id = 2; } }', 'types.proto': 'syntax="proto3"; package catalog; message Response { map<string, Item> items = 1; message Item { string name = 1; } } enum State { UNKNOWN = 0; READY = 1; }'};
    const result = await protoDocument('api.proto', read(files), full);
    expect(result.protobuf.services[0]?.methods[0]).toEqual({name: 'List', request: 'catalog.Request', response: 'catalog.Response', requestStream: true, responseStream: true});
    expect(result.protobuf.messages.find((held) => held.name === 'catalog.Response')?.fields[0]?.type).toBe('map<string, catalog.Response.Item>');
    expect(result.protobuf.messages.find((held) => held.name === 'catalog.Request')?.fields[0]?.oneof).toBe('choice');
    expect(result.protobuf.messages.find((held) => held.name === 'catalog.State')?.values).toContainEqual({name: 'READY', id: 1});
  });
  test('protobuf does not omit unresolved imports or malformed syntax', async () => {
    await expect(protoDocument('api.proto', read({'api.proto': 'syntax="proto3"; import "missing.proto";'}), full)).rejects.toThrow('/fixture/repos/catalog/missing.proto');
    await expect(protoDocument('api.proto', read({'api.proto': 'message Broken {'}), full)).rejects.toThrow('api.proto:');
  });
});
