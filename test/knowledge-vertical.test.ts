/**
 * The first vertical end to end (decision 0029, epic madarch-m38l): the
 * generated training repository is filled into a product by the wiki's own
 * fill, and the pages a reader walks are rendered from the product's templates
 * and Markdown: the payments service, a function with its callers, its source
 * and its place in the repository. The expected values are the answer key's
 * (examples/training-repository/answer-key.json) and the generated repository's
 * own files, never this engine's output.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { FACTORY, MISSING, PAY, PAYMENTS_SERVICE, ROOT, generateTrainingRepository, makeProduct, recordKey, writeSamplePages } from './knowledge-fixture.js';

const KEY = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as {
  snapshots: Record<string, string>;
  items: { id: string; location?: { path: string; symbol?: string; anchor?: string }; locations?: { path: string; symbol?: string; anchor?: string }[]; judge: { mustShow: string[]; mustLink: string[] } }[];
};
const item = (id: string) => {
  const found = KEY.items.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`the answer key has no item ${id}`);
  return found;
};

let work: string;
let repository: string;
let product: KnowledgeProduct;
let folder: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-knowledge-vertical-'));
  repository = generateTrainingRepository(join(work, 'repo'));
  mkdirSync(join(work, 'home'));
  folder = makeProduct(join(work, 'home'), 'training-shop', repository);
  writeSamplePages(folder);
  product = new KnowledgeProduct({ productFolder: folder, storeRoot: join(work, 'store') });
  const started = await product.startFill();
  expect(started).toMatchObject({ started: true });
  await product.settled();
  expect(product.fillState()).toMatchObject({ state: 'done' });
}, 900_000);

afterAll(async () => {
  await product.close();
  rmSync(work, { recursive: true, force: true });
});

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
async function page(id: string): Promise<PageModel> {
  const result = await product.page(id);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}
const block = <T extends Block['type']>(model: PageModel, type: T, at = 0): Extract<Block, { type: T }> => model.blocks.filter((entry) => entry.type === type)[at] as Extract<Block, { type: T }>;

/** The first line of a file at the final snapshot that holds the text, 1-based, read from git. */
function lineOf(path: string, text: string): number {
  const lines = git('show', `${KEY.snapshots['snapshot-final']}:${path}`).split('\n');
  const at = lines.findIndex((line) => line.includes(text));
  if (at < 0) throw new Error(`${path} at snapshot-final holds no line with ${JSON.stringify(text)}`);
  return at + 1;
}

describe('the payments service page', () => {
  test('it names the stack the answer key gives (TypeScript, Express) and lists the files the key says a reader must be able to reach', async () => {
    const model = await page(PAYMENTS_SERVICE);
    expect(model.title).toBe('payments');
    const intro = block(model, 'markdown').markdown;
    expect(intro).toContain('typescript');
    expect(intro).toContain('express');
    const files = block(model, 'related', 0).groups[0]!.rows.map((row) => row.entity.id);
    // The files the key makes a reader reach in the payments service: the port and gRPC entry, the request chain, the factory and the timeout.
    const reached = ['service.payments', 'flow.payments.chain', 'pattern.factory', 'payments.timeout']
      .flatMap((id) => [item(id).location, ...(item(id).locations ?? [])])
      .flatMap((location) => (location === undefined ? [] : [location.path]))
      .filter((path) => path.startsWith('services/payments/src/') && path.endsWith('.ts'));
    expect(reached.length).toBeGreaterThanOrEqual(6);
    for (const path of new Set(reached)) expect(files).toContain(recordKey('code.file', path));
    expect(files.every((id) => id.startsWith(recordKey('code.file', 'services/payments/')))).toBe(true);
    expect(model.findings).toEqual([]);
  });

  test('every file on the page is a link to the file\'s page, and the graph block draws the service with its package', async () => {
    const model = await page(PAYMENTS_SERVICE);
    const rows = block(model, 'related', 0).groups[0]!.rows;
    expect(rows.every((row) => row.entity.href === `/k/e/${encodeURIComponent(row.entity.id)}`)).toBe(true);
    expect(block(model, 'graph').neighborhood.edges.some((edge) => edge.relation === 'code.contains')).toBe(true);
  });
});

describe('the function page', () => {
  test('PaymentService.pay shows the callers the answer key names, each with the place it calls from, and the callees down to the repository', async () => {
    const model = await page(PAY);
    const route = item('flow.payments.chain').locations!.find((entry) => entry.symbol === 'paymentRoutes')!;
    const callers = block(model, 'callers');
    expect(callers.rows.map((row) => row.entity.label)).toContain('paymentRoutes');
    const fromRoutes = callers.rows.find((row) => row.entity.label === 'paymentRoutes')!;
    expect(fromRoutes.site!.path).toBe(route.path);
    expect(fromRoutes.site!.repo).toBe('training');
    expect(fromRoutes.site!.lineStart).toBe(lineOf(route.path, 'service.pay('));
    expect(fromRoutes.site!.href).toBe(`/k/src?repo=training&path=${encodeURIComponent(route.path)}&line=${fromRoutes.site!.lineStart}`);
    const stores = block(model, 'callees').rows.map((row) => row.entity.id);
    expect(stores).toContain(recordKey('code.symbol', 'services/payments/src/store/payment-repository.ts#PrismaPaymentRepository.create'));
  });

  test('the source block is the declaration of pay: the file, the line the key anchors it at and the lines up to the closing brace', async () => {
    const model = await page(PAY);
    const declared = item('flow.payments.chain').locations!.find((entry) => entry.symbol === 'async pay')!;
    const source = block(model, 'source');
    expect(source.location.path).toBe(declared.path);
    expect(source.location.lineStart).toBe(lineOf(declared.path, 'async pay('));
    const lines = git('show', `${KEY.snapshots['snapshot-final']}:${declared.path}`).split('\n');
    const closing = lines.findIndex((line, at) => at + 1 > source.location.lineStart && line === '  }') + 1;
    expect(source.location.lineEnd).toBe(closing);
    expect(source.text).toBe(lines.slice(source.location.lineStart - 1, closing).join('\n'));
    expect(source.text.startsWith('  async pay(')).toBe(true);
    expect(source.text).toContain(item('payments.timeout').locations!.find((entry) => entry.symbol === 'pay')!.anchor!);
    expect(source.language).toBe('typescript');
    expect(source.truncated).toBe(false);
    expect(model.trail.map((entry) => entry.label)).toEqual(['payments', 'services/payments/src/domain', 'payment-service.ts']);
  });

  test('the factory\'s page holds the anchored switch of the answer key, and the chain from pay is a sequence of its steps down to the table', async () => {
    const factory = item('pattern.factory').location!;
    const model = await page(FACTORY);
    expect(block(model, 'source').text).toContain(factory.anchor!);
    const [chain] = block(await page(PAY), 'sequence').chains;
    expect(chain!.lanes.map((lane) => lane.label)).toContain('payment-service.ts');
    expect(chain!.steps.map((step) => step.label)).toContain('withTimeout');
  });
});

describe('the pages an agent wrote, over the filled graph', () => {
  test('the home page is the product page; its ground to the payments service resolves and so does the requirement section it names', async () => {
    const status = await product.status();
    expect(status.home).toBe('product:shop');
    const model = await page('product:shop');
    expect(model.resolutions[`madarch:${PAYMENTS_SERVICE}`]).toMatchObject({ state: 'ok', label: 'payments' });
    const useCase = model.resolutions['madarch:doc:docs/requirements.md#uc-2'];
    expect(useCase?.state).toBe('ok');
    expect(useCase !== undefined && useCase.state === 'ok' ? useCase.href : '').toBe('/k/doc?repo=training&path=docs%2Frequirements.md#uc-2');
    expect(model.findings).toEqual([]);
  });

  test('the domain page shows its broken ground as broken and its ungrounded statement as one, and its grounds that hold open the function', async () => {
    const model = await page('domain:payment');
    expect(model.resolutions[`madarch:${MISSING}`]).toMatchObject({ state: 'broken' });
    expect(model.resolutions[`madarch:${FACTORY}`]).toMatchObject({ state: 'ok', href: `/k/e/${encodeURIComponent(FACTORY)}` });
    expect(model.resolutions[`madarch:${PAY}`]).toMatchObject({ state: 'ok', label: 'PaymentService.pay' });
    expect(block(model, 'body').ungrounded.map((statement) => statement.text)).toEqual(['A refund that brings the refunded total up to the captured amount moves the order to refunded.']);
    expect(model.findings.map((finding) => finding.message)).toEqual([expect.stringContaining('a ground does not resolve: no entity')]);
    const implemented = block(model, 'related');
    expect(implemented.groups[0]!.rows.map((row) => row.entity.id)).toEqual([PAYMENTS_SERVICE, PAY]);
  });

  test('the service page names the pages that are about it', async () => {
    const model = await page(PAYMENTS_SERVICE);
    const described = block(model, 'related', 1);
    expect(described.groups[0]!.rows.map((row) => row.entity.id)).toEqual(['domain:payment', 'product:shop']);
  });
});

describe('the whole wiki after the fill', () => {
  test('the kinds are counted and the repository is marked filled; a refill of the unchanged repository leaves every page as it was', async () => {
    const status = await product.status();
    expect(status).toMatchObject({ manifest: 'ok', filled: true, repositories: [{ name: 'training', filled: true }], fill: { state: 'done' } });
    expect(status.kinds.find((kind) => kind.kind === 'code.service')!.count).toBe(4);
    expect(status.kinds.find((kind) => kind.kind === 'domain')!.count).toBe(1);
    const before = await page(PAY);
    expect(await product.startFill()).toMatchObject({ started: true });
    await product.settled();
    expect(await page(PAY)).toEqual(before);
  }, 600_000);
});
