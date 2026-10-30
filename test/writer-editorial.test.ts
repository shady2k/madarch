
/**
 * The editorial pass (madarch-ztyq.9): deterministic checks first — a fact two pages state with
 * different values, a glossary term used under another name, an internal identifier in reader
 * prose — then a bounded editing judge over the pages themselves. The pass never writes a page:
 * it returns findings and bounded revision requests, and every one is a journal entry.
 *
 * Fixtures only: pages built here, a glossary passage the product holds, and a scripted editing
 * judge. No model, no network.
 */
import { describe, expect, test } from 'bun:test';
import { memoryJournal } from '../src/writer/journal.js';
import {
  runEditorialPass,
  type EditorialGraph,
  type EditorialJudge,
  type EditorialPage,
} from '../src/writer/editorial.js';
import type { DocEntity } from '../src/knowledge/doc-entities.js';

const front = (id: string, kind: string, title: string): string[] => ['---', `id: ${id}`, `kind: ${kind}`, `title: ${title}`, 'relates: []', 'producer: agent', 'sources: []', '---', ''];

const page = (path: string, title: string, body: string): EditorialPage => ({
  path,
  title,
  text: [...front(path === 'docs/product.md' ? 'product:tiny-shop' : path.startsWith('docs/domains/') ? 'domain:refunds' : 'page', path === 'docs/product.md' ? 'product' : 'domain', title), '## What it does', '', body, ''].join('\n'),
});

const ground = (label: string, target: string): string => `[^${label}]: [${label}](${target})`;

const refundA = page('docs/product.md', 'Tiny shop', [
  'The refund window is 14 days from the delivery date.[^window]',
  '',
  ground('window', 'madarch:doc:docs/requirements.md#refunds'),
].join('\n'));

const refundB = page('docs/domains/refunds.md', 'Refunds', [
  'The refund window is 30 days from the delivery date.[^window]',
  '',
  ground('window', 'madarch:doc:docs/requirements.md#refunds'),
  '[^proof]: [proof](madarch:doc:docs/requirements.md#payments)',
  '',
  'A shopper asks for a payment proof when the card statement does not name the store.[^proof]',
].join('\n'));

const term: DocEntity = {
  id: 'doc:docs/glossary.md#doc-section:1', kind: 'doc.term', title: 'Payment token', identifier: null, repo: null,
  path: 'docs/glossary.md', anchor: 'payment-token', aliases: ['payment-token'], line: 3, endLine: 6,
  text: 'The proof a provider returns when it captured money.\n- Also called: payment proof', stableId: 'doc-section:1',
  semantics: 'term', pass: 'metadata', headingPath: ['Glossary'],
};

const graph: EditorialGraph = {
  async find(options) {
    const nodes = [
      { kind: 'code.file', key: 'code.file:services/orders/src/order.go', label: 'services/orders/src/order.go', properties: { path: 'services/orders/src/order.go' } },
      { kind: 'code.symbol', key: 'code.symbol:services/orders/src/order.go#takePayment', label: 'takePayment', properties: {} },
    ].filter((node) => options.kind === undefined || node.kind === options.kind);
    return { nodes, next: null };
  },
};

const noJudge = (): EditorialJudge => ({ judge: async () => ({ requests: [] }) });

describe('the deterministic editorial checks (madarch-ztyq.9)', () => {
  test('two pages stating the same fact with different values are a finding, and one bounded request names the passage to change', async () => {
    const result = await runEditorialPass({ pages: [refundA, refundB], documentEntities: [term], graph, judge: noJudge(), maxPerPage: 1 });
    const conflict = result.findings.find((finding) => finding.kind === 'conflicting-fact');
    expect(conflict).toMatchObject({ page: 'docs/domains/refunds.md', value: '30', otherPage: 'docs/product.md', otherValue: '14' });
    expect(conflict?.passage).toBe('window');
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ page: 'docs/domains/refunds.md', passage: 'window', source: 'deterministic' });
  });

  test('a glossary term used under another name is caught from the glossary passage, not a word list', async () => {
    const result = await runEditorialPass({ pages: [refundB], documentEntities: [term], graph, judge: noJudge(), maxPerPage: 2 });
    const alias = result.findings.find((finding) => finding.kind === 'glossary-alias');
    expect(alias).toMatchObject({ page: 'docs/domains/refunds.md', term: 'Payment token', used: 'payment proof' });
    expect(result.requests.some((request) => request.page === 'docs/domains/refunds.md' && request.change.includes('Payment token'))).toBe(true);
  });

  test('an internal identifier in reader prose is caught from the graph’s own keys', async () => {
    const prose = page('docs/domains/refunds.md', 'Refunds', [
      'Orders are taken in services/orders/src/order.go before the payment is captured.[^orders]',
      '',
      ground('orders', 'madarch:code.file:services/orders/src/order.go'),
    ].join('\n'));
    const result = await runEditorialPass({ pages: [prose], documentEntities: [], graph, judge: noJudge(), maxPerPage: 2 });
    const found = result.findings.find((finding) => finding.kind === 'internal-identifier');
    expect(found).toMatchObject({ page: 'docs/domains/refunds.md', identifier: 'services/orders/src/order.go' });
  });
  test('a label inside a fenced code block is code, not a glossary synonym', async () => {
    const fenced: DocEntity = { ...term, text: 'The proof a provider returns when it captured money.\n```\n- Also called: card voucher\n```' };
    const prose = page('docs/domains/refunds.md', 'Refunds', [
      'The card voucher arrives after the capture.[^proof]',
      '',
      ground('proof', 'madarch:doc:docs/requirements.md#payments'),
    ].join('\n'));
    const result = await runEditorialPass({ pages: [prose], documentEntities: [fenced], graph, judge: noJudge(), maxPerPage: 2 });
    expect(result.findings.filter((finding) => finding.kind === 'glossary-alias')).toEqual([]);
  });

  test('a grounded sentence is read whole, so an abbreviation does not truncate it', async () => {
    let read: string[] = [];
    const prose = page('docs/domains/refunds.md', 'Refunds', [
      'Dr. Smith approves the refund after 14 days.[^window]',
      '',
      ground('window', 'madarch:doc:docs/requirements.md#refunds'),
    ].join('\n'));
    const judge: EditorialJudge = { judge: async (pack) => { read = pack.pages.flatMap((held) => held.statements.map((statement) => statement.text)); return { requests: [] }; } };
    await runEditorialPass({ pages: [prose], documentEntities: [], graph, judge, maxPerPage: 2 });
    expect(read).toEqual(['Dr. Smith approves the refund after 14 days.']);
  });

  test('numbers are compared by value: 9 and 14 days conflict, 9 and 09 days or 1,000 and 1000 units do not', async () => {
    const nine = page('docs/product.md', 'Tiny shop', ['The refund window is 9 days.[^window]', '', ground('window', 'madarch:doc:docs/requirements.md#refunds')].join('\n'));
    const fourteen = page('docs/domains/refunds.md', 'Refunds', ['The refund window is 14 days.[^window]', '', ground('window', 'madarch:doc:docs/requirements.md#refunds')].join('\n'));
    const conflict = await runEditorialPass({ pages: [nine, fourteen], documentEntities: [], graph, judge: noJudge(), maxPerPage: 2 });
    expect(conflict.findings.find((finding) => finding.kind === 'conflicting-fact')).toMatchObject({ value: '14', otherValue: '9' });
    const leading = page('docs/domains/refunds.md', 'Refunds', ['The refund window is 09 days.[^window]', '', ground('window', 'madarch:doc:docs/requirements.md#refunds')].join('\n'));
    const same = await runEditorialPass({ pages: [nine, leading], documentEntities: [], graph, judge: noJudge(), maxPerPage: 2 });
    expect(same.findings.filter((finding) => finding.kind === 'conflicting-fact')).toEqual([]);
    const thousand = page('docs/product.md', 'Tiny shop', ['The shop keeps 1,000 units.[^stock]', '', ground('stock', 'madarch:doc:docs/requirements.md#stock')].join('\n'));
    const plain = page('docs/domains/refunds.md', 'Refunds', ['The shop keeps 1000 units.[^stock]', '', ground('stock', 'madarch:doc:docs/requirements.md#stock')].join('\n'));
    const equal = await runEditorialPass({ pages: [thousand, plain], documentEntities: [], graph, judge: noJudge(), maxPerPage: 2 });
    expect(equal.findings.filter((finding) => finding.kind === 'conflicting-fact')).toEqual([]);
  });

  test('a judge that fails is a journaled warning, and the deterministic findings still stand', async () => {
    const journal = memoryJournal('run-editorial-warning');
    const result = await runEditorialPass({
      pages: [refundA, refundB], documentEntities: [], graph, maxPerPage: 2, journal,
      judge: { judge: async () => { throw new Error('the editing model is down'); } },
    });
    expect(result.errors.some((error) => error.includes('the editing model is down'))).toBe(true);
    expect(result.findings.some((finding) => finding.kind === 'conflicting-fact')).toBe(true);
    const warning = journal.records.find((record) => record.kind === 'editorial-warning');
    expect(warning?.arguments).toMatchObject({ message: expect.stringContaining('the editing model is down') });
  });
});

describe('the editing judge (madarch-ztyq.9)', () => {
  test('its requests are bounded per page and by the passages it was shown, and every finding and request is journaled', async () => {
    const journal = memoryJournal('run-editorial');
    const seen: string[] = [];
    const judge: EditorialJudge = {
      async judge(pack) {
        seen.push(...pack.pages.map((held) => held.path));
        expect(pack.maxPerPage).toBe(1);
        expect(pack.pages.find((held) => held.path === 'docs/product.md')?.statements.some((statement) => statement.id === 'window')).toBe(true);
        return {
          requests: [
            { page: 'docs/product.md', passage: 'window', change: 'Say what the refund window protects.', why: 'A newcomer cannot tell whether it is a guarantee.' },
            { page: 'docs/product.md', passage: 'window', change: 'Second request on the same page.', why: 'Beyond the bound.' },
            { page: 'docs/product.md', passage: 'not-shown', change: 'Invented passage.', why: 'Must be refused.' },
            { page: 'docs/unknown.md', passage: 'window', change: 'Unknown page.', why: 'Must be refused.' },
          ],
        };
      },
    };
    const result = await runEditorialPass({ pages: [refundA, refundB], documentEntities: [], graph, judge, maxPerPage: 1, journal });
    expect(seen).toEqual(['docs/product.md', 'docs/domains/refunds.md']);
    expect(result.requests.filter((request) => request.source === 'editing')).toHaveLength(1);
    expect(result.requests.filter((request) => request.source === 'deterministic')).toHaveLength(1);
    expect(result.requests.find((request) => request.source === 'editing')?.change).toBe('Say what the refund window protects.');
    expect(result.errors.some((error) => error.includes('not-shown'))).toBe(true);
    expect(result.errors.some((error) => error.includes('docs/unknown.md'))).toBe(true);
    const kinds = journal.records.map((record) => record.kind);
    expect(kinds).toContain('editorial-finding');
    expect(kinds).toContain('revision-request');
    expect(journal.records.filter((record) => record.kind === 'revision-request')).toHaveLength(result.requests.length);
  });

  test('the host’s jev reads first, and the editing role is asked only about the pages the jev did not read', async () => {
    const order: string[] = [];
    const jev: EditorialJudge = {
      async judge(pack) {
        order.push(`jev:${pack.pages.map((page) => page.path).join(',')}`);
        return {
          requests: [{ page: 'docs/product.md', passage: 'window', change: 'Say who pays the refund.', why: 'A newcomer cannot tell.' }],
          unreviewedPages: ['docs/domains/refunds.md'],
        };
      },
    };
    const role: EditorialJudge = {
      async judge(pack) {
        order.push(`editing:${pack.pages.map((page) => page.path).join(',')}`);
        return { requests: [{ page: 'docs/domains/refunds.md', passage: 'window', change: 'Say when the window starts.', why: 'It is not stated here.' }] };
      },
    };
    const result = await runEditorialPass({ pages: [refundA, refundB], documentEntities: [], graph, jev, judge: role, maxPerPage: 2 });
    expect(order).toEqual(['jev:docs/product.md,docs/domains/refunds.md', 'editing:docs/domains/refunds.md']);
    expect(result.requests.filter((request) => request.source === 'jev')).toHaveLength(1);
    expect(result.requests.filter((request) => request.source === 'editing')).toHaveLength(1);
  });

  test('a jev that read every page is the only model asked; a jev that fails hands every page to the editing role', async () => {
    let roleCalls = 0;
    const readAll: EditorialJudge = { judge: async () => ({ requests: [] }) };
    const first = await runEditorialPass({
      pages: [refundA, refundB], documentEntities: [], graph, maxPerPage: 2,
      jev: readAll,
      judge: { judge: async () => { roleCalls += 1; return { requests: [] }; } },
    });
    expect(first.errors).toEqual([]);
    expect(roleCalls).toBe(0);
    const failed = await runEditorialPass({
      pages: [refundA, refundB], documentEntities: [], graph, maxPerPage: 2,
      jev: { judge: async () => { throw new Error('the host judge is down'); } },
      judge: { judge: async () => { roleCalls += 1; return { requests: [] }; } },
    });
    expect(failed.errors.some((error) => error.includes('the host judge is down'))).toBe(true);
    expect(roleCalls).toBe(1);
  });

  test('with no editing judge the deterministic checks still run, and the journal says why the reading part was skipped', async () => {
    const journal = memoryJournal('run-editorial-skip');
    const result = await runEditorialPass({
      pages: [refundA, refundB], documentEntities: [], graph, maxPerPage: 2, journal,
      point: 'batch',
      skipReason: 'the editing role resolves to no pair',
    });
    expect(result.skipped).toBe('the editing role resolves to no pair');
    expect(result.findings.some((finding) => finding.kind === 'conflicting-fact')).toBe(true);
    expect(result.requests.some((request) => request.source === 'deterministic')).toBe(true);
    const skip = journal.records.find((record) => record.kind === 'editorial-skip');
    expect(skip?.arguments).toMatchObject({ reason: 'the editing role resolves to no pair', point: 'batch' });
    expect(journal.records.find((record) => record.kind === 'revision-request')?.arguments).toMatchObject({ point: 'batch' });
  });

  test('the pass itself writes no page', async () => {
    const writes: string[] = [];
    const before = [refundA.text, refundB.text];
    await runEditorialPass({
      pages: [refundA, refundB], documentEntities: [term], graph,
      judge: { judge: async () => ({ requests: [{ page: 'docs/product.md', passage: 'window', change: 'Change it.', why: 'Because.' }] }) },
      maxPerPage: 2, onWrite: (path) => writes.push(path),
    });
    expect(writes).toEqual([]);
    expect([refundA.text, refundB.text]).toEqual(before);
  });
});
