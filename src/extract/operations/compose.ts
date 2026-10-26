/**
 * One compose file, read once for every area that needs it: the services with
 * their image, build, ports, environment and depends_on, each with the line it
 * stands on. The reader is strict — YAML it refuses is a gap naming its line,
 * never a service read in part.
 */
import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { byCodePoint } from '../../model/order.js';
import type { SourceSpan } from '../records.js';
import type { Records } from './accumulate.js';
import { TreeText } from './source.js';

/** One variable of one service's environment, as the file binds it. */
export interface ComposeVariable {
  readonly name: string;
  readonly value: string | null;
  readonly span: SourceSpan;
}

/** One service of a compose file. */
export interface ComposeService {
  readonly name: string;
  readonly line: number;
  readonly image: string | null;
  /** The short build form names a context; the long one names a context and a dockerfile. */
  readonly build: string | { readonly context: string; readonly dockerfile: string } | null;
  /** The port mappings, as the file writes them ("8080:8080"). */
  readonly ports: readonly string[];
  /** The host and container ports of one mapping, when it is one of the two-part forms. */
  readonly portMappings: readonly { readonly host: string; readonly container: string }[];
  readonly environment: readonly ComposeVariable[];
  readonly dependsOn: readonly string[];
}

function scalarText(node: unknown): string | null {
  return isScalar(node) && node.value !== null ? String(node.value) : null;
}

/** Reads one compose file; a file the reader refuses is a gap and no services. */
export function readComposeFile(t: TreeText, records: Records, path: string): readonly ComposeService[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(t.text(path), { lineCounter, keepSourceTokens: true });
  for (const error of document.errors) {
    records.gap(path, `line ${lineCounter.linePos(error.pos?.[0] ?? 0).line}: ${error.message}`);
  }
  if (document.errors.length > 0) return [];
  const contents = document.contents;
  if (!isMap(contents)) {
    records.gap(path, 'the file is no mapping: a compose file maps service names to their declarations');
    return [];
  }
  const services = contents.items.find((pair) => isScalar(pair.key) && pair.key.value === 'services')?.value;
  if (!isMap(services)) {
    records.gap(path, 'the file declares no services mapping');
    return [];
  }
  const refuseEnvironment = (node: unknown): never => {
    const offset = node !== null && typeof node === 'object' && 'range' in node && Array.isArray(node.range) && typeof node.range[0] === 'number' ? node.range[0] : 0;
    records.gap(path, `line ${lineCounter.linePos(offset).line}: the environment alias or merged mapping cannot be resolved completely`);
    throw new Error('environment mapping refused');
  };
  const resolveAlias = (node: unknown): unknown => {
    const seen = new Set<unknown>();
    while (isAlias(node)) {
      if (seen.has(node)) return refuseEnvironment(node);
      seen.add(node);
      let target: unknown;
      try { target = node.resolve(document); } catch { return refuseEnvironment(node); }
      if (target === undefined) return refuseEnvironment(node);
      node = target;
    }
    return node;
  };
  type EnvironmentPair = { readonly key: unknown; readonly value: unknown };
  const environmentPairs = (source: unknown, active = new Set<unknown>()): readonly EnvironmentPair[] => {
    const mapping = resolveAlias(source);
    if (!isMap(mapping) || active.has(mapping)) return refuseEnvironment(source);
    const next = new Set(active); next.add(mapping);
    const merged = new Map<string, EnvironmentPair>();
    const explicit = new Map<string, EnvironmentPair>();
    for (const entry of mapping.items) {
      if (!isScalar(entry.key) || typeof entry.key.value !== 'string') continue;
      if (entry.key.value === '<<') {
        const source = resolveAlias(entry.value);
        for (const item of isSeq(source) ? source.items : [source]) {
          for (const pair of environmentPairs(item, next)) {
            if (isScalar(pair.key) && typeof pair.key.value === 'string' && !merged.has(pair.key.value)) merged.set(pair.key.value, pair);
          }
        }
      } else explicit.set(entry.key.value, entry);
    }
    for (const [name, pair] of explicit) merged.set(name, pair);
    return [...merged.values()];
  };
  const read: ComposeService[] = [];
  for (const pair of services.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const name = pair.key.value;
    const serviceLine = lineCounter.linePos(pair.key.range?.[0] ?? 0).line;
    const image = scalarText(isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'image')?.value : undefined);
    let build: ComposeService['build'] = null;
    const buildNode = isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'build')?.value : undefined;
    if (isScalar(buildNode) && buildNode.value !== null) build = String(buildNode.value);
    else if (isMap(buildNode)) {
      const context = scalarText(buildNode.items.find((item) => isScalar(item.key) && item.key.value === 'context')?.value);
      const dockerfile = scalarText(buildNode.items.find((item) => isScalar(item.key) && item.key.value === 'dockerfile')?.value);
      if (context !== null) build = { context, dockerfile: dockerfile ?? 'Dockerfile' };
    }
    const ports: string[] = [];
    const portMappings: { host: string; container: string }[] = [];
    const portsNode = isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'ports')?.value : undefined;
    if (isSeq(portsNode)) {
      for (const item of portsNode.items) {
        const text = scalarText(item);
        if (text === null) continue;
        ports.push(text);
        const parts = text.split(':');
        const container = parts[parts.length - 1]?.split('/')[0];
        const host = parts[parts.length - 2];
        if (container !== undefined && host !== undefined && /^\d+$/.test(container)) portMappings.push({ host, container });
      }
    }
    const environment: ComposeVariable[] = [];
    try {
      const envNode = resolveAlias(isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'environment')?.value : undefined);
      if (isMap(envNode)) {
        for (const variable of environmentPairs(envNode)) {
          if (!isScalar(variable.key) || typeof variable.key.value !== 'string') continue;
          const line = lineCounter.linePos(variable.key.range?.[0] ?? 0).line;
          environment.push({ name: variable.key.value, value: scalarText(resolveAlias(variable.value)), span: t.spanOfLine(path, line) });
        }
      } else if (isSeq(envNode)) {
        for (const source of envNode.items) {
          const item = resolveAlias(source);
          const text = scalarText(item);
          if (text === null) continue;
          const at = text.indexOf('=');
          const name = at < 0 ? text : text.slice(0, at);
          const line = lineCounter.linePos((item as { range?: number[] }).range?.[0] ?? 0).line;
          environment.push({ name, value: at < 0 ? null : text.slice(at + 1), span: t.spanOfLine(path, line) });
        }
      }
    } catch { return []; }
    const dependsOn: string[] = [];
    const dependsNode = isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'depends_on')?.value : undefined;
    if (isSeq(dependsNode)) {
      for (const item of dependsNode.items) {
        const text = scalarText(item);
        if (text !== null) dependsOn.push(text);
      }
    } else if (isMap(dependsNode)) {
      for (const item of dependsNode.items) {
        if (isScalar(item.key) && typeof item.key.value === 'string') dependsOn.push(item.key.value);
      }
    }
    environment.sort((left, right) => byCodePoint(left.name, right.name));
    dependsOn.sort(byCodePoint);
    ports.sort(byCodePoint);
    read.push({ name, line: serviceLine, image, build, ports, portMappings, environment, dependsOn });
  }
  read.sort((left, right) => byCodePoint(left.name, right.name));
  return read;
}

