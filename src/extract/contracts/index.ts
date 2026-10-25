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
 * - a contract operation is served by the one route of the tree whose method
 *   and path template match it; where several match (`/healthz` of four
 *   services), the link is not claimed;
 * - a client file's fetch calls and stub calls are `code.calls-remote` edges
 *   positioned at the call site, to the operation when a contract has one and
 *   otherwise to the one route that serves the path;
 * - a Kafka send or reader names its channel by a topic constant of the same
 *   service;
 * - the SQL path links reads of `req.query` to the string builders whose
 *   results reach `$queryRawUnsafe`, through the file's local bindings.
 */
import {asyncApiNodes, readAsyncApi} from './asyncapi.js';
import {contractSymbols} from './symbol-links.js';
import {readGoFile, resolveGoStarts, duplicatesByStatusComparison, type GoFileFacts} from './go-code.js';
import {openApiNodes, readOpenApi} from './openapi.js';
import {protoNodes, readProto} from './proto.js';
import {
  channelKey,
  CONTRACTS_PRODUCER,
  entryPointKey,
  KIND_CHANNEL,
  KIND_CONTRACT,
  KIND_MESSAGE,
  messageKey,
  operationKey,
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
import {joinPath, readTsFile, type TsFileFacts} from './ts-code.js';
import {readSyntaxTree} from '../../fill/stages/syntax-extract.js';
import type {ExtractedEdge, ExtractedNode, Extraction, ExtractionGap, PropertyValue, SourceSpan, TreeReader} from '../../extract/records.js';

/** The contract folders this extractor reads, with their formats. */
const CONTRACT_FOLDERS: readonly [string, (path: string) => boolean][] = [
  ['openapi', (p) => p.startsWith('contracts/openapi/') && /\.ya?ml$/.test(p)],
  ['asyncapi', (p) => p.startsWith('contracts/asyncapi/') && /\.ya?ml$/.test(p)],
  ['proto', (p) => p.startsWith('contracts/proto/') && p.endsWith('.proto')],
];

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

interface GoFacts {
  path: string;
  go: GoFileFacts;
}
interface TsFacts {
  path: string;
  ts: TsFileFacts;
}


/** The span of a whole file: its first line to its last, its first byte to its length. */
function wholeFileSpan(path: string, text: string): SourceSpan {
  const lines = text === '' ? 1 : text.split('\n').length;
  return {path, byteStart: 0, byteEnd: Buffer.byteLength(text, 'utf8'), lineStart: 1, lineEnd: lines};
}

export async function extractContracts(reader: TreeReader, code?: Extraction): Promise<Extraction> {
  const nodes: ExtractedNode[] = [];
  const edges: ExtractedEdge[] = [];
  const gaps: ExtractionGap[] = [];

  // ---- the contracts --------------------------------------------------------
  const openApiOperations: {method: string; routePath: string; key: string; servers: readonly string[]; contractPath: string}[] = [];
  const channels: string[] = [];
  const protoRpcs: {protoPath: string; service: string; rpc: string; key: string}[] = [];
  const declarations: {contract: string; member: string; relation: `code.${string}`}[] = [];
  const contractSpans = new Map<string, SourceSpan>();

  for (const p of reader.paths) {
    const format = CONTRACT_FOLDERS.find(([_, applies]) => applies(p))?.[0];
    if (format === undefined) continue;
    let bytes: Uint8Array;
    try {
      bytes = reader.read(p);
    } catch (error) {
      gaps.push({path: p, reason: `contracts: the tree carries no readable bytes: ${describe(error)}`});
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      gaps.push({path: p, reason: 'contracts: the bytes are not UTF-8 text'});
      continue;
    }
    // Every node read from a contract file gets its place: the file, with the byte and line span of the whole
    // document, and the file's path as a property. A contract is a file, and a channel or a message is declared in
    // one; a page that names them says where (madarch-m38l.16).
    contractSpans.set(p, wholeFileSpan(p, text));
    if (format === 'openapi') {
      const {contract, gaps: fileGaps} = readOpenApi(p, text);
      gaps.push(...fileGaps);
      nodes.push(...openApiNodes(contract));
      for (const op of contract.operations) declarations.push({contract: `code.contract:${p}`, member: operationKey(p, `${op.method}:${op.path}`), relation: 'code.declares'});
      for (const op of contract.operations) {
        openApiOperations.push({method: op.method, routePath: op.path, key: `code.operation:${p}#${op.method}:${op.path}`, servers: op.servers, contractPath: p});
      }
    } else if (format === 'asyncapi') {
      const {contract, gaps: fileGaps} = readAsyncApi(p, text);
      gaps.push(...fileGaps);
      nodes.push(...asyncApiNodes(contract));
      for (const channel of contract.channels) {
        channels.push(channel.name);
        declarations.push({contract: `code.contract:${p}`, member: channelKey(channel.name), relation: 'code.declares'});
        for (const message of channel.messages) {
          const messageId = messageKey(p, message.name);
          declarations.push({contract: `code.contract:${p}`, member: messageId, relation: 'code.declares'});
          edges.push({type: 'code.carries', from: channelKey(channel.name), to: messageId, discriminator: '', properties: {channel: channel.name}});
        }
      }
    } else {
      const {contract, gaps: fileGaps} = readProto(p, text);
      gaps.push(...fileGaps);
      nodes.push(...protoNodes(contract));
      for (const service of contract.services) for (const rpc of service.rpcs) declarations.push({contract: `code.contract:${p}`, member: operationKey(p, `${contract.package ?? ''}.${service.name}/${rpc.rpc}`), relation: 'code.declares'});
      for (const service of contract.services) {
        for (const rpc of service.rpcs) {
          protoRpcs.push({protoPath: p, service: service.name, rpc: rpc.rpc, key: `code.operation:${p}#${contract.package ?? ''}.${service.name}/${rpc.rpc}`});
        }
      }
    }
  }

  for (const declaration of declarations) edges.push({type: declaration.relation, from: declaration.contract, to: declaration.member, discriminator: '', properties: {}});

  // The place of every node a contract file declares: the file and the whole-document span, so a contract, a
  // channel and a message carry the location the wiki shows (madarch-m38l.16).
  const pathOf = (node: ExtractedNode): string | undefined => {
    if (node.kind === KIND_CONTRACT) return node.key.slice('code.contract:'.length);
    if (node.kind === KIND_MESSAGE) return node.key.slice(node.key.indexOf(':') + 1, node.key.lastIndexOf('#'));
    const held = node.properties['path'] ?? node.properties['contract'];
    return typeof held === 'string' ? held : undefined;
  };
  for (const [at, node] of nodes.entries()) {
    if (node.kind !== KIND_CONTRACT && node.kind !== KIND_CHANNEL && node.kind !== KIND_MESSAGE) continue;
    const path = pathOf(node);
    const span = path === undefined ? undefined : contractSpans.get(path);
    if (path === undefined || span === undefined) continue;
    nodes[at] = {...node, properties: {...node.properties, path}, span};
  }

  const symbols = await contractSymbols(reader, nodes, code);

  // ---- the code, one walk per file ------------------------------------------
  const goFiles: GoFacts[] = [];
  const tsFiles: TsFacts[] = [];
  for (const p of reader.paths) {
    if (!isSourcePath(p)) continue;
    let bytes: Uint8Array;
    try {
      bytes = reader.read(p);
    } catch (error) {
      gaps.push({path: p, reason: `contracts: the tree carries no readable bytes: ${describe(error)}`});
      continue;
    }
    const read = await readSyntaxTree(p, bytes, (file) => (p.endsWith('.go') ? readGoFile(p, file.root) : readTsFile(p, file.root)));
    if (!read.read) {
      gaps.push(...read.unread.map((gap) => ({path: p, reason: `contracts: ${gap.what}: ${gap.reason}`})));
      continue;
    }
    if (p.endsWith('.go')) goFiles.push({path: p, go: read.value as GoFileFacts});
    else tsFiles.push({path: p, ts: read.value as TsFileFacts});
  }

  // The service a file belongs to, named as the operations extractor names it: the folder under services/ and nothing
  // else, so `code.service:<name>` reaches the node the stack extractor makes. A file outside services/ belongs to no
  // service, and an edge would invent one (madarch-m38l.16).
  const serviceOf = (path: string): string | undefined => /^services\/([^/]+)\//.exec(path)?.[1];
  const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  // Listening ports are evidence for a contract server's service, not a global path guess.
  const portsByService = new Map<string, Set<string>>();
  for (const file of [...goFiles, ...tsFiles]) {
    const service = serviceOf(file.path);
    if (service === undefined) continue;
    const ports = portsByService.get(service) ?? new Set<string>();
    if ('go' in file) {
      for (const addr of file.go.serverAddrs.values()) {
        const literal = file.go.consts.get(addr) ?? addr;
        const port = /:(\d+)\b/.exec(literal)?.[1];
        if (port !== undefined) ports.add(port);
      }
    } else for (const start of file.ts.started) {
      if (start.kind === 'http-server' && start.port !== undefined && /^\d+$/.test(start.port)) ports.add(start.port);
    }
    portsByService.set(service, ports);
  }
  const servicesOfServers = (servers: readonly string[]): Set<string> => {
    const services = new Set<string>();
    for (const server of servers) {
      try {
        const url = new URL(server);
        if (portsByService.has(url.hostname)) {services.add(url.hostname); continue;}
        const byPort = [...portsByService].filter(([, ports]) => url.port !== '' && ports.has(url.port));
        if (byPort.length === 1 && ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) services.add(byPort[0]![0]);
      } catch { /* Relative or variable server URLs alone do not identify a service. */ }
    }
    return services;
  };
  const operationPaths = (operation: typeof openApiOperations[number]): string[] => {
    const paths = operation.servers.flatMap((server) => {
      try { return [joinPath(new URL(server, 'http://relative.invalid').pathname, operation.routePath)]; } catch { return []; }
    });
    return paths.length === 0 ? [operation.routePath] : paths;
  };
  const operationMatches = (route: {method: string; path: string}, operation: typeof openApiOperations[number]): boolean => route.method === operation.method && operationPaths(operation).some((path) => pathMatches(route.path, path));

  /** The middleware of a service whose function verifies a token with HS256. */
  const authMiddleware = new Map<string, string>();
  for (const file of [...goFiles, ...tsFiles]) {
    const service = serviceOf(file.path);
    if (service === undefined || authMiddleware.has(service)) continue;
    const names = new Set<string>();
    if ('go' in file) {
      for (const route of file.go.routes) for (const name of route.middleware) names.add(name.replace(/\(.*/, ''));
    } else {
      for (const route of file.ts.routes) for (const name of route.middleware) names.add(name);
      for (const mount of file.ts.mounts) for (const name of mount.middlewares) names.add(name);
      for (const name of file.ts.appMiddlewares) names.add(name);
    }
    for (const name of names) {
      const verified = [...goFiles, ...tsFiles].some((held) =>
        'go' in held ? held.go.hs256Functions.includes(name) : held.ts.hs256Functions.includes(name),
      );
      if (verified) {
        authMiddleware.set(service, name);
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
      const wild = (segment: string): boolean => segment.startsWith('{') || segment.startsWith(':') || segment.startsWith('${') || segment === '*' || segment === '{}';
      if (wild(a) && wild(b)) continue;
      return false;
    }
    return true;
  };

  const addEdge = (
    type: `code.${string}`,
    from: string,
    to: string,
    properties: {[key: string]: PropertyValue} = {},
    span?: SourceSpan,
  ): void => {
    edges.push({type, from, to, discriminator: '', properties, ...(span !== undefined ? {span} : {})});
  };

  const interaction = (type: `code.${string}`, path: string, target: string, properties: {[key: string]: PropertyValue}, span: SourceSpan): void => {
    const source = symbols.enclosing(span);
    // Preserve the file-level overview as explicitly aggregated evidence. The
    // canonical interaction starts at a real function, including inline handlers.
    edges.push({type, from: fileKey(path), to: target, discriminator: String(span.byteStart), properties: {...properties, summary: true}, span});
    if (source !== undefined) edges.push({type, from: source, to: target, discriminator: String(span.byteStart), properties, span});
    else gaps.push({path, reason: `contracts: line ${span.lineStart}: ${type} site has no resolved enclosing function (${path})`});
  };

  const constantForService = (service: string, channel: string): {name: string; path: string} | undefined => {
    for (const file of [...goFiles, ...tsFiles]) {
      if (serviceOf(file.path) !== service) continue;
      const consts = 'go' in file ? file.go.consts : file.ts.consts;
      for (const [name, value] of consts) {
        if (value === channel) return {name, path: file.path};
      }
    }
    return undefined;
  };
  const constValue = (service: string, name: string): string | undefined => {
    for (const file of [...goFiles, ...tsFiles]) {
      if (serviceOf(file.path) !== service) continue;
      const value = 'go' in file ? file.go.consts.get(name) : file.ts.consts.get(name);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const topicValue = (service: string | undefined, expression: string | undefined): string | undefined => {
    if (expression === undefined) return undefined;
    const literal = /^['"](.*)['"]$/.exec(expression)?.[1];
    return literal ?? (service === undefined ? undefined : constValue(service, expression));
  };

  // ---- Go: routes, entry points, Kafka ---------------------------------------
  for (const file of goFiles) {
    const service = serviceOf(file.path);
    const auth = service === undefined ? undefined : authMiddleware.get(service);
    for (const route of file.go.routes) {
      const properties: {[key: string]: PropertyValue} = {
        method: route.method,
        path: route.path,
        handler: route.handler,
        handlerSymbol: route.handlerSymbol,
        middleware: route.middleware,
        authGroup: route.authGroup,
        ...(service === undefined ? {} : {service}),
        ...(route.authGroup && auth !== undefined && route.middleware.some((name) => name.replace(/\(.*/, '') === auth) ? {authAlgorithm: 'HS256'} : {}),
      };
      const handler = symbols.handler(route.handlerSpan, route.inline, `${route.method}:${route.path}`);
      if (handler !== undefined) {
        properties['handlerPath'] = handler.slice('code.symbol:'.length, handler.indexOf('#'));
        properties['handlerKey'] = handler;
        addEdge('code.handled-by', routeKey(file.path, route.method, route.path), handler, {}, route.handlerSpan);
        edges.push({type: 'code.references', from: symbols.enclosing(route.span) ?? fileKey(file.path), to: handler, discriminator: String(route.handlerSpan.byteStart), properties: {role: 'callback-registration'}, span: route.handlerSpan});
      } else gaps.push({path: file.path, reason: `contracts: line ${route.handlerSpan.lineStart}: handler ${route.handler} is not resolved to a function symbol (${file.path})`});
      nodes.push({
        key: routeKey(file.path, route.method, route.path),
        kind: KIND_ROUTE,
        label: `${route.method} ${route.path}`,
        properties,
        span: route.span,
      });
      edges.push({type: 'code.contains', from: fileKey(file.path), to: routeKey(file.path, route.method, route.path), discriminator: '', properties: {}, span: route.span});
    }

    if (file.go.entryPoint) {
      const packageFiles = goFiles.filter((held) => folderOf(held.path) === folderOf(file.path));
      const started = resolveGoStarts(packageFiles, file.path);
      const entryKey = entryPointKey(file.path, 'main');
      const entrySpan = {path: file.path, byteStart: 0, byteEnd: reader.read(file.path).length, lineStart: 1, lineEnd: Math.max(1, textOf(reader, file.path)?.split('\n').length ?? 1)};
      nodes.push({
        key: entryKey,
        kind: KIND_ENTRY_POINT,
        label: `${service ?? 'service'} · ${file.path}`,
        properties: {language: 'go', symbol: 'main', service: service ?? '', file: file.path, starts: started},
        span: entrySpan,
      });
      edges.push({type: 'code.starts', from: entryKey, to: fileKey(file.path), discriminator: '', properties: {kind: 'entry-file'}, span: entrySpan});
      if (service !== undefined) edges.push({type: 'code.belongs-to' as const, from: entryKey, to: `code.service:${service}`, discriminator: '', properties: {}, span: entrySpan});
      const goProcess = service === undefined ? undefined : processKeyOf(file.path);
      if (goProcess !== undefined) edges.push({type: 'code.starts', from: entryKey, to: goProcess, discriminator: 'process', properties: {kind: 'process'}, span: entrySpan});
      for (const unit of started) {
        const target = unit.path !== undefined ? fileKey(unit.path) : undefined;
        if (target !== undefined) edges.push({type: 'code.starts', from: entryKey, to: target, discriminator: `${unit.kind}:${unit.symbol}`, properties: {kind: unit.kind, symbol: unit.symbol, ...(unit.port !== undefined ? {port: unit.port} : {})}, span: entrySpan});
      }
    }

    for (const site of file.go.kafkaSites) {
      if (site.kind === 'publish') {
        const direct = topicValue(service, site.topic);
        if (direct !== undefined && channels.includes(direct)) {
          interaction(REL_PUBLISHES, file.path, channelKey(direct), {topic: direct}, site.span);
          continue;
        }
        // The site names no resolved topic: it publishes the rows of the outbox table.
        // A channel is claimed only when the constant that names it is written
        // into that same table -- the writer's file carries the INSERT.
        for (const channel of channels) {
          const constant = service === undefined ? undefined : constantForService(service, channel);
          if (constant === undefined) continue;
          const constantText = textOf(reader, constant.path);
          if (constantText === undefined || !/INTO\s+outbox/.test(constantText)) continue;
          const readsOutbox = [...goFiles, ...tsFiles].some((held) => {
            if (serviceOf(held.path) !== service) return false;
            const text = textOf(reader, held.path);
            return text !== undefined && /FROM\s+outbox/.test(text);
          });
          if (!readsOutbox) continue;
          interaction(REL_PUBLISHES, file.path, channelKey(channel), {
            topic: channel,
            constant: constant.name,
            constantPath: constant.path,
            via: 'outbox',
          }, site.span);
        }
        continue;
      }
      if (site.topic === undefined) continue;
      const topic = topicValue(service, site.topic);
      if (topic === undefined || !channels.includes(topic)) continue;
      const properties: {[key: string]: PropertyValue} = {topic, ...(site.group !== undefined ? {group: site.group} : {})};
      // The handler the consumer delegates to, its mapping, and its behaviour.
      for (const name of file.go.interfaceMethods) {
        const candidates = goFiles.filter((held) => serviceOf(held.path) === service && held.go.methods.some((method) => method.endsWith(`.${name}`)));
        const methodFile = candidates.length === 1 ? candidates[0] : undefined;
        const methodKey = methodFile?.go.methods.find((method) => method.endsWith(`.${name}`));
        if (methodFile === undefined || methodKey === undefined) continue;
        properties['handler'] = methodKey;
        properties['handlerPath'] = methodFile.path;
        const kinds = new Set<string>();
        for (const held of goFiles) for (const kind of held.go.switchCases.get(name) ?? []) kinds.add(kind);
        if (kinds.size > 0) properties['eventKinds'] = [...kinds].sort();
        if (duplicatesByStatusComparison(goFiles, name)) properties['duplicates'] = 'status-comparison';
        break;
      }
      if (file.go.unconditionalCommit) properties['offsetCommit'] = 'unconditional';
      const reads = file.go.kafkaReads.filter((read) => site.readerOwner !== undefined && site.readerField !== undefined && read.owner === site.readerOwner && read.field === site.readerField);
      if (reads.length > 0) for (const read of reads) interaction(REL_CONSUMES, file.path, channelKey(topic), properties, read.span);
      else {
        // Construction proves subscription intent, not execution by a consuming function.
        addEdge(REL_CONSUMES, fileKey(file.path), channelKey(topic), {...properties, summary: true, configured: true}, site.span);
      }
    }
  }

  // ---- TypeScript: routes, entry points, clients, events, the SQL path ------
  for (const file of tsFiles) {
    const {ts} = file;
    const service = serviceOf(file.path);
    const auth = service === undefined ? undefined : authMiddleware.get(service);
    // The mounts other files of this service declare for the routers this file builds.
    const ownFactories = new Set([...ts.routerFactories.values()].filter((name) => name !== ''));
    const mountsHere = tsFiles
      .filter((other) => serviceOf(other.path) === service)
      .flatMap((other) =>
        other.ts.mounts.filter((mount) => mount.factory !== undefined && ownFactories.has(mount.factory)).map((mount) => ({mount, app: other})),
      );
    for (const route of ts.routes) {
      const mount = route.routerFactory !== undefined ? mountsHere.find((held) => held.mount.factory === route.routerFactory) : undefined;
      const appMiddlewares = mount !== undefined ? mount.app.ts.appMiddlewares : [];
      const chain = mount !== undefined ? [...appMiddlewares, ...mount.mount.middlewares, ...route.middleware] : route.middleware;
      const path = mount !== undefined ? joinPath(mount.mount.prefix, route.path) : route.path;
      const authName = auth !== undefined ? chain.find((name) => name === auth) : undefined;
      const handler = route.handler === undefined ? undefined : symbols.handler(route.handler.span, route.handler.inline, `${route.method}:${path}`);
      if (handler !== undefined) {
        addEdge('code.handled-by', routeKey(file.path, route.method, path), handler, {}, route.handler!.span);
        edges.push({type: 'code.references', from: symbols.enclosing(route.span) ?? fileKey(file.path), to: handler, discriminator: String(route.handler!.span.byteStart), properties: {role: 'callback-registration'}, span: route.handler!.span});
      } else gaps.push({path: file.path, reason: `contracts: line ${route.span.lineStart}: route ${route.method} ${path} has no resolved handler function (${file.path})`});
      nodes.push({
        key: routeKey(file.path, route.method, path),
        kind: KIND_ROUTE,
        label: `${route.method} ${path}`,
        properties: {
          method: route.method,
          path,
          ...(service === undefined ? {} : {service}),
          ...(handler === undefined ? {} : {handlerKey: handler, handlerPath: handler.slice('code.symbol:'.length, handler.indexOf('#'))}),
          middleware: chain,
          authGroup: authName !== undefined,
          ...(authName !== undefined ? {authAlgorithm: 'HS256'} : {}),
        },
        span: route.span,
      });
      edges.push({type: 'code.contains', from: fileKey(file.path), to: routeKey(file.path, route.method, path), discriminator: '', properties: {}, span: route.span});
    }

    if (ts.entry !== undefined) {
      const entryKey = entryPointKey(file.path, ts.entry.symbol);
      const entrySpan = {path: file.path, byteStart: 0, byteEnd: reader.read(file.path).length, lineStart: 1, lineEnd: Math.max(1, textOf(reader, file.path)?.split('\n').length ?? 1)};
      nodes.push({
        key: entryKey,
        kind: KIND_ENTRY_POINT,
        label: `${service ?? 'service'} · ${file.path} · ${ts.entry.symbol}`,
        properties: {
          language: 'typescript', service: service ?? '', file: file.path,
          symbol: ts.entry.symbol,
          starts: ts.started.map((unit) => ({kind: unit.kind, symbol: unit.symbol, ...(unit.path !== undefined ? {path: unit.path} : {}), ...(unit.port !== undefined ? {port: unit.port} : {})})),
        },
        span: entrySpan,
      });
      edges.push({type: 'code.starts', from: entryKey, to: fileKey(file.path), discriminator: '', properties: {kind: 'entry-file'}, span: entrySpan});
      if (service !== undefined) edges.push({type: 'code.belongs-to' as const, from: entryKey, to: `code.service:${service}`, discriminator: '', properties: {}, span: entrySpan});
      const tsProcess = service === undefined ? undefined : processKeyOf(file.path);
      if (tsProcess !== undefined) edges.push({type: 'code.starts', from: entryKey, to: tsProcess, discriminator: 'process', properties: {kind: 'process'}, span: entrySpan});
      for (const unit of ts.started) {
        const target = unit.path !== undefined ? fileKey(unit.path) : undefined;
        if (target !== undefined) edges.push({type: 'code.starts', from: entryKey, to: target, discriminator: `${unit.kind}:${unit.symbol}`, properties: {kind: unit.kind, symbol: unit.symbol, ...(unit.port !== undefined ? {port: unit.port} : {})}, span: entrySpan});
      }
    }

    // The proto this file loads, when it does.
    if (ts.protoRel !== undefined) {
      const protoPath = normalizePath(`${folderOf(file.path)}/${ts.protoRel}`);
      const rpcs = protoRpcs.filter((rpc) => rpc.protoPath === protoPath);
      for (const site of ts.grpcSites) {
        const match = rpcs.find((rpc) => rpc.rpc.toLowerCase() === site.rpc.toLowerCase());
        if (match === undefined) continue;
        if (site.kind === 'serve') {
          const handler = site.handlerSpan === undefined ? undefined : symbols.handler(site.handlerSpan, true, `grpc:${site.rpc}`);
          const properties = {handler: site.fn !== undefined ? `${site.fn}.${site.rpc}` : site.rpc};
          addEdge(REL_SERVES, fileKey(file.path), match.key, {...properties, summary: true}, site.span);
          if (handler !== undefined) addEdge(REL_SERVES, handler, match.key, properties, site.span);
        } else {
          const properties: {[key: string]: PropertyValue} = {client: site.fn !== undefined ? site.fn : site.rpc, via: 'grpc'};
          if (site.className !== undefined && site.fn !== undefined) properties['client'] = `${site.className}.${site.fn}`;
          // The deadline chain: field -> class -> `new <Class>(..., config.<name>)` -> the config default.
          if (ts.deadlineField !== undefined) {
            const constructedSomewhere = tsFiles
              .map((other) => other.ts.newCalls.get(ts.deadlineField!.className))
              .find((args) => args !== undefined);
            const secondArg = constructedSomewhere?.[1];
            const configName = secondArg !== undefined ? /\.([A-Za-z0-9_]+)$/.exec(secondArg)?.[1] : undefined;
            const deadlineMs = configName !== undefined
              ? tsFiles.map((other) => other.ts.configDefaults.get(configName)).find((value) => value !== undefined)
              : undefined;
            if (deadlineMs !== undefined) properties['deadlineMs'] = deadlineMs;
          }
          interaction(REL_CALLS_REMOTE, file.path, match.key, properties, site.span);
        }
      }
    }

    // HTTP clients: fetch calls to an operation, or to the one route that serves the path.
    for (const call of ts.fetchCalls) {
      let routePath = call.urlText.replace(/(^\$\{[^}]*\})+/, '').split('?')[0]!;
      let origin: string | undefined;
      try { const url = new URL(call.urlText); routePath = url.pathname; origin = url.origin; } catch { /* A relative/template URL has no literal origin. */ }
      if (!routePath.startsWith('/')) continue;
      const placeholder = routePath.replace(/\$\{[^}]*\}/g, '{}');
      let operations = openApiOperations.filter((op) => operationMatches({method: call.method, path: placeholder}, op));
      const text = textOf(reader, file.path) ?? '';
      if (origin !== undefined) operations = operations.filter((op) => op.servers.some((server) => { try { return new URL(server).origin === origin; } catch { return false; } }));
      const declaredContracts = operations.filter((op) => text.includes(op.contractPath));
      if (declaredContracts.length > 0) operations = declaredContracts;
      const operation = operations.length === 1 ? operations[0] : undefined;
      const properties: {[key: string]: PropertyValue} = {
        ...(call.client !== undefined ? {client: call.client} : {}),
        via: 'http',
        ...(call.tokenForwarded ? {tokenForwarded: true} : {}),
      };
      if (operation !== undefined) {
        interaction(REL_CALLS_REMOTE, file.path, operation.key, properties, call.span);
        continue;
      }
      const originScope = origin === undefined ? undefined : servicesOfServers([origin]);
      const serving = allRouteKeys().filter((route) => route.method === call.method && pathMatches(placeholder, route.path)
        && (originScope === undefined || (route.service !== undefined && originScope.has(route.service))));
      if (serving.length === 1) {
        interaction(REL_CALLS_REMOTE, file.path, serving[0]!.key, properties, call.span);
      }
    }

    // Kafka sends that name a channel.
    for (const send of ts.sends) {
      if (send.channel === undefined || !channels.includes(send.channel)) continue;
      if (!send.receiverGrounded) {
        if (send.receiverMessagingEvidence) gaps.push({path: file.path, reason: `contracts: line ${send.span.lineStart}: send names channel ${send.channel} but its receiver is not resolved to an imported KafkaJS producer or an implemented local messaging wrapper; no publisher is claimed (${file.path})`});
        continue;
      }
      const constant = service === undefined ? undefined : constantForService(service, send.channel);
      const union = [...ts.typeUnions.values()].find((members) => members.length > 0 && members.every((member) => member.includes('.')));
      interaction(REL_PUBLISHES, file.path, channelKey(send.channel), {
        topic: send.channel,
        publisher: send.publisher ?? '',
        ...(send.key !== undefined ? {key: send.key} : {}),
        ...(union !== undefined ? {eventTypes: [...union].sort()} : {}),
        ...(constant !== undefined ? {constant: constant.name, constantPath: constant.path} : {}),
      }, send.span);
    }

    // The SQL path.
    extractSqlFlow(file, nodes, addEdge);
  }

  // ---- serving links ---------------------------------------------------------
  // A contract operation is served by the one route of the tree that matches its
  // method and path template. Where several match (/healthz of four services,
  // say), the link is not claimed: ambiguity is said, not resolved.
  for (const endpoint of nodes.filter((node) => node.kind === 'code.health-endpoint' || node.kind === 'code.metrics-endpoint')) {
    const service = String(endpoint.properties['service'] ?? '');
    if (service !== '') edges.push({type: 'code.served-by', from: endpoint.key, to: `code.service:${service}`, discriminator: 'service', properties: {}});
    const endpointPath = String(endpoint.properties['path'] ?? '');
    const endpointFile = endpoint.span?.path;
    const routes = nodes.filter((node) => node.kind === KIND_ROUTE && node.properties['path'] === endpointPath && node.span?.path === endpointFile);
    for (const route of routes) edges.push({type: 'code.served-by', from: endpoint.key, to: route.key, discriminator: '', properties: {}, ...(endpoint.span === undefined ? {} : {span: endpoint.span})});
  }
  for (const operation of openApiOperations) {
    const scope = servicesOfServers(operation.servers);
    const candidates = allRouteKeys().filter((route) => operationMatches(route, operation));
    const matching = scope.size > 0 ? candidates.filter((route) => route.service !== undefined && scope.has(route.service)) : candidates;
    // One server-scoped route per operation is evidence. A duplicated path in
    // another service must neither suppress this route nor silently win a guess.
    const groups = new Map<string, typeof matching>();
    for (const route of matching) {
      const group = route.service ?? route.file;
      groups.set(group, [...(groups.get(group) ?? []), route]);
    }
    if (scope.size === 0 && groups.size > 1) {
      gaps.push({path: operation.contractPath, reason: `contracts: line 1: ${operation.method} ${operation.routePath} has multiple serving services and no resolved server scope (${operation.contractPath})`});
      continue;
    }
    for (const routes of groups.values()) {
      if (routes.length !== 1) {
        gaps.push({path: operation.contractPath, reason: `contracts: line 1: ${operation.method} ${operation.routePath} has multiple routes in the same server scope (${operation.contractPath})`});
        continue;
      }
      addEdge(REL_SERVES, routes[0]!.key, operation.key, {service: routes[0]!.service ?? ''});
    }
  }

  // Every declaration is reachable from the file that provides its evidence.
  // These edges reference the file owner's identity; no file stub is invented here.
  for (const node of nodes) {
    const path = node.span?.path;
    if (path !== undefined && !edges.some((edge) => edge.type === 'code.contains' && edge.from === fileKey(path) && edge.to === node.key)) addEdge('code.contains', fileKey(path), node.key, {}, node.span);
  }
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== KIND_CHANNEL) continue;
    const consumers = edges.filter((edge) => edge.type === REL_CONSUMES && edge.to === node.key && edge.from.startsWith('code.symbol:'));
    const configured = edges.some((edge) => edge.type === REL_CONSUMES && edge.to === node.key);
    nodes[index] = {...node, properties: {...node.properties, consumerFound: consumers.length > 0, consumerStatus: consumers.length > 0 ? 'found-in-product' : configured ? 'configured-consumer-function-not-resolved' : 'not-found-in-product'}};
  }

  nodes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  edges.sort((a, b) => (`${a.type} ${a.from} ${a.to}` < `${b.type} ${b.from} ${b.to}` ? -1 : 1));
  gaps.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {producer: CONTRACTS_PRODUCER, nodes, edges, gaps};

  /** Every route node emitted so far. */
  function allRouteKeys(): {method: string; path: string; key: string; service?: string; file: string}[] {
    return nodes
      .filter((node) => node.kind === KIND_ROUTE)
      .map((node) => ({method: node.properties['method'] as string, path: node.properties['path'] as string, key: node.key, file: node.span!.path, ...(typeof node.properties['service'] === 'string' ? {service: node.properties['service']} : {})}));
  }

}


/**
 * The process node a entry point starts, keyed as the deploy extractor keys it (madarch-m38l.16): the entry file of a
 * TypeScript program, or the folder of a Go `main.go`. A program that starts from neither has no process key, and the
 * entry point keeps its file link alone.
 */
function processKeyOf(path: string): string | undefined {
  if (path.endsWith('/main.go')) {
    const folder = path.slice(0, path.lastIndexOf('/'));
    return folder === '' ? undefined : `code.process:${folder}`;
  }
  return /\.[cm]?[jt]sx?$/.test(path) ? `code.process:${path}` : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textOf(reader: TreeReader, path: string): string | undefined {
  try {
    return decoder.decode(reader.read(path));
  } catch {
    return undefined;
  }
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

/** The SQL path of one TypeScript file: nodes for the reads, the builders on the way to the sink, and the sink, with the edges between them. */
function extractSqlFlow(
  file: TsFacts,
  nodes: ExtractedNode[],
  addEdge: (type: `code.${string}`, from: string, to: string, properties?: {[key: string]: PropertyValue}, span?: SourceSpan) => void,
): void {
  const {path, ts} = file;
  for (const input of ts.inputs) {
    nodes.push({
      key: inputKey(path, 'query', input.name),
      kind: KIND_INPUT,
      label: `query ${input.name}`,
      properties: {source: 'query', name: input.name, ...(input.fn !== undefined ? {readBy: input.fn} : {})},
      span: input.span,
    });
    // The input is read in this file, whether or not it reaches a builder or a sink (madarch-m38l.16).
    addEdge('code.contains', fileKey(path), inputKey(path, 'query', input.name), {}, input.span);
  }
  const pathBuilds = ts.stringSplicers.filter((splicer) => ts.buildersOnPath.includes(splicer.fn));
  for (const build of pathBuilds) {
    nodes.push({
      key: sqlBuildKey(path, build.fn),
      kind: KIND_SQL_BUILD,
      label: build.fn,
      properties: {function: build.fn, spliced: build.spliced},
      ...(build.span === undefined ? {} : {span: build.span}),
    });
  }
  for (const sink of ts.sqlSinks) {
    nodes.push({
      key: sqlSinkKey(path, sink.callee),
      kind: KIND_SQL_SINK,
      label: sink.callee,
      properties: {callee: sink.callee, ...(sink.fn !== undefined ? {function: sink.fn} : {})},
      span: sink.span,
    });
  }
  if (ts.inputs.length === 0 || pathBuilds.length === 0) return;

  for (const input of ts.inputs) {
    if (input.fn === undefined) continue;
    if (!(ts.returnedQueryProps.get(input.fn) ?? []).includes(input.name)) continue;
    for (const build of pathBuilds) {
      if (!build.spliced.includes(input.name)) continue;
      // The builder is called with a variable bound to the read's function's result.
      const feeds = (ts.callSiteArgs.get(build.fn) ?? []).some((arguments_) =>
        arguments_.some((variable) => ts.bindings.get(variable)?.calls.includes(input.fn!) ?? false),
      );
      if (feeds) addEdge(REL_FLOWS_INTO, inputKey(path, 'query', input.name), sqlBuildKey(path, build.fn));
    }
  }
  for (const sink of ts.sqlSinks) {
    if (sink.fn === undefined) continue;
    const sinkArgVars = (ts.callSiteArgs.get(sink.fn) ?? []).flat();
    for (const build of pathBuilds) {
      const reaches = sinkArgVars.some((variable) => {
        const binding = ts.bindings.get(variable);
        if (binding === undefined) return false;
        if (binding.calls.includes(build.fn)) return true;
        return binding.vars.some((inner) => ts.bindings.get(inner)?.calls.includes(build.fn) ?? false);
      });
      if (reaches) addEdge(REL_FLOWS_INTO, sqlBuildKey(path, build.fn), sqlSinkKey(path, sink.callee));
    }
  }
}
