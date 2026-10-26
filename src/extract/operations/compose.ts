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
  const document = parseDocument(t.text(path), { lineCounter, keepSourceTokens: true, merge: true });
  for (const error of document.errors) {
    records.gap(path, `line ${lineCounter.linePos(error.pos?.[0] ?? 0).line}: ${error.message}`);
  }
  if (document.errors.length > 0) return [];
  const refuse = (node: unknown): never => {
    const offset = node !== null && typeof node === 'object' && 'range' in node && Array.isArray(node.range) && typeof node.range[0] === 'number' ? node.range[0] : 0;
    records.gap(path, `line ${lineCounter.linePos(offset).line}: the Compose document contains an unresolved alias, invalid merge or excessive alias expansion`);
    throw new Error('Compose resolution refused');
  };
  type ResolvedPair = { readonly key: unknown; readonly value: unknown; readonly sourceValue: unknown };
  const mappings = new Map<unknown, readonly ResolvedPair[]>();
  const sequences = new Map<unknown, readonly unknown[]>();
  const resolved = new Map<unknown, unknown>();
  const active = new Set<unknown>();
  const resolveNode = (source: unknown): unknown => {
    if (resolved.has(source)) return resolved.get(source);
    if (active.has(source)) return refuse(source);
    active.add(source);
    let result = source;
    if (isAlias(source)) {
      let target: unknown;
      try { target = source.resolve(document); } catch { return refuse(source); }
      if (target === undefined) return refuse(source);
      result = resolveNode(target);
    } else if (isMap(source)) {
      const merged = new Map<unknown, ResolvedPair>();
      const explicit = new Map<unknown, ResolvedPair>();
      for (const pair of source.items) {
        const key = resolveNode(pair.key);
        const value = resolveNode(pair.value);
        const merge = isScalar(key) && typeof key.value === 'symbol' && key.value.description === '<<';
        if (merge) {
          for (const item of isSeq(value) ? sequences.get(value)! : [value]) {
            if (!isMap(item)) return refuse(pair.value);
            for (const entry of mappings.get(item)!) {
              const identity = isScalar(entry.key) ? entry.key.value : entry.key;
              if (!merged.has(identity)) merged.set(identity, entry);
            }
          }
        } else explicit.set(isScalar(key) ? key.value : key, { key, value, sourceValue: pair.value });
      }
      for (const [key, entry] of explicit) merged.set(key, entry);
      mappings.set(source, [...merged.values()]);
    } else if (isSeq(source)) sequences.set(source, source.items.map(resolveNode));
    active.delete(source); resolved.set(source, result);
    return result;
  };
  let contents: unknown;
  try {
    // The library enforces its alias-expansion budget before any consumer sees
    // a value. The shared AST view also rejects cycles anywhere in the document.
    document.toJS({ maxAliasCount: 100 });
    contents = resolveNode(document.contents);
  } catch {
    if (records.gaps.length === 0) {
      records.gap(path, 'line 1: the Compose document contains an unresolved alias, invalid merge or excessive alias expansion');
    }
    return [];
  }
  const pairs = (node: unknown): readonly ResolvedPair[] => isMap(node) ? mappings.get(node)! : [];
  const items = (node: unknown): readonly unknown[] => isSeq(node) ? sequences.get(node)! : [];
  const field = (node: unknown, name: string): unknown => pairs(node).find((entry) => isScalar(entry.key) && entry.key.value === name)?.value;
  if (!isMap(contents)) {
    records.gap(path, 'the file is no mapping: a compose file maps service names to their declarations');
    return [];
  }
  const services = field(contents, 'services');
  if (!isMap(services)) {
    records.gap(path, 'the file declares no services mapping');
    return [];
  }
  const read: ComposeService[] = [];
  for (const pair of pairs(services)) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const name = pair.key.value;
    const serviceTarget = isAlias(pair.sourceValue) && pair.value !== null && typeof pair.value === 'object' && 'range' in pair.value && Array.isArray(pair.value.range) ? pair.value.range[0] : pair.key.range?.[0];
    const serviceLine = lineCounter.linePos(typeof serviceTarget === 'number' ? serviceTarget : 0).line;
    const image = scalarText(field(pair.value, 'image'));
    let build: ComposeService['build'] = null;
    const buildNode = field(pair.value, 'build');
    if (isScalar(buildNode) && buildNode.value !== null) build = String(buildNode.value);
    else if (isMap(buildNode)) {
      const context = scalarText(field(buildNode, 'context'));
      const dockerfile = scalarText(field(buildNode, 'dockerfile'));
      if (context !== null) build = { context, dockerfile: dockerfile ?? 'Dockerfile' };
    }
    const ports: string[] = [];
    const portMappings: { host: string; container: string }[] = [];
    const portsNode = field(pair.value, 'ports');
    if (isSeq(portsNode)) {
      for (const item of items(portsNode)) {
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
    const envNode = field(pair.value, 'environment');
    if (isMap(envNode)) {
      for (const variable of pairs(envNode)) {
        if (!isScalar(variable.key) || typeof variable.key.value !== 'string') continue;
        const line = lineCounter.linePos(variable.key.range?.[0] ?? 0).line;
        environment.push({ name: variable.key.value, value: scalarText(variable.value), span: t.spanOfLine(path, line) });
      }
    } else if (isSeq(envNode)) {
      for (const item of items(envNode)) {
        const text = scalarText(item);
        if (text === null) continue;
        const at = text.indexOf('=');
        const name = at < 0 ? text : text.slice(0, at);
        const line = lineCounter.linePos((item as { range?: number[] }).range?.[0] ?? 0).line;
        environment.push({ name, value: at < 0 ? null : text.slice(at + 1), span: t.spanOfLine(path, line) });
      }
    }
    const dependsOn: string[] = [];
    const dependsNode = field(pair.value, 'depends_on');
    if (isSeq(dependsNode)) {
      for (const item of items(dependsNode)) {
        const text = scalarText(item);
        if (text !== null) dependsOn.push(text);
      }
    } else if (isMap(dependsNode)) {
      for (const item of pairs(dependsNode)) {
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

