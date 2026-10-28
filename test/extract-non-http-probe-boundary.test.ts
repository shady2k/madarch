import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {extractOperations} from './extract-code-facts-fixture.js';
import {endpointRelations} from '../src/extract/driver/relationships.js';
import {endpointTarget, resolveEndpointTarget} from '../src/extract/endpoint-target.js';
import {shellCommandModels, shellCommandModelDigest, validateShellCommandModels} from '../src/extract/library-models/shell-command-models.js';
import type {ExtractedNode, Extraction, PropertyValue, TreeReader} from '../src/extract/records.js';

const path = 'compose.yaml';
const service = 'worker';
const url = 'http://localhost:8080/healthz';
const tree = (test: string | readonly string[]): TreeReader => {
 const source = `services:
  ${service}:
    image: example:1
    healthcheck:
      test: ${JSON.stringify(test)}
`;
 return {paths: [path], read: (file) => {
  if (file !== path) throw new Error(`missing fixture ${file}`);
  return new TextEncoder().encode(source);
 }};
};
const probe = (test: PropertyValue): ExtractedNode => ({key: 'code.healthcheck:worker', kind: 'code.healthcheck', label: 'Readiness',
 properties: {service, test}, span: {path, byteStart: 0, byteEnd: 1, lineStart: 4, lineEnd: 5}});
const route: ExtractedNode = {key: 'code.route:worker', kind: 'code.route', label: 'GET /healthz', properties: {service, path: '/healthz', method: 'GET', ports: ['8080']}};
const routes: Extraction = {producer: 'code.extract.contracts', nodes: [route], edges: [], gaps: []};

test('literal readiness commands retain configuration without either HTTP-target gap or an HTTP edge', async () => {
 for (const command of [
  ['CMD-SHELL', 'pg_isready -U sample'],
  ['CMD', 'pg_isready', '-U', 'another_user'],
  // CMD argv is literal; the shell expansion control below must stay unresolved.
  ['CMD', 'pg_isready', '-U', '$USER'],
  ['CMD', 'pg_isready', '-U', 'sample; echo ignored'],
  ['CMD-SHELL', 'pg_isready --username="sample user"'],
  ['CMD', '/usr/bin/pg_isready', '--username=sample'],
  'pg_isready -Usample',
 ] as const) {
  const operations = await extractOperations(tree(command));
  const health = operations.nodes.find(node => node.kind === 'code.healthcheck');
  expect(health, JSON.stringify(command)).toBeDefined();
  if (health === undefined) throw new Error('missing extracted healthcheck');
  expect(health.properties.test).toEqual(command);
  expect(health.span?.path).toBe(path);
  expect(health.span?.lineStart).toBe(4);
  expect(resolveEndpointTarget(health)).toEqual({kind: 'non-http', modelId: 'postgresql.pg_isready'});
  expect(endpointTarget(health)).toBeUndefined();
  const configured = operations.edges.filter(edge => edge.type === 'code.configured-by' && edge.to === health.key);
  expect(configured).toHaveLength(1);
  expect(configured[0]?.from).toBe(`code.compose-service:${path}#${service}`);
  expect(configured[0]?.span).toEqual(health.span);
  expect(operations.edges.filter(edge => edge.type === 'code.probes')).toEqual([]);
  expect(operations.gaps.filter(gap => gap.path === path)).toEqual([]);
  const joined = endpointRelations([operations, routes])[0]!;
  expect(joined.nodes).toEqual(operations.nodes);
  expect(joined.edges).toEqual(operations.edges);
  expect(joined.gaps).toEqual(operations.gaps);
 }
}, 20_000);

test('unknown, malformed, wrapped and nonliteral commands keep both located HTTP-target gaps', async () => {
 const commands: readonly (string | readonly string[])[] = [
  ['CMD-SHELL', 'pg_isready --unknown'],
  ['CMD', 'pg_isready', '-U'],
  ['CMD', 'pg_isready', '-U', ''],
  ['CMD', 'pg_isready', '--username='],
  ['CMD', 'pg_isready', '-U', '--unknown'],
  ['CMD', 'pg_isready', '-U', 'sample', 'extra'],
  ['CMD', 'pg_isready', '--', '-U', 'sample'],
  ['CMD-SHELL', 'unknown-command -U sample'],
  ['CMD-SHELL', `echo curl ${url}`],
  ['CMD-SHELL', 'env pg_isready -U sample'],
  ['CMD', 'sh', '-c', 'pg_isready -U sample'],
  ['CMD-SHELL', 'pg_isready -U sample && echo ready'],
  ['CMD-SHELL', 'pg_isready -U sample | cat'],
  ['CMD-SHELL', 'pg_isready -U "$(echo sample)"'],
  ['CMD-SHELL', 'pg_isready -U "$USER"'],
  ['CMD-SHELL', "pg_isready -U 'sample"],
  ['CMD-SHELL', 'pg_isready -U sample > ready'],
  ['CMD-SHELL', 'pg_isready -U sample &'],
  ['CMD-SHELL', `curl -X "$METHOD" ${url}`],
  ['CMD', 'curl', '--unknown', url],
  ['CMD-SHELL', 'pg_isready -U sample', 'ignored'],
 ];
 for (const command of commands) {
  const operations = await extractOperations(tree(command));
  const health = operations.nodes.find(node => node.kind === 'code.healthcheck');
  expect(health, JSON.stringify(command)).toBeDefined();
  if (health === undefined) throw new Error('missing extracted healthcheck');
  expect(resolveEndpointTarget(health), JSON.stringify(command)).toEqual({kind: 'unresolved'});
  expect(operations.edges.some(edge => edge.type === 'code.configured-by' && edge.to === health.key)).toBe(true);
  expect(operations.edges.filter(edge => edge.type === 'code.probes')).toEqual([]);
  const operationsGap = {path, reason: `line 4: probe target authority or method is unresolved (${health.key})`};
  expect(operations.gaps).toContainEqual(operationsGap);
  const joined = endpointRelations([operations, routes])[0]!;
  expect(joined.edges.filter(edge => edge.type === 'code.probes')).toEqual([]);
  expect(joined.gaps).toContainEqual(operationsGap);
  expect(joined.gaps).toContainEqual({path, reason: `line 4: healthcheck command target is unresolved (${health.key})`});
 }
}, 20_000);

test('three-way resolution leaves curl methods, authority and listener ports intact', () => {
 for (const [args, method] of [
  [['CMD', 'curl', url], 'GET'],
  [['CMD', 'curl', '-X', 'post', url], 'post'],
  [['CMD-SHELL', `curl -I ${url}`], 'HEAD'],
 ] as const) {
  const node = probe(args);
  const target = {service, path: '/healthz', method, port: '8080'};
  expect(resolveEndpointTarget(node)).toEqual({kind: 'http', target});
  expect(endpointTarget(node)).toEqual(target);
  const extraction: Extraction = {producer: 'code.extract.operations', nodes: [node], edges: [], gaps: []};
  const matching = {...routes, nodes: [{...route, properties: {...route.properties, method}}]};
  expect(endpointRelations([extraction, matching])[0]?.edges.map(edge => edge.to)).toEqual([route.key]);
  const wrongPort = {...matching, nodes: [{...route, properties: {...route.properties, method, ports: ['9090']}}]};
  expect(endpointRelations([extraction, wrongPort])[0]?.edges).toEqual([]);
 }
 for (const command of [
  ['CMD', 'curl', 'http://outside.example:8080/healthz'],
  ['CMD', 'curl', 'https://user:secret@localhost:8080/healthz'],
  ['CMD', 'curl', 'ftp://localhost:8080/healthz'],
  ['CMD', 'curl', url, url],
  ['CMD'],
  [],
  null,
 ]) expect(resolveEndpointTarget(probe(command))).toEqual({kind: 'unresolved'});
});

test('non-HTTP command data is closed, frozen, disjoint and included in the interpretation digest', () => {
 const model = shellCommandModels.find(entry => entry.kind === 'non-http');
 if (model === undefined) throw new Error('missing non-HTTP command model');
 const registry = (entry: unknown) => ({schemaVersion: 1, models: [entry]});
 const option = model.options[0]!;
 expect(model).not.toHaveProperty('defaultMethod');
 for (const value of [model, model.executables, model.options, option, option.names]) expect(Object.isFrozen(value)).toBe(true);
 for (const entry of [
  {...model, kind: undefined},
  {...model, kind: 'unknown'},
  {...model, defaultMethod: 'GET'},
  {...model, positional: true},
  {...model, options: [{...option, effect: 'method'}]},
  {...model, options: [{...option, effect: 'url'}]},
  {...model, options: [{...option, effect: 'fixed-method', method: 'HEAD', priority: 1}]},
  {...model, options: [{...option, method: 'GET'}]},
  {...model, options: [{...option, priority: 1}]},
  {...model, options: [{...option, argument: 'optional'}]},
  {...model, options: [{...option, execute: true}]},
  {...model, options: [option, option]},
 ]) expect(() => validateShellCommandModels(registry(entry))).toThrow();
 expect(() => validateShellCommandModels({schemaVersion: 1, models: [model, {...model, id: 'another-command'}]})).toThrow('duplicate');
 expect(() => validateShellCommandModels({schemaVersion: 1, models: [model, {...model, executables: ['another-command']}]})).toThrow('duplicate');
 const digest = (models: unknown) => createHash('sha256').update(JSON.stringify(validateShellCommandModels({schemaVersion: 1, models}))).digest('hex');
 expect(digest(shellCommandModels)).toBe(shellCommandModelDigest);
 const changed = shellCommandModels.map(entry => entry.kind === 'non-http' ? {...entry, options: [{...option, names: [...option.names, '--another-username']}]} : entry);
 expect(digest(changed)).not.toBe(shellCommandModelDigest);
});
