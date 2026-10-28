import { expect, test } from 'bun:test';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import type { CodeFacts } from '../src/extract/code/facts.js';
import { evaluateLibraryModels } from '../src/extract/library-models/evaluate.js';
import { libraryRegistry } from '../src/extract/library-models/validate.js';
import type { SourceSpan, TreeReader } from '../src/extract/records.js';

const path = 'units/dispatch.ts';
const modelId = 'kafkajs.producer.connect';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function treeOf(source: string, packageName = 'kafkajs'): TreeReader {
  const files: Readonly<Record<string, string>> = {
    'package.json': JSON.stringify({ name: 'boundary-unit', dependencies: { [packageName]: '2.2.4' } }),
    [path]: source,
  };
  return { paths: Object.keys(files).sort(), read(file) {
    const text = files[file];
    if (text === undefined) throw new Error(`${import.meta.path}: missing source ${file}`);
    return encoder.encode(text);
  } };
}

function spanOf(source: string, invocation: string): SourceSpan {
  const start = source.indexOf(invocation);
  if (start < 0 || source.indexOf(invocation, start + 1) >= 0) {
    throw new Error(`${import.meta.path}: expected one invocation ${path}: ${invocation}`);
  }
  return { path, byteStart: encoder.encode(source.slice(0, start)).length,
    byteEnd: encoder.encode(source.slice(0, start + invocation.length)).length,
    lineStart: source.slice(0, start).split('\n').length,
    lineEnd: source.slice(0, start + invocation.length).split('\n').length };
}

function callOf(facts: CodeFacts, source: string, invocation: string) {
  const expected = spanOf(source, invocation);
  const calls = facts.calls.filter(call => call.path === path &&
    call.span.byteStart === expected.byteStart && call.span.byteEnd === expected.byteEnd);
  expect(calls, `${import.meta.path}: ${path}:${expected.lineStart}: ${invocation}`).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error(`${import.meta.path}: missing call ${path}:${expected.lineStart}`);
  expect(call.span).toEqual(expected);
  return call;
}

const declaration = `import { Kafka as Bus } from 'kafkajs';
export async function dispatch() {
  const client = new Bus({clientId: 'unit', brokers: ['localhost:9092']});
  const sender = client.producer();`;

test('an aliased Kafka constructor and local producer prove awaited connect without granting a return role', async () => {
  const source = `${declaration}
  /* π 📨 */ await sender.connect();
  await sender.send({topic: 'notifications', messages: [{value: 'notice'}]});
}`;
  const input = treeOf(source);
  const { facts } = await extractCodeWithFacts(input);
  expect(facts.files.find(file => file.path === path)?.parsed).toBe(true);
  const call = callOf(facts, source, 'sender.connect()');
  const result = evaluateLibraryModels(facts);
  const effects = result.effects.filter(effect => effect.modelId === modelId);
  expect(effects).toHaveLength(1);
  const effect = effects[0]!;
  expect(effect).toMatchObject({ kind: 'message-client', package: 'kafkajs', expression: call.expression,
    span: call.span, holder: `code.symbol:${path}#dispatch`, member: 'connect', arguments: [] });
  expect(decoder.decode(input.read(path).subarray(effect.span.byteStart, effect.span.byteEnd))).toBe('sender.connect()');
  const imported = facts.imports.find(entry => entry.path === path && entry.specifier === 'kafkajs');
  expect(imported).toBeDefined();
  expect(effect.origin.importId).toBe(imported!.id);
  expect(effect.origin.importSpan).toEqual(imported!.span);
  expect(effect.origin.exportedPath).toEqual(['Kafka']);
  const chain = effect.origin.chain;
  expect(chain).toEqual(expect.arrayContaining(['kafkajs.Kafka', 'kafkajs.Kafka.producer', modelId, call.expression]));
  expect(chain.indexOf('kafkajs.Kafka')).toBeLessThan(chain.indexOf('kafkajs.Kafka.producer'));
  expect(chain.indexOf('kafkajs.Kafka.producer')).toBeLessThan(chain.indexOf(modelId));
  expect(effect.returnRole).toBeUndefined();
  expect(libraryRegistry.models.find(model => model.id === modelId)?.returnRole).toBeUndefined();
  expect(result.roles.filter(role => role.expression === call.expression)).toEqual([]);
  expect(result.diagnostics.filter(entry => entry.expression === call.expression)).toEqual([]);
  expect(result.gaps).toEqual([]);
  const send = callOf(facts, source, "sender.send({topic: 'notifications', messages: [{value: 'notice'}]})");
  expect(result.effects.filter(entry => entry.kind === 'message-publish').map(entry => entry.expression)).toEqual([send.expression]);
});

test('a different unmodeled invocation on a proved producer keeps its exact located gap', async () => {
  const source = `${declaration}
  await sender.connect();
  await sender.unmodeledOperation();
}`;
  const { facts } = await extractCodeWithFacts(treeOf(source));
  const call = callOf(facts, source, 'sender.unmodeledOperation()');
  const result = evaluateLibraryModels(facts);
  expect(result.effects.filter(effect => effect.modelId === modelId)).toHaveLength(1);
  expect(result.effects.filter(effect => effect.expression === call.expression)).toEqual([]);
  expect(result.diagnostics.filter(entry => entry.expression === call.expression)).toEqual([{
    code: 'unknown-origin', path, span: call.span, expression: call.expression,
    reason: 'proven origin has no supported invocation model',
  }]);
  expect(result.gaps).toContainEqual({ path,
    reason: `${path}:${call.span.lineStart}: line ${call.span.lineStart}: unknown-origin: proven origin has no supported invocation model` });
});

for (const [label, source, packageName] of [
  ['wrong package', `${declaration.replace("'kafkajs'", "'other-library'")}
  await sender.connect();
}`, 'other-library'],
  ['shadowed constructor', `import { Kafka as Bus } from 'kafkajs';
export async function dispatch(Bus: any) {
  const client = new Bus(); const sender = client.producer(); await sender.connect();
}`, 'kafkajs'],
  ['client instead of producer', `${declaration}
  await client.connect();
}`, 'kafkajs'],
  ['consumer instead of producer', `${declaration}
  const reader = client.consumer({groupId: 'unit'}); await reader.connect();
}`, 'kafkajs'],
  ['nested unrelated receiver', `${declaration}
  const other = {sender: {connect() {}}}; await other.sender.connect();
}`, 'kafkajs'],
  ['shadowed producer binding', `${declaration}
  { const sender = {connect() {}}; await sender.connect(); }
}`, 'kafkajs'],
  ['dynamic member', `${declaration}
  const method = 'connect'; await sender[method]();
}`, 'kafkajs'],
] as const) {
  test(`${label} cannot borrow the exact producer connect effect`, async () => {
    const { facts } = await extractCodeWithFacts(treeOf(source, packageName));
    expect(facts.files.find(file => file.path === path)?.parsed).toBe(true);
    const result = evaluateLibraryModels(facts);
    expect(result.effects.filter(effect => effect.modelId === modelId), `${import.meta.path}: ${path}: ${label}`).toEqual([]);
    expect(result.effects.filter(effect => effect.kind === 'message-publish')).toEqual([]);
    if (label === 'dynamic member') {
      const member = facts.expressions.find(expression => expression.syntaxKind === 'subscript_expression');
      expect(member).toBeDefined();
      expect(result.diagnostics.some(entry => entry.code === 'dynamic-member' && entry.expression === member?.id &&
        entry.path === path && entry.span.lineStart === 5)).toBe(true);
    }
  });
}

test('neither direct nor awaited connect completion can become a publishing producer', async () => {
  const source = `${declaration}
  const completed = await sender.connect();
  await completed.send({topic: 'notifications', messages: []});
  await sender.connect().send({topic: 'notifications', messages: []});
}`;
  const { facts } = await extractCodeWithFacts(treeOf(source));
  const result = evaluateLibraryModels(facts);
  const connect = result.effects.filter(effect => effect.modelId === modelId);
  expect(connect).toHaveLength(2);
  expect(connect.every(effect => effect.kind === 'message-client' && effect.returnRole === undefined)).toBe(true);
  const completed = facts.bindings.find(binding => binding.name === 'completed' && binding.kind === 'local');
  expect(completed?.initializer).toBeDefined();
  expect(result.roles.filter(role => connect.some(effect => effect.expression === role.expression) ||
    role.expression === completed?.initializer)).toEqual([]);
  expect(result.effects.filter(effect => effect.kind === 'message-publish')).toEqual([]);
  // connect has no return role. Its awaited completion is not a producer
  // candidate, so that local use need not carry an unknown-origin diagnostic.
  for (const invocation of [
    "completed.send({topic: 'notifications', messages: []})",
    "sender.connect().send({topic: 'notifications', messages: []})",
  ]) {
    const call = callOf(facts, source, invocation);
    const receiver = facts.expressions.find(expression => expression.id === call.callee)?.receiver;
    expect(receiver).toBeDefined();
    expect(result.roles.filter(role => role.expression === receiver)).toEqual([]);
    expect(result.effects.filter(effect => effect.expression === call.expression)).toEqual([]);
  }
  // The direct chain retains the imported receiver's diagnostic relevance,
  // but connect still supplies no role that could authorize the send.
  const direct = callOf(facts, source, "sender.connect().send({topic: 'notifications', messages: []})");
  expect(result.diagnostics.filter(entry => entry.expression === direct.expression)).toEqual([{
    code: 'unknown-origin', path, span: direct.span, expression: direct.expression,
    reason: 'callee has no proven imported origin or receiver role',
  }]);
});
