/**
 * The observability area: the logger module of each service, the /healthz
 * endpoint of each service, and the /metrics endpoint with its counters.
 * Records are keyed by the file and the symbol that serve, never by the route,
 * so the contracts extractor may find the same routes without a collision.
 */
import type { PropertyValue } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type { Records } from './accumulate.js';
import { serviceOf, TreeText } from './source.js';

/** The logger modules: one per service, slog in Go and pino in TypeScript. */
function loggers(t: TreeText, records: Records): void {
  for (const path of t.tree.paths) {
    if (!/^services\/[^/]+\/.*\/logging\//.test(path)) continue;
    const service = serviceOf(path);
    if (service === undefined) continue;
    let text: string;
    try {
      text = t.text(path);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    if (path.endsWith('.go') && /slog\.NewJSONHandler/.test(text)) {
      const at = lines.findIndex((line) => /^func New\(/.test(line));
      if (at < 0) continue;
      records.add({
        key: `code.logger:${path}#New`,
        kind: 'code.logger',
        label: `logger of ${service}`,
        properties: { service, library: 'slog', json: true } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLine(path, at + 1),
      });
    }
    if (path.endsWith('.ts') && /\bpino\(/.test(text)) {
      const at = lines.findIndex((line) => /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*pino\(/.test(line));
      if (at < 0 || lines[at] === undefined) continue;
      const symbol = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*pino\(/.exec(lines[at] ?? '')?.[1] ?? 'logger';
      records.add({
        key: `code.logger:${path}#${symbol}`,
        kind: 'code.logger',
        label: `logger of ${service}`,
        properties: { service, library: 'pino', json: true } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLine(path, at + 1),
      });
    }
  }
}

/** One endpoint found in one file: the registration line and the symbol that serves it. */
interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly statusOk: boolean;
}

/** The route registrations of one Go file. */
function goRegistrations(t: TreeText, path: string): Endpoint[] {
  const lines = t.lines(path);
  const found: Endpoint[] = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\.(?:Handle|HandleFunc)\(\s*"([A-Z]+)\s+(\/[A-Za-z0-9_./:-]*)"\s*,\s*([^)]*)\)/g)) {
      const handler = (match[3] ?? '').trim();
      const symbol = /^[A-Za-z0-9_.]+$/.test(handler)
        ? (handler.split('.').pop() ?? '')
        : (nearestGoDeclaration(lines, index) ?? '');
      const body = lines.slice(index, index + 6).join('\n');
      found.push({
        method: match[1] ?? '',
        path: match[2] ?? '',
        line: index + 1,
        symbol,
        statusOk: /"ok"|'ok'/.test(body),
      });
    }
  });
  return found;
}

/** The route registrations of one TypeScript file. */
function tsRegistrations(t: TreeText, path: string): Endpoint[] {
  const lines = t.lines(path);
  const found: Endpoint[] = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\.(get|post|put|delete|all)\(\s*['"]([^'"]+)['"]/g)) {
      const body = lines.slice(index, index + 6).join('\n');
      found.push({
        method: (match[1] ?? '').toUpperCase(),
        path: match[2] ?? '',
        line: index + 1,
        symbol: nearestTsDeclaration(lines, index) ?? '',
        statusOk: /"ok"|'ok'/.test(body),
      });
    }
  });
  return found;
}

function nearestGoDeclaration(lines: readonly string[], index: number): string | undefined {
  for (let at = index; at >= 0; at -= 1) {
    const declared = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)/.exec(lines[at] ?? '');
    if (declared !== null) return declared[1];
  }
  return undefined;
}

function nearestTsDeclaration(lines: readonly string[], index: number): string | undefined {
  const ownLine = lines[index] ?? '';
  const own = ownLine.length - ownLine.trimStart().length;
  for (let at = index; at >= 0; at -= 1) {
    const line = lines[at] ?? '';
    const indent = line.length - line.trimStart().length;
    if (at !== index && indent >= own) continue;
    const declared = /(?:function\s+([A-Za-z0-9_]+)|(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\()/.exec(line);
    if (declared !== null) return declared[1] ?? declared[2];
  }
  return undefined;
}

/** The health endpoints: every registration of /healthz, keyed by its file and symbol. */
function healthEndpoints(t: TreeText, records: Records): void {
  for (const path of t.tree.paths) {
    if (!/^services\//.test(path) || !(path.endsWith('.go') || path.endsWith('.ts'))) continue;
    const found = path.endsWith('.go') ? goRegistrations(t, path) : tsRegistrations(t, path);
    for (const endpoint of found.filter((entry) => entry.path === '/healthz')) {
      records.add({
        key: `code.health-endpoint:${path}#${endpoint.symbol}`,
        kind: 'code.health-endpoint',
        label: `/healthz of ${serviceOf(path) ?? path}`,
        properties: { path: endpoint.path, method: endpoint.method, statusOk: endpoint.statusOk } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLine(path, endpoint.line),
      });
    }
  }
}

/** The metrics endpoints: the files that write Prometheus counters, with the route their service registers. */
function metricsEndpoints(t: TreeText, records: Records): void {
  for (const path of t.tree.paths) {
    if (!/^services\//.test(path) || !path.endsWith('.go')) continue;
    let text: string;
    try {
      text = t.text(path);
    } catch {
      continue;
    }
    if (!/func \([^)]+\) ServeHTTP/.test(text)) continue;
    const counters = [...text.matchAll(/([a-z][a-z0-9_]*_total)\b/g)].map((match) => match[1] ?? '').filter((name) => name !== '');
    if (counters.length === 0) continue;
    const service = serviceOf(path);
    if (service === undefined) continue;
    const registered = [...t.tree.paths]
      .filter((other) => other.startsWith(`services/${service}/`) && other.endsWith('.go'))
      .some((other) => /["'`][A-Z]* ?\/metrics["'`]/.test(t.text(other)));
    if (!registered) continue;
    const receiver = /func \(\w+ \*?([A-Za-z0-9_]+)\) ServeHTTP/.exec(text)?.[1] ?? 'Metrics';
    const distinct = [...new Set(counters)].sort(byCodePoint);
    records.add({
      key: `code.metrics-endpoint:${path}#${receiver}`,
      kind: 'code.metrics-endpoint',
      label: `/metrics of ${service}`,
      properties: { path: '/metrics', format: 'prometheus-text', counters: distinct } satisfies { [key: string]: PropertyValue },
      span: t.spanOfFile(path),
    });
  }
}

/** The observability area. */
export function extractObservability(t: TreeText, records: Records): void {
  loggers(t, records);
  healthEndpoints(t, records);
  metricsEndpoints(t, records);
}
