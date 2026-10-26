import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import type {TreeReader} from '../src/extract/records.js';

const path = 'services/dispatch/main.go';
const header = `package dispatch
import ("context"; "database/sql"; "github.com/segmentio/kafka-go")
const Topic = "events"
type pending struct { topic string; attempts int }
func Queue(ctx context.Context, tx *sql.Tx) { tx.ExecContext(ctx, \`INSERT INTO outbox (topic) VALUES ($1)\`, Topic) }
`;
const fixture = (after = '', before = '', tail = '') => header + `
func Flush(ctx context.Context, db *sql.DB, writer *kafka.Writer, actualTopic string, actualRows *sql.Rows) {
  rows, err := db.QueryContext(ctx, \`SELECT topic FROM outbox\`)
  if err != nil { return }
  defer rows.Close()
  var row pending
  var other pending
  ${before}
  for rows.Next() {
    rows.Scan(&row.topic)
    ${after}
    writer.WriteMessages(ctx, kafka.Message{Topic: row.topic})
    ${tail}
  }
}`;
const batch = (beforeAppend = '', beforeSend = '', adapterWrite = '') => header + `
type Publisher interface { Publish(context.Context, string) error }
type KafkaPublisher struct { writer *kafka.Writer }
func (p *KafkaPublisher) Publish(ctx context.Context, topic string) error {
  ${adapterWrite}
  return p.writer.WriteMessages(ctx, kafka.Message{Topic: topic})
}
type Relay struct { publisher Publisher; db *sql.DB }
func (r *Relay) Flush(ctx context.Context, actualTopic string) {
  rows, err := r.db.QueryContext(ctx, \`SELECT topic FROM outbox\`)
  if err != nil { return }
  var batch []pending
  for rows.Next() {
    var row pending
    rows.Scan(&row.topic)
    ${beforeAppend}
    batch = append(batch, row)
  }
  for _, row := range batch {
    ${beforeSend}
    r.publisher.Publish(ctx, row.topic)
  }
}`;
// Multi-column transaction/Scan/error cleanup/append/range/adapter flow.
// In particular, the failed-Scan branch discards Close's result before append.
const fullBatch = header.replace('type pending struct { topic string; attempts int }', 'type pending struct { id int64; key string; topic string; payload []byte; attempts int }') + `
type Publisher interface { Publish(context.Context, string, string, []byte) error }
type KafkaPublisher struct { writer *kafka.Writer }
func (p *KafkaPublisher) Publish(ctx context.Context, topic, key string, payload []byte) error {
  return p.writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(key), Value: payload})
}
type Relay struct { publisher Publisher; db *sql.DB }
func (r *Relay) Flush(ctx context.Context) (int, error) {
  tx, err := r.db.BeginTx(ctx, nil)
  if err != nil { return 0, err }
  defer func() { _ = tx.Rollback() }()
  rows, err := tx.QueryContext(ctx,
    \`SELECT id, aggregate_id, topic, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED\`, 100)
  if err != nil { return 0, err }
  var batch []pending
  for rows.Next() {
    var row pending
    if err := rows.Scan(&row.id, &row.key, &row.topic, &row.payload); err != nil {
      _ = rows.Close()
      return 0, err
    }
    batch = append(batch, row)
  }
  if err := rows.Close(); err != nil { return 0, err }
  var published []int64
  for _, row := range batch {
    if err := r.publisher.Publish(ctx, row.topic, row.key, row.payload); err != nil {
      return 0, err
    }
    published = append(published, row.id)
  }
  return len(published), tx.Commit()
}`;
const run = async (source: string) => {
  const files: Record<string, string> = {
    'go.mod': 'module example.test/dispatch\n\ngo 1.23\n',
    'contracts/asyncapi/events.yaml': 'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n  events:\n    publish: {message: {name: Event}}\n',
    [path]: source,
  };
  const input: TreeReader = {paths: Object.keys(files).sort(), read(name) {
    const text = files[name]; if (text === undefined) throw new Error(`missing fixture ${name}`);
    return new TextEncoder().encode(text);
  }};
  const shared = await extractCodeWithFacts(input);
  const result = await extractContracts(input, shared.extraction, shared.facts);
  return {input, shared, result};
};
const publications = (value: Awaited<ReturnType<typeof run>>) => value.result.edges.filter(edge => edge.type === 'code.publishes');
const diagnostic = (value: Awaited<ReturnType<typeof run>>) => `${import.meta.path}: write-boundary proof (${path})\n${JSON.stringify(value, null, 2)}`;

for (const [label, source] of [
  ['same-field assignment', fixture('row.topic = actualTopic')],
  ['same-field compound assignment', fixture('row.topic += actualTopic')],
  ['whole row assignment', fixture('row = other')],
  ['conditional same-field assignment', fixture('if actualTopic != "" { row.topic = actualTopic }')],
  ['parallel assignment', fixture('row.topic, other.topic = actualTopic, actualTopic')],
  ['query receiver rebinding', fixture('', 'rows = actualRows')],
  ['range source write before append', batch('row.topic = actualTopic')],
  ['range value write before adapter send', batch('', 'row.topic = actualTopic')],
  ['range value compound write before adapter send', batch('', 'row.topic += actualTopic')],
  ['range value receiver rebinding', batch('', 'row = pending{topic: actualTopic}')],
  ['adapter parameter overwritten before actual producer', batch('', '', 'topic = ctx.Value("topic").(string)')],
] as const) test(`outbox proof stops at ${label}`, async () => {
  const value = await run(source);
  expect(publications(value), diagnostic(value)).toEqual([]);
  expect(value.result.gaps.some(gap => gap.path === path && gap.reason.includes('line ') && gap.reason.includes('outbox')), diagnostic(value)).toBe(true);
});

for (const [label, source] of [
  ['unchanged scanned topic', fixture()],
  ['a different field assignment', fixture('row.attempts = 1')],
  ['a different field increment', fixture('row.attempts++')],
  ['a different field decrement', fixture('row.attempts--')],
  ['a different row assignment', fixture('other.topic = actualTopic')],
  ['a whole different row assignment', fixture('other = pending{topic: actualTopic}')],
  ['a topic assignment before Scan', fixture('', 'row.topic = actualTopic')],
  ['a whole row assignment before Scan', fixture('', 'row = other')],
  ['a topic assignment after publication', fixture('', '', 'row.topic = actualTopic')],
  ['SQL and Kafka import aliases', fixture().replace('"database/sql"', 'database "database/sql"').replace('"github.com/segmentio/kafka-go"', 'stream "github.com/segmentio/kafka-go"').replaceAll('sql.', 'database.').replaceAll('kafka.', 'stream.')],
] as const) test(`outbox proof survives ${label}`, async () => {
  const value = await run(source);
  expect(publications(value).map(edge => ({from: edge.from, to: edge.to, via: edge.properties.via})), diagnostic(value)).toEqual([
    {from: `code.file:${path}`, to: 'code.channel:events', via: 'outbox'},
    {from: `code.symbol:${path}#Flush`, to: 'code.channel:events', via: 'outbox'},
  ]);
});

for (const [label, source] of [
  ['the canonical Go range value', batch()],
  ['the full transaction and multi-column Scan cleanup flow', fullBatch],
  ['a range source unrelated field write', batch('row.attempts++')],
  ['a range value unrelated field write', batch('', 'row.attempts++')],
] as const) test(`outbox batch proof preserves ${label}`, async () => {
  const value = await run(source);
  const edges = publications(value).filter(edge => !edge.properties.summary);
  expect(edges.map(edge => ({from: edge.from, to: edge.to, via: edge.properties.via})), diagnostic(value)).toEqual([
    {from: `code.symbol:${path}#KafkaPublisher.Publish`, to: 'code.channel:events', via: 'outbox'},
  ]);
});

test('a missing copied range-value identity cannot be replaced with the row spelling', async () => {
  const value = await run(batch());
  const missing = freezeCodeFacts({...value.shared.facts, bindings: value.shared.facts.bindings.map(binding => {
    if (binding.goRange?.role !== 'value') return binding;
    const {goRange: discarded, ...retained} = binding; void discarded; return retained;
  })});
  const result = await extractContracts(value.input, value.shared.extraction, missing);
  expect(result.edges.filter(edge => edge.type === 'code.publishes'), diagnostic(value)).toEqual([]);
});
