/**
 * The observability area: the logger module of each service, the /healthz
 * endpoint of each service, and the /metrics endpoint with its counters.
 * Records are keyed by the file and the symbol that serve, never by the route,
 * so the contracts extractor may find the same routes without a collision.
 */
import type { PropertyValue } from '../records.js';
import { extractMetrics } from './metrics.js';
import type { Records } from './accumulate.js';
import { serviceOf, TreeText } from './source.js';
import { escaped, functionAt, functionNode, functionsOf, relativeSource, sourceMask, sourceSpan } from './symbol-sites.js';

/** Logger declarations and uses resolved through imports, not a global name match. */
function loggers(t: TreeText, records: Records): void {
  const declarations: { key: string; path: string; symbol: string; service: string; go: boolean }[] = [];
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
        const symbol = match[1] ?? '';
        const key = `code.logger:${path}#${symbol}`;
        records.add({ key, kind: 'code.logger', label: `logger of ${service}`, properties: { service, library: 'pino', json: true }, span: sourceSpan(t, path, match.index, match.index + match[0].length) });
        declarations.push({ key, path, symbol, service, go: false });
      }
    }
  }
  const use = (key: string, path: string, at: number, end: number): void => {
    const span = sourceSpan(t, path, at, end);
    const discriminator = `${span.byteStart}`;
    records.edge('code.uses-logger', key, records.file(path), {}, span, discriminator);
    const site = functionAt(t, path, at);
    if (site !== undefined) records.edge('code.uses-logger', key, functionNode(records, site), {}, span, discriminator);
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
            const site = functionAt(t, path, match.index);
            if (site !== undefined) {
              const before = mask.slice(site.start, match.index);
              const parameters = mask.slice(site.start, site.bodyStart);
              if (new RegExp(`\\b${escaped(binding)}\\s*(?::|,|\\)|=)`).test(parameters) || new RegExp(`\\b(?:const|let|var)\\s+${escaped(binding)}\\b`).test(before)) continue;
            }
            use(logger.key, path, match.index, match.index + match[0].length);
          }
        }
      }
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

/**
 * The route registrations of one Go file. A named handler's response is read
 * at the handler's own declaration, not at the registration line, so a
 * statusOk property always sits where the answer is written.
 */
function goRegistrations(t: TreeText, path: string): Endpoint[] {
  const lines = t.lines(path);
  const found: Endpoint[] = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\.(?:Handle|HandleFunc)\(\s*"([A-Z]+)\s+(\/[A-Za-z0-9_./:-]*)"\s*,\s*([^)]*)\)/g)) {
      const handler = (match[3] ?? '').trim();
      const named = /^[A-Za-z0-9_.]+$/.test(handler);
      const symbol = named ? (handler.split('.').pop() ?? '') : (nearestGoDeclaration(lines, index) ?? '');
      let body = lines.slice(index, index + 6).join('\n');
      if (named && symbol !== '') {
        const declared = lines.findIndex((candidate) => new RegExp(`^func\\s+(?:\\([^)]*\\)\\s+)?${symbol}\\s*\\(`).test(candidate));
        if (declared >= 0) body = lines.slice(declared, declared + 8).join('\n');
      }
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
    for (const endpoint of found.filter((entry) => /^\/(?:healthz?|readyz?|livez?|startupz?)$/.test(entry.path))) {
      const endpointKey = `code.health-endpoint:${path}#${endpoint.symbol}${endpoint.path === '/healthz' ? '' : endpoint.path}`;
      records.add({
        key: endpointKey,
        kind: 'code.health-endpoint',
        label: `${endpoint.path} of ${serviceOf(path) ?? path}`,
        properties: { path: endpoint.path, method: endpoint.method, statusOk: endpoint.statusOk, service: serviceOf(path) ?? '' } satisfies { [key: string]: PropertyValue },
        span: t.spanOfLine(path, endpoint.line),
      });
      records.edge('code.served-by', endpointKey, records.file(path), {service: serviceOf(path) ?? ''}, t.spanOfLine(path, endpoint.line));
      const declared = functionsOf(t, path).filter((site) => site.name === endpoint.symbol);
      if (declared.length === 1 && declared[0] !== undefined) records.edge('code.served-by', endpointKey, functionNode(records, declared[0]), { role: 'handler' }, t.spanOfLine(path, endpoint.line));
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
    let routePath = probe.properties.path;
    if (probe.kind === 'code.healthcheck') {
      const command = Array.isArray(probe.properties.test) ? probe.properties.test.join(' ') : probe.properties.test;
      routePath = typeof command === 'string' ? /https?:\/\/[^\s/]+(\/[^\s'"]*)/.exec(command)?.[1] : undefined;
    }
    const endpoints = records.nodes.filter((node) => node.kind === 'code.health-endpoint' && node.properties.path === routePath && node.properties.service === probe.properties.service);
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
