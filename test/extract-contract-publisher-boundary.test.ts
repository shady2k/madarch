import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {structuralPublishers} from '../src/extract/contracts/ts-code.js';
import {TreeText} from '../src/extract/operations/source.js';
import type {TreeReader} from '../src/extract/records.js';

const tree = (files: Readonly<Record<string, string>>): TreeReader => ({
  paths: Object.keys(files).sort(),
  read(path) { const text = files[path]; if (text === undefined) throw new Error(`missing fixture ${path}`); return new TextEncoder().encode(text); },
});
const contract = 'asyncapi: 2.6.0\ninfo: {title: Notices, version: 1.0.0}\nchannels:\n  notifications:\n    publish: {message: {name: Notice}}\n';
const main = 'services/dispatch/main.ts';
const adapter = 'services/dispatch/adapter.ts';
const files = {
  'contracts/asyncapi/notices.yaml': contract,
  [main]: `import {NoticePort as Port} from './adapter';
export async function dispatch(bus: Port) {
  await bus.send('notifications', 'record', '{}');
}`,
  [adapter]: `import type {Producer as RemoteProducer} from 'kafkajs';
export class NoticePort {
  constructor(private producer: RemoteProducer) {}
  async send(topic: string, key: string, value: string) {
    await this.producer.send({topic, messages: [{key, value}]});
  }
}`,
};
const publications = (result: Awaited<ReturnType<typeof extractContracts>>) => result.edges.filter(edge => edge.type === 'code.publishes' && !edge.properties.summary);
const diagnostic = (input: TreeReader, shared: Awaited<ReturnType<typeof extractCodeWithFacts>>, result: Awaited<ReturnType<typeof extractContracts>>): string =>
  `${import.meta.path}: publisher proof mismatch\n${JSON.stringify({
    structural: structuralPublishers(new TreeText(input, shared.extraction, shared.facts)),
    library: new TreeText(input, shared.extraction, shared.facts).libraryFacts(),
    facts: shared.facts, code: shared.extraction, contracts: result,
  }, null, 2)}`;

test('a typed imported publisher propagates arguments to the declared channel with canonical evidence', async () => {
  const input = tree(files); const shared = await extractCodeWithFacts(input);
  expect(Object.isFrozen(shared.facts)).toBe(true);
  const result = await extractContracts(input, shared.extraction, shared.facts);
  const published = publications(result).find(edge => edge.from === `code.symbol:${main}#dispatch`);
  expect(published?.to, diagnostic(input, shared, result)).toBe('code.channel:notifications');
  expect(published?.span?.path).toBe(main);
  expect(published?.span?.lineStart).toBe(3);
  const span = published?.span;
  if (span === undefined) throw new Error(`${import.meta.path}:42: no canonical publication span (${main}:3)`);
  expect(new TextDecoder().decode(input.read(main).subarray(span.byteStart, span.byteEnd))).toBe("bus.send('notifications', 'record', '{}')");
  expect(published?.properties.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({path: main, lineStart: 3}),
    expect.objectContaining({path: adapter, lineStart: 5}),
  ]));
  expect(result.nodes.some(node => node.kind === 'code.symbol')).toBe(false);
  // Removing a resolved hop cannot fall back to the same source spelling.
  const hop = shared.facts.sites.find(site => site.path === main && site.use === 'call' && site.to.endsWith('#NoticePort.send'));
  if (hop === undefined) throw new Error(`${import.meta.path}:51: missing shared imported call hop (${main}:3)`);
  const missing = freezeCodeFacts({...shared.facts, sites: shared.facts.sites.filter(site => site !== hop)});
  const incomplete = await extractContracts(input, shared.extraction, missing);
  expect(publications(incomplete).filter(edge => edge.from === `code.symbol:${main}#dispatch`)).toEqual([]);
  expect(incomplete.gaps.some(gap => gap.path === main && gap.reason.includes('line 3:') && gap.reason.includes('no publisher'))).toBe(true);
  expect(shared.facts.sites).toContain(hop);
});

test('an imported same-name local sender is not a publisher and unresolved channel arguments are located', async () => {
  const unrelated = tree({...files, [adapter]: `export class NoticePort {
    async send(topic: string, key: string, value: string) { return [topic, key, value]; }
  }`});
  const unrelatedCode = await extractCodeWithFacts(unrelated);
  const unrelatedResult = await extractContracts(unrelated, unrelatedCode.extraction, unrelatedCode.facts);
  expect(publications(unrelatedResult)).toEqual([]);
  expect(unrelatedResult.gaps.some(gap => gap.path === main && gap.reason.includes('line 3:') && gap.reason.includes('no publisher'))).toBe(true);
  const dynamic = tree({...files, [main]: files[main].replace("dispatch(bus: Port)", 'dispatch(bus: Port, channel: string)').replace("'notifications', 'record'", "channel, 'record'")});
  const dynamicCode = await extractCodeWithFacts(dynamic);
  const dynamicResult = await extractContracts(dynamic, dynamicCode.extraction, dynamicCode.facts);
  expect(publications(dynamicResult)).toEqual([]);
  expect(dynamicResult.gaps.some(gap => gap.path === adapter && gap.reason.includes('line 5:') && gap.reason.includes('topic is unresolved')), diagnostic(dynamic, dynamicCode, dynamicResult)).toBe(true);
});

const goPath = 'services/dispatch/main.go';
const goSource = (shadow: boolean) => `package dispatch
import (
  "context"
  stream "github.com/segmentio/kafka-go"
)
type inertWriter struct{}
func (inertWriter) WriteMessages(context.Context, ...stream.Message) error { return nil }
func Dispatch(w *stream.Writer) {
  {
    ${shadow ? 'w := inertWriter{}' : 'writer := w'}
    ${shadow ? 'w' : 'writer'}.WriteMessages(context.Background(), stream.Message{Topic: "notifications"})
  }
}`;

test('an aliased Go writer preserves the exact local binding and canonical publication site', async () => {
  const input = tree({'go.mod': 'module example.test/notices\n\ngo 1.23\n', 'contracts/asyncapi/notices.yaml': contract, [goPath]: goSource(false)});
  const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
  const published = publications(result);
  expect(published.map(edge => ({from: edge.from, to: edge.to})), diagnostic(input, shared, result)).toEqual([{from: `code.symbol:${goPath}#Dispatch`, to: 'code.channel:notifications'}]);
  expect(published[0]?.span?.lineStart).toBe(11);
  const span = published[0]?.span;
  if (span === undefined) throw new Error(`${import.meta.path}: missing canonical Go invocation (${goPath}:11)`);
  expect(new TextDecoder().decode(input.read(goPath).subarray(span.byteStart, span.byteEnd))).toBe('writer.WriteMessages(context.Background(), stream.Message{Topic: "notifications"})');
  const imported = shared.facts.imports.find(entry => entry.specifier === 'github.com/segmentio/kafka-go');
  if (imported === undefined) throw new Error(`${import.meta.path}:103: no writer import proof (${goPath}:4)`);
  const missing = freezeCodeFacts({...shared.facts, imports: shared.facts.imports.filter(entry => entry.id !== imported.id)});
  expect(publications(await extractContracts(input, shared.extraction, missing))).toEqual([]);
});

test('an inner fake writer shadows the imported writer parameter and never publishes', async () => {
  const input = tree({'go.mod': 'module example.test/notices\n\ngo 1.23\n', 'contracts/asyncapi/notices.yaml': contract, [goPath]: goSource(true)});
  const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
  expect(publications(result)).toEqual([]);
  const call = shared.facts.calls.find(call => call.path === goPath && call.span.lineStart === 11);
  const callee = shared.facts.expressions.find(expression => expression.id === call?.callee);
  const receiver = shared.facts.expressions.find(expression => expression.id === callee?.receiver);
  const binding = shared.facts.bindings.find(binding => binding.id === receiver?.bindingId);
  expect(binding?.kind).toBe('local');
  expect(binding?.span.lineStart).toBe(10);
  expect(result.edges.filter(edge => edge.type === 'code.publishes')).toEqual([]);
});

for (const [label, declaration, invocation, holder] of [
  ['a named imported parameter', `import type {Producer as Wire} from 'kafkajs';
export async function emit(transport: (Wire)) {
  /* π 📨 */ await transport.send({topic: 'notifications', messages: [{value: '通知'}]});
}`, "transport.send({topic: 'notifications', messages: [{value: '通知'}]})", 'emit'],
  ['an exact constructor parameter property', `import type {Producer as Wire} from 'kafkajs';
export class Emitter {
  constructor(private readonly transport: (Wire)) {}
  async emit() { /* π 📨 */ await this.transport.send({topic: 'notifications', messages: [{value: '通知'}]}); }
}`, "this.transport.send({topic: 'notifications', messages: [{value: '通知'}]})", 'Emitter.emit'],
] as const) {
  test(`${label} retains Unicode, imported identity and the full invocation`, async () => {
    const path = 'services/dispatch/emitter.ts';
    const input = tree({'contracts/asyncapi/notices.yaml': contract, [path]: declaration});
    const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
    const published = publications(result);
    expect(published.map(edge => ({from: edge.from, to: edge.to})), diagnostic(input, shared, result)).toEqual([
      {from: `code.symbol:${path}#${holder}`, to: 'code.channel:notifications'},
    ]);
    const span = published[0]?.span;
    if (span === undefined) throw new Error(`${import.meta.path}: missing canonical invocation (${path})\n${diagnostic(input, shared, result)}`);
    expect(new TextDecoder().decode(input.read(path).subarray(span.byteStart, span.byteEnd))).toBe(invocation);
    const imported = shared.facts.imports.find(entry => entry.specifier === 'kafkajs');
    if (imported === undefined) throw new Error(`${import.meta.path}: missing imported producer identity (${path}:1)\n${diagnostic(input, shared, result)}`);
    const missing = freezeCodeFacts({...shared.facts, imports: shared.facts.imports.filter(entry => entry.id !== imported.id)});
    expect(publications(await extractContracts(input, shared.extraction, missing))).toEqual([]);
    // The complete call span is independent of the public invocation prefix.
    const call = shared.facts.calls.find(entry => entry.path === path && entry.span.byteStart === span.byteStart && entry.span.byteEnd === span.byteEnd);
    if (call === undefined) throw new Error(`${import.meta.path}: missing full call proof (${path}:${span.lineStart})\n${diagnostic(input, shared, result)}`);
    const truncated = freezeCodeFacts({...shared.facts, calls: shared.facts.calls.map(entry => entry === call ? {...entry, span: {...entry.span, byteEnd: entry.span.byteEnd - 1}} : entry)});
    expect(publications(await extractContracts(input, shared.extraction, truncated))).toEqual([]);
  });
}

for (const [label, source] of [
  ['a reassigned imported producer parameter', `import type {Producer as Wire} from 'kafkajs';
export async function emit(transport: Wire, replacement: unknown) {
  transport = replacement as Wire;
  await transport.send({topic: 'notifications', messages: []});
}`],
  ['an inner same-name local producer', `import type {Producer as Wire} from 'kafkajs';
export async function emit(transport: Wire) {
  { const transport = {send(value: unknown) { return value; }};
    transport.send({topic: 'notifications', messages: []}); }
}`],
  ['a lexical type shadow', `import type {Producer as Wire} from 'kafkajs';
function container() {
  interface Wire { send(value: unknown): unknown }
  async function emit(transport: Wire) { await transport.send({topic: 'notifications', messages: []}); }
}`],
] as const) {
  test(`${label} never borrows the external producer identity`, async () => {
    const path = 'services/dispatch/emitter.ts';
    const input = tree({'contracts/asyncapi/notices.yaml': contract, [path]: source});
    const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
    expect(publications(result), diagnostic(input, shared, result)).toEqual([]);
  });
}

for (const [label, message, expected] of [
  ['direct key before nested decoys', 'Topic: "notifications", Headers: []queue.Header{{Key: "Topic", Value: []byte("elsewhere")}}, Value: []byte("Topic: elsewhere")', true],
  ['direct key after nested decoys', '/* Topic: "elsewhere" */ Value: []byte("Topic: elsewhere"), Headers: []queue.Header{{Key: "Topic", Value: []byte("elsewhere")}}, Topic: "notifications"', true],
  ['nested keys without a direct key', 'Value: []byte("Topic: notifications"), Headers: []queue.Header{{Key: "Topic", Value: []byte("notifications")}}', false],
  ['unresolved direct key beside literal decoys', 'Topic: channel, Value: []byte("notifications"), Headers: []queue.Header{{Key: "Topic", Value: []byte("notifications")}}', false],
] as const) {
  test(`Go message selectors read only the direct grammar pair: ${label}`, async () => {
    const path = 'services/outbox/publish.go';
    const input = tree({'go.mod': 'module example.test/outbox\n\ngo 1.23\n', 'contracts/asyncapi/notices.yaml': contract,
      [path]: `package outbox
import ("context"; queue "github.com/segmentio/kafka-go")
func Emit(sender *queue.Writer, channel string) {
  /* π 📨 */ sender.WriteMessages(context.Background(), queue.Message{${message}})
}`});
    const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
    expect(publications(result).map(edge => ({from: edge.from, to: edge.to})), diagnostic(input, shared, result)).toEqual(expected ? [
      {from: `code.symbol:${path}#Emit`, to: 'code.channel:notifications'},
    ] : []);
    if (expected) {
      const span = publications(result)[0]?.span;
      if (span === undefined) throw new Error(`${import.meta.path}: missing complete Go publication (${path}:4)`);
      expect(new TextDecoder().decode(input.read(path).subarray(span.byteStart, span.byteEnd))).toBe(`sender.WriteMessages(context.Background(), queue.Message{${message}})`);
      expect(result.gaps).toEqual([]);
    } else {
      expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('line 4:') && gap.reason.includes('topic is unresolved'))).toBe(true);
    }
  });
}

test('Go direct keyed selectors fail closed when operand, identity or complete call proof is missing', async () => {
  const input = tree({'go.mod': 'module example.test/notices\n\ngo 1.23\n', 'contracts/asyncapi/notices.yaml': contract, [goPath]: goSource(false)});
  const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
  expect(publications(result), diagnostic(input, shared, result)).toHaveLength(1);
  const pairs = shared.facts.expressions.filter(entry => entry.path === goPath && entry.syntaxKind === 'keyed_element');
  const pair = pairs.length === 1 ? pairs[0] : undefined;
  const operands = pair?.children.map(id => shared.facts.expressions.find(entry => entry.id === id));
  const call = shared.facts.calls.find(entry => entry.path === goPath && entry.span.lineStart === 11 && !entry.construct && entry.arguments.length === 2);
  if (pair === undefined || operands?.length !== 2 || operands.some(entry => entry?.syntaxKind !== 'literal_element') || call === undefined) {
    throw new Error(`${import.meta.path}: missing direct grammar/call proof (${goPath}:11)\n${diagnostic(input, shared, result)}`);
  }
  for (const id of [pair.id, ...operands.flatMap(entry => entry === undefined ? [] : [entry.id, ...entry.children])]) {
    const missing = freezeCodeFacts({...shared.facts, expressions: shared.facts.expressions.filter(entry => entry.id !== id)});
    expect(publications(await extractContracts(input, shared.extraction, missing)), `${import.meta.path}: missing ${id} must not publish`).toEqual([]);
  }
  const ambiguous = freezeCodeFacts({...shared.facts, expressions: [...shared.facts.expressions, pair]});
  expect(publications(await extractContracts(input, shared.extraction, ambiguous))).toEqual([]);
  const reversed = freezeCodeFacts({...shared.facts, expressions: shared.facts.expressions.map(entry => entry === pair ? {...entry, children: [...entry.children].reverse()} : entry)});
  expect(publications(await extractContracts(input, shared.extraction, reversed))).toEqual([]);
  const partialNamed = freezeCodeFacts({...shared.facts, expressions: shared.facts.expressions.map(entry => entry === pair ? {...entry, fields: {key: [entry.children[0]!]}} : entry)});
  expect(publications(await extractContracts(input, shared.extraction, partialNamed))).toEqual([]);
  const truncated = freezeCodeFacts({...shared.facts, calls: shared.facts.calls.map(entry => entry === call ? {...entry, span: {...entry.span, byteEnd: entry.span.byteEnd - 1}} : entry)});
  expect(publications(await extractContracts(input, shared.extraction, truncated))).toEqual([]);
});

test('Go short declaration reuse invalidates the original writer identity', async () => {
  const input = tree({'go.mod': 'module example.test/notices\n\ngo 1.23\n', 'contracts/asyncapi/notices.yaml': contract,
    [goPath]: `package dispatch
import (
  "context"
  stream "github.com/segmentio/kafka-go"
)
func Dispatch(w *stream.Writer, replacement *stream.Writer) {
  w, marker := replacement, 1
  _ = marker
  w.WriteMessages(context.Background(), stream.Message{Topic: "notifications"})
}`});
  const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
  expect(publications(result), diagnostic(input, shared, result)).toEqual([]);
});

test('an implicit Go package name comes from documented package identity and explicit aliases still win', async () => {
  const source = goSource(false).replace('stream "github.com/segmentio/kafka-go"', '"github.com/segmentio/kafka-go"').replaceAll('stream.', 'kafka.');
  const input = tree({'go.mod': 'module example.test/notices\n\ngo 1.23\n', 'contracts/asyncapi/notices.yaml': contract, [goPath]: source});
  const shared = await extractCodeWithFacts(input);
  const result = await extractContracts(input, shared.extraction, shared.facts);
  expect(shared.facts.imports.find(entry => entry.specifier === 'github.com/segmentio/kafka-go')?.local).toBe('kafka');
  expect(publications(result).map(edge => edge.to), diagnostic(input, shared, result)).toEqual(['code.channel:notifications']);
  const wrong = tree({'go.mod': 'module example.test/notices\n\ngo 1.23\n', 'contracts/asyncapi/notices.yaml': contract, [goPath]: source.replace('kafka.Writer', 'other.Writer')});
  const wrongCode = await extractCodeWithFacts(wrong);
  expect(publications(await extractContracts(wrong, wrongCode.extraction, wrongCode.facts))).toEqual([]);
});


test('publisher ownership stops at the resolved sender method, not its transitive callers', async () => {
  const caller = 'services/dispatch/workflow.ts';
  const input = tree({...files,
    [main]: `${files[main]}
export function relay(bus: Port) { return dispatch(bus); }
export class Workflow {
  run(bus: Port) { return relay(bus); }
}`,
    [caller]: `import {dispatch, Workflow} from './main';
import {NoticePort} from './adapter';
export function start(bus: NoticePort) { return dispatch(bus); }
export function advance(flow: Workflow, bus: NoticePort) { return flow.run(bus); }`,
  });
  const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
  expect(publications(result).map(edge => ({from: edge.from, to: edge.to})), diagnostic(input, shared, result)).toEqual([
    {from: `code.symbol:${main}#dispatch`, to: 'code.channel:notifications'},
  ]);
  expect(result.edges.filter(edge => edge.type === 'code.publishes').map(edge => edge.from)).toEqual([
    `code.file:${main}`, `code.symbol:${main}#dispatch`,
  ]);
  expect(shared.extraction.edges.some(edge => edge.type === 'code.calls' && edge.from === `code.symbol:${caller}#start` && edge.to === `code.symbol:${main}#dispatch`)).toBe(true);
  expect(publications(result)[0]?.properties.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({path: main, lineStart: 3}),
    expect.objectContaining({path: adapter, lineStart: 5}),
  ]));
});

test('a local any shadow keeps a located producer candidate without claiming a publication', async () => {
  const path = 'services/dispatch/emitter.ts';
  const input = tree({'contracts/asyncapi/notices.yaml': contract,
    [path]: `import type {Producer as Wire} from 'kafkajs';
export function emit(transport: Wire) {
  { const transport: any = {};
    transport.send({topic: 'notifications', messages: []}); }
}`});
  const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
  expect(result.edges.filter(edge => edge.type === 'code.publishes'), diagnostic(input, shared, result)).toEqual([]);
  expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('line 4: send names channel notifications') && gap.reason.includes('shadows a proved producer binding') && gap.reason.includes('no publisher')), diagnostic(input, shared, result)).toBe(true);
  const imported = shared.facts.imports.find(entry => entry.specifier === 'kafkajs');
  if (imported === undefined) throw new Error(`${import.meta.path}: missing outer producer import (${path}:1)\n${diagnostic(input, shared, result)}`);
  const missing = freezeCodeFacts({...shared.facts, imports: shared.facts.imports.filter(entry => entry.id !== imported.id)});
  const incomplete = await extractContracts(input, shared.extraction, missing);
  expect(incomplete.edges.filter(edge => edge.type === 'code.publishes')).toEqual([]);
  expect(incomplete.gaps.filter(gap => gap.reason.includes('shadows a proved producer binding'))).toEqual([]);
});

for (const [label, declaration] of [
  ['an untyped response with a matching method', `export function emit(response: any) {
  response.send({topic: 'notifications', messages: []});
}`],
  ['an untyped outer binding with a typed producer elsewhere', `import type {Producer as Wire} from 'kafkajs';
function unrelated(transport: Wire) {}
export function emit(transport: any) {
  { const transport: any = {}; transport.send({topic: 'notifications', messages: []}); }
}`],
  ['a nearer untyped binding between the producer and local shadow', `import type {Producer as Wire} from 'kafkajs';
export function emit(transport: Wire) {
  function inner(transport: any) {
    { const transport: any = {}; transport.send({topic: 'notifications', messages: []}); }
  }
}`],
] as const) {
  test(`${label} cannot borrow a producer candidate diagnostic`, async () => {
    const path = 'services/dispatch/emitter.ts';
    const input = tree({'contracts/asyncapi/notices.yaml': contract, [path]: declaration});
    const shared = await extractCodeWithFacts(input); const result = await extractContracts(input, shared.extraction, shared.facts);
    expect(result.edges.filter(edge => edge.type === 'code.publishes'), diagnostic(input, shared, result)).toEqual([]);
    expect(result.gaps.filter(gap => gap.reason.includes('receiver') || gap.reason.includes('producer binding')), diagnostic(input, shared, result)).toEqual([]);
  });
}


for (const [label, declarations, options, expected] of [
  ['unknown spread overwrites an earlier topic', '', "{topic: 'notifications', messages: [], ...overrides}", undefined],
  ['explicit topic restores an unknown spread', '', "{...overrides, messages: [], topic: 'notifications'}", 'notifications'],
  ['known spread overwrites an earlier topic', "const known = {topic: 'other'};", "{topic: 'notifications', messages: [], ...known}", 'other'],
  ['known unrelated spread preserves an earlier topic', 'const known = {messages: []};', "{topic: 'notifications', ...known}", 'notifications'],
  ['nested known spreads retain their final topic', "const base = {topic: 'other'}; const known = {...base, topic: 'notifications'};", '{messages: [], ...known}', 'notifications'],
  ['nested unknown spread invalidates an earlier topic', "const known = {topic: 'notifications', ...overrides};", '{messages: [], ...known}', undefined],
  ['nested explicit topic restores an unknown spread', "const known = {...overrides, topic: 'notifications'};", '{messages: [], ...known}', 'notifications'],
  ['unknown spread overwrites a known spread', "const known = {topic: 'notifications'};", '{messages: [], ...known, ...overrides}', undefined],
  ['later known spread restores an unknown spread', "const known = {topic: 'notifications'};", '{messages: [], ...overrides, ...known}', 'notifications'],
  ['explicit duplicate keys use the final value', '', "{topic: 'other', messages: [], topic: 'notifications'}", 'notifications'],
  ['shorthand topic restores an unknown spread', "const topic = 'notifications';", '{messages: [], ...overrides, topic}', 'notifications'],
  ['known spread retains required messages presence after an unknown overwrite', 'const known = {messages: [], ...overrides};', "{...known, topic: 'notifications'}", 'notifications'],
  ['unresolved computed key cannot delete required messages', '', "{messages: [], [dynamicKey]: 'other', topic: 'notifications'}", 'notifications'],
  ['required messages presence does not claim a payload type', '', "{messages: undefined, topic: 'notifications'}", 'notifications'],
  ['unknown spread cannot prove otherwise absent required messages', '', "{...overrides, topic: 'notifications'}", undefined],
  ['literal topic cannot replace an absent required messages selector', '', "{topic: 'notifications'}", undefined],
  ['spread shorthand retains its lexical initializer', "const topic = 'notifications'; const known = {topic};", '{messages: [], ...known}', 'notifications'],
  ['unresolved computed key can overwrite the topic', '', "{topic: 'notifications', messages: [], [dynamicKey]: 'other'}", undefined],
  ['known unrelated computed key preserves the topic', '', "{topic: 'notifications', ['messages']: []}", 'notifications'],
  ['explicit topic restores an unresolved computed key', '', "{[dynamicKey]: 'other', messages: [], topic: 'notifications'}", 'notifications'],
  ['method property overwrites the topic', '', "{topic: 'notifications', messages: [], topic() { return 'other'; }}", undefined],
  ['nested decoy topic cannot supply a direct topic', "const known = {messages: [{topic: 'notifications'}]};", '{...known}', undefined],
  ['cyclic spread cannot supply a topic', 'const known = {...known};', '{messages: [], ...known}', undefined],
] as const) {
  test(`TypeScript publisher object properties are evaluated in order: ${label}`, async () => {
    const path = 'services/dispatch/ordered.ts';
    const invocation = `transport.send(${options})`;
    const input = tree({'contracts/asyncapi/notices.yaml': `${contract}  other:\n    publish: {message: {name: Other}}\n`,
      [path]: `import type {Producer} from 'kafkajs';
export async function emit(transport: Producer, overrides: {topic: string}, dynamicKey: string) {
  ${declarations}
  /* π 📨 */ await ${invocation};
}`});
    const shared = await extractCodeWithFacts(input);
    const result = await extractContracts(input, shared.extraction, shared.facts);
    const structural = structuralPublishers(new TreeText(input, shared.extraction, shared.facts));
    expect(publications(result).map(edge => ({from: edge.from, to: edge.to})), diagnostic(input, shared, result)).toEqual(expected === undefined ? [] : [
      {from: `code.symbol:${path}#emit`, to: `code.channel:${expected}`},
    ]);
    // An unresolved selector still retains the entire raw call, not a prefix
    // or a silently smaller positive claim from a surviving earlier property.
    expect(structural.sites, diagnostic(input, shared, result)).toHaveLength(1);
    const site = structural.sites[0];
    if (site === undefined) throw new Error(`${import.meta.path}: missing full publisher candidate (${path}:4)`);
    expect(site.channel).toBe(expected);
    expect(site.span.path).toBe(path);
    expect(site.span.lineStart).toBe(4);
    expect(new TextDecoder().decode(input.read(path).subarray(site.span.byteStart, site.span.byteEnd))).toBe(invocation);
    expect(site.evidence).toEqual([site.span]);
    if (expected === undefined) {
      expect(result.edges.filter(edge => edge.type === 'code.publishes')).toEqual([]);
      expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('line 4:') && gap.reason.includes('topic is unresolved') && gap.reason.includes(`(${path})`)), diagnostic(input, shared, result)).toBe(true);
    } else {
      expect(publications(result)[0]?.span).toEqual(site.span);
      expect(result.gaps, diagnostic(input, shared, result)).toEqual([]);
    }
  });
}

test('ordered publisher spread selection fails closed for missing, duplicate or reordered AST facts', async () => {
  const path = 'services/dispatch/ordered.ts';
  const input = tree({'contracts/asyncapi/notices.yaml': contract,
    [path]: `import type {Producer} from 'kafkajs';
export async function emit(transport: Producer) {
  const known = {topic: 'notifications'};
  /* π 📨 */ await transport.send({messages: [], ...known});
}`});
  const shared = await extractCodeWithFacts(input);
  expect(publications(await extractContracts(input, shared.extraction, shared.facts))).toHaveLength(1);
  const call = shared.facts.calls.find(entry => entry.path === path && entry.span.lineStart === 4);
  const options = shared.facts.expressions.find(entry => entry.id === call?.arguments[0]);
  const spread = shared.facts.expressions.find(entry => options?.children.includes(entry.id) && entry.syntaxKind === 'spread_element');
  const declaration = shared.facts.bindings.find(entry => entry.path === path && entry.name === 'known');
  const known = shared.facts.expressions.find(entry => entry.id === declaration?.initializer);
  if (call === undefined || options?.syntaxKind !== 'object' || spread === undefined || known?.syntaxKind !== 'object') {
    throw new Error(`${import.meta.path}: missing ordered object/spread proof (${path}:4)`);
  }
  for (const id of [spread.id, ...spread.children, known.id, ...known.children]) {
    const missing = freezeCodeFacts({...shared.facts, expressions: shared.facts.expressions.filter(entry => entry.id !== id)});
    const result = await extractContracts(input, shared.extraction, missing);
    expect(result.edges.filter(edge => edge.type === 'code.publishes'), `${import.meta.path}: missing ${id} must not publish (${path}:4)`).toEqual([]);
    expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('line 4:') && gap.reason.includes('topic is unresolved'))).toBe(true);
  }
  const duplicate = freezeCodeFacts({...shared.facts, expressions: [...shared.facts.expressions, spread]});
  const reversed = freezeCodeFacts({...shared.facts, expressions: shared.facts.expressions.map(entry => entry === options ? {...entry, children: [...entry.children].reverse()} : entry)});
  for (const facts of [duplicate, reversed]) {
    const result = await extractContracts(input, shared.extraction, facts);
    expect(result.edges.filter(edge => edge.type === 'code.publishes')).toEqual([]);
    expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('line 4:') && gap.reason.includes('topic is unresolved'))).toBe(true);
  }
  expect(Object.isFrozen(shared.facts)).toBe(true);
});
