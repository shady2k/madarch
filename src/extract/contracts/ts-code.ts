/**
 * The TypeScript half of the contracts extractor's code reading: the routes an
 * Express app and its routers register (with the middleware chain each one
 * sits behind, outermost first, and whether the chain authenticates), the
 * process entry points and what they start, the HTTP and gRPC clients and the
 * server handlers of a proto, the Kafka send sites, and the untrusted-input
 * path to `$queryRawUnsafe`. Everything is read from one file's bytes plus
 * the indexes built over the whole tree (const values, function declarations),
 * never from a run.
 */
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {calleeName, callsNamed, enclosingFunctionName, stringValue, walkTree} from './walk.js';

/** One route registered on an Express app or router, joined with its mount. */
export interface TsRoute {
  readonly method: string;
  readonly path: string;
  /** The app or router variable the registration goes through (`app`, `router`). */
  readonly routerVar: string;
  /** The middleware chain, outermost first: the app's earlier uses, then the mount's, then the route's. */
  readonly middleware: readonly string[];
  /** The middleware in the chain that authenticates, when one does. */
  readonly authMiddleware?: string;
  readonly spanNode: SyntaxNode;
}

/** One long-running piece an entry point starts. */
export interface TsStarted {
  readonly kind: 'http-server' | 'grpc-server';
  readonly symbol: string;
  readonly port?: string;
}

/** One Kafka send the file makes. */
export interface TsSend {
  /** The channel name the topic expression names, when it names one. */
  readonly channel?: string;
  readonly publisher?: string;
  readonly key?: string;
  readonly spanNode: SyntaxNode;
}

/** One read of a request query parameter. */
export interface TsQueryInput {
  readonly name: string;
  readonly fn?: string;
  readonly spanNode: SyntaxNode;
}

/** One function of the file that splices values into SQL text. */
export interface TsSqlBuild {
  readonly fn: string;
  readonly spliced: readonly string[];
  readonly spanNode: SyntaxNode;
}

/** One SQL execution sink. */
export interface TsSqlSink {
  readonly callee: string;
  readonly fn?: string;
  readonly spanNode: SyntaxNode;
}

/** One gRPC site: a server handler object's key, or a stub method call. */
export interface TsGrpcSite {
  readonly kind: 'serve' | 'call';
  readonly rpc: string;
  readonly fn?: string;
  readonly spanNode: SyntaxNode;
}

export interface TsMount {
  readonly prefix: string;
  readonly middlewares: readonly string[];
  /** The router factory the mount hands the request to (`paymentRoutes`), when it names one. */
  readonly factory?: string;
}

export interface TsFileFacts {
  readonly path: string;
  /** String-valued top-level consts, by name (`PAYMENTS_TOPIC` -> `payments.events`). */
  readonly consts: ReadonlyMap<string, string>;
  /** The string-literal members of the file's type unions (`PaymentEventType`). */
  readonly typeUnions: ReadonlyMap<string, readonly string[]>;
  /** The app's global middleware uses, in order (`express.json`, `requestLogger`). */
  readonly appMiddlewares: readonly string[];
  /** The mounted routers: `app.use('/payments', auth, paymentRoutes(...))`. */
  readonly mounts: readonly TsMount[];
  /** The router variables and the factory each is built in (`router` -> `paymentRoutes`). */
  readonly routerFactories: ReadonlyMap<string, string>;
  readonly routes: readonly TsRoute[];
  readonly entry: {symbol: string} | undefined;
  readonly started: readonly TsStarted[];
  readonly sends: readonly TsSend[];
  readonly fetchCalls: readonly {urlText: string; method: string; tokenForwarded: boolean; client?: string; spanNode: SyntaxNode}[];
  readonly protoPath?: string;
  readonly grpcSites: readonly TsGrpcSite[];
  readonly inputs: readonly TsQueryInput[];
  readonly sqlBuilds: readonly TsSqlBuild[];
  readonly sqlSinks: readonly TsSqlSink[];
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use']);

/** The text of a string or the literal parts of a template (`\`${base}/orders\`` -> '/orders' kept whole). */
function urlText(node: SyntaxNode): string | undefined {
  if (node.type === 'string') return stringValue(node);
  if (node.type === 'template_string') return node.text.slice(1, -1);
  return undefined;
}

export function readTsFile(path: string, root: SyntaxNode): TsFileFacts {
  const consts = new Map<string, string>();
  const typeUnions = new Map<string, readonly string[]>();
  const registrations: {verb: string; pathText?: string; args: SyntaxNode; spanNode: SyntaxNode}[] = [];
  const routerFactories = new Map<string, string>(); // router var -> declaring function name
  let appVar: string | undefined;
  let entry: {symbol: string} | undefined;
  const started: TsStarted[] = [];
  const sends: TsSend[] = [];
  const fetchCalls: {urlText: string; method: string; tokenForwarded: boolean; client?: string; spanNode: SyntaxNode}[] = [];
  let protoPath: string | undefined;
  const grpcSites: TsGrpcSite[] = [];
  const inputs: TsQueryInput[] = [];
  const sqlBuilds: TsSqlBuild[] = [];
  const sqlSinks: TsSqlSink[] = [];

  // Top-level const values and type unions.
  walkTree(root, (node) => {
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      const parent = node.parent;
      if (parent !== null && parent.type !== 'program' && parent.type !== 'export_statement') return;
      for (let i = 0; i < node.childCount; i++) {
        const decl = node.child(i);
        if (decl === null || decl.type !== 'variable_declarator') continue;
        const name = decl.childForFieldName('name')?.text;
        const value = decl.childForFieldName('value');
        const literal = value === null || value === undefined ? undefined : value.type === 'string' ? stringValue(value) : value.type === 'number' ? value.text : undefined;
        if (name !== undefined && literal !== undefined) consts.set(name, literal);
        // `const PROTO_PATH = path.resolve(__dirname, '<rel>')`.
        if (name !== undefined && value !== null && value !== undefined && value.type === 'call_expression' && calleeName(value) === 'resolve') {
          const args = value.childForFieldName('arguments');
          const second = args?.namedChild(1);
          const rel = stringValue(second ?? null);
          if (rel !== undefined && rel.includes('contracts/')) protoPath = rel;
        }
      }
      return;
    }
    if (node.type === 'type_alias') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value');
      if (name !== undefined && value?.type === 'union_type') {
        const members: string[] = [];
        walkTree(value, (member) => {
          if (member.type === 'string') {
            const literal = stringValue(member);
            if (literal !== undefined) members.push(literal);
          }
        });
        typeUnions.set(name, members);
      }
      return;
    }
    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text;
      const body = node.childForFieldName('body');
      if (name !== undefined && body !== null) {
        // `const router = Router()` inside a function makes it a router factory.
        walkTree(body, (inner) => {
          if (inner.type === 'variable_declarator') {
            const varName = inner.childForFieldName('name')?.text;
            const value = inner.childForFieldName('value');
            if (varName !== undefined && value?.type === 'call_expression' && calleeName(value) === 'Router') {
              routerFactories.set(varName, name);
            }
          }
        });
      }
      return;
    }
    if (node.type === 'variable_declarator' && node.parent?.type === 'program') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value');
      if (name !== undefined && value?.type === 'call_expression' && calleeName(value) === 'express') appVar = name;
      if (name !== undefined && value?.type === 'call_expression' && calleeName(value) === 'Router') routerFactories.set(name, '');
    }
  });

  // A file starts a process when a top-level statement listens, or calls a local function that listens.
  const listenCalls = callsNamed(root, new Set(['listen']));
  for (const call of listenCalls) {
    const holder = topStatementOf(call);
    if (holder === undefined) continue;
    if (entry === undefined) entry = {symbol: 'index'};
    const args = call.childForFieldName('arguments');
    const portArg = args?.namedChild(0)?.text;
    const port = portArg !== undefined ? (consts.get(portArg) ?? portArg) : undefined;
    started.push({kind: 'http-server', symbol: call.text, ...(port !== undefined ? {port} : {})});
  }
  walkTree(root, (node) => {
    if (node.type !== 'expression_statement') return;
    const first = node.namedChild(0);
    if (first === null || first.type !== 'call_expression') return;
    const fn = first.childForFieldName('function');
    // `main().catch(...)` or `main();`
    const inner = fn?.type === 'member_expression' ? fn.childForFieldName('object') : fn;
    if (inner === null || inner === undefined || inner.type !== 'identifier') return;
    const name = inner.text;
    if (entry !== undefined || name === 'require') return;
    const body = functionBodyOf(root, name);
    if (body === undefined) return;
    const listens = callsNamed(body, new Set(['listen']));
    const grpc = callsNamed(body, new Set(['startGrpcServer']));
    if (listens.length === 0 && grpc.length === 0) return;
    entry = {symbol: name};
    for (const call of listens) {
      const args = call.childForFieldName('arguments');
      const portArg = args?.namedChild(0)?.text;
      const port = portArg !== undefined ? (consts.get(portArg) ?? portArg) : undefined;
      started.push({kind: 'http-server', symbol: call.text, ...(port !== undefined ? {port} : {})});
    }
    for (const call of grpc) {
      const args = call.childForFieldName('arguments');
      const portArg = args?.namedChild(1)?.text;
      const port = portArg !== undefined ? (consts.get(portArg) ?? portArg) : undefined;
      started.push({kind: 'grpc-server', symbol: call.text, ...(port !== undefined ? {port} : {})});
    }
  });

  // Express registrations: app.get(...), router.post(...), app.use(...). Only the
  // app's own variable and the file's router variables count, so `req.get(...)`
  // and every other `.get` of the file stay out.
  for (const call of callsNamed(root, new Set(HTTP_VERBS))) {
    const fn = call.childForFieldName('function');
    if (fn === null || fn.type !== 'member_expression') continue;
    const object = fn.childForFieldName('object')?.text;
    const verb = fn.childForFieldName('property')?.text ?? '';
    if (object === undefined) continue;
    if (object !== appVar && !routerFactories.has(object)) continue;
    const args = call.childForFieldName('arguments');
    if (args === null) continue;
    const first = args.namedChild(0);
    const pathText = first === null || first === undefined ? undefined : urlText(first);
    registrations.push({verb, pathText, args, spanNode: call});
  }

  // The app's global middleware uses, in order: `app.use(express.json())`, `app.use(requestLogger)`.
  const appMiddlewares: string[] = [];
  const mounts: {prefix: string; middlewares: string[]; factory?: string}[] = [];
  for (const reg of registrations) {
    if (reg.verb !== 'use') continue;
    const object = reg.args.parent === null ? '' : reg.spanNode.childForFieldName('function')?.childForFieldName('object')?.text ?? '';
    if (object !== appVar) continue;
    const parts = argNodes(reg.args);
    if (parts.length === 0) continue;
    const firstText = urlText(parts[0]!);
    if (firstText !== undefined && firstText.startsWith('/')) {
      // A mounted router: `app.use('/payments', auth, paymentRoutes(deps.service))`.
      const middlewares: string[] = [];
      let factory: string | undefined;
      for (const part of parts.slice(1)) {
        if (part.type === 'identifier') {
          const resolved = middlewareName(root, part.text);
          if (resolved !== undefined) middlewares.push(resolved);
          continue;
        }
        if (part.type === 'call_expression') factory = calleeName(part);
      }
      mounts.push({prefix: firstText, middlewares, factory});
      continue;
    }
    for (const part of parts) {
      if (part.type === 'identifier') {
        const resolved = middlewareName(root, part.text);
        if (resolved === undefined) continue;
        if (isErrorMiddleware(root, part.text)) continue;
        appMiddlewares.push(resolved);
      }
      if (part.type === 'call_expression' && calleeName(part) === 'json') appMiddlewares.push('express.json');
    }
  }

  const routes: TsRoute[] = [];
  for (const reg of registrations) {
    if (reg.verb === 'use') continue;
    const object = reg.spanNode.childForFieldName('function')?.childForFieldName('object')?.text ?? '';
    const parts = argNodes(reg.args);
    const pathText = reg.pathText;
    if (pathText === undefined) continue;
    const routeMiddlewares: string[] = [];
    for (const part of parts.slice(1)) {
      if (part.type === 'identifier') {
        const resolved = middlewareName(root, part.text);
        if (resolved !== undefined && !isErrorMiddleware(root, part.text)) routeMiddlewares.push(resolved);
      }
    }
    const mount = mounts.find((held) => routerFactories.get(object) === held.factory);
    const prefix = mount?.prefix ?? '';
    const chain = [...(mount === undefined ? appMiddlewares : []), ...(mount?.middlewares ?? []), ...routeMiddlewares];
    routes.push({
      method: reg.verb.toUpperCase(),
      path: joinPath(prefix, pathText),
      middleware: mount === undefined ? [...appMiddlewares, ...routeMiddlewares] : chain,
      routerVar: object,
      spanNode: reg.spanNode,
    });
  }

  // Kafka sends: `<x>.send(topic, key, ...)`.
  for (const call of callsNamed(root, new Set(['send']))) {
    const args = call.childForFieldName('arguments');
    const topicArg = args?.namedChild(0);
    if (topicArg === null || topicArg === undefined) continue;
    const name = topicArg.type === 'identifier' ? consts.get(topicArg.text) : stringValue(topicArg);
    const keyArg = args?.namedChild(1);
    sends.push({
      ...(name !== undefined ? {channel: name} : {}),
      publisher: enclosingFunctionName(call),
      ...(keyArg !== undefined && keyArg !== null ? {key: keyArg.text} : {}),
      spanNode: call,
    });
  }

  // HTTP clients: fetch(<url>, {method, headers}).
  for (const call of callsNamed(root, new Set(['fetch']))) {
    const args = call.childForFieldName('arguments');
    const urlArg = args?.namedChild(0);
    const url = urlArg === undefined || urlArg === null ? undefined : urlText(urlArg);
    if (url === undefined) continue;
    const init = args?.namedChild(1);
    let method = 'GET';
    let tokenForwarded = false;
    if (init !== undefined && init !== null && init.type === 'object') {
      walkTree(init, (pair) => {
        if (pair.type !== 'pair') return;
        const key = pair.childForFieldName('key')?.text.replace(/['"]/g, '');
        const value = pair.childForFieldName('value');
        if (key === 'method' && value !== null) method = (stringValue(value) ?? 'GET').toUpperCase();
        if (key !== undefined && key.toLowerCase() === 'authorization' && value !== null && value.text !== "''") tokenForwarded = true;
      });
    }
    fetchCalls.push({urlText: url, method, tokenForwarded, client: qualifiedClient(call), spanNode: call});
  }

  // gRPC: server handler keys and stub calls, matched against the proto the file loads.
  if (protoPath !== undefined) {
    walkTree(root, (node) => {
      if (node.type === 'pair') {
        const key = node.childForFieldName('key')?.text.replace(/['"]/g, '');
        const value = node.childForFieldName('value');
        if (key !== undefined && value !== null && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          grpcSites.push({kind: 'serve', rpc: key, fn: enclosingFunctionName(node), spanNode: node});
        }
        return;
      }
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'member_expression') {
          const object = fn.childForFieldName('object')?.text ?? '';
          const rpc = fn.childForFieldName('property')?.text ?? '';
          if (object.startsWith('this.') && rpc !== '') {
            grpcSites.push({kind: 'call', rpc, fn: enclosingFunctionName(node), spanNode: node});
          }
        }
      }
    });
  }

  // Untrusted query input: `req.query.<name>`.
  walkTree(root, (node) => {
    if (node.type !== 'member_expression') return;
    const object = node.childForFieldName('object');
    if (object === null || object === undefined) return;
    if (object.text === 'req.query' || object.text === 'request.query') {
      const name = node.childForFieldName('property')?.text;
      if (name !== undefined && name !== '') inputs.push({name, fn: enclosingFunctionName(node), spanNode: node});
    }
  });

  // SQL builders: a function whose string templates or concatenations splice `<param>.<prop>`.
  walkTree(root, (node) => {
    if (node.type !== 'function_declaration') return;
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    const params = (node.childForFieldName('parameters')?.namedChildren ?? []).map((p) => (p === null ? '' : p.text.replace(/[:{].*$/, '')));
    if (name === undefined || body === null) return;
    const spliced = new Set<string>();
    walkTree(body, (inner) => {
      const inString = inner.type === 'template_substitution' || isConcatOperand(inner);
      if (!inString || inner.type !== 'member_expression') return;
      const object = inner.childForFieldName('object')?.text ?? '';
      const prop = inner.childForFieldName('property')?.text;
      if (params.includes(object) && prop !== undefined) spliced.add(prop);
    });
    if (spliced.size > 0) sqlBuilds.push({fn: name, spliced: [...spliced].sort(), spanNode: node});
  });

  // SQL sinks: `$queryRawUnsafe(...)`.
  walkTree(root, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'member_expression') return;
    const prop = fn.childForFieldName('property')?.text ?? '';
    if (!prop.startsWith('$queryRaw')) return;
    sqlSinks.push({callee: prop, fn: enclosingFunctionName(node), spanNode: node});
  });

  return {
    path,
    consts,
    typeUnions,
    appMiddlewares,
    mounts,
    routerFactories,
    routes,
    entry,
    started,
    sends,
    fetchCalls,
    protoPath,
    grpcSites,
    inputs,
    sqlBuilds,
    sqlSinks,
  };
}

// ---- small local helpers ----------------------------------------------------

function argNodes(args: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (child !== null && child.type !== ',' && child.type !== '(' && child.type !== ')') out.push(child);
  }
  return out;
}

function topStatementOf(node: SyntaxNode): SyntaxNode | undefined {
  let held: SyntaxNode | null = node;
  while (held !== null && held.parent !== null && held.parent.type !== 'program') held = held.parent;
  return held?.type === 'expression_statement' ? held : undefined;
}

function functionBodyOf(root: SyntaxNode, name: string): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walkTree(root, (node) => {
    if (found !== undefined) return;
    if (node.type === 'function_declaration' && node.childForFieldName('name')?.text === name) {
      found = node.childForFieldName('body') ?? undefined;
    }
  });
  return found;
}

/** The middleware an identifier names: a local binding (`auth`) or its own name (`requestLogger`). */
function middlewareName(root: SyntaxNode, identifier: string): string | undefined {
  let found: string | undefined;
  walkTree(root, (node) => {
    if (found !== undefined || node.type !== 'variable_declarator') return;
    if (node.childForFieldName('name')?.text !== identifier) return;
    const value = node.childForFieldName('value');
    if (value === null) return;
    found = value.type === 'identifier' ? value.text : value.type === 'call_expression' ? calleeName(value) : undefined;
  });
  return found ?? identifier;
}

/** An error middleware takes four parameters (`errorHandler(err, req, res, next)`). */
function isErrorMiddleware(root: SyntaxNode, identifier: string): boolean {
  let four = false;
  walkTree(root, (node) => {
    if (four || node.type !== 'function_declaration') return;
    if (node.childForFieldName('name')?.text !== identifier) return;
    four = (node.childForFieldName('parameters')?.namedChildCount ?? 0) === 4;
  });
  return four;
}

function isConcatOperand(node: SyntaxNode): boolean {
  const parent = node.parent;
  return parent !== null && parent.type === 'binary_expression' && parent.childForFieldName('operator')?.text === '+';
}

/** `OrdersClient.placeOrder`: the class and method a call stands in. */
function qualifiedClient(node: SyntaxNode): string | undefined {
  let held: SyntaxNode | null = node;
  let method: string | undefined;
  while (held !== null) {
    if (held.type === 'method_definition' && method === undefined) {
      method = held.childForFieldName('name')?.text;
    }
    if (held.type === 'class_declaration' && method !== undefined) {
      const className = held.childForFieldName('name')?.text;
      if (className !== undefined) return `${className}.${method}`;
    }
    held = held.parent;
  }
  return undefined;
}

/** `'/' + '/'`, `'/payments' + '/:id'`. */
export function joinPath(prefix: string, suffix: string): string {
  const left = prefix.endsWith('/') && prefix !== '/' ? prefix.slice(0, -1) : prefix;
  const right = suffix === '/' ? '' : suffix.startsWith('/') ? suffix : `/${suffix}`;
  const joined = left === '/' ? right : `${left}${right}`;
  return joined === '' ? '/' : joined;
}
