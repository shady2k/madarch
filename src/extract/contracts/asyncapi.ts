/**
 * The AsyncAPI reader: contracts/asyncapi/*.yaml into one `code.contract`
 * node, one `code.channel` node per channel (the Kafka topic is the channel
 * name here), and one `code.message` node per message the channels carry,
 * each with the span it was read at.
 */
import {parseDocument} from 'yaml';
import {channelKey, contractKey, KIND_CHANNEL, KIND_CONTRACT, KIND_MESSAGE, messageKey} from './schema.js';
import {SpanMeasure} from './spans.js';
import type {ExtractedNode, SourceSpan, ExtractionGap} from '../../extract/records.js';

/** One channel of an AsyncAPI document, with the messages it carries. */
export interface AsyncApiChannel {
  readonly name: string;
  readonly description?: string;
  readonly protocol?: string;
  readonly messages: readonly {name: string; eventTypes?: readonly string[]}[];
}

export interface AsyncApiContract {
  readonly path: string;
  readonly title?: string;
  readonly version?: string;
  readonly specVersion?: string;
  readonly channels: readonly AsyncApiChannel[];
}

/** The payload's `type` enum, when the payload declares one (the payment events do). */
function eventTypesOf(payload: unknown): readonly string[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const type = (payload as {properties?: {type?: {enum?: unknown}}}).properties?.type;
  const enumValues = type?.enum;
  if (!Array.isArray(enumValues)) return undefined;
  return enumValues.filter((v): v is string => typeof v === 'string').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Reads one AsyncAPI document; a malformed file is a gap, never a silence. */
export function readAsyncApi(path: string, text: string): {contract: AsyncApiContract; gaps: readonly ExtractionGap[]} {
  const gaps: ExtractionGap[] = [];
  const doc = parseDocument(text, {uniqueKeys: false});
  if (doc.errors.length > 0) {
    const line = new SpanMeasure(text).lineOf(doc.errors[0]!.pos?.[0] ?? 0);
    gaps.push({path, reason: `asyncapi: YAML parse error at line ${line}: ${doc.errors[0]!.message}`});
    return {contract: {path, channels: []}, gaps};
  }
  const root = doc.toJS() as {
    asyncapi?: string;
    info?: {title?: string; version?: string};
    servers?: Record<string, {protocol?: string}>;
    channels?: Record<string, unknown>;
    components?: {messages?: Record<string, unknown>};
  } | null;
  const measure = new SpanMeasure(text);
  const defaultProtocol = Object.values(root?.servers ?? {})[0]?.protocol;
  const componentMessages = root?.components?.messages ?? {};
  const channels: AsyncApiChannel[] = [];
  for (const [name, held] of Object.entries(root?.channels ?? {})) {
    const channel = (held ?? {}) as {
      description?: string;
      publish?: {message?: {$ref?: string} | Record<string, unknown>};
      subscribe?: {message?: {$ref?: string} | Record<string, unknown>};
    };
    const protocol = defaultProtocol;
    const messages: {name: string; eventTypes?: readonly string[]}[] = [];
    for (const direction of ['publish', 'subscribe'] as const) {
      const message = channel[direction]?.message;
      if (!message) continue;
      const ref = (message as {$ref?: string}).$ref;
      const nameMatch = typeof ref === 'string' ? ref.split('/').at(-1) : (message as {name?: string}).name;
      const name = typeof nameMatch === 'string' ? nameMatch : undefined;
      if (name === undefined) continue;
      const component = componentMessages[name] as {name?: string; payload?: unknown} | undefined;
      const eventTypes = eventTypesOf(component?.payload ?? (message as {payload?: unknown}).payload);
      messages.push({name, ...(eventTypes !== undefined ? {eventTypes} : {})});
    }
    channels.push({name, ...(channel.description !== undefined ? {description: channel.description} : {}), ...(protocol !== undefined ? {protocol} : {}), messages});
  }
  channels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    contract: {
      path,
      title: typeof root?.info?.title === 'string' ? root.info.title : undefined,
      version: typeof root?.info?.version === 'string' ? root.info.version : undefined,
      specVersion: typeof root?.asyncapi === 'string' ? root.asyncapi : undefined,
      channels,
    },
    gaps,
  };
}

/** The contract, channel and message nodes of one AsyncAPI document. */
export function asyncApiNodes(contract: AsyncApiContract): ExtractedNode[] {
  const nodes: ExtractedNode[] = [
    {
      key: contractKey(contract.path),
      kind: KIND_CONTRACT,
      label: contract.title ?? contract.path,
      properties: {
        format: 'asyncapi',
        ...(contract.specVersion !== undefined ? {specVersion: contract.specVersion} : {}),
        ...(contract.version !== undefined ? {version: contract.version} : {}),
      },
    },
  ];
  for (const channel of contract.channels) {
    nodes.push({
      key: channelKey(channel.name),
      kind: KIND_CHANNEL,
      label: channel.name,
      properties: {
        contract: contract.path,
        ...(channel.description !== undefined ? {description: channel.description} : {}),
        ...(channel.protocol !== undefined ? {protocol: channel.protocol} : {}),
      },
    });
    for (const message of channel.messages) {
      nodes.push({
        key: messageKey(contract.path, message.name),
        kind: KIND_MESSAGE,
        label: message.name,
        properties: {
          channel: channel.name,
          ...(message.eventTypes !== undefined ? {eventTypes: message.eventTypes} : {}),
        },
      });
    }
  }
  return nodes;
}
