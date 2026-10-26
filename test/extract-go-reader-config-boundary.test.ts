import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {structuralGoReaders} from '../src/extract/contracts/go-code.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {TreeText} from '../src/extract/operations/source.js';
import type {TreeReader} from '../src/extract/records.js';

const path = 'services/dispatch/consumer.go';
function tree(source: string): TreeReader {
  const files: Record<string, string> = {
    'go.mod': 'module example.test/dispatch\n\ngo 1.23\n',
    'contracts/asyncapi/events.yaml': 'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n  events:\n    subscribe: {message: {name: Event}}\n  elsewhere:\n    subscribe: {message: {name: Other}}\n',
    [path]: source,
  };
  return {paths: Object.keys(files).sort(), read(name) {
    const value = files[name]; if (value === undefined) throw new Error(`missing fixture ${name}`);
    return new TextEncoder().encode(value);
  }};
}
const header = 'package dispatch\nimport stream "github.com/segmentio/kafka-go"\n';
const run = async (source: string) => {
  const input = tree(source); const shared = await extractCodeWithFacts(input);
  const text = new TreeText(input, shared.extraction, shared.facts);
  return {input, shared, text, sites: structuralGoReaders(text, path)};
};
const consumed = (result: Awaited<ReturnType<typeof extractContracts>>) => result.edges.filter(edge => edge.type === 'code.consumes');

test('ReaderConfig takes the AST Topic field, never an earlier commented field', async () => {
  const source = header + 'func Configure() { _ = stream.ReaderConfig{/* Topic: "events", GroupID: "fake" */ Topic: "elsewhere", GroupID: "workers"} }';
  const value = await run(source);
  expect(value.sites.map(site => [site.channel, site.group])).toEqual([['elsewhere', 'workers']]);
  const span = value.sites[0]!.span;
  expect(new TextDecoder().decode(value.input.read(path).slice(span.byteStart, span.byteEnd))).toBe('stream.ReaderConfig{/* Topic: "events", GroupID: "fake" */ Topic: "elsewhere", GroupID: "workers"}');
  const result = await extractContracts(value.input, value.shared.extraction, value.shared.facts);
  expect(consumed(result).map(edge => edge.to)).toEqual(['code.channel:elsewhere']);
  const commentsOnly = await run(header + 'func Configure() { /* stream.ReaderConfig{Topic: "events"} */ }');
  expect(commentsOnly.sites).toEqual([]);
});

test('canonical Kafka import aliases and exact local topic bindings resolve decoded literals', async () => {
  for (const expression of ['"events"', '`events`', 'selected', 'alias']) {
    const source = header + `const selected = "elsewhere"
func Configure() { selected := "events"; alias := selected; _ = alias; _ = stream.ReaderConfig{Topic: ${expression}, GroupID: "workers"} }`;
    const value = await run(source);
    expect(value.sites.map(site => site.channel), source).toEqual(['events']);
    const result = await extractContracts(value.input, value.shared.extraction, value.shared.facts);
    expect(consumed(result).map(edge => edge.to), source).toEqual(['code.channel:events']);
  }
});

test('local packages, local ReaderConfig types, and shadowed import receivers cannot prove Kafka configuration', async () => {
  for (const source of [
    'package dispatch\nimport stream "example.test/local"\nfunc Configure() { _ = stream.ReaderConfig{Topic: "events"} }',
    'package dispatch\ntype ReaderConfig struct { Topic string }\nfunc Configure() { _ = ReaderConfig{Topic: "events"} }',
    header + 'func Configure(stream interface{}) { _ = stream.ReaderConfig{Topic: "events"} }',
    header + 'func Configure() { type stream struct{}; _ = stream.ReaderConfig{Topic: "events"} }',
    header + 'type ReaderConfig = stream.ReaderConfig\nfunc Configure() { _ = ReaderConfig{Topic: "events"} }',
  ]) {
    const value = await run(source);
    expect(value.sites, source).toEqual([]);
    expect(consumed(await extractContracts(value.input, value.shared.extraction, value.shared.facts)), source).toEqual([]);
  }
});

test('an unknown or overwritten topic has a located gap and cannot use a same-spelling service constant', async () => {
  for (const statement of ['func Configure(selected string) { _ = stream.ReaderConfig{Topic: selected} }',
    'func Configure() { selected := "events"; selected = actualTopic; _ = stream.ReaderConfig{Topic: selected} }',
    'func Configure() { _ = stream.ReaderConfig{/* Topic: "events" */} }']) {
    const source = header + 'const selected = "events"\n' + statement;
    const value = await run(source);
    expect(value.sites, source).toEqual([]);
    expect([...value.text.factGaps.values()].some(gap => gap.path === path && gap.reason.includes('line 4:') && gap.reason.includes('topic is unresolved') && gap.reason.includes(path)), source).toBe(true);
    const result = await extractContracts(value.input, value.shared.extraction, value.shared.facts);
    expect(consumed(result), source).toEqual([]);
    expect(result.gaps.some(gap => gap.path === path && gap.reason.includes('topic is unresolved')), source).toBe(true);
  }
});

test('missing and partial shared facts never trigger a replacement parser or name fallback', async () => {
  const value = await run(header + 'func Configure() { _ = stream.ReaderConfig{Topic: "events"} }');
  const missing = new TreeText(value.input);
  expect(structuralGoReaders(missing, path)).toEqual([]);
  expect([...missing.factGaps.values()].some(gap => gap.path === path && gap.reason.includes('line 1:') && gap.reason.includes('requires shared parsed code facts'))).toBe(true);
  const imported = value.shared.facts.bindings.find(binding => binding.kind === 'import')!;
  for (const facts of [
    freezeCodeFacts({...value.shared.facts, bindings: value.shared.facts.bindings.filter(binding => binding.id !== imported.id)}),
    freezeCodeFacts({...value.shared.facts, imports: []}),
    freezeCodeFacts({...value.shared.facts, bindings: [...value.shared.facts.bindings, imported]}),
  ]) expect(structuralGoReaders(new TreeText(value.input, value.shared.extraction, facts), path)).toEqual([]);
});

const readerSource = header + `
import "context"
type Consumer struct { reader *stream.Reader }
type Other struct { reader *stream.Reader }
func New() *Consumer {
 config := stream.ReaderConfig{Topic: "events"}
 reader := stream.NewReader(config)
 return &Consumer{reader: reader}
}
func (c *Consumer) Run(ctx context.Context) { c.reader.FetchMessage(ctx) }
func (c *Other) Run(ctx context.Context) { c.reader.ReadMessage(ctx) }
`;

test('consumer method association uses the exact declared Reader field, not another same-named field', async () => {
  const value = await run(readerSource);
  expect(value.sites).toHaveLength(1);
  const reads = value.sites[0]!.reads ?? [];
  expect(reads.map(span => new TextDecoder().decode(value.input.read(path).slice(span.byteStart, span.byteEnd)))).toEqual(['c.reader.FetchMessage(ctx)']);
  const result = await extractContracts(value.input, value.shared.extraction, value.shared.facts);
  expect(consumed(result).filter(edge => edge.from.startsWith('code.symbol:')).map(edge => edge.from)).toEqual([`code.symbol:${path}#Consumer.Run`]);
});

test('an unproved consumer association keeps configuration intent and a located gap', async () => {
  const value = await run(header + 'func Configure() { _ = stream.ReaderConfig{Topic: "events"} }');
  expect(value.sites[0]?.reads).toEqual([]);
  expect([...value.text.factGaps.values()].some(gap => gap.path === path && gap.reason.includes('line 3:') && gap.reason.includes('consuming function association is unresolved'))).toBe(true);
  const result = await extractContracts(value.input, value.shared.extraction, value.shared.facts);
  expect(consumed(result).map(edge => [edge.from, edge.properties.configured])).toEqual([[`code.file:${path}`, true]]);
});
