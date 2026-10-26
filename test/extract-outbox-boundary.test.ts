import {expect, test} from 'bun:test';
import {extractCodeWithFacts} from '../src/extract/code/index.js';
import {freezeCodeFacts} from '../src/extract/code/facts.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {outboxSqlFacts} from '../src/extract/contracts/outbox.js';
import {parsePostgres} from '../src/parsers/postgres.js';
import outboxData from '../src/extract/library-models/outbox-models.json';
import {validateOutboxModels} from '../src/extract/library-models/outbox-models.js';
import type {TreeReader} from '../src/extract/records.js';

const path = 'services/dispatch/main.go';
const tree = (source: string): TreeReader => {
  const files: Record<string, string> = {
    'go.mod': 'module example.test/dispatch\n\ngo 1.23\n',
    'contracts/asyncapi/events.yaml': 'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n  events:\n    publish: {message: {name: Event}}\n',
    [path]: source,
  };
  return {paths: Object.keys(files).sort(), read(path) {const value = files[path]; if (value === undefined) throw new Error(`missing fixture ${path}`); return new TextEncoder().encode(value);}};
};
const header = 'package dispatch\nimport ("context"; "database/sql"; "github.com/segmentio/kafka-go")\nconst Topic = "events"\n';
const publications = (result: Awaited<ReturnType<typeof extractContracts>>) => result.edges.filter(edge => edge.type === 'code.publishes');
const fixture = (insert = 'INSERT INTO outbox (topic) VALUES ($1)', read = 'SELECT topic FROM outbox', publish = 'row.topic', value = 'Topic') => header + `
func Queue(ctx context.Context, tx *sql.Tx) { tx.ExecContext(ctx, \`${insert}\`, ${value}) }
func Flush(ctx context.Context, db *sql.DB, writer *kafka.Writer, actualTopic string) {
  rows, err := db.QueryContext(ctx, \`${read}\`)
  if err != nil { return }
  defer rows.Close()
  var row struct { topic string }
  for rows.Next() {
    rows.Scan(&row.topic)
    writer.WriteMessages(ctx, kafka.Message{Topic: ${publish}})
  }
}`;
const run = async (source: string) => {const input = tree(source); const shared = await extractCodeWithFacts(input); return {input, shared, result: await extractContracts(input, shared.extraction, shared.facts)};};
const diagnostic = (value: Awaited<ReturnType<typeof run>>) => `${import.meta.path}: outbox proof (${path})\n${JSON.stringify(value, null, 2)}`;

test('an INSERT topic argument and scanned SELECT topic prove the real producer outbox chain', async () => {
  const value = await run(fixture());
  const edges = publications(value.result);
  expect(edges.map(edge => ({from: edge.from, to: edge.to})), diagnostic(value)).toEqual([
    {from: `code.file:${path}`, to: 'code.channel:events'},
    {from: `code.symbol:${path}#Flush`, to: 'code.channel:events'},
  ]);
  const edge = edges.find(edge => edge.from.startsWith('code.symbol:'))!;
  expect(edge.properties.via).toBe('outbox');
  expect(edge.properties.constant).toBe('Topic');
  const span = edge.span!;
  expect(new TextDecoder().decode(value.input.read(path).subarray(span.byteStart, span.byteEnd))).toBe('writer.WriteMessages(ctx, kafka.Message{Topic: row.topic})');
  expect(edge.properties.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({path, lineStart: 5}), expect.objectContaining({path, lineStart: 7}),
  ]));
  const withoutStrings = freezeCodeFacts({...value.shared.facts, expressions: value.shared.facts.expressions.map(node => node.literal?.kind === 'string' ? {...node, literal: {...node.literal, value: undefined}} : node)});
  expect(publications(await extractContracts(value.input, value.shared.extraction, withoutStrings))).toEqual([]);
});

for (const [label, source] of [
  ['source comments are not SQL', header + '// INTO outbox\n// FROM outbox\nfunc Publish(w *kafka.Writer, actualTopic string) { w.WriteMessages(context.Background(), kafka.Message{Topic: actualTopic}) }'],
  ['SQL strings containing comments are not statements', fixture('-- INSERT INTO outbox (topic) VALUES ($1)', '-- SELECT topic FROM outbox')],
  ['a real outbox read does not resolve actualTopic', fixture(undefined, undefined, 'actualTopic')],
  ['a declared constant does not resolve the INSERT topic argument', fixture(undefined, undefined, undefined, 'unknownTopic')],
  ['a different schema does not join the table identity', fixture('INSERT INTO first.outbox (topic) VALUES ($1)', 'SELECT topic FROM second.outbox')],
  ['an unresolved second writer prevents a closed topic claim', fixture() + '\nfunc Other(ctx context.Context, tx *sql.Tx, topic string) { tx.ExecContext(ctx, `INSERT INTO outbox (topic) VALUES ($1)`, topic) }'],
  ['a fake producer does not become Kafka through SQL', fixture().replace('writer *kafka.Writer', 'writer *FakeWriter') + '\ntype FakeWriter struct {}\nfunc (*FakeWriter) WriteMessages(context.Context, ...kafka.Message) {}'],
  ['a decoy SELECT in an unused string does not prove rows', fixture().replace('rows, err := db.QueryContext(ctx, `SELECT topic FROM outbox`)', 'unused := `SELECT topic FROM outbox`; _ = unused; rows, err := db.QueryContext(ctx, `SELECT topic FROM inbox`)')],
] as const) test(label, async () => {const value = await run(source); expect(publications(value.result), diagnostic(value)).toEqual([]);});

test('PostgreSQL AST canonicalizes unquoted case and preserves quoted schema identity', async () => {
  const value = await run(fixture('insert into "Ledger"."outbox" ("topic") values ($1)', 'select "topic" from "Ledger"."outbox"'));
  expect(publications(value.result).some(edge => edge.from === `code.symbol:${path}#Flush`), diagnostic(value)).toBe(true);
  const parsed = outboxSqlFacts(await parsePostgres('INSERT INTO PUBLIC.OUTBOX(topic) VALUES (\'events\'); SELECT topic FROM public.outbox; SELECT topic FROM "public.outbox";'));
  expect(parsed.inserts[0]?.table.key).toBe(parsed.selects[0]?.table.key);
  expect(parsed.selects).toHaveLength(1);
});

test('CTE relation names are not physical outbox tables and SQL quoted text is not SQL syntax', async () => {
  const parsed = outboxSqlFacts(await parsePostgres("WITH outbox AS (SELECT 'events' AS topic) SELECT topic FROM outbox; SELECT 'INSERT INTO outbox(topic) VALUES (1)' AS note;"));
  expect(parsed.inserts).toEqual([]); expect(parsed.selects).toEqual([]);
});

test('CTE query bodies and every parsed statement retain their actual table evidence', async () => {
  const parsed = outboxSqlFacts(await parsePostgres("WITH queued AS (INSERT INTO audit.outbox(topic) VALUES ('events') RETURNING topic) SELECT topic FROM queued; SELECT topic FROM audit.outbox;"));
  expect(parsed.inserts).toHaveLength(1); expect(parsed.selects).toHaveLength(1);
  expect(parsed.inserts[0]?.table.key).toBe(parsed.selects[0]?.table.key);
});


test('constructor topic binding and a scanned batch reach the real adapter producer', async () => {
  const value = await run(header + `
type OutboxWriter struct { topic string }
func NewOutboxWriter(topic string) *OutboxWriter { return &OutboxWriter{topic: topic} }
func (w *OutboxWriter) Queue(ctx context.Context, tx *sql.Tx) { tx.ExecContext(ctx, \`INSERT INTO outbox (topic) VALUES ($1)\`, w.topic) }
func Configure() *OutboxWriter { return NewOutboxWriter(Topic) }
type Publisher interface { Publish(context.Context, string) error }
type KafkaPublisher struct { writer *kafka.Writer }
func (p *KafkaPublisher) Publish(ctx context.Context, topic string) error { return p.writer.WriteMessages(ctx, kafka.Message{Topic: topic}) }
type Relay struct { publisher Publisher; db *sql.DB }
type pending struct { topic string }
func (r *Relay) Flush(ctx context.Context) {
  rows, err := r.db.QueryContext(ctx, \`SELECT topic FROM outbox\`)
  if err != nil { return }
  var batch []pending
  for rows.Next() {
    var p pending
    rows.Scan(&p.topic)
    batch = append(batch, p)
  }
  for _, p := range batch { r.publisher.Publish(ctx, p.topic) }
}`);
  const published = publications(value.result).filter(edge => !edge.properties.summary);
  expect(published.map(edge => ({from: edge.from, to: edge.to})), diagnostic(value)).toEqual([
    {from: `code.symbol:${path}#KafkaPublisher.Publish`, to: 'code.channel:events'},
  ]);
  expect(published[0]?.properties.via).toBe('outbox');
  expect(published[0]?.properties.constant).toBe('Topic');
});


for (const [label, source] of [
  ['a fake SELECT receiver does not become SQL by method spelling', fixture().replace('db *sql.DB', 'db *FakeDB') + '\ntype FakeDB struct {}\nfunc (*FakeDB) QueryContext(context.Context, string) (*sql.Rows, error) { return nil, nil }'],
  ['a fake INSERT receiver does not prove database writes', fixture().replace('tx *sql.Tx', 'tx *FakeTx') + '\ntype FakeTx struct {}\nfunc (*FakeTx) ExecContext(context.Context, string, ...any) {}'],
  ['a shadowed sql import does not prove a database receiver', fixture().replace('"database/sql";', '"example.test/fake/sql";')],
  ['an unrelated row with the same topic field is not the scanned topic', fixture(undefined, undefined, 'other.topic').replace('var row struct { topic string }', 'var row struct { topic string }; var other struct { topic string }')],
] as const) test(label, async () => {const value = await run(source); expect(publications(value.result), diagnostic(value)).toEqual([]); expect(value.result.gaps.some(gap => gap.path === path)).toBe(true);});

test('outbox model validation is closed and receiver identities cannot be ambiguous', () => {
  expect(Object.isFrozen(validateOutboxModels(outboxData))).toBe(true);
  for (const mutate of [
    (value: Record<string, any>) => {value.extra = true;},
    (value: Record<string, any>) => {value.outbox.extra = true;},
    (value: Record<string, any>) => {value.receivers.push(value.receivers[0]);},
    (value: Record<string, any>) => {value.receivers[0].extra = true;},
    (value: Record<string, any>) => {value.operations[0].receiverIds = ['unknown'];},
    (value: Record<string, any>) => {value.operations[0].values = -1;},
    (value: Record<string, any>) => {value.operations[0].values = value.operations[0].sql;},
    (value: Record<string, any>) => {value.operations[0].reference = 'javascript:bad';},
    (value: Record<string, any>) => {value.scan.member = '';},
    (value: Record<string, any>) => {value.append.collection = 0.5;},
    (value: Record<string, any>) => {value.factories[0].returns = 'unknown';},
  ]) {
    const value = structuredClone(outboxData); mutate(value); expect(() => validateOutboxModels(value)).toThrow();
  }
});
