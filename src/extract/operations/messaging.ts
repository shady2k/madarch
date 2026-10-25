/** Broker instances require an image, address setting or AsyncAPI server. */
import { LineCounter, isMap, isSeq, isScalar, parseDocument } from 'yaml';
import type { SourceSpan } from '../records.js';
import type { Records } from './accumulate.js';
import { readComposeFile } from './compose.js';
import type { TreeText } from './source.js';

interface Broker { key: string; aliases: Set<string>; addresses: Set<string>; span: SourceSpan }
const kafkaImage = /(?:^|\/)(?:kafka|cp-kafka|redpanda)(?::|@|$)/i;
function addresses(value: string): string[] {
  return value.split(',').map((part) => part.trim().replace(/^[A-Za-z][\w+.-]*:\/\//, '')).filter((part) => /^[\w.-]+:\d+$/.test(part));
}

export function extractMessaging(t: TreeText, records: Records): void {
  const brokers: Broker[] = [];
  const add = (key: string, name: string, span: SourceSpan, aliases: readonly string[], values: readonly string[], source: string): Broker => {
    const broker = { key, aliases: new Set(aliases), addresses: new Set(values), span };
    records.add({ key, kind: 'code.broker', label: name, properties: { technology: 'kafka', source, addresses: values }, span });
    brokers.push(broker);
    return broker;
  };
  for (const path of t.pathsNamed(/^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/)) {
    for (const service of readComposeFile(t, records, path)) {
      if (service.image === null || !kafkaImage.test(service.image)) continue;
      const values = service.environment.filter((variable) => /ADVERTISED_LISTENERS|ADVERTISED_KAFKA_ADDR/.test(variable.name)).flatMap((variable) => addresses(variable.value ?? ''));
      const broker = add(`code.broker:${path}#${service.name}`, service.name, t.spanOfLine(path, service.line), [service.name], values, 'compose');
      records.edge('code.runs', `code.compose-service:${path}#${service.name}`, broker.key, {}, broker.span);
    }
  }
  for (const node of records.nodes.filter((held) => held.kind === 'code.k8s-deployment')) {
    const image = node.properties.image;
    if (typeof image !== 'string' || !kafkaImage.test(image) || node.span === undefined) continue;
    const broker = add(`code.broker:${node.key.slice(node.key.indexOf(':') + 1)}`, node.label, node.span, [node.label], [], 'kubernetes');
    records.edge('code.runs', node.key, broker.key, {}, node.span);
  }
  const matching = (address: string): Broker[] => {
    const host = address.split(':')[0] ?? '';
    return brokers.filter((broker) => broker.addresses.has(address) || broker.aliases.has(host));
  };
  // Address settings keep their actual definition identities. An unresolved
  // variable substitution is not an address and creates no broker.
  for (const definition of [...records.nodes].filter((node) => node.kind === 'code.env-definition' && /(?:KAFKA_BROKERS|KAFKA_BOOTSTRAP_SERVERS)/.test(node.key))) {
    if (typeof definition.properties.value !== 'string' || definition.span === undefined) continue;
    for (const address of addresses(definition.properties.value)) {
      const candidates = matching(address);
      const broker = candidates.length === 1 ? candidates[0] : candidates.length === 0 ? add(`code.broker:address/${address}`, address, definition.span, [address.split(':')[0] ?? ''], [address], 'configuration') : undefined;
      if (broker === undefined) continue;
      records.edge('code.configured-by', broker.key, definition.key, { address }, definition.span, address);
      const scope = definition.properties.scope;
      if (typeof scope === 'string' && records.nodes.some((node) => node.key === `code.service:${scope}`)) records.edge('code.connects-to', `code.service:${scope}`, broker.key, { address }, definition.span, address);
      for (const edge of records.edges.filter((edge) => edge.type === 'code.defines' && edge.from === definition.key)) {
        const variableService = edge.to.slice('code.env-var:'.length).split('/')[0];
        if (variableService !== undefined && records.nodes.some((node) => node.key === `code.service:${variableService}`)) records.edge('code.connects-to', `code.service:${variableService}`, broker.key, { address }, definition.span, address);
      }
    }
  }
  // The server address in an AsyncAPI document binds its declared channels.
  for (const path of t.pathsUnder('contracts/asyncapi', /\.ya?ml$/)) {
    const counter = new LineCounter();
    const document = parseDocument(t.text(path), { lineCounter: counter, keepSourceTokens: true });
    for (const error of document.errors) records.gap(path, `line ${counter.linePos(error.pos[0]).line}: ${error.message}`);
    if (document.errors.length > 0 || !isMap(document.contents)) continue;
    const root = document.contents;
    const version = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'asyncapi')?.value;
    if (!isScalar(version) || !/^2\./.test(String(version.value))) {
      records.gap(path, `line 1: AsyncAPI ${isScalar(version) ? String(version.value) : 'version absent'} server membership is unsupported; no broker/channel hosting is inferred`); continue;
    }
    const servers = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'servers')?.value;
    const connected = new Map<string, Set<string>>();
    if (isMap(servers)) for (const server of servers.items) {
      if (!isMap(server.value)) continue;
      const scalar = (name: string): string | undefined => {
        const value = server.value && isMap(server.value) ? server.value.items.find((pair) => isScalar(pair.key) && pair.key.value === name)?.value : undefined;
        return isScalar(value) ? String(value.value) : undefined;
      };
      if (!/^kafka(?:-secure)?$/.test(scalar('protocol') ?? '')) continue;
      for (const address of addresses(scalar('url') ?? '')) {
        let candidates = matching(address);
        if (candidates.length === 0) {
          const line = counter.linePos(server.value.range?.[0] ?? 0).line;
          candidates = [add(`code.broker:address/${address}`, address, t.spanOfLine(path, line), [address.split(':')[0] ?? ''], [address], 'asyncapi-server')];
        }
        if (candidates.length === 1 && candidates[0] !== undefined && isScalar(server.key)) {
          const name = String(server.key.value);
          const held = connected.get(name) ?? new Set<string>(); held.add(candidates[0].key); connected.set(name, held);
        }
      }
    }
    const channels = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'channels')?.value;
    if (!isMap(channels)) continue;
    for (const channel of channels.items) {
      if (!isScalar(channel.key) || typeof channel.key.value !== 'string') continue;
      const name = channel.key.value;
      const line = counter.linePos(channel.key.range?.[0] ?? 0).line;
      const span = t.spanOfLine(path, line);
      const key = `code.channel:${name}`;
      records.add({ key, kind: 'code.channel', label: name, properties: { contract: path, protocol: 'kafka' }, span });
      const restriction = isMap(channel.value) ? channel.value.items.find((pair) => isScalar(pair.key) && pair.key.value === 'servers')?.value : undefined;
      let selected = [...connected.keys()];
      if (restriction !== undefined) {
        if (!isSeq(restriction) || restriction.items.some((item) => !isScalar(item) || typeof item.value !== 'string')) {
          records.gap(path, `line ${line}: channel ${name} has an unsupported servers membership; no broker is inferred`); continue;
        }
        selected = restriction.items.flatMap((item) => isScalar(item) && typeof item.value === 'string' ? [item.value] : []);
        for (const server of selected) if (!connected.has(server)) records.gap(path, `line ${line}: channel ${name} names unresolved server ${server}`);
      }
      for (const broker of new Set(selected.flatMap((server) => [...(connected.get(server) ?? [])]))) records.edge('code.hosts-channel', broker, key, {}, span);
    }
  }
}
