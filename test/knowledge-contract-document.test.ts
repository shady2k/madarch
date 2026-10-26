import {describe, expect, expectTypeOf, test} from 'bun:test';
import type {ContractReason as AppContractReason} from '../wiki/app/src/knowledge/types.js';
import {contractDocument, ContractReadError, contractObjectAt, contractReasonOf, type ContractReason} from '../src/knowledge/contract-document.js';
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


test('diagnostic reasons are additive and retain legacy source evidence', async () => {
  const cases: {path: string; files: Record<string, string>; reason: ContractReason; code: string}[] = [
    {path: 'contracts/service.yaml', files: {}, reason: {code: 'definitionMissing'}, code: 'missing'},
    {path: 'contracts/service.yaml', files: {'contracts/service.yaml': '[]'}, reason: {code: 'definitionObjectRequired'}, code: 'shape'},
    {path: 'contracts/service.yaml', files: {'contracts/service.yaml': 'broken: ['}, reason: {code: 'yamlParse'}, code: 'parse'},
    {path: 'contracts/service.yaml', files: {'contracts/service.yaml': 'x: {$ref: "https://invalid.example/model"}'}, reason: {code: 'referenceRemoteOrAbsolute', params: {ref: 'https://invalid.example/model'}}, code: 'reference'},
  ];
  for (const fixture of cases) {
    try { await contractDocument(fixture.path, read(fixture.files), full); throw new Error('expected refusal'); }
    catch (error) {
      expect(error).toBeInstanceOf(ContractReadError);
      const diagnostic = (error as ContractReadError).diagnostic;
      expect(diagnostic).toMatchObject({path: fixture.path, fullPath: full(fixture.path), code: fixture.code, reason: fixture.reason});
      expect(diagnostic.line).toBeGreaterThan(0);
      expect((error as Error).message).toBe(`${diagnostic.path}:${diagnostic.line} (${diagnostic.fullPath}): ${diagnostic.detail}`);
      expect(diagnostic.technicalDetail).toBe(diagnostic.detail);
    }
  }
  try { await protoDocument('contracts/service.proto', read({}), full); throw new Error('expected refusal'); }
  catch (error) { expect((error as ContractReadError).diagnostic).toMatchObject({code: 'missing', reason: {code: 'protoImportMissing'}}); }
});

test('operation reference reason tags preserve Error and URIError behavior', () => {
  for (const fixture of [
    {document: {x: {$ref: '#/x'}}, value: {$ref: '#/x'}, reason: 'operationReferenceBudgetOrCycle', error: Error},
    {document: {}, value: {$ref: 'external'}, reason: 'operationReferenceUnresolved', error: Error},
    {document: {}, value: {$ref: '#/%broken'}, reason: 'pointerEncodingInvalid', error: URIError},
  ]) {
    try { contractObjectAt(fixture.document, fixture.value); throw new Error('expected refusal'); }
    catch (error) { expect(error).toBeInstanceOf(fixture.error); expect(error).not.toBeInstanceOf(ContractReadError); expect(String(contractReasonOf(error)?.code)).toBe(fixture.reason); }
  }
});


test('server and app diagnostic reason types are exactly compatible', () => {
  expectTypeOf<ContractReason>().toEqualTypeOf<AppContractReason>();
  expectTypeOf<AppContractReason>().toEqualTypeOf<ContractReason>();
});


test('literal instance reference keys stay opaque while actual schema properties are walked', async () => {
  const literals = {example: {$ref: 'https://invalid.example/literal'}, default: {$ref: './not-read.yaml'}, enum: [{$ref: './not-read.yaml'}], const: {$ref: './not-read.yaml'}};
  const document = {openapi: '3.0.3', components: {schemas: {Record: {...literals, properties: Object.fromEntries(['$ref', 'example', 'default', 'enum', 'const'].map((name) => [name, {$ref: './models.yaml#/Field'}]))}}}, paths: {'/records': {get: {responses: {'200': {content: {'application/json': {example: literals, examples: {named: {value: literals}}}}}}}}}};
  const requested: string[] = [];
  const files: Record<string, string> = {'contracts/service.yaml': JSON.stringify(document), 'contracts/models.yaml': 'Field: {type: string}'};
  const result = await contractDocument('contracts/service.yaml', async (path) => {requested.push(path); return files[path];}, full);
  const schemas = result.document['components'] as {schemas: {Record: typeof literals & {properties: Record<string, {$ref: string}>}}};
  expect(schemas.schemas.Record.example).toEqual(literals.example); expect(schemas.schemas.Record.default).toEqual(literals.default); expect(schemas.schemas.Record.enum).toEqual(literals.enum); expect(schemas.schemas.Record.const).toEqual(literals.const);
  for (const name of ['$ref', 'example', 'default', 'enum', 'const']) expect(schemas.schemas.Record.properties[name]?.$ref).toBe('#/x-madarch-references/file0/Field');
  expect(requested).toEqual(['contracts/service.yaml', 'contracts/models.yaml']);
  const paths = result.document['paths'] as typeof document.paths;
  expect(paths['/records'].get.responses['200'].content['application/json'].examples.named.value).toEqual(literals);
});

test('cross-file fragment context preserves example instances and description source records', async () => {
  const files = {'contracts/service.yaml': 'openapi: 3.0.3\ncomponents:\n  examples:\n    Record: {$ref: "./examples.yaml#/Record"}\n  schemas:\n    Record: {$ref: "./models.yaml#/Record"}', 'contracts/examples.yaml': 'Record: {value: {$ref: "https://invalid.example/literal"}}', 'contracts/models.yaml': 'Record:\n  type: object\n  description: "![record][logo]\\n\\n[logo]: image.png"\n  properties: {example: {$ref: "#/Field"}}\nField: {type: string}'};
  const result = await contractDocument('contracts/service.yaml', read(files), full);
  const bundled = result.document['x-madarch-references'] as Record<string, {Record: {value?: {$ref: string}}}>;
  expect(Object.values(bundled).find((doc) => doc.Record.value !== undefined)?.Record.value).toEqual({$ref: 'https://invalid.example/literal'});
  expect(result.descriptions).toEqual([{text: '![record][logo]\n\n[logo]: image.png', path: 'contracts/models.yaml', line: 3, fullPath: full('contracts/models.yaml')}]);
});


test('whole external fragment maps check sibling references and collect sibling descriptions', async () => {
  const rootText = 'openapi: 3.0.3\ncomponents: {schemas: {Record: {$ref: "./models.yaml#/Record"}}}';
  const safe = {'contracts/service.yaml': rootText, 'contracts/models.yaml': 'Record: {type: string}\nSibling: {description: "![record](image.png)", example: {$ref: "https://invalid.example/literal"}}'};
  const result = await contractDocument('contracts/service.yaml', read(safe), full);
  expect(result.descriptions).toContainEqual({text: '![record](image.png)', path: 'contracts/models.yaml', line: 2, fullPath: full('contracts/models.yaml')});
  const bad = {...safe, 'contracts/models.yaml': 'Record: {type: string}\nSibling: {$ref: "https://invalid.example/schema"}'};
  await expect(contractDocument('contracts/service.yaml', read(bad), full)).rejects.toThrow('remote or absolute reference is not allowed');
  const examples = {'contracts/service.yaml': 'openapi: 3.0.3\ncomponents: {examples: {Record: {$ref: "./examples.yaml#/Record"}}}', 'contracts/examples.yaml': 'Record: {value: {$ref: "https://invalid.example/one"}}\nSibling: {value: {$ref: "https://invalid.example/two", description: "![literal](image.png)"}}'};
  const opaque = await contractDocument('contracts/service.yaml', read(examples), full);
  expect(opaque.descriptions).toEqual([]);
  expect(JSON.stringify(opaque.document)).toContain('https://invalid.example/two');
});

test('spec-owned component maps do not confuse arbitrary member names with instance fields', async () => {
  const names = ['schema', 'example', 'examples', 'default', 'enum', 'const', '$ref'];
  const document = {openapi: '3.0.3', components: {schemas: Object.fromEntries(names.map((name) => [name, {$ref: './models.yaml#/Field'}])), headers: Object.fromEntries(names.map((name) => [name, {$ref: './headers.yaml#/Header'}])), securitySchemes: Object.fromEntries(names.map((name) => [name, {$ref: './security.yaml#/Security'}]))}};
  const result = await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': JSON.stringify(document), 'contracts/models.yaml': 'Field: {type: string}', 'contracts/headers.yaml': 'Header: {schema: {type: string}}', 'contracts/security.yaml': 'Security: {type: apiKey, in: header, name: token}'}), full);
  const components = result.document['components'] as Record<string, Record<string, {$ref: string}>>;
  for (const kind of ['schemas', 'headers', 'securitySchemes']) for (const name of names) expect(components[kind]?.[name]?.$ref).toStartWith('#/x-madarch-references/');
});

test('alias context cloning preserves opaque instances and refuses expanded representations before allocation', async () => {
  const shared = 'openapi: 3.0.3\ncomponents:\n  schemas:\n    Record: &shared {description: "![literal](image.png)", type: string}\n  examples:\n    Record: {value: *shared}';
  const result = await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': shared}), full);
  expect(result.descriptions).toHaveLength(1);
  const components = result.document['components'] as {schemas: {Record: {description: string}}; examples: {Record: {value: {description: string}}}};
  expect(components.schemas.Record).not.toBe(components.examples.Record.value);
  const huge = `openapi: 3.0.3\nvalue: &shared "${'x'.repeat(300_000)}"\nexamples: [${Array.from({length: 20}, () => '*shared').join(', ')}]`;
  try { await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': huge}), full); throw new Error('expected representation refusal'); }
  catch (error) { expect(error).toBeInstanceOf(ContractReadError); expect((error as ContractReadError).diagnostic.reason).toEqual({code: 'definitionRepresentationBudget', params: {maxBytes: 4 * 1024 * 1024}}); }
});


test('nested external fragments inspect root prose and every sibling without touching opaque instances', async () => {
  const entry = 'openapi: 3.0.3\ncomponents: {schemas: {Record: {$ref: "./models.yaml#/definitions/Record"}}}';
  const external = {description: '![root](image.png)', definitions: {Record: {type: 'object', properties: {$ref: {type: 'string'}, example: {$ref: '#/definitions/Other'}}}, Other: {type: 'string', example: {$ref: 'https://invalid.example/literal'}}}, Sibling: {description: '![sibling](image.png)', type: 'string'}};
  const result = await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': entry, 'contracts/models.yaml': JSON.stringify(external)}), full);
  expect(result.descriptions.map((source) => source.text)).toEqual(['![sibling](image.png)', '![root](image.png)']);
  const bundled = result.document['x-madarch-references'] as Record<string, typeof external>;
  expect(bundled['file0']?.definitions.Record.properties.$ref).toEqual({type: 'string'});
  expect(bundled['file0']?.definitions.Other.example).toEqual({$ref: 'https://invalid.example/literal'});
  expect(bundled['file0']?.definitions.Record.properties.example.$ref).toBe('#/x-madarch-references/file0/definitions/Other');
  const bad = {...external, Sibling: {$ref: 'https://invalid.example/schema'}};
  await expect(contractDocument('contracts/service.yaml', read({'contracts/service.yaml': entry, 'contracts/models.yaml': JSON.stringify(bad)}), full)).rejects.toThrow('remote or absolute reference is not allowed');
  const examplesEntry = 'openapi: 3.0.3\ncomponents: {examples: {Record: {$ref: "./examples.yaml#/catalog/Record"}}}';
  const examples = {description: '![root example file](image.png)', catalog: {Record: {value: {$ref: 'https://invalid.example/literal'}}, Sibling: {value: {$ref: './never-read.yaml', description: '![opaque](image.png)'}}}};
  const requested: string[] = [];
  const files: Record<string, string> = {'contracts/service.yaml': examplesEntry, 'contracts/examples.yaml': JSON.stringify(examples)};
  const opaque = await contractDocument('contracts/service.yaml', async (path) => {requested.push(path); return files[path];}, full);
  expect(opaque.descriptions.map((source) => source.text)).toEqual(['![root example file](image.png)']);
  expect(requested).toEqual(['contracts/service.yaml', 'contracts/examples.yaml']);
});


test('an external items fragment preserves its containing schema instance example', async () => {
  const files = {'contracts/service.yaml': 'openapi: 3.0.3\ncomponents: {schemas: {Record: {$ref: "./models.yaml#/items"}}}', 'contracts/models.yaml': 'type: array\nitems: {type: string}\nexample: {$ref: "https://invalid.example/literal"}'};
  const result = await contractDocument('contracts/service.yaml', read(files), full);
  const bundled = result.document['x-madarch-references'] as Record<string, {example: {$ref: string}}>;
  expect(bundled['file0']?.example).toEqual({$ref: 'https://invalid.example/literal'});
});

test('OpenAPI response header maps and AsyncAPI message header schemas use different roles', async () => {
  const names = ['example', 'default', 'enum', 'const', '$ref'];
  const openapi = {openapi: '3.0.3', paths: {'/records': {get: {responses: {'200': {headers: Object.fromEntries(names.map((name) => [name, name === '$ref' ? {schema: {type: 'string'}} : {$ref: './headers.yaml#/Header'}]))}}}}}};
  const result = await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': JSON.stringify(openapi), 'contracts/headers.yaml': 'Header: {schema: {type: string}}'}), full);
  const paths = result.document['paths'] as typeof openapi.paths;
  for (const name of names.filter((name) => name !== '$ref')) expect(paths['/records'].get.responses['200'].headers[name]?.$ref).toStartWith('#/x-madarch-references/');
  expect(paths['/records'].get.responses['200'].headers['$ref']?.schema).toEqual({type: 'string'});
  const asyncapi = {asyncapi: '2.6.0', components: {messages: {Record: {headers: {type: 'object', example: {$ref: 'https://invalid.example/literal'}, properties: {example: {$ref: './models.yaml#/Field'}}}}}}};
  const message = await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': JSON.stringify(asyncapi), 'contracts/models.yaml': 'Field: {type: string}'}), full);
  const components = message.document['components'] as typeof asyncapi.components;
  expect(components.messages.Record.headers.example).toEqual({$ref: 'https://invalid.example/literal'});
  expect(components.messages.Record.headers.properties.example.$ref).toBe('#/x-madarch-references/file0/Field');
});


test('an external schema field fragment preserves the containing media example', async () => {
  const files = {'contracts/service.yaml': 'openapi: 3.0.3\ncomponents: {schemas: {Record: {$ref: "./media.yaml#/schema"}}}', 'contracts/media.yaml': 'schema: {type: string}\nexample: {$ref: "https://invalid.example/literal"}'};
  const result = await contractDocument('contracts/service.yaml', read(files), full);
  const bundled = result.document['x-madarch-references'] as Record<string, {example: {$ref: string}}>;
  expect(bundled['file0']?.example).toEqual({$ref: 'https://invalid.example/literal'});
});


test('shared owning-role transitions handle schema arrays and preserve every literal instance', async () => {
  const entry = 'openapi: 3.0.3\ncomponents: {schemas: {Record: {$ref: "./models.yaml#/allOf/0"}}}';
  const safe = {allOf: [{type: 'string', example: {$ref: 'https://invalid.example/LITERAL'}}]};
  const result = await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': entry, 'contracts/models.yaml': JSON.stringify(safe)}), full);
  expect(JSON.stringify(result.document)).toContain('https://invalid.example/LITERAL');
  const sibling = {allOf: [...safe.allOf, {type: 'object', properties: {example: {$ref: 'https://invalid.example/ACTUAL'}}}]};
  await expect(contractDocument('contracts/service.yaml', read({'contracts/service.yaml': entry, 'contracts/models.yaml': JSON.stringify(sibling)}), full)).rejects.toThrow('remote or absolute reference is not allowed');
  const tuples = {type: 'array', items: [{type: 'string', example: {$ref: 'https://invalid.example/LITERAL'}}], example: {$ref: 'https://invalid.example/ROOT_LITERAL'}};
  await expect(contractDocument('contracts/service.yaml', read({'contracts/service.yaml': entry.replace('/allOf/0', '/items/0'), 'contracts/models.yaml': JSON.stringify(tuples)}), full)).resolves.toHaveProperty('document');
});

test('unmarked Example maps preserve arbitrary member names and opaque values', async () => {
  const names = ['type', 'schema', 'example', '$ref', 'header', 'Record'];
  const examples = Object.fromEntries(names.map((name) => [name, {value: {$ref: `https://invalid.example/${name}`, description: '![literal](image.png)'}}]));
  const entry = 'openapi: 3.0.3\ncomponents: {examples: {Record: {$ref: "./examples.yaml#/Record"}}}';
  const requested: string[] = [];
  const files: Record<string, string> = {'contracts/service.yaml': entry, 'contracts/examples.yaml': JSON.stringify(examples)};
  const result = await contractDocument('contracts/service.yaml', async (path) => {requested.push(path); return files[path];}, full);
  expect(result.descriptions).toEqual([]); expect(requested).toEqual(['contracts/service.yaml', 'contracts/examples.yaml']);
  const bundled = result.document['x-madarch-references'] as Record<string, typeof examples>;
  expect(bundled['file0']).toEqual(examples);
});


test('nested unknown containers preserve Example maps and inspect outside-target siblings', async () => {
  const entry = 'openapi: 3.0.3\ncomponents: {examples: {Record: {$ref: "./examples.yaml#/catalog/Record"}}}';
  const external = {description: '![root](image.png)', catalog: {type: {value: {$ref: 'https://invalid.example/type'}}, Record: {value: {$ref: 'https://invalid.example/Record'}}}, Outside: {description: '![outside](image.png)', $ref: './schema.yaml#/Field'}};
  const files: Record<string, string> = {'contracts/service.yaml': entry, 'contracts/examples.yaml': JSON.stringify(external), 'contracts/schema.yaml': 'Field: {type: string}'};
  const result = await contractDocument('contracts/service.yaml', read(files), full);
  expect(result.descriptions.map((source) => source.text)).toEqual(['![outside](image.png)', '![root](image.png)']);
  const bad = {...external, Outside: {$ref: 'https://invalid.example/actual'}};
  await expect(contractDocument('contracts/service.yaml', read({...files, 'contracts/examples.yaml': JSON.stringify(bad)}), full)).rejects.toThrow('remote or absolute reference is not allowed');
  const bundled = result.document['x-madarch-references'] as Record<string, typeof external>;
  expect(bundled['file0']?.catalog.type.value).toEqual({$ref: 'https://invalid.example/type'});
});


test('typed array elements retain parameter, schema and AsyncAPI message ownership', async () => {
  const literal = {$ref: 'https://example.com/literal'};
  const parameter = {name: 'filter', in: 'query', schema: {type: 'object'}, example: literal, examples: {named: {value: literal}}};
  const openapi = {openapi: '3.0.3', servers: [{url: 'https://example.com'}], tags: [{name: 'records'}], security: [{token: []}], paths: {'/records': {parameters: [parameter], get: {parameters: [parameter], responses: {'200': {description: 'Records'}}}}}, components: {schemas: {Record: {allOf: [{type: 'object', example: literal}], anyOf: [{type: 'object', default: literal}], oneOf: [{type: 'object', enum: [literal]}], prefixItems: [{type: 'object', const: literal}]}}}};
  const result = await contractDocument('contracts/service.yaml', read({'contracts/service.yaml': JSON.stringify(openapi)}), full);
  expect(result.document).toEqual(openapi);
  const asyncapi = {asyncapi: '2.6.0', channels: {records: {publish: {message: {oneOf: [{name: 'Record', headers: {type: 'object', example: literal}, payload: {type: 'object', default: literal}, examples: [{payload: literal, headers: literal}]}]}}}}};
  expect((await contractDocument('contracts/events.yaml', read({'contracts/events.yaml': JSON.stringify(asyncapi)}), full)).document).toEqual(asyncapi);
  const invalid = {...parameter, schema: {$ref: 'https://example.com/actual-schema'}};
  const actual = {openapi: '3.0.3', paths: {'/records': {get: {parameters: [invalid], responses: {}}}}};
  await expect(contractDocument('contracts/service.yaml', read({'contracts/service.yaml': JSON.stringify(actual)}), full)).rejects.toThrow('remote or absolute reference is not allowed');
});
