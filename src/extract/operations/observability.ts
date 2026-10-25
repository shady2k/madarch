/**
 * The observability area: the logger module of each service, the /healthz
 * endpoint of each service, and the /metrics endpoint with its counters.
 * Records are keyed by the file and the symbol that serve, never by the route,
 * so the contracts extractor may find the same routes without a collision.
 */
import {endpointTarget, matchesEndpoint} from '../endpoint-target.js';
import type { PropertyValue } from '../records.js';
import { extractMetrics } from './metrics.js';
import type { Records } from './accumulate.js';
import { serviceOf, TreeText } from './source.js';
import { bindingShadowed, closeDelimiter, escaped, functionAt, functionNode, functionsOf, goImportAlias, httpReceiver, relativeSource, sourceMask, sourceSpan } from './symbol-sites.js';

/** Logger declarations and uses resolved through imports, not a global name match. */
function loggers(t: TreeText, records: Records): void {
  const declarations: { key: string; path: string; symbol: string; service: string; go: boolean; definition?: number }[] = [];
  for (const path of t.tree.paths) {
    if (!/^services\//.test(path) || !/\.(?:go|ts)$/.test(path)) continue;
    const text = t.text(path);
    const mask = sourceMask(text);
    const service = serviceOf(path);
    if (service === undefined) continue;
    if (path.endsWith('.go') && /slog\.NewJSONHandler/.test(mask)) {
      for (const site of functionsOf(t, path)) {
        if (!/slog\.NewJSONHandler/.test(mask.slice(site.start, site.end))) continue;
        const key = `code.logger:${path}#${site.qualifiedName}`;
        records.add({ key, kind: 'code.logger', label: `logger of ${service}`, properties: { service, library: 'slog', json: true }, span: site.span });
        declarations.push({ key, path, symbol: site.name, service, go: true });
      }
    }
    if (path.endsWith('.ts')) {
      // Require the library binding as well as its call. A same-named local pino is not evidence.
      const imported = /import\s+(\w+)\s+from\s*['"]pino['"]/.exec(text);
      const binding = imported?.[1];
      if (binding === undefined || imported === null || mask.slice(imported.index, imported.index + 6) !== 'import') continue;
      for (const match of text.matchAll(new RegExp(`(?:export\\s+)?const\\s+(\\w+)\\s*=\\s*${escaped(binding)}\\s*\\(`, 'g'))) {
        if (mask.slice(match.index, match.index + match[0].length).trim() === '') continue;
        if (bindingShadowed(mask, binding, match.index)) {records.gap(path, `line ${sourceSpan(t, path, match.index, match.index + match[0].length).lineStart}: logger factory ${binding} is shadowed or its binding pattern is unsupported (${path})`); continue;}
        const symbol = match[1] ?? '';
        const key = `code.logger:${path}#${symbol}`;
        records.add({ key, kind: 'code.logger', label: `logger of ${service}`, properties: { service, library: 'pino', json: true }, span: sourceSpan(t, path, match.index, match.index + match[0].length) });
        declarations.push({ key, path, symbol, service, go: false, definition: match.index + match[0].indexOf('const') });
      }
    }
  }
  const use = (key: string, path: string, at: number, end: number): void => {
    const span = sourceSpan(t, path, at, end);
    const discriminator = `${span.byteStart}`;
    records.edge('code.uses-logger', key, records.file(path), {}, span, discriminator);
    const site = functionAt(t, path, at);
    if (site !== undefined) records.edge('code.uses-logger', key, functionNode(records, site), {}, span, discriminator);
    else records.gap(path, `line ${span.lineStart}: logger use has no resolved function (${path})`);
  };
  for (const logger of declarations) {
    const folder = logger.path.slice(0, logger.path.lastIndexOf('/'));
    const modPath = `services/${logger.service}/go.mod`;
    const module = logger.go && t.has(modPath) ? /^module\s+(\S+)/m.exec(t.text(modPath))?.[1] : undefined;
    const importedPackage = module === undefined ? undefined : `${module}/${folder.slice(`services/${logger.service}/`.length)}`;
    for (const path of t.tree.paths) {
      if (serviceOf(path) !== logger.service || !path.endsWith(logger.go ? '.go' : '.ts')) continue;
      const text = t.text(path);
      const mask = sourceMask(text);
      if (logger.go) {
        const imports = importedPackage === undefined ? [] : [...text.matchAll(new RegExp(`(?:^|\\n)\\s*(?:import\\s+)?(?:(\\w+)\\s+)?"${escaped(importedPackage)}"`, 'g'))];
        const alias = imports[0] === undefined ? undefined : imports[0][1] ?? /^package\s+(\w+)/m.exec(t.text(logger.path))?.[1];
        if (alias === undefined) continue;
        // Calls through the imported logger package are grounded even for context accessors.
        for (const match of mask.matchAll(new RegExp(`\\b${escaped(alias)}\\.(?:${escaped(logger.symbol)}|FromContext|WithLogger)\\s*\\(`, 'g'))) {
          const site = functionAt(t, path, match.index);
          if (site !== undefined && new RegExp(`\\b${escaped(alias)}\\s*(?::=|=)`).test(sourceMask(text.slice(site.start, match.index)))) continue;
          use(logger.key, path, match.index, match.index + match[0].length);
          // A factory assigned to a local carries this logger only within that function.
          const prefix = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index);
          const local = /(\w+)\s*:=\s*$/.exec(prefix)?.[1];
          if (local !== undefined && site !== undefined) {
            const tail = mask.slice(match.index + match[0].length, site.end);
            for (const called of tail.matchAll(new RegExp(`\\b${escaped(local)}\\.(?:Info|Error|Warn|Debug|With)\\s*\\(`, 'g'))) {
              const at = match.index + match[0].length + called.index;
              use(logger.key, path, at, at + called[0].length);
            }
          }
        }
      } else {
        const bindings: string[] = [];
        if (path === logger.path) bindings.push(logger.symbol);
        for (const imported of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
          if (relativeSource(t, path, imported[2] ?? '') !== logger.path) continue;
          for (const entry of (imported[1] ?? '').split(',')) {
            const named = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(entry);
            if (named?.[1] === logger.symbol) bindings.push(named[2] ?? logger.symbol);
          }
        }
        for (const binding of bindings) {
          for (const match of mask.matchAll(new RegExp(`\\b${escaped(binding)}\\.(?:info|error|warn|debug|trace|fatal|child)\\s*\\(`, 'g'))) {
            if (bindingShadowed(mask, binding, match.index, path === logger.path ? logger.definition : undefined)) continue;
            use(logger.key, path, match.index, match.index + match[0].length);
          }
        }
      }
    }
  }
}

/** A real registration, and its resolved handler (if canonical code facts are available). */
interface Endpoint {
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
    found.push({method, path: routePath, span: sourceSpan(t, path, match.index, end), ...(handler === undefined ? {} : {handler}), statusOk: handler !== undefined && /['"]ok['"]/.test(text.slice(handler.start, handler.end))});
  }
  return found;
}

/** Literal listeners in this service; no healthcheck option supplies a server port. */
function listenerPorts(t: TreeText, service: string | undefined): string[] {
  const ports = new Set<string>();
  for (const path of t.tree.paths.filter((path) => serviceOf(path) === service && /\.(?:ts|go)$/.test(path))) {
    const text = t.text(path); const mask = sourceMask(text);
    if (path.endsWith('.ts')) {
      for (const match of mask.matchAll(/\b(\w+)\.listen\(\s*(\d+)\b/g)) if (httpReceiver(t, path, match[1] ?? '', match.index)) ports.add(match[2]!);
      continue;
    }
    const alias = goImportAlias(text, 'net/http');
    if (alias === undefined) continue;
    for (const match of text.matchAll(new RegExp(`\\b${escaped(alias)}\\.ListenAndServe\\(\\s*"[^"]*:(\\d+)"`, 'g'))) if (mask.slice(match.index, match.index + alias.length) === alias && !bindingShadowed(mask, alias, match.index)) ports.add(match[1]!);
    for (const declaration of mask.matchAll(new RegExp(`\\b(\\w+)\\s*:=\\s*&?${escaped(alias)}\\.Server\\s*\\{`, 'g'))) {
      const open = declaration.index + declaration[0].lastIndexOf('{'); const end = closeDelimiter(mask, open, '{', '}');
      if (end === undefined || bindingShadowed(mask, alias, declaration.index)) continue;
      const server = declaration[1]!;
      const calls = [...mask.matchAll(new RegExp(`\\b${escaped(server)}\\.ListenAndServe\\s*\\(`, 'g'))];
      if (!calls.some((call) => !bindingShadowed(mask, server, call.index, declaration.index))) continue;
      const body = text.slice(open, end); const bodyMask = mask.slice(open, end);
      const addr = /\bAddr\s*:\s*("[^"]+"|\w+)/.exec(body);
      if (addr === null || !/^Addr/.test(bodyMask.slice(addr.index))) continue;
      const value = addr[1]!; const constant = value.startsWith('"') ? value : new RegExp(`\\b${escaped(value)}\\s*=\\s*("[^"]+")`).exec(text)?.[1];
      const port = constant === undefined ? undefined : /:(\d+)"$/.exec(constant)?.[1];
      if (port !== undefined) ports.add(port);
    }
  }
  return [...ports].sort();
}

/** The health endpoints: every registration of /healthz, keyed by its file and symbol. */
function healthEndpoints(t: TreeText, records: Records): void {
  for (const path of t.tree.paths) {
    if (!/^services\//.test(path) || !(path.endsWith('.go') || path.endsWith('.ts'))) continue;
    const found = registrations(t, path);
    for (const endpoint of found.filter((entry) => /^\/(?:healthz?|readyz?|livez?|startupz?)$/.test(entry.path))) {
      const identity = endpoint.handler?.qualifiedName ?? `unresolved@${endpoint.span.lineStart}:${endpoint.span.byteStart}`;
      const endpointKey = `code.health-endpoint:${path}#${identity}${endpoint.path === '/healthz' ? '' : endpoint.path}`;
      records.add({
        key: endpointKey,
        kind: 'code.health-endpoint',
        label: `${endpoint.path} of ${serviceOf(path) ?? path}`,
        properties: { path: endpoint.path, method: endpoint.method, ports: listenerPorts(t, serviceOf(path)), statusOk: endpoint.statusOk, service: serviceOf(path) ?? '' } satisfies { [key: string]: PropertyValue },
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
