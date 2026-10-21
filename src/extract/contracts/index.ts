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
import {readGoFile, resolveGoStarts, duplicatesByStatusComparison, type GoFileFacts} from './go-code.js';
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
import {joinPath, readTsFile, type TsFileFacts} from './ts-code.js';
import {readSyntaxTree} from '../../fill/stages/syntax-extract.js';
import type {ExtractedEdge, ExtractedNode, Extraction, ExtractionGap, PropertyValue, SourceSpan, TreeReader} from '../../extract/records.js';

/** The contract folders this extractor reads, with their formats. */
const CONTRACT_FOLDERS: readonly [string, (path: string) => boolean][] = [
  ['openapi', (p) => p.startsWith('contracts/openapi/') && p.endsWith('.yaml')],
  ['asyncapi', (p) => p.startsWith('contracts/asyncapi/') && p.endsWith('.yaml')],
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

export async function extractContracts(reader: TreeReader): Promise<Extraction> {
  const nodes: ExtractedNode[] = [];
  const edges: ExtractedEdge[] = [];
  const gaps: ExtractionGap[] = [];

  // ---- the contracts --------------------------------------------------------
  const openApiOperations: {method: string; routePath: string; key: string}[] = [];
  const channels: string[] = [];
  const protoRpcs: {protoPath: string; service: string; rpc: string; key: string}[] = [];

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
    if (format === 'openapi') {
      const {contract, gaps: fileGaps} = readOpenApi(p, text);
      gaps.push(...fileGaps);
      nodes.push(...openApiNodes(contract));
      for (const op of contract.operations) {
        openApiOperations.push({method: op.method, routePath: op.path, key: `code.operation:${p}#${op.method}:${op.path}`});
      }
    } else if (format === 'asyncapi') {
      const {contract, gaps: fileGaps} = readAsyncApi(p, text);
      gaps.push(...fileGaps);
      nodes.push(...asyncApiNodes(contract));
      for (const channel of contract.channels) channels.push(channel.name);
    } else {
      const {contract, gaps: fileGaps} = readProto(p, text);
      gaps.push(...fileGaps);
      nodes.push(...protoNodes(contract));
      for (const service of contract.services) {
        for (const rpc of service.rpcs) {
          protoRpcs.push({protoPath: p, service: service.name, rpc: rpc.rpc, key: `code.operation:${p}#${contract.package ?? ''}.${service.name}/${rpc.rpc}`});
        }
      }
    }
  }

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

  const serviceOf = (path: string): string => /^(services\/[^/]+)\//.exec(path)?.[1] ?? path;
  const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const goMethodFiles = new Map<string, string>();
  for (const file of goFiles) for (const method of file.go.methods) if (!goMethodFiles.has(method)) goMethodFiles.set(method, file.path);

  /** The middleware of a service whose function verifies a token with HS256. */
  const authMiddleware = new Map<string, string>();
  for (const file of [...goFiles, ...tsFiles]) {
    const service = serviceOf(file.path);
    if (authMiddleware.has(service)) continue;
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

  // ---- Go: routes, entry points, Kafka ---------------------------------------
  for (const file of goFiles) {
    const service = serviceOf(file.path);
    const auth = authMiddleware.get(service);
    for (const route of file.go.routes) {
      const properties: {[key: string]: PropertyValue} = {
        method: route.method,
        path: route.path,
        handler: route.handler,
        handlerSymbol: route.handlerSymbol,
        middleware: route.middleware,
        authGroup: route.authGroup,
        ...(route.authGroup && auth !== undefined && route.middleware.some((name) => name.replace(/\(.*/, '') === auth) ? {authAlgorithm: 'HS256'} : {}),
      };
      const handlerFile = goMethodFiles.get(route.handlerSymbol);
      if (handlerFile !== undefined) properties['handlerPath'] = handlerFile;
      nodes.push({
        key: routeKey(file.path, route.method, route.path),
        kind: KIND_ROUTE,
        label: `${route.method} ${route.path}`,
        properties,
        span: route.span,
      });
    }

    if (file.go.entryPoint) {
      const packageFiles = goFiles.filter((held) => folderOf(held.path) === folderOf(file.path));
      const started = resolveGoStarts(packageFiles, file.path);
      nodes.push({
        key: entryPointKey(file.path, 'main'),
        kind: KIND_ENTRY_POINT,
        label: 'main',
        properties: {language: 'go', symbol: 'main', starts: started},
      });
    }

    for (const site of file.go.kafkaSites) {
      if (site.kind === 'publish') {
        const viaOutbox = [...goFiles, ...tsFiles].some((held) => {
          if (serviceOf(held.path) !== service) return false;
          const text = textOf(reader, held.path);
          return text !== undefined && /FROM outbox|INTO outbox/.test(text);
        });
        for (const channel of channels) {
          const constant = constantForService(service, channel);
          if (constant === undefined) continue;
          addEdge(REL_PUBLISHES, fileKey(file.path), channelKey(channel), {
            topic: channel,
            constant: constant.name,
            constantPath: constant.path,
            ...(viaOutbox ? {via: 'outbox'} : {}),
          }, site.span);
        }
        continue;
      }
      if (site.topic === undefined) continue;
      const topic = constValue(service, site.topic);
      if (topic === undefined || !channels.includes(topic)) continue;
      const properties: {[key: string]: PropertyValue} = {topic, ...(site.group !== undefined ? {group: site.group} : {})};
      // The handler the consumer delegates to, its mapping, and its behaviour.
      for (const name of file.go.interfaceMethods) {
        const methodFile = goFiles.find((held) => held.go.methods.some((method) => method.endsWith(`.${name}`)));
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
      addEdge(REL_CONSUMES, fileKey(file.path), channelKey(topic), properties, site.span);
    }
  }

  // ---- TypeScript: routes, entry points, clients, events, the SQL path ------
  for (const file of tsFiles) {
    const {ts} = file;
    const service = serviceOf(file.path);
    const auth = authMiddleware.get(service);
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
        span: route.span,
      });
    }

    if (ts.entry !== undefined) {
      nodes.push({
        key: entryPointKey(file.path, ts.entry.symbol),
        kind: KIND_ENTRY_POINT,
        label: ts.entry.symbol,
        properties: {
          language: 'typescript',
          symbol: ts.entry.symbol,
          starts: ts.started.map((unit) => ({kind: unit.kind, symbol: unit.symbol, ...(unit.path !== undefined ? {path: unit.path} : {}), ...(unit.port !== undefined ? {port: unit.port} : {})})),
        },
      });
    }

    // The proto this file loads, when it does.
    if (ts.protoRel !== undefined) {
      const protoPath = normalizePath(`${folderOf(file.path)}/${ts.protoRel}`);
      const rpcs = protoRpcs.filter((rpc) => rpc.protoPath === protoPath);
      for (const site of ts.grpcSites) {
        const match = rpcs.find((rpc) => rpc.rpc.toLowerCase() === site.rpc.toLowerCase());
        if (match === undefined) continue;
        if (site.kind === 'serve') {
          addEdge(REL_SERVES, fileKey(file.path), match.key, {handler: site.fn !== undefined ? `${site.fn}.${site.rpc}` : site.rpc}, site.span);
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
          addEdge(REL_CALLS_REMOTE, fileKey(file.path), match.key, properties, site.span);
        }
      }
    }

    // HTTP clients: fetch calls to an operation, or to the one route that serves the path.
    for (const call of ts.fetchCalls) {
      const routePath = call.urlText.replace(/(^\$\{[^}]*\})+/, '').split('?')[0]!;
      if (!routePath.startsWith('/')) continue;
      const placeholder = routePath.replace(/\$\{[^}]*\}/g, '{}');
      const operation = openApiOperations.find((op) => op.method === call.method && (op.routePath === placeholder || pathMatches(placeholder, op.routePath)));
      const properties: {[key: string]: PropertyValue} = {
        ...(call.client !== undefined ? {client: call.client} : {}),
        via: 'http',
        ...(call.tokenForwarded ? {tokenForwarded: true} : {}),
      };
      if (operation !== undefined) {
        addEdge(REL_CALLS_REMOTE, fileKey(file.path), operation.key, properties, call.span);
        continue;
      }
      const serving = allRouteKeys().filter((route) => route.method === call.method && pathMatches(placeholder, route.path));
      if (serving.length === 1) {
        addEdge(REL_CALLS_REMOTE, fileKey(file.path), serving[0]!.key, properties, call.span);
      }
    }

    // Kafka sends that name a channel.
    for (const send of ts.sends) {
      if (send.channel === undefined || !channels.includes(send.channel)) continue;
      const constant = constantForService(service, send.channel);
      const union = [...ts.typeUnions.values()].find((members) => members.length > 0 && members.every((member) => member.includes('.')));
      addEdge(REL_PUBLISHES, fileKey(file.path), channelKey(send.channel), {
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
  for (const operation of openApiOperations) {
    const matching = allRouteKeys().filter((route) => route.method === operation.method && pathMatches(route.path, operation.routePath));
    if (matching.length !== 1) continue;
    addEdge(REL_SERVES, matching[0]!.key, operation.key, {});
  }

  nodes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  edges.sort((a, b) => (`${a.type} ${a.from} ${a.to}` < `${b.type} ${b.from} ${b.to}` ? -1 : 1));
  gaps.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {producer: CONTRACTS_PRODUCER, nodes, edges, gaps};

  /** Every route node emitted so far. */
  function allRouteKeys(): {method: string; path: string; key: string}[] {
    return nodes
      .filter((node) => node.kind === KIND_ROUTE)
      .map((node) => ({method: node.properties['method'] as string, path: node.properties['path'] as string, key: node.key}));
  }

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
  }
  const pathBuilds = ts.stringSplicers.filter((splicer) => ts.buildersOnPath.includes(splicer.fn));
  for (const build of pathBuilds) {
    nodes.push({
      key: sqlBuildKey(path, build.fn),
      kind: KIND_SQL_BUILD,
      label: build.fn,
      properties: {function: build.fn, spliced: build.spliced},
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
