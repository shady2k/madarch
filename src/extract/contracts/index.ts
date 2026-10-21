/**
 * The contracts extractor (madarch-o0eq.1): one `Extraction` over a TreeReader
 * that carries the contracts (OpenAPI, protobuf, AsyncAPI), the routes and
 * servers that serve them, the clients that call them, the Kafka channels the
 * code speaks on, the process entry points and what each starts, and the
 * untrusted-input path to `$queryRawUnsafe`. Pure: the reader's bytes decide
 * the answer, and every file this extractor tries to read and cannot is a gap,
 * never a silence.
 *
 * Linking rules, each bounded to what the bytes say:
 * - a route serves the operation whose contract method and path template it
 *   registers (`{id}` against `:id` and `${orderId}`);
 * - a client file's fetch calls and stub calls are `code.calls-remote` edges
 *   positioned at the call site, to the operation when a contract has one and
 *   otherwise to the serving route;
 * - a Kafka send names its channel by a topic constant of the same service;
 * - the SQL path links reads of `req.query` to a builder that splices them and
 *   on to `$queryRawUnsafe` through the file's local variable bindings.
 */
import {readAsyncApi, asyncApiNodes} from './asyncapi.js';
import {goEntryPointStarts, readGoFile, type GoFileFacts} from './go-code.js';
import {openApiNodes, readOpenApi} from './openapi.js';
import {protoNodes, readProto} from './proto.js';
import {
  channelKey,
  CONTRACTS_PRODUCER,
  entryPointKey,
  fileKey,
  inputKey,
  KIND_ENTRY_POINT,
  KIND_INPUT,
  KIND_ROUTE,
  KIND_SQL_BUILD,
  KIND_SQL_SINK,
  REL_CALLS_REMOTE,
  REL_CONSUMES,
  REL_FLOWS_INTO,
  REL_PUBLISHES,
  REL_SERVES,
  routeKey,
  sqlBuildKey,
  sqlSinkKey,
} from './schema.js';
import {readTsFile, joinPath, type TsFileFacts} from './ts-code.js';
import {readSyntaxTree} from '../../fill/stages/syntax-extract.js';
import type {ExtractedEdge, ExtractedNode, Extraction, ExtractionGap, TreeReader} from '../../extract/records.js';

/** The path prefixes this extractor reads contracts from. */
const CONTRACT_FOLDERS: ReadonlyMap<string, (path: string) => boolean> = new Map([
  ['openapi', (p) => p.startsWith('contracts/openapi/') && p.endsWith('.yaml')],
  ['asyncapi', (p) => p.startsWith('contracts/asyncapi/') && p.endsWith('.yaml')],
  ['proto', (p) => p.startsWith('contracts/proto/') && p.endsWith('.proto')],
]);

const decoder = new TextDecoder('utf-8', {fatal: true});

/** The path is source a client or an event site can live in: no test file, no declaration file. */
function isSourcePath(path: string): boolean {
  return (
    (path.endsWith('.ts') || path.endsWith('.go')) &&
    !path.endsWith('.d.ts') &&
    !/(^|\/)(test|tests|__tests__)\//.test(path) &&
    !/\.(test|spec)\.[tj]s$/.test(path) &&
    !path.endsWith('_test.go')
  );
}

export async function extractContracts(reader: TreeReader): Promise<Extraction> {
  const nodes: ExtractedNode[] = [];
  const edges: ExtractedEdge[] = [];
  const gaps: ExtractionGap[] = [];

  // ---- the contracts --------------------------------------------------------
  const openApiOperations: {path: string; method: string; routePath: string; key: string}[] = [];
  const channels: {name: string; messageEventTypes: ReadonlyMap<string, readonly string[]>}[] = [];
  const protoRpcs: {protoPath: string; package?: string; service: string; rpc: string; key: string}[] = [];

  for (const p of reader.paths) {
    let bytes: Uint8Array;
    try {
      bytes = reader.read(p);
    } catch (error) {
      gaps.push({path: p, reason: `contracts: the tree carries no readable bytes: ${String(error)}`});
      continue;
    }
    const format = [...CONTRACT_FOLDERS.entries()].find(([_, applies]) => applies(p))?.[0];
    if (format === undefined) continue;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      gaps.push({path: p, reason: 'contracts: the bytes are not UTF-8 text'});
      continue;
    }
    if (format === 'openapi') {
      const {contract, gaps: fileGaps} = readOpenApi(p, text);
      gaps.push(...fileGaps);
      nodes.push(...openApiNodes(contract));
      for (const op of contract.operations) {
        openApiOperations.push({path: p, method: op.method, routePath: op.path, key: `code.operation:${p}#${op.method}:${op.path}`});
      }
    } else if (format === 'asyncapi') {
      const {contract, gaps: fileGaps} = readAsyncApi(p, text);
      gaps.push(...fileGaps);
      nodes.push(...asyncApiNodes(contract));
      for (const channel of contract.channels) {
        channels.push({name: channel.name, messageEventTypes: new Map(channel.messages.map((m) => [m.name, m.eventTypes ?? []]))});
      }
    } else {
      const {contract, gaps: fileGaps} = readProto(p, text);
      gaps.push(...fileGaps);
      nodes.push(...protoNodes(contract));
      for (const service of contract.services) {
        for (const rpc of service.rpcs) {
          const key = `code.operation:${p}#${contract.package ?? ''}.${service.name}/${rpc.rpc}`;
          protoRpcs.push({protoPath: p, package: contract.package, service: service.name, rpc: rpc.rpc, key});
        }
      }
    }
  }

  // ---- the code -------------------------------------------------------------
  interface Parsed {
    path: string;
    go?: GoFileFacts;
    ts?: TsFileFacts;
    root?: import('web-tree-sitter').Node;
  }
  const parsed: Parsed[] = [];
  for (const p of reader.paths) {
    if (!isSourcePath(p)) continue;
    let bytes: Uint8Array;
    try {
      bytes = reader.read(p);
    } catch (error) {
      gaps.push({path: p, reason: `contracts: the tree carries no readable bytes: ${String(error)}`});
      continue;
    }
    const read = await readSyntaxTree(p, bytes, (file) => file.root);
    if (!read.read) {
      gaps.push(...read.unread.map((gap) => ({path: p, reason: `contracts: ${gap.what}: ${gap.reason}`})));
      continue;
    }
    const facts = p.endsWith('.go') ? readGoFile(p, read.value) : readTsFile(p, read.value);
    parsed.push({path: p, ...(p.endsWith('.go') ? {go: facts as GoFileFacts} : {ts: facts as TsFileFacts}), root: read.value});
  }

  const goFiles = parsed.filter((file) => file.go !== undefined) as (Parsed & {go: GoFileFacts; root: import('web-tree-sitter').Node})[];
  const tsFiles = parsed.filter((file) => file.ts !== undefined) as (Parsed & {ts: TsFileFacts; root: import('web-tree-sitter').Node})[];

  /** The Go methods of the tree, `Type.Name` -> the file that declares it. */
  const goMethodFiles = new Map<string, string>();
  for (const file of goFiles) for (const method of file.go.methods) if (!goMethodFiles.has(method)) goMethodFiles.set(method, file.path);

  const serviceOf = moduleServiceOf;
  const filesOfService = (service: string): Parsed[] => parsed.filter((file) => moduleServiceOf(file.path) === service);

  /** The first middleware of any chain whose function verifies with HS256, per service. */
  const authMiddlewareByService = new Map<string, {name: string}>();
  for (const file of parsed) {
    const service = serviceOf(file.path);
    if (authMiddlewareByService.has(service)) continue;
    const names = new Set<string>();
    if (file.go !== undefined) {
      for (const route of file.go.routes) for (const name of route.middleware) names.add(name.replace(/\(.*/, ''));
    }
    if (file.ts !== undefined) {
      for (const route of file.ts.routes) for (const name of route.middleware) names.add(name);
      for (const mount of file.ts.mounts) for (const name of mount.middlewares) names.add(name);
    }
    if (file.root === undefined) continue;
    for (const name of names) {
      const root = file.root;
      let verifies = false;
      const scan = (node: import('web-tree-sitter').Node): void => {
        if (verifies) return;
        const isFn = node.type === 'function_declaration' && node.childForFieldName('name')?.text === name;
        if (isFn) {
          const literal = /"HS256"|'HS256'/.test(node.text);
          if (literal) verifies = true;
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child !== null) scan(child);
        }
      };
      scan(root);
      if (verifies) {
        authMiddlewareByService.set(service, {name});
        break;
      }
    }
  }

  /** True when two path templates match segment by segment (`{id}` against `:id` and `${orderId}`). */
  const pathMatches = (candidate: string, template: string): boolean => {
    const left = candidate.split('?')[0]!.split('/');
    const right = template.split('?')[0]!.split('/');
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      const a = left[i]!;
      const b = right[i]!;
      if (a === b) continue;
      const wildA = a.startsWith('{') || a.startsWith(':') || a.startsWith('${') || a === '*';
      const wildB = b.startsWith('{') || b.startsWith(':') || b.startsWith('${') || b === '*';
      if (wildA && wildB) continue;
      return false;
    }
    return true;
  };

  /** The OpenAPI operation a method and path serve, exact template first. */
  const operationFor = (method: string, routePath: string): string | undefined => {
    const sameMethod = openApiOperations.filter((op) => op.method === method);
    return (sameMethod.find((op) => op.routePath === routePath) ?? sameMethod.find((op) => pathMatches(routePath, op.routePath)))?.key;
  };

  /** The code route a client call with no contract hits, exact template first. */
  const routeKeyFor = (method: string, routePath: string): string | undefined => {
    const all: {method: string; path: string; file: string}[] = [];
    for (const file of goFiles) for (const route of file.go.routes) all.push({method: route.method, path: route.path, file: file.path});
    for (const file of tsFiles) for (const route of file.ts.routes) all.push({method: route.method, path: route.path, file: file.path});
    const sameMethod = all.filter((route) => route.method === method);
    const found = sameMethod.find((route) => route.path === routePath) ?? sameMethod.find((route) => pathMatches(routePath, route.path));
    return found !== undefined ? routeKey(found.file, found.method, found.path) : undefined;
  };

  const addEdge = (
    type: typeof REL_SERVES | typeof REL_CALLS_REMOTE | typeof REL_PUBLISHES | typeof REL_CONSUMES | typeof REL_FLOWS_INTO,
    from: string,
    to: string,
    properties: {readonly [key: string]: import('../../extract/records.js').PropertyValue},
    span?: {path: string; byteStart: number; byteEnd: number; lineStart: number; lineEnd: number},
  ): void => {
    edges.push({type, from, to, discriminator: '', properties, ...(span !== undefined ? {span} : {})});
  };

  // ---- Go: routes, serves, entry points, Kafka -------------------------------
  for (const file of goFiles) {
    const service = serviceOf(file.path);
    const auth = authMiddlewareByService.get(service);
    for (const route of file.go.routes) {
      const properties: {[key: string]: import('../../extract/records.js').PropertyValue} = {
        method: route.method,
        path: route.path,
        handler: route.handler,
        handlerSymbol: route.handlerSymbol,
        middleware: route.middleware,
        authGroup: route.authGroup,
        ...(route.authGroup && auth !== undefined && route.middleware.includes(auth.name) ? {authAlgorithm: 'HS256'} : {}),
      };
      if (goMethodFiles.has(route.handlerSymbol)) properties['handlerPath'] = goMethodFiles.get(route.handlerSymbol)!;
      const span = spanOfNode(file.root, route.spanNode, file.path);
      nodes.push({
        key: routeKey(file.path, route.method, route.path),
        kind: KIND_ROUTE,
        label: `${route.method} ${route.path}`,
        properties,
        span,
      });
    }

    if (file.go.entryPoint) {
      const body = mainBodyOf(file.root);
      if (body !== undefined) {
        const packageFiles = new Map(goFiles.filter((held) => folderOf(held.path) === folderOf(file.path)).map((held) => [held.path, held.root]));
        const started = goEntryPointStarts(body, packageFiles, file.path);
        nodes.push({
          key: entryPointKey(file.path, 'main'),
          kind: KIND_ENTRY_POINT,
          label: `main (${file.path})`,
          properties: {language: 'go', symbol: 'main', starts: started.map((unit) => ({...unit}))},
        });
      }
    }

    for (const site of file.go.kafkaSites) {
      if (site.kind === 'publish') {
        const span = spanOfNode(file.root, site.spanNode, file.path);
        const viaOutbox = filesOfService(service).some((held) => {
          const text = textOf(reader, held.path, gaps);
          return text !== undefined && /FROM outbox|INTO outbox/.test(text);
        });
        for (const channel of channels) {
          const constant = constantForService(filesOfService(service), channel.name);
          if (constant === undefined) continue;
          addEdge(REL_PUBLISHES, fileKey(file.path), channelKey(channel.name), {
            topic: channel.name,
            constant: constant.name,
            constantPath: constant.path,
            ...(viaOutbox ? {via: 'outbox'} : {}),
          }, span);
        }
      } else if (site.topic !== undefined) {
        const constName = site.topic.replace(/^&/, '');
        const topic = readerConst(filesOfService(service), constName);
        if (topic === undefined) continue;
        const channel = channels.find((held) => held.name === topic);
        if (channel === undefined) continue;
        const span = spanOfNode(file.root, site.spanNode, file.path);
        addEdge(REL_CONSUMES, fileKey(file.path), channelKey(topic), {
          topic,
          ...(site.group !== undefined ? {group: site.group} : {}),
          ...consumerBehaviour(file, filesOfService(service)),
        }, span);
      }
    }
  }

  // ---- TypeScript: routes, mounts, entry points, clients, events, SQL -------
  for (const file of tsFiles) {
    const service = serviceOf(file.path);
    const auth = authMiddlewareByService.get(service);
    // The mounts other files of this service declare for the routers this file builds.
    const ownFactories = new Set(file.ts.routerFactories.values());
    const mountsHere = tsFiles
      .filter((other) => serviceOf(other.path) === service)
      .flatMap((other) => other.ts.mounts.filter((mount) => mount.factory !== undefined && ownFactories.has(mount.factory)).map((mount) => ({mount, from: other.path})));
    const appMiddlewares = tsFiles
      .filter((other) => serviceOf(other.path) === service && other.ts.mounts.length > 0)
      .flatMap((other) => other.ts.appMiddlewares);
    for (const route of file.ts.routes) {
      const routeFactory = route.routerVar !== undefined ? file.ts.routerFactories.get(route.routerVar) : undefined;
      const mount = routeFactory !== undefined ? mountsHere.find((held) => held.mount.factory === routeFactory) : undefined;
      const prefix = mount !== undefined ? mount.mount.prefix : '';
      const chain = mount !== undefined ? [...appMiddlewares, ...mount.mount.middlewares, ...route.middleware] : route.middleware;
      const path = mount !== undefined ? joinPath(prefix, route.path) : route.path;
      const authName = chain.find((name) => auth !== undefined && name === auth.name);
      nodes.push({
        key: routeKey(file.path, route.method, path),
        kind: KIND_ROUTE,
        label: `${route.method} ${path}`,
        properties: {
          method: route.method,
          path,
          middleware: chain,
          authGroup: authName !== undefined,
          ...(authName !== undefined ? {authAlgorithm: 'HS256'} : {}),
        },
        span: spanOfNode(file.root, route.spanNode, file.path),
      });
    }

    if (file.ts.entry !== undefined) {
      nodes.push({
        key: entryPointKey(file.path, file.ts.entry.symbol),
        kind: KIND_ENTRY_POINT,
        label: `${file.ts.entry.symbol} (${file.path})`,
        properties: {language: 'typescript', symbol: file.ts.entry.symbol, starts: file.ts.started.map((unit) => ({...unit}))},
      });
    }

    // The proto this file loads, if it does.
    let protoKeyOf: string | undefined;
    if (file.ts.protoPath !== undefined) {
      const resolved = normalizePath(`${folderOf(file.path)}/${file.ts.protoPath}`);
      const rpcs = protoRpcs.filter((rpc) => rpc.protoPath === resolved);
      if (rpcs.length > 0) protoKeyOf = resolved;

      for (const site of file.ts.grpcSites) {
        const match = rpcs.find((rpc) => rpc.rpc.toLowerCase() === site.rpc.toLowerCase());
        if (match === undefined) continue;
        if (site.kind === 'serve') {
          addEdge(REL_SERVES, fileKey(file.path), match.key, {
            handler: site.fn !== undefined ? `${site.fn}.${site.rpc}` : site.rpc,
          }, spanOfNode(file.root, site.spanNode, file.path));
        } else {
          const client = qualifiedNameOf(file.root, site.spanNode) ?? site.rpc;
          addEdge(REL_CALLS_REMOTE, fileKey(file.path), match.key, {
            client,
            via: 'grpc',
            ...deadlineOf(file, tsFiles, serviceOf(file.path)),
          }, spanOfNode(file.root, site.spanNode, file.path));
        }
      }
    }

    // HTTP clients: fetch calls to an operation, or to the route that serves the path.
    for (const call of file.ts.fetchCalls) {
      const routePath = call.urlText.replace(/(^\$\{[^}]*\})+/, '').split('?')[0]!;
      if (!routePath.startsWith('/')) continue;
      const placeholder = routePath.replace(/\$\{[^}]*\}/g, '{}');
      const operation = operationFor(call.method, placeholder);
      const properties: {[key: string]: import('../../extract/records.js').PropertyValue} = {
        ...(call.client !== undefined ? {client: call.client} : {}),
        via: 'http',
        ...(call.tokenForwarded ? {tokenForwarded: true} : {}),
      };
      const span = spanOfNode(file.root, call.spanNode, file.path);
      if (operation !== undefined) {
        addEdge(REL_CALLS_REMOTE, fileKey(file.path), operation, properties, span);
        continue;
      }
      const route = routeKeyFor(call.method, placeholder);
      if (route !== undefined) addEdge(REL_CALLS_REMOTE, fileKey(file.path), route, properties, span);
    }

    // Kafka sends that name a channel by a constant of this service.
    for (const send of file.ts.sends) {
      if (send.channel === undefined) continue;
      if (!channels.some((held) => held.name === send.channel)) continue;
      const constantEntry = constantForService(filesOfService(service), send.channel);
      const union = [...file.ts.typeUnions.values()].find((members) => members.length > 0 && members.every((member) => member.includes('.')));
      addEdge(REL_PUBLISHES, fileKey(file.path), channelKey(send.channel), {
        topic: send.channel,
        publisher: send.publisher ?? '',
        ...(send.key !== undefined ? {key: send.key} : {}),
        ...(union !== undefined ? {eventTypes: [...union].sort()} : {}),
        ...(constantEntry !== undefined ? {constant: constantEntry.name, constantPath: constantEntry.path} : {}),
      }, spanOfNode(file.root, send.spanNode, file.path));
    }

    // The SQL path of one file: inputs, builders, the sink, and the local bindings between them.
    extractSqlFlow(file, nodes, addEdge);
  }

  // ---- serving links --------------------------------------------------------
  // A contract operation is served by the one route of the tree that matches its
  // method and path template. Where several match (/healthz of four services,
  // say), the link is not claimed: ambiguity is said, not resolved.
  {
    const allRoutes: {method: string; path: string; key: string}[] = [];
    for (const node of nodes) {
      if (node.kind !== KIND_ROUTE) continue;
      allRoutes.push({method: node.properties['method'] as string, path: node.properties['path'] as string, key: node.key});
    }
    for (const operation of openApiOperations) {
      const matching = allRoutes.filter((route) => route.method === operation.method && pathMatches(route.path, operation.routePath));
      if (matching.length !== 1) continue;
      addEdge(REL_SERVES, matching[0]!.key, operation.key, {});
    }
  }

  nodes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  edges.sort((a, b) => `${a.type} ${a.from} ${a.to}` < `${b.type} ${b.from} ${b.to}` ? -1 : 1);
  gaps.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {producer: CONTRACTS_PRODUCER, nodes, edges, gaps};
}

// ---- helpers over the parsed trees ------------------------------------------

import {calleeName, callsNamed, walkTree} from './walk.js';
import type {Node as SyntaxNode} from 'web-tree-sitter';
import type {PropertyValue} from '../../extract/records.js';

type AddEdge = (
  type: typeof REL_SERVES | typeof REL_CALLS_REMOTE | typeof REL_PUBLISHES | typeof REL_CONSUMES | typeof REL_FLOWS_INTO,
  from: string,
  to: string,
  properties: {readonly [key: string]: PropertyValue},
  span?: {path: string; byteStart: number; byteEnd: number; lineStart: number; lineEnd: number},
) => void;

function spanOfNode(root: SyntaxNode, node: SyntaxNode, path: string): {path: string; byteStart: number; byteEnd: number; lineStart: number; lineEnd: number} {
  void root;
  return {
    path,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
  };
}

/** The service folder a path stands under (`services/orders/...` -> `services/orders`). */
function moduleServiceOf(path: string): string {
  const match = /^(services\/[^/]+)\//.exec(path);
  return match?.[1] ?? path;
}

function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function mainBodyOf(root: SyntaxNode): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walkTree(root, (node) => {
    if (found !== undefined || node.type !== 'function_declaration') return;
    if (node.childForFieldName('name')?.text === 'main') found = node.childForFieldName('body') ?? undefined;
  });
  return found;
}

/** The class and method a node stands in (`PaymentsClient.authorize`). */
function qualifiedNameOf(root: SyntaxNode, node: SyntaxNode): string | undefined {
  void root;
  let held: SyntaxNode | null = node;
  let method: string | undefined;
  while (held !== null) {
    if (held.type === 'method_definition' && method === undefined) method = held.childForFieldName('name')?.text;
    if (held.type === 'class_declaration' && method !== undefined) {
      const className = held.childForFieldName('name')?.text;
      if (className !== undefined) return `${className}.${method}`;
    }
    held = held.parent;
  }
  return undefined;
}

/** The deadline hop chain: `{ deadline }` -> `this.<field>` -> constructor arg -> `config.<name>` -> `?? <n>`. */
function deadlineOf(file: {root: SyntaxNode; path: string; ts: TsFileFacts}, tsFiles: {path: string; ts: TsFileFacts; root: SyntaxNode}[], service: string): {deadlineMs?: number} {
  // 1. the stub call's deadline argument names a field of the client (`this.deadlineMs`).
  let field: string | undefined;
  walkTree(file.root, (node) => {
    if (field !== undefined || node.type !== 'variable_declarator') return;
    if (node.childForFieldName('name')?.text !== 'deadline') return;
    const value = node.childForFieldName('value')?.text ?? '';
    const match = /this\.([A-Za-z0-9_]+)/.exec(value);
    if (match) field = match[1]!;
  });
  if (field === undefined) return {};
  // 2. the client class of this file (the one with the constructor parameter property of that name).
  let className: string | undefined;
  walkTree(file.root, (node) => {
    if (className !== undefined || node.type !== 'class_declaration') return;
    const body = node.childForFieldName('body');
    if (body === null) return;
    let has = false;
    walkTree(body, (inner) => {
      if (inner.type === 'required_parameter' || inner.type === 'private_property_definition') {
        if (inner.text.includes(field!)) has = true;
      }
    });
    if (has) className = node.childForFieldName('name')?.text;
  });
  if (className === undefined) return {};
  // 3. a `new <Class>(..., config.<name>)` somewhere in the service.
  let configName: string | undefined;
  for (const other of tsFiles) {
    if (moduleServiceOf(other.path) !== service) continue;
    let found = false;
    walkTree(other.root, (node) => {
      if (found || node.type !== 'new_expression') return;
      if (node.childForFieldName('constructor')?.text !== className) return;
      const args = node.childForFieldName('arguments');
      const second = args?.namedChild(1)?.text;
      const match = second !== undefined ? /\.([A-Za-z0-9_]+)$/.exec(second) : undefined;
      if (match) {
        configName = match[1]!;
        found = true;
      }
    });
    if (found) break;
  }
  if (configName === undefined) return {};
  // 4. the service's config default: `<name>: ... ?? <number>`.
  for (const other of tsFiles) {
    if (moduleServiceOf(other.path) !== service) continue;
    let value: number | undefined;
    walkTree(other.root, (node) => {
      if (value !== undefined || node.type !== 'pair') return;
      if (node.childForFieldName('key')?.text !== configName) return;
      const match = /\?\?\s*(\d+)/.exec(node.childForFieldName('value')?.text ?? '');
      if (match) value = Number(match[1]);
    });
    if (value !== undefined) return {deadlineMs: value};
  }
  return {};
}

/** The constant of one service whose value is the channel name. */
function constantForService(files: {path: string}[], channel: string): {name: string; path: string} | undefined {
  for (const file of files as {path: string; go?: GoFileFacts; ts?: TsFileFacts}[]) {
    const consts = file.go?.consts ?? file.ts?.consts;
    if (consts === undefined) continue;
    for (const [name, value] of consts) {
      if (value === channel) return {name, path: file.path};
    }
  }
  return undefined;
}

/** The value of one named string constant across a set of parsed files. */
function readerConst(files: {go?: GoFileFacts; ts?: TsFileFacts}[], name: string): string | undefined {
  for (const file of files) {
    const value = file.go?.consts.get(name) ?? file.ts?.consts.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function textOf(reader: TreeReader, path: string, gaps: ExtractionGap[]): string | undefined {
  try {
    return decoder.decode(reader.read(path));
  } catch {
    return undefined;
  }
}

/**
 * The consumer's behaviour, as far as the bytes state it: the interface method
 * the consumer delegates to and the type that implements it, the event kinds
 * its switch maps, whether duplicates are decided by a status comparison, and
 * whether the offset commit is unconditional in the loop.
 */
function consumerBehaviour(
  file: {path: string; go: GoFileFacts; root: SyntaxNode},
  serviceFiles: {path: string; go?: GoFileFacts; root?: SyntaxNode}[],
): {[key: string]: PropertyValue} {
  // The interface methods the file declares (`ApplyPaymentEvent` of PaymentEventHandler).
  const interfaceMethods: string[] = [];
  walkTree(file.root, (node) => {
    if (node.type !== 'interface_type') return;
    walkTree(node, (inner) => {
      if (inner.type === 'method_element') {
        const name = inner.childForFieldName('name')?.text;
        if (name !== undefined) interfaceMethods.push(name);
      }
    });
  });
  const properties: {[key: string]: PropertyValue} = {};
  for (const name of interfaceMethods) {
    // The implementing method in the same service.
    let handlerType: string | undefined;
    let handlerFile: {path: string; root: SyntaxNode} | undefined;
    for (const other of serviceFiles) {
      const otherRoot = other.root;
      if (other.go === undefined || otherRoot === undefined) continue;
      let found = false;
      walkTree(otherRoot, (node) => {
        if (found || node.type !== 'method_declaration') return;
        if (node.childForFieldName('name')?.text !== name) return;
        const receiver = node.childForFieldName('receiver')?.namedChild(0)?.text.replace(/^\*?/, '') ?? '';
        handlerType = receiver;
        handlerFile = {path: other.path, root: otherRoot};
        found = true;
      });
      if (found && handlerFile !== undefined) break;
    }
    if (handlerType === undefined || handlerFile === undefined) continue;
    properties['handler'] = `${handlerType}.${name}`;
    properties['handlerPath'] = handlerFile.path;
    // The event kinds the handler's switch maps.
    let handlerBody: SyntaxNode | undefined;
    walkTree(handlerFile.root, (node) => {
      if (handlerBody !== undefined || node.type !== 'method_declaration') return;
      if (node.childForFieldName('name')?.text !== name) return;
      handlerBody = node.childForFieldName('body') ?? undefined;
    });
    if (handlerBody === undefined) continue;
    const kinds = new Set<string>();
    walkTree(handlerBody, (node) => {
      if (node.type !== 'expression_switch_case' && node.type !== 'expression_case') return;
      walkTree(node, (inner) => {
        if (inner.type === 'interpreted_string_literal') {
          const value = inner.text.slice(1, -1);
          if (value.includes('.')) kinds.add(value);
        }
      });
    });
    if (kinds.size > 0) properties['eventKinds'] = [...kinds].sort();
    // Duplicates: a guard method comparing a status for equality before applying.
    let statusComparison = false;
    walkTree(handlerBody, (node) => {
      if (statusComparison || node.type !== 'call_expression') return;
      const callee = node.childForFieldName('function');
      const method = callee?.type === 'selector_expression' ? callee.childForFieldName('field')?.text : callee?.type === 'identifier' ? callee.text : undefined;
      if (method === undefined || method === name) return;
      for (const other of serviceFiles) {
        if (other.go === undefined || other.root === undefined || statusComparison) continue;
        walkTree(other.root, (candidate) => {
          if (statusComparison || candidate.type !== 'method_declaration') return;
          if (candidate.childForFieldName('name')?.text !== method) return;
          const body = candidate.childForFieldName('body');
          if (body === null) return;
          walkTree(body, (binary) => {
            if (statusComparison || binary.type !== 'binary_expression') return;
            if (binary.childForFieldName('operator')?.text !== '==') return;
            if (binary.text.includes('.Status') || binary.text.includes('Status ==')) statusComparison = true;
          });
        });
      }
    });
    if (statusComparison) properties['duplicates'] = 'status-comparison';
    break;
  }
  // The offset commit: the handler is applied as a statement of the loop whose
  // outcome the commit does not read -- the commit checks only its own error.
  let unconditional = false;
  walkTree(file.root, (node) => {
    if (unconditional || node.type !== 'for_statement') return;
    const body = node.childForFieldName('body');
    if (body === null) return;
    let applies = false;
    let commits = false;
    for (let i = 0; i < body.childCount; i++) {
      const statement = body.child(i);
      if (statement === null) continue;
      if (statement.type === 'expression_statement') {
        const call = statement.namedChild(0);
        const name = call !== null && call.type === 'call_expression' ? calleeName(call) : undefined;
        if (name !== undefined && name !== 'CommitMessages' && name !== 'FetchMessage') applies = true;
      }
      if (statement.type === 'if_statement' && statement.text.includes('CommitMessages')) commits = true;
    }
    unconditional = applies && commits;
  });
  if (unconditional) properties['offsetCommit'] = 'unconditional';
  return properties;
}

/** The SQL path of one TypeScript file: nodes for the reads, the builders and the sink, edges between them. */
function extractSqlFlow(
  file: {path: string; ts: TsFileFacts; root: SyntaxNode},
  nodes: ExtractedNode[],
  addEdge: AddEdge,
): void {
  const {path, ts} = file;
  for (const input of ts.inputs) {
    nodes.push({
      key: inputKey(path, 'query', input.name),
      kind: KIND_INPUT,
      label: `query ${input.name}`,
      properties: {source: 'query', name: input.name, ...(input.fn !== undefined ? {readBy: input.fn} : {})},
      span: spanOfNode(file.root, input.spanNode, path),
    });
  }
  for (const sink of ts.sqlSinks) {
    nodes.push({
      key: sqlSinkKey(path, sink.callee),
      kind: KIND_SQL_SINK,
      label: sink.callee,
      properties: {callee: sink.callee, ...(sink.fn !== undefined ? {function: sink.fn} : {})},
      span: spanOfNode(file.root, sink.spanNode, path),
    });
  }
  if (ts.inputs.length === 0 || ts.sqlBuilds.length === 0 || ts.sqlSinks.length === 0) return;

  // The file's local bindings: `const filters = readFilters(req)` names the functions and variables its value uses.
  const bindings = new Map<string, {calls: Set<string>; vars: Set<string>}>();
  walkTree(file.root, (node) => {
    if (node.type !== 'variable_declarator') return;
    const name = node.childForFieldName('name')?.text;
    const value = node.childForFieldName('value');
    if (name === undefined || value === null) return;
    const calls = new Set<string>();
    const vars = new Set<string>();
    walkTree(value, (inner) => {
      if (inner.type === 'call_expression') {
        const callee = calleeName(inner);
        if (callee !== undefined) calls.add(callee);
      }
      if (inner.type === 'identifier' && inner.parent?.type !== 'call_expression') vars.add(inner.text);
    });
    bindings.set(name, {calls, vars});
  });

  // A string builder is only claimed when its result reaches the sink: the
  // splicing functions whose values never reach `$queryRawUnsafe` (the report
  // renderers splice their parameters into output text) are not builders.
  const onPath = new Set<string>();
  for (const sink of ts.sqlSinks) {
    if (sink.fn === undefined) continue;
    const sinkArgVars: string[] = [];
    walkTree(file.root, (node) => {
      if (node.type !== 'call_expression' || calleeName(node) !== sink.fn) return;
      const args = node.childForFieldName('arguments');
      if (args === null) return;
      for (let i = 0; i < args.childCount; i++) {
        const arg = args.child(i);
        if (arg !== null && arg.type === 'identifier') sinkArgVars.push(arg.text);
      }
    });
    for (const build of ts.sqlBuilds) {
      const reaches = sinkArgVars.some((variable) => {
        const binding = bindings.get(variable);
        if (binding === undefined) return false;
        if (binding.calls.has(build.fn)) return true;
        return [...binding.vars].some((inner) => bindings.get(inner)?.calls.has(build.fn) ?? false);
      });
      if (reaches) onPath.add(build.fn);
    }
  }
  const pathBuilds = ts.sqlBuilds.filter((build) => onPath.has(build.fn));
  for (const build of pathBuilds) {
    nodes.push({
      key: sqlBuildKey(path, build.fn),
      kind: KIND_SQL_BUILD,
      label: build.fn,
      properties: {function: build.fn, spliced: build.spliced},
      span: spanOfNode(file.root, build.spanNode, path),
    });
  }
  if (pathBuilds.length === 0) return;

  // input -> builder: the read's function returns the input under its own name, and the builder is called with that result.
  const buildCalls = new Map<string, string[]>();
  for (const build of pathBuilds) {
    const argVars: string[] = [];
    walkTree(file.root, (node) => {
      if (node.type !== 'call_expression') return;
      if (calleeName(node) !== build.fn) return;
      const arg = node.childForFieldName('arguments')?.namedChild(0)?.text;
      if (arg !== undefined) argVars.push(arg);
    });
    buildCalls.set(build.fn, argVars);
  }
  for (const input of ts.inputs) {
    if (input.fn === undefined) continue;
    const returned = returnsQueryProperty(file.root, input.fn, input.name);
    if (!returned) continue;
    for (const build of pathBuilds) {
      if (!build.spliced.includes(input.name)) continue;
      const callVars = buildCalls.get(build.fn) ?? [];
      const feeds = callVars.some((variable) => bindings.get(variable)?.calls.has(input.fn!) ?? false);
      if (feeds) addEdge(REL_FLOWS_INTO, inputKey(path, 'query', input.name), sqlBuildKey(path, build.fn), {});
    }
  }
  // builder -> sink.
  for (const sink of ts.sqlSinks) {
    if (sink.fn === undefined) continue;
    const sinkCalls: string[][] = [];
    walkTree(file.root, (node) => {
      if (node.type !== 'call_expression') return;
      if (calleeName(node) !== sink.fn) return;
      const args = node.childForFieldName('arguments');
      const vars: string[] = [];
      if (args !== null) {
        for (let i = 0; i < args.childCount; i++) {
          const arg = args.child(i);
          if (arg !== null && arg.type === 'identifier') vars.push(arg.text);
        }
      }
      sinkCalls.push(vars);
    });
    for (const build of pathBuilds) {
      const reaches = sinkCalls.some((vars) =>
        vars.some((variable) => {
          const binding = bindings.get(variable);
          if (binding === undefined) return false;
          if (binding.calls.has(build.fn)) return true;
          return [...binding.vars].some((inner) => bindings.get(inner)?.calls.has(build.fn) ?? false);
        }),
      );
      if (reaches) addEdge(REL_FLOWS_INTO, sqlBuildKey(path, build.fn), sqlSinkKey(path, sink.callee), {});
    }
  }
}

/** Whether the function returns the query input under the property `name`. */
function returnsQueryProperty(root: SyntaxNode, fn: string, name: string): boolean {
  let found = false;
  walkTree(root, (node) => {
    if (found || node.type !== 'function_declaration') return;
    if (node.childForFieldName('name')?.text !== fn) return;
    const body = node.childForFieldName('body');
    if (body === null) return;
    walkTree(body, (inner) => {
      if (found || inner.type !== 'return_statement') return;
      const value = inner.namedChild(0);
      if (value === null || value.type !== 'object') return;
      walkTree(value, (pair) => {
        if (found || pair.type !== 'pair') return;
        if (pair.childForFieldName('key')?.text !== name) return;
        if ((pair.childForFieldName('value')?.text ?? '').includes(`query.${name}`)) found = true;
      });
    });
  });
  return found;
}
