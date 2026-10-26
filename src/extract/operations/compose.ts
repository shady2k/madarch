/**
 * One compose file, read once for every area that needs it: the services with
 * their image, build, ports, environment and depends_on, each with the line it
 * stands on. The reader is strict — YAML it refuses is a gap naming its line,
 * never a service read in part. Anything in a Compose file that cannot be fully
 * resolved and interpreted refuses the whole file, never a partial read.
 */
import { LineCounter, isAlias, isMap, isScalar, isSeq, parseAllDocuments, parseDocument, type Document } from 'yaml';
import { byCodePoint } from '../../model/order.js';
import type { ExtractionGap, SourceSpan } from '../records.js';
import { Records } from './accumulate.js';
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
  /** Pinned environment files named by the fully resolved service declaration. */
  readonly envFiles: readonly string[];
  readonly dependsOn: readonly string[];
  readonly healthcheck: {
    readonly test: string | readonly string[] | null;
    readonly interval: string | null;
    readonly timeout: string | null;
    readonly retries: number | null;
    readonly startPeriod: string | null;
    readonly startInterval: string | null;
    readonly disable: boolean | null;
    readonly span: SourceSpan;
  } | null;
}

function scalarText(node: unknown): string | null {
  return isScalar(node) && node.value !== null ? String(node.value) : null;
}

export type ComposeDocumentReading =
  | { readonly present: false; readonly reason: 'not-mapping' | 'no-services' }
  | { readonly present: true; readonly services: readonly ComposeService[]; readonly gaps: readonly ExtractionGap[] };

/** Probes the complete resolved document set; Compose authority never accepts a multi-document file. */
export function readComposeDocument(text: string, path: string): ComposeDocumentReading {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, { lineCounter, keepSourceTokens: true, merge: true });
  const tree = new TreeText({ paths: [path], read: () => new TextEncoder().encode(text) });
  let candidate: { services: readonly ComposeService[]; gaps: readonly ExtractionGap[] } | undefined;
  let reason: 'not-mapping' | 'no-services' = 'not-mapping';
  for (const document of documents) {
    const records = new Records(tree);
    const state: { absent?: 'not-mapping' | 'no-services' } = {};
    // Compose-ness is determined inside the shared reader only after root aliases
    // and merge keys have been resolved through the same accessor as all fields.
    const services = readResolvedCompose(tree, records, path, state, document, lineCounter);
    if (state.absent === undefined) candidate = { services, gaps: records.gaps };
    else if (state.absent === 'no-services') reason = 'no-services';
  }
  if (candidate === undefined) return { present: false, reason };
  if (documents.length > 1) return { present: true, services: [], gaps: [{ path, reason: 'line 1: a Compose file must contain exactly one YAML document; no partial document was read' }] };
  return { present: true, ...candidate };
}

/** Reads one compose file; a file the reader refuses is a gap and no services. */
export function readComposeFile(t: TreeText, records: Records, path: string): readonly ComposeService[] {
  // Extraction keeps its historical single-document diagnostics. The authority
  // probe checks document membership separately; both use this resolved reader.
  const lineCounter = new LineCounter();
  const document = parseDocument(t.text(path), { lineCounter, keepSourceTokens: true, merge: true });
  const state: { absent?: 'not-mapping' | 'no-services' } = {};
  const services = readResolvedCompose(t, records, path, state, document, lineCounter);
  if (state.absent !== undefined) records.gap(path, state.absent === 'not-mapping' ? 'the file is no mapping: a compose file maps service names to their declarations' : 'the file declares no services mapping');
  return services;
}

function readResolvedCompose(t: TreeText, records: Records, path: string, state: { absent?: 'not-mapping' | 'no-services' }, document: Document, lineCounter: LineCounter): readonly ComposeService[] {
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
    state.absent = 'not-mapping';
    return [];
  }
  const services = field(contents, 'services');
  if (services === undefined) { state.absent = 'no-services'; return []; }
  if (!isMap(services)) {
    const key = pairs(contents).find((entry) => isScalar(entry.key) && entry.key.value === 'services')?.key;
    const line = lineCounter.linePos(isScalar(key) ? key.range?.[0] ?? 0 : 0).line;
    records.gap(path, `line ${line}: the file declares no services mapping`); return [];
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
    const envFiles: string[] = [];
    const filesNode = field(pair.value, 'env_file');
    for (const entry of isSeq(filesNode) ? items(filesNode) : filesNode === undefined ? [] : [filesNode]) {
      const file = isMap(entry) ? field(entry, 'path') : entry;
      if (!isScalar(file) || typeof file.value !== 'string') {
        records.gap(path, `line ${serviceLine}: the environment file declaration is unsupported`);
        return [];
      }
      envFiles.push(file.value);
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
    const healthPair = isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'healthcheck') : undefined;
    const health = healthPair?.value;
    let healthcheck: ComposeService['healthcheck'] = null;
    if (isMap(health)) {
      const value = (name: string): unknown => health.items.find((item) => isScalar(item.key) && item.key.value === name)?.value;
      const test = value('test');
      const retries = Number(scalarText(value('retries')) ?? Number.NaN);
      const disabled = scalarText(value('disable'));
      const start = isScalar(healthPair?.key) ? healthPair.key.range?.[0] ?? 0 : health.range?.[0] ?? 0;
      healthcheck = {
        test: isSeq(test) ? test.items.map(scalarText).filter((item): item is string => item !== null) : scalarText(test),
        interval: scalarText(value('interval')), timeout: scalarText(value('timeout')),
        retries: Number.isFinite(retries) ? retries : null,
        startPeriod: scalarText(value('start_period')), startInterval: scalarText(value('start_interval')),
        disable: disabled === null ? null : disabled === 'true',
        span: t.spanOfLines(path, lineCounter.linePos(start).line, lineCounter.linePos(Math.max(start, (health.range?.[1] ?? start + 1) - 1)).line),
      };
    }
    environment.sort((left, right) => byCodePoint(left.name, right.name));
    dependsOn.sort(byCodePoint);
    ports.sort(byCodePoint);
    read.push({ name, line: serviceLine, image, build, ports, portMappings, environment, envFiles, dependsOn, healthcheck });
  }
  read.sort((left, right) => byCodePoint(left.name, right.name));
  return read;
}

