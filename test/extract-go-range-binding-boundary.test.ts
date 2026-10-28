import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import type {TreeReader} from '../src/extract/records.js';

const path = 'services/dispatch/main.go';
function tree(source: string, contracts = false): TreeReader {
  const files: Record<string, string> = {'go.mod': 'module example.test/dispatch\n\ngo 1.23\n', [path]: source};
  if (contracts) files['contracts/asyncapi/events.yaml'] = 'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n  events:\n    publish: {message: {name: Event}}\n';
  return {paths: Object.keys(files).sort(), read(name) {
    const source = files[name]; if (source === undefined) throw new Error(`missing fixture ${name}`);
    return new TextEncoder().encode(source);
  }};
}

test('Go range declarations copy exact selection identity without inventing an initializer', async () => {
  const source = 'package sample\nfunc run(item []int){ for _, item := range item { consume(item) }; consume(item) }';
  const {facts} = await extractCodeWithFacts(tree(source));
  const outer = facts.bindings.find(binding => binding.name === 'item' && binding.kind === 'parameter')!;
  const selected = facts.bindings.find(binding => binding.name === 'item' && binding.kind === 'local')!;
  const clause = facts.expressions.find(node => node.syntaxKind === 'range_clause')!;
  const loop = facts.expressions.find(node => node.syntaxKind === 'for_statement')!;
  const collection = facts.expressions.find(node => node.id === clause.fields.right?.[0])!;
  expect(outer).toBeDefined(); expect(selected).toBeDefined(); expect(collection.bindingId).toBe(outer.id);
  expect(selected.goRange).toEqual({clauseExpression: clause.id, collectionExpression: collection.id, ordinal: 1, role: 'value'});
  expect(selected.initializer).toBeUndefined(); expect(selected.scope).toEqual(loop.span);
  expect(source.slice(selected.span.byteStart, selected.span.byteEnd)).toBe('item');
  const names = facts.expressions.filter(node => node.name === 'item').sort((a, b) => a.span.byteStart - b.span.byteStart);
  expect(names.find(node => node.span.byteStart === selected.span.byteStart)?.bindingId).toBe(selected.id);
  expect(names.find(node => node.span.byteStart === source.indexOf('consume(item)') + 'consume('.length)?.bindingId).toBe(selected.id);
  expect(names.at(-1)?.bindingId).toBe(outer.id);
  expect(Object.isFrozen(selected.goRange)).toBe(true);
  expect(facts.gaps).toEqual([]);
});

test('Go one-name range selects an index/key, and two-name range preserves both ordinal roles', async () => {
  for (const targets of ['index', 'index, value']) {
    const source = `package sample\nfunc run(values []int){ for ${targets} := range values { consume(${targets}) } }`;
    const {facts} = await extractCodeWithFacts(tree(source));
    const selected = facts.bindings.filter(binding => binding.goRange !== undefined);
    expect(selected.map(binding => [binding.name, binding.goRange?.ordinal, binding.goRange?.role])).toEqual(
      targets === 'index' ? [['index', 0, 'key']] : [['index', 0, 'key'], ['value', 1, 'value']]);
    expect(selected.every(binding => binding.initializer === undefined)).toBe(true);
    expect(facts.gaps).toEqual([]);
  }
});

test('Go range assignment reuses the old identity and removes a stale initializer', async () => {
  const source = 'package sample\nfunc run(values []int){ item := initial(); for _, item = range values { consume(item) }; consume(item) }';
  const {facts} = await extractCodeWithFacts(tree(source));
  const bindings = facts.bindings.filter(binding => binding.name === 'item');
  expect(bindings).toHaveLength(1);
  expect(bindings[0]?.initializer).toBeUndefined(); expect(bindings[0]?.goRange).toBeUndefined();
  expect(facts.expressions.filter(node => node.name === 'item').every(node => node.bindingId === bindings[0]?.id)).toBe(true);
  expect(facts.gaps).toEqual([]);
});

test('Go range scope ends before a following local declaration, and no-target range has no binding proof', async () => {
  const source = 'package sample\nfunc run(values []int){ for _, item := range values { consume(item) }; item := initial(); consume(item); for range values { consume(values) } }';
  const {facts} = await extractCodeWithFacts(tree(source));
  const bindings = facts.bindings.filter(binding => binding.name === 'item');
  expect(bindings).toHaveLength(2);
  const last = facts.expressions.filter(node => node.name === 'item').sort((a, b) => b.span.byteStart - a.span.byteStart)[0];
  expect(last?.bindingId).toBe(bindings.find(binding => binding.span.byteStart === source.indexOf('item := initial'))?.id);
  expect(bindings.filter(binding => binding.goRange !== undefined)).toHaveLength(1);
  expect(facts.gaps).toEqual([]);
});

test('Go malformed range declarations do not acquire a selection proof or outer initializer', async () => {
  for (const targets of ['item, item', 'first, second, item']) {
    const source = `package sample\nfunc run(values []int){ item := initial(); for ${targets} := range values { consume(item) } }`;
    const {facts} = await extractCodeWithFacts(tree(source));
    expect(facts.bindings.filter(binding => binding.goRange !== undefined), targets).toEqual([]);
    const use = facts.expressions.find(node => node.name === 'item' && node.span.byteStart === source.indexOf('consume(item)') + 'consume('.length)!;
    const binding = facts.bindings.find(binding => binding.id === use.bindingId);
    expect(binding, targets).toBeDefined(); expect(binding?.initializer, targets).toBeUndefined();
    expect(facts.gaps.some(gap => gap.reason.includes('unsupported Go range binding')), targets).toBe(true);
  }
  const {facts} = await extractCodeWithFacts(tree('package sample\nfunc run(values []int){ for _, item := range { consume(item) } }'));
  expect(facts.bindings.filter(binding => binding.goRange !== undefined)).toEqual([]);
  expect(facts.gaps.length).toBeGreaterThan(0);
});

const batchSource = `package dispatch
import ("context"; "database/sql"; "github.com/segmentio/kafka-go")
const Topic = "events"
type pending struct { topic string }
func Queue(ctx context.Context, tx *sql.Tx) { tx.ExecContext(ctx, \`INSERT INTO outbox (topic) VALUES ($1)\`, Topic) }
func Flush(ctx context.Context, db *sql.DB, writer *kafka.Writer) {
 rows, err := db.QueryContext(ctx, \`SELECT topic FROM outbox\`)
 if err != nil { return }
 var batch []pending
 for rows.Next() { var row pending; rows.Scan(&row.topic); batch = append(batch, row) }
 for _, item := range batch { writer.WriteMessages(ctx, kafka.Message{Topic: item.topic}) }
}`;

test('outbox batch transfers require the exact value-selection proof, scope, and declaration identity', async () => {
  const input = tree(batchSource, true); const shared = await extractCodeWithFacts(input);
  const published = (result: Awaited<ReturnType<typeof extractContracts>>) => result.edges.filter(edge => edge.type === 'code.publishes' && !edge.properties.summary);
  expect(published(await extractContracts(input, shared.extraction, shared.facts))).toHaveLength(1);
  const binding = shared.facts.bindings.find(binding => binding.name === 'item' && binding.goRange !== undefined)!;
  expect(binding).toBeDefined();
  const clause = shared.facts.expressions.find(node => node.id === binding.goRange?.clauseExpression)!;
  const loop = shared.facts.expressions.find(node => node.syntaxKind === 'for_statement' && node.span.byteStart <= clause.span.byteStart && clause.span.byteEnd <= node.span.byteEnd)!;
  const body = shared.facts.expressions.find(node => node.id === loop.fields.body?.[0])!;
  for (const replacement of [
    {...binding, goRange: undefined},
    {...binding, goRange: {...binding.goRange!, ordinal: 0 as const, role: 'key' as const}},
    {...binding, goRange: {...binding.goRange!, collectionExpression: clause.id}},
    {...binding, goRange: {...binding.goRange!, clauseExpression: body.id}},
    {...binding, scope: body.span},
    {...binding, initializer: binding.goRange!.collectionExpression},
    {...binding, span: {...binding.span, byteEnd: binding.span.byteEnd + 1}},
  ]) {
    const facts = freezeCodeFacts({...shared.facts, bindings: shared.facts.bindings.map(held => held.id === binding.id ? replacement : held)});
    expect(published(await extractContracts(input, shared.extraction, facts)), JSON.stringify(replacement)).toEqual([]);
  }
  const noDeclarationIdentity = freezeCodeFacts({...shared.facts, expressions: shared.facts.expressions.map(node => node.bindingId === binding.id && node.span.byteStart === binding.span.byteStart ? {...node, bindingId: undefined} : node)});
  expect(published(await extractContracts(input, shared.extraction, noDeclarationIdentity))).toEqual([]);
});
