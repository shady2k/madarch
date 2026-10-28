import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {readGoFile, resolveGoStarts, structuralGoReaders} from '../src/extract/contracts/go-code.js';
import {readSyntaxTree} from '../src/fill/stages/syntax-extract.js';
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

// ---- the consumer read and its commit, from grammar nodes and library data ----

const readFactsOf = async (source: string) => {
  const read = await readSyntaxTree(path, new TextEncoder().encode(source), (file) => readGoFile(path, file.root));
  if (!read.read) throw new Error('the fixture did not parse');
  return read.value;
};
const readsOf = async (source: string) => (await readFactsOf(source)).kafkaReads.map(read => [read.owner, read.field]);
const consumerBody = (fieldType: string, statement: string): string =>
  `${header}type Consumer struct { reader ${fieldType} }\nfunc (c *Consumer) Run() { ${statement} }\n`;

test('a consumer read is proved from grammar nodes and the namespace the file imports', async () => {
  // The same call written with spaces around its dots is the same tree, so the same read.
  for (const statement of ['c.reader.FetchMessage(ctx)', 'c . reader . ReadMessage(ctx)']) {
    expect(await readsOf(consumerBody('*stream.Reader', statement)), statement).toEqual([['Consumer', 'reader']]);
  }
  // A receiver chain, a parenthesized operand, a call's own result and the commit
  // member are no read of a reader field this file declares.
  const nested = `${header}type Consumer struct { inner *Inner }\ntype Inner struct { reader *stream.Reader }\nfunc (c *Consumer) Run() { c.inner.reader.FetchMessage(ctx) }\n`;
  expect(await readsOf(nested)).toEqual([]);
  for (const statement of ['(c.reader).FetchMessage(ctx)', 'stream.NewReader(config).FetchMessage(ctx)', 'c.reader.CommitMessages(ctx, message)']) {
    expect(await readsOf(consumerBody('*stream.Reader', statement)), statement).toEqual([]);
  }
});

test('a locally declared reader type and a differently imported package are no consumer read', async () => {
  for (const source of [
    `${header}type Reader struct { n int }\nfunc (r *Reader) FetchMessage() {}\ntype Consumer struct { reader *Reader }\nfunc (c *Consumer) Run() { c.reader.FetchMessage() }\n`,
    'package dispatch\nimport stream "example.test/streams"\ntype Consumer struct { reader *stream.Reader }\nfunc (c *Consumer) Run() { c.reader.FetchMessage(ctx) }\n',
    header + 'type Consumer struct { reader *Unknown }\nfunc (c *Consumer) Run() { c.reader.FetchMessage(ctx) }\n',
  ]) expect(await readsOf(source), source).toEqual([]);
  // A parameter that shadows the package name at the call site decides nothing:
  // the read is proved from the field's declaration, never from a spelling.
  expect(await readsOf(`${header}type Consumer struct { reader *stream.Reader }\nfunc (c *Consumer) Run(stream interface{}) { _ = stream; c.reader.FetchMessage(ctx) }\n`)).toEqual([['Consumer', 'reader']]);
});

const consumerLoop = (statement: string): string => header + `import "context"
type Consumer struct { reader *stream.Reader }
func New() *Consumer {
 config := stream.ReaderConfig{Topic: "events"}
 reader := stream.NewReader(config)
 return &Consumer{reader: reader}
}
func (c *Consumer) Run(ctx context.Context) {
 for {
  message, err := c.reader.FetchMessage(ctx)
  if err != nil {
   return
  }
  c.handle(ctx, message)
${statement}
 }
}
`;
const commitOf = async (source: string) => {
  const value = await run(source);
  const result = await extractContracts(value.input, value.shared.extraction, value.shared.facts);
  // Every consumes edge of the file agrees, whichever edge the read settled on.
  return [...new Set(consumed(result).map(edge => edge.properties['offsetCommit'] ?? 'none'))];
};

test('the commit is unconditional where nothing decides whether it runs', async () => {
  // Coordinator correction 2026-10-25T15:10Z: the claim holds when the commit call
  // is the whole of a statement directly in the loop's block and the loop is a
  // statement of the function's own body, when it is the init statement of a
  // top-level if or switch, or when it is the first operand a top-level condition
  // evaluates. A branch body, a later operand of && or ||, a nested loop, a select,
  // a closure or a larger expression runs on a decision and stays conditional.
  expect(await commitOf(consumerLoop('  c.reader.CommitMessages(ctx, message)'))).toEqual(['unconditional']);
  // The training repository's own shape (services/orders/internal/consumer/payments.go):
  // an if initializer always executes, so the commit is unconditional.
  const initializer = '  if err := c.reader.CommitMessages(ctx, message); err != nil {\n   return\n  }';
  expect(await commitOf(consumerLoop(initializer))).toEqual(['unconditional']);
  expect(await commitOf(consumerLoop('  if c.reader.CommitMessages(ctx, message) == nil {\n   return\n  }'))).toEqual(['unconditional']);
  expect(await commitOf(consumerLoop('  if c.reader.CommitMessages(ctx, message) != nil || other() {\n   return\n  }'))).toEqual(['unconditional']);
  for (const statement of [
    '  if err != nil {\n   c.reader.CommitMessages(ctx, message)\n  }',
    '  for i := 0; i < 1; i++ {\n   c.reader.CommitMessages(ctx, message)\n  }',
    '  func() { c.reader.CommitMessages(ctx, message) }()',
    '  _ = c.reader.CommitMessages(ctx, message)',
    '  if ok() || c.reader.CommitMessages(ctx, message) != nil {\n   return\n  }',
  ]) expect(await commitOf(consumerLoop(statement)), statement).toEqual(['none']);
});

test('the commit is decided from grammar nodes, never from a comment or a string that names it', async () => {
  // The if statement's own block names the member in a comment and in a string, and calls nothing.
  expect(await commitOf(consumerLoop('  if err != nil { /* c.reader.CommitMessages(ctx, message) */ return }'))).toEqual(['none']);
  expect(await commitOf(consumerLoop('  if err != nil { _ = "CommitMessages"; return }'))).toEqual(['none']);
});

test('the commit is the reader the loop reads, not another reader the same file holds', async () => {
  const source = header + `import "context"
type Consumer struct { reader *stream.Reader; other *stream.Reader }
func New() *Consumer {
 config := stream.ReaderConfig{Topic: "events"}
 reader := stream.NewReader(config)
 other := stream.NewReader(config)
 return &Consumer{reader: reader, other: other}
}
func (c *Consumer) Run(ctx context.Context) {
 for {
  message, err := c.reader.FetchMessage(ctx)
  if err != nil {
   return
  }
  c.handle(ctx, message)
  c.other.CommitMessages(ctx, message)
 }
}
`;
  expect(await commitOf(source)).toEqual(['none']);
});

// ---- the file's facts from the grammar, never from a second pattern over the source ----

/** One file's facts, at a path of its own so a main package can be read too. */
const factsAt = async (filePath: string, source: string) => {
  const read = await readSyntaxTree(filePath, new TextEncoder().encode(source), (file) => readGoFile(filePath, file.root));
  if (!read.read) throw new Error('the fixture did not parse');
  return read.value;
};

test('a function verifies HS256 from the string literal its body holds', async () => {
  const verifies = (body: string): string => `${header}func RequireAuth() { ${body} }\n`;
  // The token is delimited by the grammar and decoded; a raw literal is the same value.
  expect((await readFactsOf(verifies('jwt.WithValidMethods([]string{"HS256"})'))).hs256Functions).toEqual(['RequireAuth']);
  expect((await readFactsOf(verifies('jwt.WithValidMethods([]string{`HS256`})'))).hs256Functions).toEqual(['RequireAuth']);
  // A comment that names the method list states no literal, and another token verifies nothing.
  expect((await readFactsOf(verifies('/* jwt.WithValidMethods([]string{"HS256"}) */ _ = "HS512"'))).hs256Functions).toEqual([]);
  // A list this reader cannot decode stays unresolved rather than guessed.
  expect((await readFactsOf(verifies('methods := allowedMethods(); jwt.WithValidMethods(methods)'))).hs256Functions).toEqual([]);
});

test('a status comparison is the equality\'s own operand, never a comment or a string', async () => {
  const decides = (body: string): string => `${header}type Store struct{}\nfunc (s *Store) decide() bool { ${body} }\n`;
  const statusOf = async (body: string) => (await readFactsOf(decides(body))).statusComparisons;
  expect(await statusOf('return s.order.Status == Cancelled')).toEqual(['decide']);
  expect(await statusOf('return known && order.Status == outcome')).toEqual(['decide']);
  // The same characters in a comment and in a string are no operand of an equality.
  expect(await statusOf('/* s.order.Status == Cancelled */ return false')).toEqual([]);
  expect(await statusOf('_ = "s.order.Status == Cancelled"; return false')).toEqual([]);
  // Another field that merely begins with `Status`, and a comparison that is no equality, stay unclaimed.
  expect(await statusOf('return s.response.StatusCode == 200')).toEqual([]);
  expect(await statusOf('return s.order.Status != Cancelled')).toEqual([]);
});

test('a listening address is the Addr keyed element, decoded or named', async () => {
  const addrsOf = async (statement: string) => [...(await readFactsOf(`${header}func start() { ${statement} }`)).serverAddrs];
  // The literal's own token, decoded: no quote reaches the port's reader.
  expect(await addrsOf('server := &http.Server{Addr: ":7311"}; _ = server')).toEqual([['server', ':7311']]);
  // A constant's name, which the package's joins resolve.
  expect(await addrsOf('server := &http.Server{Addr: listenAddr}; _ = server')).toEqual([['server', 'listenAddr']]);
  // A comment that spells the literal, and another type's field, are no address.
  expect(await addrsOf('/* server := &http.Server{Addr: ":7311"} */ _ = 1')).toEqual([]);
  expect(await addrsOf('server := &other.Server{Addr: ":7311"}; _ = server')).toEqual([]);
  // A value this reader cannot decode stays unresolved rather than guessed.
  expect(await addrsOf('server := &http.Server{Addr: address()}; _ = server')).toEqual([]);
});

test('a literal Addr reaches the started port without its quotes', async () => {
  const mainPath = 'cmd/serve/main.go';
  const source = 'package main\nimport "net/http"\nconst listenAddr = ":8080"\nfunc main() { server := &http.Server{Addr: ":7311"}; server.ListenAndServe() }\n';
  const starts = resolveGoStarts([{path: mainPath, go: await factsAt(mainPath, source)}], mainPath);
  expect(starts).toEqual([{kind: 'http-server', symbol: 'server.ListenAndServe()', port: '7311'}]);
});
