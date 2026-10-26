/**
 * The observability area: the logger module of each service, the /healthz
 * endpoint of each service, and the /metrics endpoint with its counters.
 * Records are keyed by the file and the symbol that serve, never by the route,
 * so the contracts extractor may find the same routes without a collision.
 */
import {endpointTarget, matchesEndpoint} from '../endpoint-target.js';
import { extractMetrics } from './metrics.js';
import { effectOwner, effectSpan, libraryEvidence } from './code-facts.js';
import type { Records } from './accumulate.js';
import { serviceOf, TreeText } from './source.js';
import { functionNode } from './symbol-sites.js';
import { structuralHttpRegistrations } from './route-facts.js';

/** Logger effects require resolved package/receiver provenance from shared facts. */
function loggers(t: TreeText, records: Records): void {
  if (t.facts === undefined) { records.gap('.', 'logger extraction requires the shared resolved code facts'); return; }
  const facts = t.facts;
  const evaluated = t.libraryFacts()!;
  const declarations = new Map<string, string>();
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'logger-declare')) {
    const bindings = facts.bindings.filter((binding) => binding.initializer === effect.expression);
    const binding = bindings.length === 1 ? bindings[0] : undefined;
    const holder = facts.symbols.filter((symbol) => symbol.key === effect.holder && symbol.callable && symbol.path === effect.span.path &&
      symbol.span.byteStart <= effect.span.byteStart && effect.span.byteEnd <= symbol.span.byteEnd);
    const expressionIndex = new Map(facts.expressions.map((expression) => [expression.id, expression]));
    const descends = (id: string, target: string, seen = new Set<string>()): boolean => {
      if (id === target) return true;
      if (seen.has(id)) return false; seen.add(id);
      return expressionIndex.get(id)?.children.some((child) => descends(child, target, seen)) ?? false;
    };
    const returned = holder.length === 1 && facts.expressions.some((expression) => expression.path === effect.span.path && expression.syntaxKind === 'return_statement' &&
      holder[0]!.span.byteStart <= expression.span.byteStart && expression.span.byteEnd <= holder[0]!.span.byteEnd &&
      expression.span.byteStart <= effect.span.byteStart && effect.span.byteEnd <= expression.span.byteEnd && descends(expression.id, effect.expression));
    const peers = evaluated.effects.filter((one) => one.kind === 'logger-declare' && one.holder === effect.holder);
    const identity = binding?.name ?? (returned && peers.length === 1 ? holder[0]!.qualifiedName : `${effect.holder.slice(effect.holder.lastIndexOf('#') + 1)}@${effect.span.byteStart}`);
    const key = `code.logger:${effect.span.path}#${identity}`;
    const manifest = facts.files.find((file) => file.path === effect.span.path)?.manifest;
    const service = serviceOf(effect.span.path) ?? manifest?.name ?? '';
    records.add({ key, kind: 'code.logger', label: `logger ${identity} of ${service || effect.span.path}`,
      properties: { service, ...libraryEvidence(effect),
        ...(effect.presentation === undefined ? {} : {library: effect.presentation.library,
          ...(effect.presentation.json === undefined ? {} : {json: effect.presentation.json})}) },
      span: binding?.declarationSpan ?? (returned ? holder[0]!.span : effect.span) });
    declarations.set(effect.expression, key);
  }
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'logger-use')) {
    const logger = effect.roleOrigin === undefined ? undefined : declarations.get(effect.roleOrigin);
    if (logger === undefined) { records.gap(effect.span.path, `line ${effect.span.lineStart}: logger use has no resolved declaration [${effect.modelId}]`); continue; }
    const owner = effectOwner(t, records, effect);
    if (owner === undefined) continue;
    const discriminator = String(effect.span.byteStart);
    records.edge('code.uses-logger', logger, records.file(effect.span.path), libraryEvidence(effect), effectSpan(effect), discriminator);
    if (owner !== `code.file:${effect.span.path}`) records.edge('code.uses-logger', logger, owner, libraryEvidence(effect), effectSpan(effect), discriminator);
    else records.gap(effect.span.path, `line ${effect.span.lineStart}: logger use is outside a callable [${effect.modelId}]`);
  }
}

/** Health registrations and handlers come only from shared structural facts. */
function healthEndpoints(t: TreeText, records: Records): void {
  for (const endpoint of structuralHttpRegistrations(t)) {
    const path = endpoint.span.path;
    const health = new Set(['/health', '/healthz', '/ready', '/readyz', '/live', '/livez', '/startup', '/startupz']);
    if (!health.has(endpoint.path)) continue;
    const identity = endpoint.handler?.qualifiedName ?? `unresolved@${endpoint.span.lineStart}:${endpoint.span.byteStart}`;
    const endpointKey = `code.health-endpoint:${path}#${identity}${endpoint.path === '/healthz' ? '' : endpoint.path}`;
    const ports = [...endpoint.ports];
    if (ports.length === 0) records.gap(path, `line ${endpoint.span.lineStart}: health receiver/listener association is unresolved (${path})`);
    const statusOk = endpoint.handler !== undefined && (t.facts?.expressions ?? []).some((expression) => expression.path === path &&
      endpoint.handler!.span.byteStart <= expression.span.byteStart && expression.span.byteEnd <= endpoint.handler!.span.byteEnd && expression.literal?.value === 'ok');
    records.add({key: endpointKey, kind: 'code.health-endpoint', label: `${endpoint.path} of ${serviceOf(path) ?? path}`,
      properties: {path:endpoint.path, method:endpoint.method, ports, statusOk, service:serviceOf(path) ?? ''}, span:endpoint.span});
    records.edge('code.served-by', endpointKey, records.file(path), {service:serviceOf(path) ?? ''}, endpoint.span);
    if (endpoint.handler !== undefined) records.edge('code.served-by', endpointKey, functionNode(records,endpoint.handler), {role:'handler'},endpoint.span);
    else records.gap(path,`line ${endpoint.span.lineStart}: health registration handler is unresolved (${path})`);
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
