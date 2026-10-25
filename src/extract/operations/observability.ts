/**
 * The observability area: the logger module of each service, the /healthz
 * endpoint of each service, and the /metrics endpoint with its counters.
 * Records are keyed by the file and the symbol that serve, never by the route,
 * so the contracts extractor may find the same routes without a collision.
 */
import {endpointTarget, matchesEndpoint} from '../endpoint-target.js';
import type { PropertyValue } from '../records.js';
import { extractMetrics } from './metrics.js';
import { libraryEvidence } from './code-facts.js';
import type { Records } from './accumulate.js';
import { serviceOf, TreeText } from './source.js';
import { closeDelimiter, functionNode, functionsOf, httpReceiver, receiverListenerPorts, sourceMask, sourceSpan } from './symbol-sites.js';

/** Logger effects require resolved package/receiver provenance from shared facts. */
function loggers(t: TreeText, records: Records): void {
  if (t.facts === undefined) { records.gap('.', 'logger extraction requires the shared resolved code facts'); return; }
  const facts = t.facts;
  const evaluated = t.libraryFacts()!;
  const declarations = new Map<string, string>();
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'logger-declare')) {
    const bindings = facts.bindings.filter((binding) => binding.initializer === effect.expression);
    const binding = bindings.length === 1 ? bindings[0] : undefined;
    const identity = binding?.name ?? `${effect.holder.slice(effect.holder.lastIndexOf('#') + 1)}@${effect.span.byteStart}`;
    const key = `code.logger:${effect.span.path}#${identity}`;
    const service = facts.files.find((file) => file.path === effect.span.path)?.manifest?.name ?? '';
    records.add({ key, kind: 'code.logger', label: `logger of ${service || effect.span.path}`,
      properties: { service, ...libraryEvidence(effect) }, span: effect.span });
    declarations.set(effect.expression, key);
  }
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'logger-use')) {
    const logger = effect.roleOrigin === undefined ? undefined : declarations.get(effect.roleOrigin);
    if (logger === undefined) { records.gap(effect.span.path, `line ${effect.span.lineStart}: logger use has no resolved declaration [${effect.modelId}]`); continue; }
    const discriminator = String(effect.span.byteStart);
    records.edge('code.uses-logger', logger, records.file(effect.span.path), libraryEvidence(effect), effect.span, discriminator);
    if (effect.holder !== `code.file:${effect.span.path}`) records.edge('code.uses-logger', logger, effect.holder, libraryEvidence(effect), effect.span, discriminator);
    else records.gap(effect.span.path, `line ${effect.span.lineStart}: logger use is outside a callable [${effect.modelId}]`);
  }
}

/** A real registration, and its resolved handler (if canonical code facts are available). */
interface Endpoint {
  readonly receiver: string;
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly span: import('../records.js').SourceSpan;
  readonly handler?: import('./symbol-sites.js').FunctionSite;
  readonly statusOk: boolean;
}
function registrations(t: TreeText, path: string): Endpoint[] {
  const text = t.text(path); const mask = sourceMask(text); const found: Endpoint[] = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\.(get|post|put|delete|all|Handle|HandleFunc)\(\s*['"]([^'"]+)['"]\s*,/g;
  for (const match of text.matchAll(pattern)) {
    if (!httpReceiver(t, path, match[1] ?? '', match.index)) continue;
    const open = match.index + match[0].indexOf('(');
    const end = closeDelimiter(mask, open); if (end === undefined) continue;
    const handlerStart = match.index + match[0].length;
    const handlerText = text.slice(handlerStart, end - 1).trim();
    const at = handlerStart + text.slice(handlerStart, end - 1).indexOf(handlerText);
    const byte = new TextEncoder().encode(text.slice(0, at)).length;
    const inline = /^(?:async\s+)?(?:\(|function\b|func\b)/.test(handlerText);
    const sites = functionsOf(t, path);
    let handler = inline ? sites.find((site) => site.span.byteStart === byte && site.end <= end) : undefined;
    if (!inline && t.code !== undefined) {
      const targets = new Set(t.code.edges.filter((edge) => edge.type === 'code.occurrence' && edge.span?.path === path && byte <= edge.span.byteStart && edge.span.byteEnd <= new TextEncoder().encode(text.slice(0, end - 1)).length).map((edge) => edge.to));
      const candidates = sites.filter((site) => targets.has(`code.symbol:${path}#${site.qualifiedName}`));
      if (candidates.length === 1) handler = candidates[0];
    } else if (!inline && /^[\w.]+$/.test(handlerText)) {
      const candidates = sites.filter((site) => site.name === handlerText.split('.').pop());
      if (candidates.length === 1) handler = candidates[0];
    }
    const raw = match[3] ?? ''; const go = (match[2] ?? '').startsWith('Handle');
    const method = go ? /^([A-Z]+) /.exec(raw)?.[1] ?? '' : (match[2] ?? '').toUpperCase();
    const routePath = go ? raw.replace(/^[A-Z]+ /, '') : raw;
    found.push({receiver: match[1]!, at: match.index, method, path: routePath, span: sourceSpan(t, path, match.index, end), ...(handler === undefined ? {} : {handler}), statusOk: handler !== undefined && /['"]ok['"]/.test(text.slice(handler.start, handler.end))});
  }
  return found;
}

/** The health endpoints: every registration of /healthz, keyed by its file and symbol. */
function healthEndpoints(t: TreeText, records: Records): void {
  for (const path of t.tree.paths) {
    if (!/^services\//.test(path) || !(path.endsWith('.go') || path.endsWith('.ts'))) continue;
    const found = registrations(t, path);
    for (const endpoint of found.filter((entry) => /^\/(?:healthz?|readyz?|livez?|startupz?)$/.test(entry.path))) {
      const identity = endpoint.handler?.qualifiedName ?? `unresolved@${endpoint.span.lineStart}:${endpoint.span.byteStart}`;
      const endpointKey = `code.health-endpoint:${path}#${identity}${endpoint.path === '/healthz' ? '' : endpoint.path}`;
      const ports = receiverListenerPorts(t, path, endpoint.receiver, endpoint.at);
      if (ports.length === 0) records.gap(path, `line ${endpoint.span.lineStart}: health receiver/listener association is unresolved (${path})`);
      records.add({
        key: endpointKey,
        kind: 'code.health-endpoint',
        label: `${endpoint.path} of ${serviceOf(path) ?? path}`,
        properties: { path: endpoint.path, method: endpoint.method, ports, statusOk: endpoint.statusOk, service: serviceOf(path) ?? '' } satisfies { [key: string]: PropertyValue },
        span: endpoint.span,
      });
      records.edge('code.served-by', endpointKey, records.file(path), {service: serviceOf(path) ?? ''}, endpoint.span);
      if (endpoint.handler !== undefined) records.edge('code.served-by', endpointKey, functionNode(records, endpoint.handler), {role: 'handler'}, endpoint.span);
      else records.gap(path, `line ${endpoint.span.lineStart}: health registration handler is unresolved (${path})`);
    }
  }
}

/**
 * The endpoints link to the service that serves them (madarch-m38l.16): the health and metrics endpoints point at the
 * file they stand in, and a reader also needs "this is the health route of the orders service". Run after the stack
 * extractor, which makes the `code.service` nodes; an endpoint whose service has no manifest keeps its file link and
 * gets no service link, because a link to a service nothing declares would be a node of its own.
 */
export function linkEndpoints(t: TreeText, records: Records): void {
  for (const probe of records.nodes.filter((node) => node.kind === 'code.probe' || node.kind === 'code.healthcheck')) {
    // A TCP/exec/database readiness command does not claim an HTTP endpoint.
    if (probe.kind === 'code.probe' && probe.properties.transport !== 'http') continue;
    if (probe.kind === 'code.healthcheck') {
      const test = probe.properties.test;
      const command = Array.isArray(test) ? test.join(' ') : test;
      if (typeof command !== 'string' || !/https?:\/\//.test(command)) continue;
    }
    const target = endpointTarget(probe);
    if (target === undefined) {records.gap(probe.span?.path ?? '.', `line ${probe.span?.lineStart ?? 1}: probe target authority or method is unresolved (${probe.key})`); continue;}
    const endpoints = records.nodes.filter((node) => node.kind === 'code.health-endpoint' && matchesEndpoint(target, node));
    if (endpoints.length === 1 && endpoints[0] !== undefined) records.edge('code.probes', probe.key, endpoints[0].key, { role: 'endpoint' }, probe.span);
  }
  for (const node of [...records.nodes]) {
    if (node.kind !== 'code.health-endpoint' && node.kind !== 'code.metrics-endpoint') continue;
    const path = node.key.slice(node.key.indexOf(':') + 1, node.key.lastIndexOf('#'));
    const service = serviceOf(path);
    if (service === undefined) continue;
    const key = `code.service:${service}`;
    if (!records.nodes.some((held) => held.key === key)) continue;
    records.edge('code.served-by', node.key, key, {role: 'service'}, node.span ?? t.spanOfFile(path));
  }
}

/** The observability area. */
export function extractObservability(t: TreeText, records: Records): void {
  loggers(t, records);
  healthEndpoints(t, records);
  extractMetrics(t, records);
}
