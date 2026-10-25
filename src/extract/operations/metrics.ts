/** Individual metric definitions and positioned updates; no name-only service joins. */
import type { PropertyValue, SourceSpan } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type { Records } from './accumulate.js';
import { serviceOf, type TreeText } from './source.js';
import { bindingShadowed, closeDelimiter, escaped, functionAt, functionNode, functionsOf, relativeSource, sourceMask, sourceSpan, type FunctionSite } from './symbol-sites.js';

interface Metric {
  readonly path: string;
  readonly name: string;
  readonly metricType: string;
  readonly labels: readonly string[];
  readonly binding: string;
  readonly owner?: string;
  readonly span: SourceSpan;
  readonly textWriter: boolean;
  readonly bindingAt?: number;
  readonly defaultRegistry?: boolean;
}


/** Explicit constructors, and the text-format definitions the training service writes. */
function definitions(t: TreeText, path: string): Metric[] {
  const text = t.text(path);
  const found: Metric[] = [];
  const mask = sourceMask(text);
  const imported = new Map<string, string>();
  const autoRegistered = new Set<string>();
  if (path.endsWith('.ts')) {
    for (const statement of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]prom-client['"]/g)) {
      if (mask.slice(statement.index, statement.index + 6) !== 'import') continue;
      for (const entry of (statement[1] ?? '').split(',')) {
      const name = /^\s*(Counter|Gauge|Histogram)(?:\s+as\s+(\w+))?\s*$/.exec(entry);
      if (name !== null) imported.set(name[2] ?? name[1]!, name[1]!);
      }
    }
    for (const statement of text.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*['"]prom-client['"]/g)) {
      if (mask.slice(statement.index, statement.index + 6) !== 'import') continue;
      for (const name of ['Counter', 'Gauge', 'Histogram']) imported.set(`${statement[1]}.${name}`, name);
    }
  } else {
    for (const statement of text.matchAll(/(?:^|[\n;(])\s*(?:import\s+)?(?:(\w+)\s+)?"github\.com\/prometheus\/client_golang\/(prometheus(?:\/promauto)?)"/g)) {
      const lineStart = text.lastIndexOf('\n', statement.index) + 1;
      if (/^\s*(?:\/\/|\/\*|\*)/.test(text.slice(lineStart, statement.index + statement[0].length))) continue;
      for (const name of ['Counter', 'Gauge', 'Histogram']) for (const suffix of ['', 'Vec']) {
        const binding = `${statement[1] ?? (statement[2]?.endsWith('/promauto') ? 'promauto' : 'prometheus')}.New${name}${suffix}`;
        imported.set(binding, name);
        if (statement[2]?.endsWith('/promauto')) autoRegistered.add(binding);
      }
    }
  }
  const constructors = /\b(?:var|const|let)?\s*(\w+)\s*(?::=|=)\s*(?:new\s+)?([\w.]+)\s*\(/g;
  for (const match of text.matchAll(constructors)) {
    if (mask.slice(match.index, match.index + match[0].length).trim() === '') continue;
    const constructor = match[2] ?? '';
    const metricType = imported.get(constructor);
    if (metricType === undefined) continue;
    const rootBinding = constructor.split('.')[0]!;
    if (bindingShadowed(mask, rootBinding, match.index)) continue;
    const open = match.index + match[0].lastIndexOf('(');
    const stop = closeDelimiter(mask, open);
    if (stop === undefined) continue;
    const body = text.slice(match.index, stop);
    const name = /\b(?:Name|name)\s*:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    if (name === undefined) continue;
    const namespace = /\bNamespace\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const subsystem = /\bSubsystem\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const labelBody = /\blabelNames\s*:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? /\[\]string\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    const labels = [...labelBody.matchAll(/['"]([^'"]+)['"]/g)].map((held) => held[1] ?? '').sort(byCodePoint);
    found.push({ path, name: [namespace, subsystem, name].filter(Boolean).join('_'), metricType: metricType.toLowerCase(), labels, binding: match[1] ?? '', span: sourceSpan(t, path, match.index, stop), textWriter: false, defaultRegistry: path.endsWith('.ts') ? !/\bregisters\s*:/.test(body) : autoRegistered.has(constructor), bindingAt: match.index + match[0].indexOf(match[1] ?? '') });
  }
  const typeDirectives = new Map<string, string>();
  for (const match of text.matchAll(/# TYPE\s+([a-zA-Z_:][\w:]*)\s+(counter|gauge|histogram)\b/g)) typeDirectives.set(match[1] ?? '', match[2] ?? '');
  for (const site of functionsOf(t, path).filter((held) => held.name === 'ServeHTTP' && held.receiver !== undefined)) {
    const body = text.slice(site.start, site.end);
    for (const match of body.matchAll(/fmt\.Fprintf\([^\n]*?"([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+[^"\n]*"\s*,\s*([^\n]*)/g)) {
      const callAt = site.start + match.index;
      if (mask.slice(callAt, callAt + 3) !== 'fmt') continue;
      const name = match[1] ?? '';
      const metricType = typeDirectives.get(name);
      if (metricType === undefined) continue; // A numeric sample alone proves no metric type.
      const binding = new RegExp(`\\b${escaped(site.receiver ?? '')}\\.(\\w+)`).exec(match[3] ?? '')?.[1];
      if (binding === undefined) continue;
      const labels = [...(match[2] ?? '').matchAll(/([a-zA-Z_]\w*)=/g)].map((held) => held[1] ?? '').sort(byCodePoint);
      found.push({ path, name, metricType, labels, binding, owner: site.receiverType, span: sourceSpan(t, path, site.start + match.index, site.start + match.index + match[0].length), textWriter: true });
    }
  }
  return found;
}

function updater(records: Records, t: TreeText, metricKey: string, path: string, at: number, end: number): FunctionSite | undefined {
  const site = functionAt(t, path, at);
  if (site === undefined) {const span = sourceSpan(t, path, at, end); records.gap(path, `line ${span.lineStart}: metric update has no resolved function (${path})`); return undefined;}
  const span = sourceSpan(t, path, at, end);
  records.edge('code.updates-metric', functionNode(records, site), metricKey, {}, span, String(span.byteStart));
  return site;
}

export function extractMetrics(t: TreeText, records: Records): void {
  const sources = t.tree.paths.filter((path) => /^services\//.test(path) && /\.(go|ts)$/.test(path));
  const metrics = sources.flatMap((path) => definitions(t, path));
  for (const metric of metrics) {
    const service = serviceOf(metric.path) ?? '';
    const key = `code.metric:${metric.path}#${metric.name}`;
    records.add({ key, kind: 'code.metric', label: metric.name, properties: { name: metric.name, metricType: metric.metricType, labels: metric.labels, service, binding: metric.binding, definitionFormat: metric.textWriter ? 'prometheus-text' : 'constructor' } satisfies { [key: string]: PropertyValue }, span: metric.span });
    const updateMethods = new Map<string, FunctionSite>();
    for (const path of sources.filter((held) => serviceOf(held) === service)) {
      const text = t.text(path);
      const mask = sourceMask(text);
      if (metric.textWriter) {
        if (path !== metric.path) continue;
        for (const site of functionsOf(t, path).filter((held) => held.receiverType === metric.owner)) {
          const body = mask.slice(site.bodyStart, site.end);
          const pattern = new RegExp(`\\b${escaped(site.receiver ?? '')}\\.${escaped(metric.binding)}(?:\\[[^\\]\\n]+\\])?\\s*(?:\\.(?:Add|Store|Inc|Dec|Set|Observe)\\s*\\(|\\+\\+|--|\\+=|-=|=(?!=))`, 'g');
          for (const match of body.matchAll(pattern)) {
            updater(records, t, key, path, site.bodyStart + match.index, site.bodyStart + match.index + match[0].length);
            updateMethods.set(site.name, site);
          }
        }
      } else {
        const bindings: string[] = path === metric.path ? [metric.binding] : [];
        if (path.endsWith('.go') && path.slice(0, path.lastIndexOf('/')) === metric.path.slice(0, metric.path.lastIndexOf('/'))) bindings.push(metric.binding);
        if (path.endsWith('.ts')) {
          for (const imported of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
            if (relativeSource(t, path, imported[2] ?? '') !== metric.path) continue;
            for (const entry of (imported[1] ?? '').split(',')) {
              const named = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(entry);
              if (named?.[1] === metric.binding) bindings.push(named[2] ?? metric.binding);
            }
          }
        }
        for (const binding of new Set(bindings)) {
          const pattern = new RegExp(`\\b${escaped(binding)}(?:\\.(?:WithLabelValues|With|labels)\\([^;\\n]*?\\))?\\.(?:Inc|Dec|Add|Sub|Set|Observe|inc|dec|add|set|observe)\\s*\\(`, 'g');
          for (const match of mask.matchAll(pattern)) {
            if (bindingShadowed(mask, binding, match.index, path === metric.path ? metric.bindingAt : undefined)) continue;
            updater(records, t, key, path, match.index, match.index + match[0].length);
          }
        }
      }
    }
    // A service method delegates through a typed interface field. Require both
    // that field and its declared interface method; never join bare names globally.
    if (metric.textWriter) for (const path of sources.filter((held) => held.endsWith('.go') && serviceOf(held) === service)) {
      const text = t.text(path);
      for (const caller of functionsOf(t, path).filter((held) => held.receiverType !== undefined)) {
        const struct = new RegExp(`type\\s+${escaped(caller.receiverType ?? '')}\\s+struct\\s*\\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1] ?? '';
        for (const field of struct.matchAll(/^\s*(\w+)\s+([\w.]+)\s*$/gm)) {
          const type = field[2] ?? '';
          const iface = new RegExp(`type\\s+${escaped(type)}\\s+interface\\s*\\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1];
          if (iface === undefined) continue;
          for (const method of updateMethods.keys()) {
            if (!new RegExp(`\\b${escaped(method)}\\s*\\(`).test(iface)) continue;
            const implementations = sources.filter((held) => serviceOf(held) === service).flatMap((held) => functionsOf(t, held)).filter((held) => held.name === method && held.receiverType !== undefined && updateMethods.get(method)?.path === held.path);
            if (implementations.length !== 1) continue;
            const body = sourceMask(text.slice(caller.bodyStart, caller.end));
            for (const match of body.matchAll(new RegExp(`\\b${escaped(caller.receiver ?? '')}\\.${escaped(field[1] ?? '')}\\.${escaped(method)}\\s*\\(`, 'g'))) updater(records, t, key, path, caller.bodyStart + match.index, caller.bodyStart + match.index + match[0].length);
          }
        }
      }
    }
  }
  // An endpoint is grounded in a route registration and its metric handler, not
  // merely a /metrics string somewhere in the service.
  for (const path of sources) {
    const text = t.text(path);
    const service = serviceOf(path) ?? '';
    const mask = sourceMask(text);
    const registrations = [...text.matchAll(/\.(?:Handle|HandleFunc|get)\(\s*['"](?:GET )?\/metrics['"]\s*,/g)].filter((match) => mask[match.index] === '.');
    if (registrations.length === 0) continue;
    const serviceMetrics = metrics.filter((metric) => serviceOf(metric.path) === service);
    for (const registration of registrations) {
      const end = closeDelimiter(mask, registration.index + registration[0].indexOf('('));
      if (end === undefined) continue;
      const handler = text.slice(registration.index + registration[0].length, end - 1);
      const handlerMask = mask.slice(registration.index + registration[0].length, end - 1);
      const textGroups = new Map<string, Metric[]>();
      for (const metric of serviceMetrics.filter((held) => held.textWriter)) {
        // Resolve handler receiver type through a declared field or local constructor.
        const owner = metric.owner ?? '';
        const binding = handler.replace(/\)\s*$/, '').trim();
        const field = binding.split('.').pop() ?? '';
        const owns = new RegExp(`\\b${escaped(field)}\\s+\\*?${escaped(owner)}\\b`).test(text) || new RegExp(`\\b${escaped(field)}\\s*:=\\s*(?:\\w+\\.)?New${escaped(owner)}\\s*\\(`).test(text);
        if (!owns) continue;
        const group = `${metric.path}#${owner}`;
        textGroups.set(group, [...(textGroups.get(group) ?? []), metric]);
      }
      const constructorMetrics = serviceMetrics.filter((metric) => !metric.textWriter);
      // Only the imported default registry can expose its known members. A
      // receiver's spelling, comments or an unrelated object prove nothing.
      const registryBindings: string[] = [];
      for (const statement of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]prom-client['"]/g)) {
        if (mask.slice(statement.index, statement.index + 6) !== 'import') continue;
        for (const entry of (statement[1] ?? '').split(',')) {
          const named = /^\s*register(?:\s+as\s+(\w+))?\s*$/.exec(entry);
          if (named !== null) registryBindings.push(named[1] ?? 'register');
        }
      }
      let defaultRegistry = false;
      for (const binding of registryBindings) for (const call of handlerMask.matchAll(new RegExp(`\\b${escaped(binding)}\\.metrics\\s*\\(`, 'g'))) {
        const at = registration.index + registration[0].length + call.index;
        if (!bindingShadowed(mask, binding, at)) defaultRegistry = true;
      }
      // Go's promhttp default Handler only exports explicitly registered or
      // promauto metrics. Plain NewCounter does not register by construction.
      const promhttp = /(?:^|[\n;(])\s*(?:import\s+)?(?:(\w+)\s+)?"github\.com\/prometheus\/client_golang\/prometheus\/promhttp"/g;
      for (const statement of text.matchAll(promhttp)) {
        const alias = statement[1] ?? 'promhttp';
        if (new RegExp(`\\b${escaped(alias)}\\.Handler\\s*\\(`).test(handlerMask) && !bindingShadowed(mask, alias, registration.index)) defaultRegistry = true;
      }
      if (defaultRegistry) for (const metric of constructorMetrics.filter((metric) => metric.defaultRegistry)) {
        textGroups.set(`${metric.path}#registry`, [...(textGroups.get(`${metric.path}#registry`) ?? []), metric]);
      }
      if (textGroups.size === 0) records.gap(path, `line ${text.slice(0, registration.index).split('\n').length}: metrics registration receiver or membership is unresolved (${path})`);
      for (const [group, held] of textGroups) {
        const endpoint = `code.metrics-endpoint:${group}`;
        const span = sourceSpan(t, path, registration.index, end);
        records.add({ key: endpoint, kind: 'code.metrics-endpoint', label: `/metrics of ${service}`, properties: { path: '/metrics', service, format: 'prometheus-text', counters: held.filter((metric) => metric.metricType === 'counter').map((metric) => metric.name).sort(byCodePoint) }, span });
        records.edge('code.served-by', endpoint, records.file(path), { service }, span);
        for (const metric of held) records.edge('code.exposes-metric', endpoint, `code.metric:${metric.path}#${metric.name}`, {}, span);
        const handlerSite = functionsOf(t, held[0]?.path ?? path).find((site) => site.name === 'ServeHTTP' && site.receiverType === held[0]?.owner);
        if (handlerSite !== undefined) records.edge('code.served-by', endpoint, functionNode(records, handlerSite), { role: 'handler' }, span);
      }
    }
  }
}
