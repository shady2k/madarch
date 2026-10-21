/*
 * Settlement and reconciliation reports for finance.
 *
 * This file was ported from the monthly billing script of the previous
 * platform when payments moved to Express. The report queries still build
 * their SQL by hand the way the script did, and the output formats (json,
 * csv, html, xml) are the ones finance's spreadsheets already import, so
 * please do not change a column name or the order of columns without asking
 * them first.
 *
 * Endpoint:  GET /reports/legacy?report=<name>&format=<json|csv|html|xml>
 *
 * Reports:   daily-settlement, refund-register, declines, aging,
 *            provider-split, currency-summary, invoice-lines
// @@ since report-extras
 *            order-ledger, reconciliation
// @@ end
 *
 * Filters:   from, to      (YYYY-MM-DD, inclusive, on created_at)
 *            status        (pending | captured | declined | refunded)
 *            currency      (EUR, USD...)
 *            order         (an order id)
 *            provider      (cardnet | deferred)
 *            sort          (a column name of the report)
 *            limit         (rows, default 5000)
 */
import { Request, Response, Router } from 'express';
import { PrismaClient } from '@prisma/client';
import _ from 'lodash';
// @@ since legacy-report until drop-legacy-format
import { formatInvoiceLegacy, formatMoney } from '../format';
// @@ end
// @@ since drop-legacy-format
import { formatMoney } from '../format';
// @@ end

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface ReportColumn {
  key: string;
  title: string;
  /** How the value is written in csv/html/xml; defaults to String(value). */
  format?: (value: unknown, row: Row) => string;
}

interface ReportResult {
  name: string;
  title: string;
  columns: ReportColumn[];
  rows: Row[];
  /** Footer line finance reads first: totals across all rows. */
  totals?: Row;
}

interface ReportFilters {
  from?: string;
  to?: string;
  status?: string;
  currency?: string;
  order?: string;
  provider?: string;
  sort?: string;
  limit: number;
}

type ReportBuilder = (prisma: PrismaClient, filters: ReportFilters) => Promise<ReportResult>;

const DEFAULT_LIMIT = 5000;
const FORMATS = ['json', 'csv', 'html', 'xml'];

// ---------------------------------------------------------------------------
// Small helpers (kept local; the old script had them inline)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function isoStamp(d: Date): string {
  return `${isoDay(d)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function asNumber(value: unknown): number {
  // $queryRawUnsafe returns bigint for COUNT(*) and SUM(): normalise before arithmetic.
  if (typeof value === 'bigint') {
    return Number(value);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function first(value: unknown): string | undefined {
  // Express gives string | string[] | ParsedQs | ParsedQs[]; the old script only ever saw strings.
  if (Array.isArray(value)) {
    return first(value[0]);
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cell(column: ReportColumn, row: Row): string {
  const value = row[column.key];
  if (column.format) {
    return column.format(value, row);
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return isoStamp(value);
  }
  return String(value);
}

const money: ReportColumn['format'] = (value, row) => formatMoney(asNumber(value), String(row.currency ?? 'EUR'));

// ---------------------------------------------------------------------------
// Filters and the WHERE clause
// ---------------------------------------------------------------------------

function readFilters(req: Request): ReportFilters {
  const limit = Number(first(req.query.limit));
  return {
    from: first(req.query.from),
    to: first(req.query.to),
    status: first(req.query.status),
    currency: first(req.query.currency),
    order: first(req.query.order),
    provider: first(req.query.provider),
    sort: first(req.query.sort),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50000) : DEFAULT_LIMIT,
  };
}

/**
 * Builds the WHERE clause the way the old script did: the filter values are
 * pasted into the SQL text as they arrive in the query string.
 * FIXME: parameterize these queries before the endpoint leaves the internal network.
 */
function whereClause(filters: ReportFilters, alias = 'p'): string {
  let where = ' WHERE 1 = 1';
  if (filters.from) {
    where += ` AND ${alias}.created_at >= '${filters.from} 00:00:00'`;
  }
  if (filters.to) {
    where += ` AND ${alias}.created_at <= '${filters.to} 23:59:59'`;
  }
  if (filters.status) {
    where += ` AND ${alias}.status = '` + filters.status + `'`;
  }
  if (filters.currency) {
    where += ` AND ${alias}.currency = '` + filters.currency + `'`;
  }
  if (filters.order) {
    // The order id comes straight from the query string: this is the injectable input.
    where += ` AND ${alias}.order_id = '` + filters.order + `'`;
  }
  if (filters.provider === 'deferred') {
    where += ` AND ${alias}.provider_reference LIKE 'def_%'`;
  } else if (filters.provider) {
    where += ` AND ${alias}.provider_reference NOT LIKE 'def_%'`;
  }
  return where;
}

function orderBy(filters: ReportFilters, allowed: string[], fallback: string): string {
  // The sort column is pasted too, but only when it names one of the report's columns.
  const wanted = filters.sort && allowed.includes(filters.sort.replace(/^-/, '')) ? filters.sort : fallback;
  const descending = wanted.startsWith('-');
  return ` ORDER BY ${wanted.replace(/^-/, '')} ${descending ? 'DESC' : 'ASC'}`;
}

function limitClause(filters: ReportFilters): string {
  return ` LIMIT ${filters.limit}`;
}

async function query(prisma: PrismaClient, sql: string): Promise<Row[]> {
  return (await prisma.$queryRawUnsafe(sql)) as Row[];
}

// ---------------------------------------------------------------------------
// Report: daily-settlement
// One row per day and currency: what was captured, what was refunded, the net.
// ---------------------------------------------------------------------------

const dailySettlement: ReportBuilder = async (prisma, filters) => {
  const where = whereClause(filters);
  const sql =
    'SELECT date(p.created_at) AS day, p.currency AS currency,' +
    ' COUNT(*) AS payments,' +
    " SUM(CASE WHEN p.status IN ('captured', 'refunded') THEN p.amount_cents ELSE 0 END) AS captured_cents," +
    ' COALESCE(SUM(r.refunded_cents), 0) AS refunded_cents' +
    ' FROM payments p' +
    ' LEFT JOIN (SELECT payment_id, SUM(amount_cents) AS refunded_cents FROM refunds GROUP BY payment_id) r' +
    ' ON r.payment_id = p.id' +
    where +
    ' GROUP BY date(p.created_at), p.currency' +
    orderBy(filters, ['day', 'currency', 'payments', 'captured_cents', 'refunded_cents'], 'day') +
    limitClause(filters);
  const rows: Row[] = (await query(prisma, sql)).map((row) => ({
    ...row,
    day: isoDay(asDate(row.day) ?? new Date(0)),
    net_cents: asNumber(row.captured_cents) - asNumber(row.refunded_cents),
  }));

  const totals: Row = {
    day: 'total',
    currency: '',
    payments: _.sumBy(rows, (r) => asNumber(r.payments)),
    captured_cents: _.sumBy(rows, (r) => asNumber(r.captured_cents)),
    refunded_cents: _.sumBy(rows, (r) => asNumber(r.refunded_cents)),
    net_cents: _.sumBy(rows, (r) => asNumber(r.net_cents)),
  };
  return {
    name: 'daily-settlement',
    title: 'Daily settlement',
    columns: [
      { key: 'day', title: 'Day' },
      { key: 'currency', title: 'Currency' },
      { key: 'payments', title: 'Payments' },
      { key: 'captured_cents', title: 'Captured', format: money },
      { key: 'refunded_cents', title: 'Refunded', format: money },
      { key: 'net_cents', title: 'Net', format: money },
    ],
    rows,
    totals,
  };
};

// ---------------------------------------------------------------------------
// Report: refund-register
// Every refund with the payment it belongs to, newest first.
// ---------------------------------------------------------------------------

const refundRegister: ReportBuilder = async (prisma, filters) => {
  const where = whereClause(filters);
  const sql =
    'SELECT r.id AS refund_id, r.created_at AS refunded_at, r.amount_cents AS amount_cents,' +
    ' r.reason AS reason, p.id AS payment_id, p.order_id AS order_id, p.currency AS currency,' +
    ' p.amount_cents AS payment_cents' +
    ' FROM refunds r JOIN payments p ON p.id = r.payment_id' +
    where +
    orderBy(filters, ['refunded_at', 'amount_cents', 'order_id', 'currency'], '-refunded_at') +
    limitClause(filters);
  const rows = await query(prisma, sql);

  const byReason = _.countBy(rows, (r) => String(r.reason ?? 'none'));
  const totals: Row = {
    refund_id: 'total',
    amount_cents: _.sumBy(rows, (r) => asNumber(r.amount_cents)),
    reason: Object.entries(byReason)
      .map(([reason, count]) => `${reason}: ${count}`)
      .join('; '),
  };
  return {
    name: 'refund-register',
    title: 'Refund register',
    columns: [
      { key: 'refund_id', title: 'Refund' },
      { key: 'refunded_at', title: 'Refunded at' },
      { key: 'order_id', title: 'Order' },
      { key: 'payment_id', title: 'Payment' },
      { key: 'amount_cents', title: 'Amount', format: money },
      { key: 'payment_cents', title: 'Payment amount', format: money },
      { key: 'reason', title: 'Reason' },
    ],
    rows,
    totals,
  };
};

// ---------------------------------------------------------------------------
// Report: declines
// Why payments were declined, most frequent reason first.
// ---------------------------------------------------------------------------

const declines: ReportBuilder = async (prisma, filters) => {
  const scoped: ReportFilters = { ...filters, status: 'declined' };
  const where = whereClause(scoped);
  const sql =
    "SELECT COALESCE(p.decline_reason, 'unknown') AS reason, p.currency AS currency," +
    ' COUNT(*) AS declines, SUM(p.amount_cents) AS lost_cents,' +
    ' MIN(p.created_at) AS first_seen, MAX(p.created_at) AS last_seen' +
    ' FROM payments p' +
    where +
    ' GROUP BY p.decline_reason, p.currency' +
    orderBy(filters, ['reason', 'declines', 'lost_cents', 'first_seen', 'last_seen'], '-declines') +
    limitClause(filters);
  const rows = await query(prisma, sql);
  const total = _.sumBy(rows, (r) => asNumber(r.declines));

  return {
    name: 'declines',
    title: 'Declined payments by reason',
    columns: [
      { key: 'reason', title: 'Reason' },
      { key: 'currency', title: 'Currency' },
      { key: 'declines', title: 'Declines' },
      { key: 'share', title: 'Share' },
      { key: 'lost_cents', title: 'Not collected', format: money },
      { key: 'first_seen', title: 'First seen' },
      { key: 'last_seen', title: 'Last seen' },
    ],
    rows: rows.map((r) => ({
      ...r,
      share: total === 0 ? '0%' : `${Math.round((asNumber(r.declines) / total) * 100)}%`,
    })),
    totals: { reason: 'total', declines: total, lost_cents: _.sumBy(rows, (r) => asNumber(r.lost_cents)) },
  };
};

// ---------------------------------------------------------------------------
// Report: aging
// Payments that are still pending, grouped by how long they have been waiting.
// A pending payment older than an hour usually means a provider call died
// between the insert and the update.
// ---------------------------------------------------------------------------

const AGING_BUCKETS: Array<{ label: string; minMinutes: number; maxMinutes: number }> = [
  { label: 'under 1 hour', minMinutes: 0, maxMinutes: 60 },
  { label: '1 to 24 hours', minMinutes: 60, maxMinutes: 24 * 60 },
  { label: '1 to 7 days', minMinutes: 24 * 60, maxMinutes: 7 * 24 * 60 },
  { label: 'over 7 days', minMinutes: 7 * 24 * 60, maxMinutes: Number.MAX_SAFE_INTEGER },
];

const aging: ReportBuilder = async (prisma, filters) => {
  const scoped: ReportFilters = { ...filters, status: 'pending' };
  const where = whereClause(scoped);
  const sql =
    'SELECT p.id AS payment_id, p.order_id AS order_id, p.currency AS currency, p.amount_cents AS amount_cents,' +
    ' p.created_at AS created_at,' +
    ' EXTRACT(EPOCH FROM (now() - p.created_at)) / 60 AS age_minutes' +
    ' FROM payments p' +
    where +
    orderBy(filters, ['created_at', 'amount_cents', 'order_id'], 'created_at') +
    limitClause(filters);
  const rows = await query(prisma, sql);

  const buckets = AGING_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((r) => {
      const minutes = asNumber(r.age_minutes);
      return minutes >= bucket.minMinutes && minutes < bucket.maxMinutes;
    });
    return {
      bucket: bucket.label,
      payments: inBucket.length,
      amount_cents: _.sumBy(inBucket, (r) => asNumber(r.amount_cents)),
      currency: _.uniq(inBucket.map((r) => String(r.currency))).join(','),
    };
  });

  return {
    name: 'aging',
    title: 'Pending payments by age',
    columns: [
      { key: 'bucket', title: 'Waiting for' },
      { key: 'payments', title: 'Payments' },
      { key: 'amount_cents', title: 'Amount', format: money },
      { key: 'currency', title: 'Currency' },
    ],
    rows: buckets,
    totals: { bucket: 'total', payments: rows.length, amount_cents: _.sumBy(rows, (r) => asNumber(r.amount_cents)) },
  };
};

// ---------------------------------------------------------------------------
// Report: provider-split
// How much went through each provider. The provider is not a column: the
// deferred adapter's references start with "def_", cardnet's do not.
// ---------------------------------------------------------------------------

const providerSplit: ReportBuilder = async (prisma, filters) => {
  const where = whereClause({ ...filters, status: filters.status ?? 'captured' });
  const sql =
    "SELECT CASE WHEN p.provider_reference LIKE 'def_%' THEN 'deferred' ELSE 'cardnet' END AS provider," +
    ' p.currency AS currency, COUNT(*) AS payments, SUM(p.amount_cents) AS amount_cents,' +
    ' AVG(p.amount_cents) AS average_cents' +
    ' FROM payments p' +
    where +
    " GROUP BY CASE WHEN p.provider_reference LIKE 'def_%' THEN 'deferred' ELSE 'cardnet' END, p.currency" +
    orderBy(filters, ['provider', 'currency', 'payments', 'amount_cents', 'average_cents'], 'provider') +
    limitClause(filters);
  const rows: Row[] = (await query(prisma, sql)).map((r) => ({ ...r, average_cents: Math.round(asNumber(r.average_cents)) }));

  const grouped = _.groupBy(rows, (r) => String(r.provider));
  const totals: Row = {
    provider: Object.keys(grouped)
      .sort()
      .map((name) => `${name}: ${_.sumBy(grouped[name], (r) => asNumber(r.payments))}`)
      .join('; '),
    payments: _.sumBy(rows, (r) => asNumber(r.payments)),
  };
  return {
    name: 'provider-split',
    title: 'Captured payments by provider',
    columns: [
      { key: 'provider', title: 'Provider' },
      { key: 'currency', title: 'Currency' },
      { key: 'payments', title: 'Payments' },
      { key: 'amount_cents', title: 'Amount', format: money },
      { key: 'average_cents', title: 'Average', format: money },
    ],
    rows,
    totals,
  };
};

// ---------------------------------------------------------------------------
// Report: currency-summary
// One row per currency and status; finance pastes it into the month-end sheet.
// ---------------------------------------------------------------------------

const currencySummary: ReportBuilder = async (prisma, filters) => {
  const where = whereClause(filters);
  const sql =
    'SELECT p.currency AS currency, p.status AS status, COUNT(*) AS payments, SUM(p.amount_cents) AS amount_cents' +
    ' FROM payments p' +
    where +
    ' GROUP BY p.currency, p.status' +
    orderBy(filters, ['currency', 'status', 'payments', 'amount_cents'], 'currency') +
    limitClause(filters);
  const rows = await query(prisma, sql);

  const perCurrency = _.mapValues(_.groupBy(rows, (r) => String(r.currency)), (group) => ({
    payments: _.sumBy(group, (r) => asNumber(r.payments)),
    amount_cents: _.sumBy(group, (r) => asNumber(r.amount_cents)),
  }));
  const withSubtotals: Row[] = [];
  for (const currency of Object.keys(perCurrency).sort()) {
    withSubtotals.push(...rows.filter((r) => r.currency === currency));
    withSubtotals.push({
      currency,
      status: 'subtotal',
      payments: perCurrency[currency].payments,
      amount_cents: perCurrency[currency].amount_cents,
    });
  }

  return {
    name: 'currency-summary',
    title: 'Payments by currency and status',
    columns: [
      { key: 'currency', title: 'Currency' },
      { key: 'status', title: 'Status' },
      { key: 'payments', title: 'Payments' },
      { key: 'amount_cents', title: 'Amount', format: money },
    ],
    rows: withSubtotals,
  };
};

// ---------------------------------------------------------------------------
// Report: invoice-lines
// One line per captured payment, in the layout the invoicing sheet expects:
// the amount as one string in the invoice's own format.
// ---------------------------------------------------------------------------

const invoiceLines: ReportBuilder = async (prisma, filters) => {
  const where = whereClause({ ...filters, status: filters.status ?? 'captured' });
  const sql =
    'SELECT p.id AS payment_id, p.order_id AS order_id, p.currency AS currency, p.amount_cents AS amount_cents,' +
    ' p.captured_at AS captured_at, p.provider_reference AS provider_reference' +
    ' FROM payments p' +
    where +
    orderBy(filters, ['captured_at', 'order_id', 'amount_cents'], 'captured_at') +
    limitClause(filters);
  const rows = (await query(prisma, sql)).map((r, index) => ({
    ...r,
    line: index + 1,
// @@ since legacy-report until drop-legacy-format
    invoice_amount: formatInvoiceLegacy(asNumber(r.amount_cents) / 100),
// @@ end
// @@ since drop-legacy-format
    invoice_amount: formatMoney(asNumber(r.amount_cents), String(r.currency)),
// @@ end
  }));

  return {
    name: 'invoice-lines',
    title: 'Invoice lines',
    columns: [
      { key: 'line', title: 'Line' },
      { key: 'order_id', title: 'Order' },
      { key: 'payment_id', title: 'Payment' },
      { key: 'captured_at', title: 'Captured at' },
      { key: 'invoice_amount', title: 'Amount' },
      { key: 'provider_reference', title: 'Provider reference' },
    ],
    rows,
    totals: { line: 'total', invoice_amount: `${rows.length} lines` },
  };
};

// @@ since report-extras
// ---------------------------------------------------------------------------
// Report: order-ledger
// Everything that happened to the money of one order, oldest first, with a
// running balance. Support opens it when a customer asks "where is my money".
// ---------------------------------------------------------------------------

const orderLedger: ReportBuilder = async (prisma, filters) => {
  if (!filters.order) {
    throw new Error('order-ledger needs the order filter, for example ?order=ord_1a2b3c');
  }
  const where = whereClause(filters);
  const charges = await query(
    prisma,
    'SELECT p.id AS payment_id, p.created_at AS at, p.status AS status, p.amount_cents AS amount_cents, p.currency AS currency' +
      ' FROM payments p' +
      where +
      ' ORDER BY p.created_at',
  );
  const refundRows = await query(
    prisma,
    'SELECT r.id AS refund_id, r.payment_id AS payment_id, r.created_at AS at, r.amount_cents AS amount_cents, p.currency AS currency' +
      ' FROM refunds r JOIN payments p ON p.id = r.payment_id' +
      whereClause(filters) +
      ' ORDER BY r.created_at',
  );

  const entries: Row[] = [
    ...charges.map((c) => ({
      at: asDate(c.at) ?? new Date(0),
      kind: c.status === 'captured' || c.status === 'refunded' ? 'capture' : String(c.status),
      reference: c.payment_id,
      currency: c.currency,
      delta_cents: c.status === 'captured' || c.status === 'refunded' ? asNumber(c.amount_cents) : 0,
    })),
    ...refundRows.map((r) => ({
      at: asDate(r.at) ?? new Date(0),
      kind: 'refund',
      reference: r.refund_id,
      currency: r.currency,
      delta_cents: -asNumber(r.amount_cents),
    })),
  ].sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());

  let balance = 0;
  const rows: Row[] = entries.map((entry) => {
    balance += asNumber(entry.delta_cents);
    return { ...entry, balance_cents: balance };
  });

  return {
    name: 'order-ledger',
    title: `Ledger of order ${filters.order}`,
    columns: [
      { key: 'at', title: 'When' },
      { key: 'kind', title: 'Entry' },
      { key: 'reference', title: 'Reference' },
      { key: 'delta_cents', title: 'Change', format: money },
      { key: 'balance_cents', title: 'Balance', format: money },
    ],
    rows,
    totals: { at: 'balance', balance_cents: balance, currency: rows.length > 0 ? rows[0].currency : '' },
  };
};

// ---------------------------------------------------------------------------
// Report: reconciliation
// Rows that should not exist: captured payments with no provider reference,
// payments refunded for more than they captured, pending payments with a
// provider reference. Finance sends the output to the provider's support.
// ---------------------------------------------------------------------------

const reconciliation: ReportBuilder = async (prisma, filters) => {
  const where = whereClause(filters);
  const noReference = await query(
    prisma,
    "SELECT p.id AS payment_id, p.order_id AS order_id, 'captured without provider reference' AS problem, p.amount_cents AS amount_cents, p.currency AS currency" +
      ' FROM payments p' +
      where +
      " AND p.status = 'captured' AND p.provider_reference IS NULL" +
      limitClause(filters),
  );
  const overRefunded = await query(
    prisma,
    "SELECT p.id AS payment_id, p.order_id AS order_id, 'refunded for more than captured' AS problem, SUM(r.amount_cents) AS amount_cents, p.currency AS currency" +
      ' FROM payments p JOIN refunds r ON r.payment_id = p.id' +
      where +
      ' GROUP BY p.id, p.order_id, p.currency, p.amount_cents' +
      ' HAVING SUM(r.amount_cents) > p.amount_cents' +
      limitClause(filters),
  );
  const pendingWithReference = await query(
    prisma,
    "SELECT p.id AS payment_id, p.order_id AS order_id, 'pending but has a provider reference' AS problem, p.amount_cents AS amount_cents, p.currency AS currency" +
      ' FROM payments p' +
      where +
      " AND p.status = 'pending' AND p.provider_reference IS NOT NULL" +
      limitClause(filters),
  );

  const rows = [...noReference, ...overRefunded, ...pendingWithReference];
  return {
    name: 'reconciliation',
    title: 'Reconciliation exceptions',
    columns: [
      { key: 'problem', title: 'Problem' },
      { key: 'order_id', title: 'Order' },
      { key: 'payment_id', title: 'Payment' },
      { key: 'amount_cents', title: 'Amount', format: money },
    ],
    rows,
    totals: { problem: `${rows.length} exceptions` },
  };
};

// @@ end
const BUILDERS: Record<string, ReportBuilder> = {
  'daily-settlement': dailySettlement,
  'refund-register': refundRegister,
  declines,
  aging,
  'provider-split': providerSplit,
  'currency-summary': currencySummary,
  'invoice-lines': invoiceLines,
// @@ since report-extras
  'order-ledger': orderLedger,
  reconciliation,
// @@ end
};

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderJson(report: ReportResult): string {
  return JSON.stringify(
    {
      report: report.name,
      title: report.title,
      generatedAt: isoStamp(new Date()),
      columns: report.columns.map((c) => c.key),
      rows: report.rows.map((row) => _.mapValues(row, (v) => (typeof v === 'bigint' ? Number(v) : v))),
      totals: report.totals ?? null,
    },
    null,
    2,
  );
}

function renderCsv(report: ReportResult): string {
  // Finance opens the file in a spreadsheet that guesses the encoding: the byte order mark settles it.
  const lines: string[] = [];
  lines.push(report.columns.map((c) => csvCell(c.title)).join(','));
  for (const row of report.rows) {
    lines.push(report.columns.map((c) => csvCell(cell(c, row))).join(','));
  }
  if (report.totals) {
    const totals = report.totals;
    lines.push(report.columns.map((c) => csvCell(cell(c, totals))).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

function renderHtml(report: ReportResult): string {
  const head = report.columns.map((c) => `<th>${htmlEscape(c.title)}</th>`).join('');
  const body = report.rows
    .map((row, index) => {
      const cells = report.columns.map((c) => `<td>${htmlEscape(cell(c, row))}</td>`).join('');
      return `<tr class="${index % 2 === 0 ? 'even' : 'odd'}">${cells}</tr>`;
    })
    .join('\n');
  let footer = '';
  if (report.totals) {
    const totals = report.totals;
    footer = `<tfoot><tr>${report.columns.map((c) => `<th>${htmlEscape(cell(c, totals))}</th>`).join('')}</tr></tfoot>`;
  }
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${htmlEscape(report.title)}</title>`,
    '<style>',
    'body { font-family: Arial, sans-serif; margin: 24px; }',
    'table { border-collapse: collapse; }',
    'th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; }',
    'tr.odd { background: #f3f3f3; }',
    'tfoot th { background: #ddd; }',
    '@media print { body { margin: 0; } }',
    '</style>',
    '</head>',
    '<body>',
    `<h1>${htmlEscape(report.title)}</h1>`,
    `<p>Generated ${isoStamp(new Date())} UTC, ${report.rows.length} rows.</p>`,
    `<table><thead><tr>${head}</tr></thead>`,
    `<tbody>${body}</tbody>`,
    footer,
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');
}

function renderXml(report: ReportResult): string {
  // The element name is the column key; the old importer reads <row> elements positionally.
  const rows = report.rows
    .map((row) => {
      const fields = report.columns.map((c) => `    <${c.key}>${xmlEscape(cell(c, row))}</${c.key}>`).join('\n');
      return `  <row>\n${fields}\n  </row>`;
    })
    .join('\n');
  let totals = '';
  if (report.totals) {
    const t = report.totals;
    const fields = report.columns.map((c) => `    <${c.key}>${xmlEscape(cell(c, t))}</${c.key}>`).join('\n');
    totals = `\n  <totals>\n${fields}\n  </totals>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<report name="${report.name}" generated="${isoStamp(new Date())}">\n${rows}${totals}\n</report>\n`;
}

const RENDERERS: Record<string, { contentType: string; extension: string; render: (report: ReportResult) => string }> = {
  json: { contentType: 'application/json; charset=utf-8', extension: 'json', render: renderJson },
  csv: { contentType: 'text/csv; charset=utf-8', extension: 'csv', render: renderCsv },
  html: { contentType: 'text/html; charset=utf-8', extension: 'html', render: renderHtml },
  xml: { contentType: 'application/xml; charset=utf-8', extension: 'xml', render: renderXml },
};

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

function validateDay(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? undefined : `${name} must look like 2026-07-31`;
}

async function handleReport(prisma: PrismaClient, req: Request, res: Response): Promise<void> {
  const name = first(req.query.report) ?? 'daily-settlement';
  const format = first(req.query.format) ?? 'json';

  const builder = BUILDERS[name];
  if (!builder) {
    res.status(404).json({ error: 'unknown_report', message: `no report "${name}"`, reports: Object.keys(BUILDERS) });
    return;
  }
  if (!FORMATS.includes(format)) {
    res.status(400).json({ error: 'unknown_format', message: `no format "${format}"`, formats: FORMATS });
    return;
  }

  const filters = readFilters(req);
  // The days are checked; every other filter reaches the SQL as typed.
  const problem = validateDay('from', filters.from) ?? validateDay('to', filters.to);
  if (problem) {
    res.status(400).json({ error: 'bad_filter', message: problem });
    return;
  }

  try {
    const report = await builder(prisma, filters);
    const renderer = RENDERERS[format];
    res.setHeader('Content-Type', renderer.contentType);
    if (format !== 'json' && format !== 'html') {
      res.setHeader('Content-Disposition', `attachment; filename="${report.name}-${isoDay(new Date())}.${renderer.extension}"`);
    }
    res.send(renderer.render(report));
  } catch (error) {
    // The old script printed the database error to the operator; so does this.
    res.status(500).json({ error: 'report_failed', message: (error as Error).message });
  }
}

/** Mounts the legacy report endpoint at /reports/legacy. */
export function legacyReportRoutes(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/legacy', (req, res) => {
    void handleReport(prisma, req, res);
  });
  return router;
}
