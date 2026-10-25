/**
 * One compose file, read once for every area that needs it: the services with
 * their image, build, ports, environment and depends_on, each with the line it
 * stands on. The reader is strict — YAML it refuses is a gap naming its line,
 * never a service read in part.
 */
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
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
    const envNode = isMap(pair.value) ? pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'environment')?.value : undefined;
    if (isMap(envNode)) {
      for (const variable of envNode.items) {
        if (!isScalar(variable.key) || typeof variable.key.value !== 'string') continue;
        const line = lineCounter.linePos(variable.key.range?.[0] ?? 0).line;
        environment.push({ name: variable.key.value, value: scalarText(variable.value), span: t.spanOfLine(path, line) });
      }
    } else if (isSeq(envNode)) {
      for (const item of envNode.items) {
        const text = scalarText(item);
        if (text === null) continue;
        const at = text.indexOf('=');
        const name = at < 0 ? text : text.slice(0, at);
        const line = lineCounter.linePos((item as { range?: number[] }).range?.[0] ?? 0).line;
        environment.push({ name, value: at < 0 ? null : text.slice(at + 1), span: t.spanOfLine(path, line) });
      }
    }
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
    read.push({ name, line: serviceLine, image, build, ports, portMappings, environment, dependsOn, healthcheck });
  }
  read.sort((left, right) => byCodePoint(left.name, right.name));
  return read;
}

