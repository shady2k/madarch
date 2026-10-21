// Tests of the data-model extractor (src/extract/data-model) against the
// generated training repository and its answer key (madarch-o0eq.2). Every
// expected value comes from the key's items - their `expectedWikiStatement`,
// `judge.mustShow`, `judge.mustNotClaim` and their `location` anchors - never
// from the extractor's own output.
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {byCodePoint} from '../src/model/order.js';
import type {ExtractedEdge, ExtractedNode, Extraction, SourceSpan, TreeReader} from '../src/extract/records.js';
import {columnKey, fileKey, functionKey, indexKey, tableKey} from '../src/extract/data-model/keys.js';
const execFileAsync = promisify(execFile);
const worktreeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const generator = path.join(worktreeRoot, 'examples/training-repository/generate.mjs');
const answerKey = JSON.parse(await readFile(path.join(worktreeRoot, 'examples/training-repository/answer-key.json'), 'utf8')) as AnswerKey;

interface KeyLocation {
  readonly path: string;
  readonly anchor: string;
}
interface KeyItem {
  readonly id: string;
  readonly evidenceClass: string;
  readonly location?: KeyLocation;
  readonly locations?: readonly KeyLocation[];
  readonly expectedWikiStatement: string;
  readonly judge: {readonly mustShow: readonly string[]; readonly mustNotClaim?: readonly string[]};
}
interface AnswerKey {
  readonly items: readonly KeyItem[];
}

/** Builds a TreeReader over a generated repository folder (records.ts: "a test builds one over a folder"). */
async function treeReaderOf(folder: string): Promise<{tree: TreeReader; bytes: Map<string, Uint8Array>}> {
  const files: string[] = [];
  const bytes = new Map<string, Uint8Array>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(dir)).sort(byCodePoint)) {
      const absolute = path.join(dir, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      if ((await stat(absolute)).isDirectory()) {
        if (entry !== '.git') await walk(absolute, relative);
      } else {
        files.push(relative);
        bytes.set(relative, new Uint8Array(await readFile(absolute)));
      }
    }
  }
  await walk(folder, '');
  return {
    tree: {
      paths: files.sort(byCodePoint),
      read(pathname: string): Uint8Array {
        const held = bytes.get(pathname);
        if (held === undefined) throw new Error(`no such path in the tree: ${pathname}`);
        return held;
      },
    },
    bytes,
  };
}

let home: string;
let repoFolder: string;
let extraction: Extraction;
let repoBytes: Map<string, Uint8Array>;
beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'madarch-extract-data-model-'));
  repoFolder = path.join(home, 'training-repository');
  await execFileAsync('node', [generator, repoFolder], {cwd: worktreeRoot});
  const read = await treeReaderOf(repoFolder);
  repoBytes = read.bytes;
  extraction = await extractDataModel(read.tree);
}, 120_000);
afterAll(async () => {
  await rm(home, {recursive: true, force: true});
});

// ---- record lookups -------------------------------------------------------

function node(keyOf: string): ExtractedNode {
  const found = extraction.nodes.find((candidate) => candidate.key === keyOf);
  expect(found, `no node ${keyOf} in the extraction`).toBeDefined();
  return found!;
}
function edgesOf(type: string): ExtractedEdge[] {
  return extraction.edges.filter((edge) => edge.type === type);
}
function edgesBetween(type: string, from: string, to: string): ExtractedEdge[] {
  return edgesOf(type).filter((edge) => edge.from === from && edge.to === to);
}
function oneEdge(type: string, from: string, to: string): ExtractedEdge {
  const found = edgesBetween(type, from, to);
  expect(found, `expected exactly one ${type} edge ${from} -> ${to}, found ${found.length}`).toHaveLength(1);
  return found[0];
}

function textOf(pathname: string): string {
  return new TextDecoder().decode(repoBytes.get(pathname)!);
}
function spanText(span: SourceSpan): string {
  return textOf(span.path).slice(span.byteStart, span.byteEnd);
}
/** Every text a record cites: its own span and each call site it carries. */
function citedTexts(edge: ExtractedEdge): string[] {
  const sites = [edge.span ?? undefined, ...((edge.properties['sites'] as readonly SourceSpan[] | undefined) ?? [])];
  return sites.filter((site): site is SourceSpan => site !== undefined).map(spanText);
}

function keyItem(id: string): KeyItem {
  const found = answerKey.items.find((candidate) => candidate.id === id);
  expect(found, `the answer key has no item ${id}`).toBeDefined();
  return found!;
}
function keyItemsOf(prefix: string): KeyItem[] {
  return answerKey.items.filter((item) => item.id.startsWith(`${prefix}.`)).sort((a, b) => byCodePoint(a.id, b.id));
}

/**
 * Every anchor of the item must stand inside a record's span or one of its call
 * sites, at the location's own path (the key: each anchor is found verbatim in
 * the file at its snapshot, so the record that carries the fact cites it).
 */
function expectAnchorsCited(item: KeyItem): void {
  for (const location of item.locations ?? (item.location ? [item.location] : [])) {
    const cited = extraction.edges.some(
      (edge) => edge.span?.path === location.path && citedTexts(edge).some((text) => text.includes(location.anchor)),
    );
    expect(cited, `no record of the extraction cites the anchor of ${item.id} at ${location.path}: ${location.anchor}`).toBe(true);
  }
}

describe('data-model extractor (training repository, answer key)', () => {
  test('every database, table-access and outbox item of the key names a case of this file', () => {
    const ids = keyItemsOf('database').concat(keyItemsOf('table-access'), keyItemsOf('outbox')).map((item) => item.id);
    for (const id of ids) {
      expect(itemCaseNames[id], `the key item ${id} has no case in itemCaseNames`).toBeDefined();
    }
  });

  test('the records are keyed by logical identity, sorted, and named by their producer', () => {
    expect(extraction.producer).toBe('code.extract.data-model');
    const nodeKeys = extraction.nodes.map((record) => record.key);
    expect(nodeKeys).toEqual([...nodeKeys].sort(byCodePoint));
    const edgeKeys = extraction.edges.map((edge) => `${edge.type} ${edge.from} ${edge.to} ${edge.discriminator}`);
    expect(edgeKeys).toEqual([...edgeKeys].sort(byCodePoint));
    const gapPaths = extraction.gaps.map((gap) => gap.path);
    expect(gapPaths).toEqual([...gapPaths].sort(byCodePoint));
  });

  test('two extractions of the same tree give the same records', async () => {
    const read = await treeReaderOf(repoFolder);
    const again = await extractDataModel(read.tree);
    expect(JSON.stringify(again)).toBe(JSON.stringify(extraction));
  });

  test('a migration file that cannot be read becomes a gap, never a silence', async () => {
    const broken = 'services/broken/migrations/0001_broken.sql';
    const tree: TreeReader = {
      paths: [broken],
      read(pathname: string): Uint8Array {
        if (pathname !== broken) throw new Error(`no such path in the tree: ${pathname}`);
        return new TextEncoder().encode('this is not sql at all <<<');
      },
    };
    const read = await extractDataModel(tree);
    const gap = read.gaps.find((candidate) => candidate.path === broken);
    expect(gap, `no gap for ${broken}`).toBeDefined();
    expect(gap!.reason).toContain('no table or column statement');
  });
});

/** The named case of each key item: the case name carries the key id. */
const itemCaseNames: Record<string, string> = {};
function keyCase(id: string, body: (item: KeyItem) => void): void {
  const item = keyItem(id);
  itemCaseNames[id] = `${id}: ${item.expectedWikiStatement}`;
  test(`${id}: ${item.expectedWikiStatement}`, () => body(item));
}

describe('database items (answer key)', () => {
  keyCase('database.orders', (item) => {
    for (const table of ['customers', 'orders', 'order_items', 'outbox']) {
      node(tableKey('orders', table));
    }
    expect(columnsOf('orders', 'customers')).toEqual(['created_at', 'email', 'id', 'name']);
    expect(columnsOf('orders', 'orders')).toEqual(['cancel_reason', 'created_at', 'customer_id', 'discount_cents', 'id', 'request_id', 'status', 'subtotal_cents', 'tax_cents', 'total_cents', 'updated_at']);
    expect(columnsOf('orders', 'order_items')).toEqual(['id', 'order_id', 'price_cents', 'quantity', 'sku', 'zero_rated']);
    expect(columnsOf('orders', 'outbox')).toEqual(['aggregate_id', 'created_at', 'id', 'payload', 'published_at', 'topic']);
    for (const table of ['customers', 'orders', 'order_items', 'outbox']) {
      expect(node(columnKey('orders', table, 'id')).properties['primaryKey'], `id of ${table}`).toBe(true);
    }
    const toCustomers = oneEdge('code.foreign-key', tableKey('orders', 'orders'), tableKey('orders', 'customers'));
    expect(toCustomers.properties['column']).toBe('customer_id');
    expect(toCustomers.properties['targetColumn']).toBe('id');
    expect(toCustomers.properties['cardinality']).toBe('many-to-one');
    const toOrders = oneEdge('code.foreign-key', tableKey('orders', 'order_items'), tableKey('orders', 'orders'));
    expect(toOrders.properties['column']).toBe('order_id');
    expect(toOrders.properties['onDelete']).toBe('CASCADE');
    expect(edgesOf('code.foreign-key').filter((edge) => edge.from === tableKey('orders', 'outbox') || edge.to === tableKey('orders', 'outbox'))).toEqual([]);
    expect(node(columnKey('orders', 'customers', 'name')).properties['nullable']).toBe(true);
    expect(node(columnKey('orders', 'orders', 'cancel_reason')).properties['nullable']).toBe(true);
    expect(node(columnKey('orders', 'orders', 'request_id')).properties['nullable']).toBe(true);
    expect(node(columnKey('orders', 'outbox', 'published_at')).properties['nullable']).toBe(true);
    expect(node(columnKey('orders', 'orders', 'total_cents')).properties['nullable']).toBe(false);
    expect(node(columnKey('orders', 'orders', 'total_cents')).properties['type']).toBe('BIGINT');
    const declaredIn: Record<string, string> = {
      customers: 'services/orders/migrations/0001_customers.sql',
      orders: 'services/orders/migrations/0002_orders.sql',
      order_items: 'services/orders/migrations/0003_order_items.sql',
      outbox: 'services/orders/migrations/0004_outbox.sql',
    };
    for (const [table, migrationPath] of Object.entries(declaredIn)) {
      const tableNode = node(tableKey('orders', table));
      expect(tableNode.span?.path, `table ${table} declared in`).toBe(migrationPath);
      expect(spanText(tableNode.span!)).toContain(`CREATE TABLE ${table}`);
    }
  });

  keyCase('database.cardinality.order-items', (item) => {
    const edge = oneEdge('code.foreign-key', tableKey('orders', 'order_items'), tableKey('orders', 'orders'));
    expect(edge.properties['cardinality']).toBe('many-to-one');
    expect(edge.properties['column']).toBe('order_id');
    expect(edge.properties['targetColumn']).toBe('id');
  });

  keyCase('database.migration-order', (item) => {
    const migrations = extraction.nodes
      .filter((record) => record.kind === 'code.migration' && record.key.startsWith('code.migration:orders/'))
      .map((record) => ({name: record.label, ordinal: record.properties['ordinal'] as number}))
      .sort((a, b) => a.ordinal - b.ordinal);
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_customers.sql',
      '0002_orders.sql',
      '0003_order_items.sql',
      '0004_outbox.sql',
      '0005_order_request_id.sql',
    ]);
    expect(new Set(migrations.map((migration) => migration.ordinal)).size).toBe(migrations.length);
    node(tableKey('orders', 'schema_migrations'));
  });

  keyCase('database.payments', (item) => {
    node(tableKey('payments', 'payments'));
    node(tableKey('payments', 'refunds'));
    expect(columnsOf('payments', 'payments')).toEqual(['amount_cents', 'captured_at', 'created_at', 'currency', 'decline_reason', 'id', 'idempotency_key', 'order_id', 'provider_reference', 'status']);
    expect(columnsOf('payments', 'refunds')).toEqual(['amount_cents', 'created_at', 'id', 'payment_id', 'reason']);
    const edge = oneEdge('code.foreign-key', tableKey('payments', 'refunds'), tableKey('payments', 'payments'));
    expect(edge.properties['column']).toBe('payment_id');
    expect(edge.properties['targetColumn']).toBe('id');
    expect(String(edge.properties['constraint'] ?? edge.discriminator)).toContain('refunds_payment_id_fkey');
    expect(node(columnKey('payments', 'payments', 'idempotency_key')).properties['unique']).toBe(true);
    for (const column of ['provider_reference', 'decline_reason', 'captured_at']) {
      expect(node(columnKey('payments', 'payments', column)).properties['nullable'], column).toBe(true);
    }
    expect(spanText(node(tableKey('payments', 'payments')).span!)).toContain('@@map("payments")');
    expect(spanText(node(tableKey('payments', 'refunds')).span!)).toContain('@@map("refunds")');
  });

  keyCase('database.logical-reference', (item) => {
    const edge = oneEdge('code.logical-reference', tableKey('payments', 'payments'), tableKey('orders', 'orders'));
    expect(edge.properties['column']).toBe('order_id');
    expect(edgesBetween('code.foreign-key', tableKey('payments', 'payments'), tableKey('orders', 'orders'))).toEqual([]);
    expect(edgesBetween('code.foreign-key', tableKey('payments', 'refunds'), tableKey('orders', 'orders'))).toEqual([]);
    expect(citedTexts(edge).join('\n')).toContain('orderId is a logical reference to the orders service');
  });

  keyCase('database.promotions', (item) => {
    node(tableKey('promotions', 'promotions'));
    expect(columnsOf('promotions', 'promotions')).toEqual(['active', 'code', 'expires_at', 'id', 'kind', 'min_cents', 'value']);
    expect(node(columnKey('promotions', 'promotions', 'code')).properties['unique']).toBe(true);
    expect(node(columnKey('promotions', 'promotions', 'min_cents')).properties['nullable']).toBe(true);
    expect(node(columnKey('promotions', 'promotions', 'expires_at')).properties['nullable']).toBe(true);
    const check = String(node(columnKey('promotions', 'promotions', 'kind')).properties['check'] ?? '');
    expect(check).toContain("'percent'");
    expect(check).toContain("'fixed'");
    expect(check).toContain("'threshold'");
    expect(edgesOf('code.foreign-key').filter((edge) => edge.from.startsWith('code.table:promotions/') || edge.to.startsWith('code.table:promotions/'))).toEqual([]);
  });

  keyCase('database.direct-access', (item) => {
    const migrate = functionKey('services/orders/internal/store/db.go', 'Migrate');
    node(migrate);
    expect(edgesBetween('code.reads-table', migrate, tableKey('orders', 'schema_migrations')).length > 0).toBe(true);
    expect(edgesBetween('code.writes-table', migrate, tableKey('orders', 'schema_migrations')).length > 0).toBe(true);
    const write = functionKey('services/orders/internal/store/outbox.go', 'OutboxWriter.Write');
    expect(edgesBetween('code.writes-table', write, tableKey('orders', 'outbox')).length > 0).toBe(true);
    const flush = functionKey('services/orders/internal/relay/relay.go', 'Relay.Flush');
    expect(edgesBetween('code.reads-table', flush, tableKey('orders', 'outbox')).length > 0).toBe(true);
    const mark = functionKey('services/orders/internal/relay/relay.go', 'Relay.markPublished');
    expect(edgesBetween('code.writes-table', mark, tableKey('orders', 'outbox')).length > 0).toBe(true);
    const reportReads = edgesOf('code.reads-table').filter((edge) => edge.from.startsWith('code.function:services/payments/src/api/legacy-report.ts#'));
    expect(reportReads.some((edge) => edge.to === tableKey('payments', 'payments')), 'the legacy report reads payments').toBe(true);
    expect(reportReads.some((edge) => edge.to === tableKey('payments', 'refunds')), 'the legacy report reads refunds').toBe(true);
  });
});

describe('table-access items (answer key)', () => {
  keyCase('table-access.orders', (item) => {
    const table = tableKey('orders', 'orders');
    const repositoryPath = 'services/orders/internal/store/order_repository.go';
    const writers = edgesOf('code.writes-table').filter((edge) => edge.to === table).map((edge) => edge.from);
    expect(writers).toContain(functionKey(repositoryPath, 'OrderRepository.Create'));
    expect(writers).toContain(functionKey(repositoryPath, 'OrderRepository.Save'));
    expect(writers).toContain(functionKey(repositoryPath, 'OrderRepository.Delete'));
    expect(writers).toContain(functionKey(repositoryPath, 'insertOrder'));
    for (const writer of writers) {
      expect(writer.startsWith(`code.function:${repositoryPath}#`) || writer.startsWith('code.file:'), writer).toBe(true);
    }
    const readers = edgesOf('code.reads-table').filter((edge) => edge.to === table).map((edge) => edge.from);
    for (const reader of ['OrderRepository.Get', 'OrderRepository.List', 'OrderRepository.FindByRequestID', 'OrderRepository.ListCreatedBefore']) {
      expect(readers, reader).toContain(functionKey(repositoryPath, reader));
    }
    expectAnchorsCited(item);
  });

  keyCase('table-access.order-items', (item) => {
    const table = tableKey('orders', 'order_items');
    const repositoryPath = 'services/orders/internal/store/order_repository.go';
    expect(edgesOf('code.writes-table').some((edge) => edge.to === table && edge.from === functionKey(repositoryPath, 'insertItems'))).toBe(true);
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from === functionKey(repositoryPath, 'attachItems'))).toBe(true);
    expect(oneEdge('code.foreign-key', table, tableKey('orders', 'orders')).properties['onDelete']).toBe('CASCADE');
    expectAnchorsCited(item);
  });

  keyCase('table-access.outbox', (item) => {
    const table = tableKey('orders', 'outbox');
    expect(edgesOf('code.writes-table').some((edge) => edge.to === table && edge.from === functionKey('services/orders/internal/store/outbox.go', 'OutboxWriter.Write'))).toBe(true);
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from === functionKey('services/orders/internal/relay/relay.go', 'Relay.Flush'))).toBe(true);
    expect(edgesOf('code.writes-table').some((edge) => edge.to === table && edge.from === functionKey('services/orders/internal/relay/relay.go', 'Relay.markPublished'))).toBe(true);
    expectAnchorsCited(item);
  });

  keyCase('table-access.customers', (item) => {
    const table = tableKey('orders', 'customers');
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from === functionKey('services/orders/internal/store/order_repository.go', 'OrderRepository.CustomerExists'))).toBe(true);
    const writers = edgesOf('code.writes-table').filter((edge) => edge.to === table).map((edge) => edge.from);
    expect(writers).toEqual([fileKey('scripts/seed-orders.sql')]);
    expectAnchorsCited(item);
  });

  keyCase('table-access.payments', (item) => {
    const table = tableKey('payments', 'payments');
    const repository = 'services/payments/src/store/payment-repository.ts';
    expect(edgesOf('code.writes-table').some((edge) => edge.to === table && edge.from === functionKey(repository, 'PrismaPaymentRepository.create'))).toBe(true);
    expect(edgesOf('code.writes-table').some((edge) => edge.to === table && edge.from === functionKey(repository, 'PrismaPaymentRepository.save'))).toBe(true);
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from === functionKey(repository, 'PrismaPaymentRepository.findById'))).toBe(true);
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from === functionKey(repository, 'PrismaPaymentRepository.findByIdempotencyKey'))).toBe(true);
    const reportReads = edgesOf('code.reads-table').filter((edge) => edge.to === table && edge.from.startsWith('code.function:services/payments/src/api/legacy-report.ts#'));
    expect(reportReads.length > 0, 'the legacy report reads payments').toBe(true);
    expect(edgesOf('code.writes-table').some((edge) => edge.to === table && edge.from.startsWith('code.function:services/payments/src/api/legacy-report.ts#'))).toBe(false);
    expectAnchorsCited(item);
  });

  keyCase('table-access.refunds', (item) => {
    const table = tableKey('payments', 'refunds');
    const repository = 'services/payments/src/store/payment-repository.ts';
    expect(edgesOf('code.writes-table').some((edge) => edge.to === table && edge.from === functionKey(repository, 'PrismaPaymentRepository.addRefund'))).toBe(true);
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from === functionKey(repository, 'PrismaPaymentRepository.refundedTotal'))).toBe(true);
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from.startsWith('code.function:services/payments/src/api/legacy-report.ts#'))).toBe(true);
    expectAnchorsCited(item);
  });

  keyCase('table-access.promotions', (item) => {
    const table = tableKey('promotions', 'promotions');
    expect(edgesOf('code.reads-table').some((edge) => edge.to === table && edge.from === functionKey('services/promotions/internal/store/promotions.go', 'Repository.FindActive'))).toBe(true);
    const writers = edgesOf('code.writes-table').filter((edge) => edge.to === table).map((edge) => edge.from);
    expect(writers).toEqual([fileKey('scripts/seed-promotions.sql')]);
    expectAnchorsCited(item);
  });
});

describe('outbox items (answer key)', () => {
  keyCase('outbox.table', (item) => {
    const table = node(tableKey('orders', 'outbox'));
    expect(spanText(table.span!)).toContain('CREATE TABLE outbox');
    expect(node(columnKey('orders', 'outbox', 'published_at')).properties['nullable']).toBe(true);
    expect(node(columnKey('orders', 'outbox', 'payload')).properties['type']).toBe('JSONB');
    const index = node(indexKey('orders', 'outbox', 'outbox_unpublished_idx'));
    expect(index.properties['columns']).toEqual(['id']);
    expect(index.properties['where']).toBe('published_at IS NULL');
  });

  keyCase('outbox.writer', (item) => {
    const outbox = tableKey('orders', 'outbox');
    const write = oneEdge('code.writes-table', functionKey('services/orders/internal/store/outbox.go', 'OutboxWriter.Write'), outbox);
    expect(write.properties['via']).toBe('sql');
    expect(spanText(write.span!)).toContain('INSERT INTO outbox');
    const repositoryPath = 'services/orders/internal/store/order_repository.go';
    for (const caller of ['OrderRepository.Create', 'OrderRepository.Save', 'OrderRepository.Delete']) {
      const edge = oneEdge('code.writes-table', functionKey(repositoryPath, caller), outbox);
      expect(edge.properties['callee']).toBe('OutboxWriter.Write');
    }
    const create = oneEdge('code.writes-table', functionKey(repositoryPath, 'OrderRepository.Create'), outbox);
    expect(citedTexts(create).some((text) => text.includes('r.outbox.Write(ctx, tx, changeOf(order))'))).toBe(true);
    expectAnchorsCited(item);
  });

  keyCase('outbox.relay', (item) => {
    const outbox = tableKey('orders', 'outbox');
    const flush = oneEdge('code.reads-table', functionKey('services/orders/internal/relay/relay.go', 'Relay.Flush'), outbox);
    const cited = citedTexts(flush).join('\n');
    expect(cited).toContain('published_at IS NULL');
    expect(cited).toContain('FOR UPDATE SKIP LOCKED');
    const mark = oneEdge('code.writes-table', functionKey('services/orders/internal/relay/relay.go', 'Relay.markPublished'), outbox);
    expect(citedTexts(mark).join('\n')).toContain('UPDATE outbox SET published_at');
    expectAnchorsCited(item);
  });

  keyCase('outbox.chain', () => {
    const repositoryPath = 'services/orders/internal/store/order_repository.go';
    expect(edgesBetween('code.writes-table', functionKey(repositoryPath, 'OrderRepository.Create'), tableKey('orders', 'orders')).length > 0).toBe(true);
    expect(edgesBetween('code.writes-table', functionKey(repositoryPath, 'OrderRepository.Create'), tableKey('orders', 'outbox')).length > 0).toBe(true);
    expect(edgesBetween('code.reads-table', functionKey('services/orders/internal/relay/relay.go', 'Relay.Flush'), tableKey('orders', 'outbox')).length > 0).toBe(true);
    expect(edgesBetween('code.writes-table', functionKey('services/orders/internal/relay/relay.go', 'Relay.markPublished'), tableKey('orders', 'outbox')).length > 0).toBe(true);
  });

  test.todo('outbox.adr: a document-fact; docs/adr/0002-outbox.md is the documents extractor input, not a data-model record');
});

function columnsOf(database: string, table: string): string[] {
  const prefix = `${tableKey(database, table)}/`;
  return extraction.nodes
    .filter((record) => record.kind === 'code.column' && record.key.startsWith(prefix))
    .map((record) => record.key.slice(prefix.length))
    .sort(byCodePoint);
}
