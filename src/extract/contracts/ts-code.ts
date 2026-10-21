/**
 * The TypeScript half of the contracts extractor's code reading: the routes an
 * Express app and its routers register (with the middleware chain each one
 * sits behind, outermost first, and whether the chain authenticates), the
 * process entry points and what they start, the HTTP and gRPC clients and the
 * server handlers of a proto, the Kafka send sites, and the untrusted-input
 * path to `$queryRawUnsafe`. One file's tree is walked once, inside the read
 * that owns it; the answer is plain data, so the joins with the rest of the
 * tree (mounts, config defaults, proto services) happen later, without a tree.
 */
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {calleeName, spanOf, stringValue, walkTree} from './walk.js';
import type {SourceSpan} from '../../extract/records.js';

/** One route registered on an Express app or router, as the file states it (mounts joined later). */
export interface TsRoute {
  readonly method: string;
  readonly path: string;
  /** The middleware chain this file states, outermost first. */
  readonly middleware: readonly string[];
  /** The app or router variable the registration goes through (`app`, `router`). */
  readonly routerVar: string;
  /** The router factory that built the router, when the variable is one (`paymentRoutes`). */
  readonly routerFactory?: string;
  readonly span: SourceSpan;
}

/** One long-running piece an entry point starts. */
export interface TsStarted {
  readonly kind: 'http-server' | 'grpc-server';
  readonly symbol: string;
  readonly port?: string;
  readonly path?: string;
}

/** One Kafka send the file makes. */
export interface TsSend {
  /** The channel name the topic expression names, when it names one. */
  readonly channel?: string;
  readonly publisher?: string;
  readonly key?: string;
  readonly span: SourceSpan;
}

export interface TsFileFacts {
  readonly path: string;
  /** String- and number-valued top-level consts, by name (`PAYMENTS_TOPIC` -> `payments.events`). */
  readonly consts: ReadonlyMap<string, string>;
  /** The string-literal members of the file's type unions (`PaymentEventType`). */
  readonly typeUnions: ReadonlyMap<string, readonly string[]>;
  /** The functions of the file whose text verifies a token with HS256. */
  readonly hs256Functions: readonly string[];
  /** The app's global middleware uses, in order (`express.json`, `requestLogger`). */
  readonly appMiddlewares: readonly string[];
  /** The mounted routers: `app.use('/payments', auth, paymentRoutes(...))`. */
  readonly mounts: readonly {prefix: string; middlewares: readonly string[]; factory?: string}[];
  /** The router variables and the factory each is built in (`router` -> `paymentRoutes`). */
  readonly routerFactories: ReadonlyMap<string, string>;
  readonly routes: readonly TsRoute[];
  readonly entry: {symbol: string} | undefined;
  readonly started: readonly TsStarted[];
  readonly sends: readonly TsSend[];
  readonly fetchCalls: readonly {urlText: string; method: string; tokenForwarded: boolean; client?: string; span: SourceSpan}[];
  /** `const PROTO_PATH = path.resolve(__dirname, '<rel>')`: the relative part. */
  readonly protoRel?: string;
  readonly grpcSites: readonly {kind: 'serve' | 'call'; rpc: string; fn?: string; className?: string; span: SourceSpan}[];
  /** The identifier arguments of every call, by callee name (`query` -> [['prisma', 'sql']]). */
  readonly callSiteArgs: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** The deadline hops this file states: the client field and the class that carries it. */
  readonly deadlineField?: {field: string; className: string};
  /** `new <Class>(...)` and the text of each argument (`PaymentsClient` -> ['config.paymentsAddr', ...]). */
  readonly newCalls: ReadonlyMap<string, readonly string[]>;
  /** Config properties with a literal fallback: `paymentsDeadlineMs` -> 8000. */
  readonly configDefaults: ReadonlyMap<string, number>;
  readonly inputs: readonly {name: string; fn?: string; span: SourceSpan}[];
  /** The query parameters each function returns under its own name (`readFilters` -> order, status, ...). */
  readonly returnedQueryProps: ReadonlyMap<string, readonly string[]>;
  /** The functions that splice a parameter property into a string, and the properties. */
  readonly stringSplicers: readonly {fn: string; spliced: readonly string[]}[];
  /** The file's local bindings: the functions and variables each initializer uses. */
  readonly bindings: ReadonlyMap<string, {calls: readonly string[]; vars: readonly string[]}>;
  /** The functions whose string-building result reaches the sink's function. */
  readonly buildersOnPath: readonly string[];
  readonly sqlSinks: readonly {callee: string; fn?: string; span: SourceSpan}[];
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use']);

/** The text of a string or the literal parts of a template. */
function urlText(node: SyntaxNode): string | undefined {
  if (node.type === 'string') return stringValue(node);
  if (node.type === 'template_string') return node.text.slice(1, -1);
  return undefined;
}

export function readTsFile(path: string, root: SyntaxNode): TsFileFacts {
  const consts = new Map<string, string>();
  const typeUnions = new Map<string, readonly string[]>();
  const hs256Functions: string[] = [];
  const registrations: {verb: string; object: string; pathText?: string; args: SyntaxNode; spanNode: SyntaxNode}[] = [];
  const routerFactories = new Map<string, string>();
  let appVar: string | undefined;
  let entry: {symbol: string} | undefined;
  const started: TsStarted[] = [];
  const sends: TsSend[] = [];
  const fetchCalls: {urlText: string; method: string; tokenForwarded: boolean; client?: string; span: SourceSpan}[] = [];
  let protoRel: string | undefined;
  const grpcSites: {kind: 'serve' | 'call'; rpc: string; fn?: string; className?: string; span: SourceSpan}[] = [];
  let deadlineField: {field: string; className: string} | undefined;
  const newCalls = new Map<string, string[]>();
  const configDefaults = new Map<string, number>();
  const inputs: {name: string; fn?: string; span: SourceSpan}[] = [];
  const stringSplicers: {fn: string; spliced: string[]}[] = [];
  const bindings = new Map<string, {calls: Set<string>; vars: Set<string>}>();
  const sqlSinks: {callee: string; fn?: string; span: SourceSpan}[] = [];
  const callSiteArgs = new Map<string, string[][]>();

  // One collection walk.
  walkTree(root, (node) => {
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const decl = node.child(i);
        if (decl === null || decl.type !== 'variable_declarator') continue;
        const name = decl.childForFieldName('name')?.text;
        const value = decl.childForFieldName('value');
        if (name === undefined || value === null) continue;
        const literal = value.type === 'string' ? stringValue(value) : value.type === 'number' ? value.text : undefined;
        const atTopLevel = node.parent?.type === 'program' || node.parent?.type === 'export_statement';
        if (literal !== undefined && atTopLevel) consts.set(name, literal);
        // `const PROTO_PATH = path.resolve(__dirname, '<rel>')`.
        if (value.type === 'call_expression' && calleeName(value) === 'resolve') {
          const second = value.childForFieldName('arguments')?.namedChild(1);
          const rel = stringValue(second ?? null);
          if (rel !== undefined && rel.includes('contracts/')) protoRel = rel;
        }
        // The file's local bindings.
        {
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
        }
      }
      return;
    }
    if (node.type === 'type_alias') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value');
      if (name !== undefined && value !== null && value.type === 'union_type') {
        const members: string[] = [];
        walkTree(value, (member) => {
          if (member.type !== 'string') return;
          const literal = stringValue(member);
          if (literal !== undefined) members.push(literal);
        });
        typeUnions.set(name, members);
      }
      return;
    }
    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text;
      const body = node.childForFieldName('body');
      if (name === undefined || body === null) return;
      if (/['"]HS256['"]/.test(node.text)) hs256Functions.push(name);
      // `const router = Router()` inside a function makes it a router factory.
      walkTree(body, (inner) => {
        if (inner.type !== 'variable_declarator') return;
        const varName = inner.childForFieldName('name')?.text;
        const value = inner.childForFieldName('value');
        if (varName !== undefined && value !== null && value.type === 'call_expression' && calleeName(value) === 'Router') {
          routerFactories.set(varName, name);
        }
      });
      return;
    }
    if (node.type === 'variable_declarator' && node.parent?.type === 'lexical_declaration' && node.parent.parent?.type === 'program') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value');
      if (name !== undefined && value !== null && value.type === 'call_expression') {
        if (calleeName(value) === 'express') appVar = name;
        if (calleeName(value) === 'Router') routerFactories.set(name, '');
      }
      return;
    }
    if (node.type === 'new_expression') {
      const className = node.childForFieldName('constructor')?.text;
      const args = node.childForFieldName('arguments');
      if (className !== undefined && args !== null) {
        const argTexts: string[] = [];
        for (let i = 0; i < args.childCount; i++) {
          const arg = args.child(i);
          if (arg !== null && arg.type !== ',' && arg.type !== '(' && arg.type !== ')') argTexts.push(arg.text);
        }
        newCalls.set(className, argTexts);
      }
      return;
    }
    if (node.type === 'pair') {
      const key = node.childForFieldName('key')?.text;
      const value = node.childForFieldName('value');
      if (key !== undefined && value !== null) {
        // A config property with a literal fallback: `paymentsDeadlineMs: Number(env.X ?? 8000)`.
        const fallback = /\?\?\s*(\d+)/.exec(value.text);
        if (fallback !== null && /^[A-Za-z0-9_]+$/.test(key)) configDefaults.set(key, Number(fallback[1]));
        // A gRPC server handler object's key with a function value.
        if (value.type === 'arrow_function' || value.type === 'function_expression') {
          grpcSites.push({kind: 'serve', rpc: key, fn: enclosingFunctionName(node), span: spanOf(node, path)});
        }
      }
      return;
    }
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      {
        // The identifier arguments of this call site, for the SQL path's joins.
        const callee = calleeName(node);
        if (callee !== undefined) {
          const argsNode = node.childForFieldName('arguments');
          const identifiers: string[] = [];
          if (argsNode !== null) {
            for (let i = 0; i < argsNode.childCount; i++) {
              const arg = argsNode.child(i);
              if (arg !== null && arg.type === 'identifier') identifiers.push(arg.text);
            }
          }
          const held = callSiteArgs.get(callee) ?? [];
          held.push(identifiers);
          callSiteArgs.set(callee, held);
        }
      }
      // A gRPC stub call: `this.stub.authorize(...)`.
      if (fn !== null && fn !== undefined && fn.type === 'member_expression') {
        const object = fn.childForFieldName('object')?.text ?? '';
        const rpc = fn.childForFieldName('property')?.text ?? '';
        if (object.startsWith('this.') && rpc !== '') {
          grpcSites.push({kind: 'call', rpc, fn: enclosingFunctionName(node), className: enclosingClassName(node), span: spanOf(node, path)});
        }
      }
      // A Kafka send.
      if (calleeName(node) === 'send') {
        const args = node.childForFieldName('arguments');
        const topicArg = args?.namedChild(0);
        if (topicArg !== null && topicArg !== undefined) {
          const channel = topicArg.type === 'identifier' ? consts.get(topicArg.text) : stringValue(topicArg);
          const keyArg = args?.namedChild(1);
          sends.push({
            ...(channel !== undefined ? {channel} : {}),
            publisher: enclosingFunctionName(node),
            ...(keyArg !== undefined && keyArg !== null ? {key: keyArg.text} : {}),
            span: spanOf(node, path),
          });
        }
      }
      // An HTTP client call.
      if (calleeName(node) === 'fetch') {
        const args = node.childForFieldName('arguments');
        const urlArg = args?.namedChild(0);
        const url = urlArg === null || urlArg === undefined ? undefined : urlText(urlArg);
        if (url !== undefined) {
          const init = args?.namedChild(1);
          let method = 'GET';
          let tokenForwarded = false;
          if (init !== null && init !== undefined && init.type === 'object') {
            walkTree(init, (pair) => {
              if (pair.type !== 'pair') return;
              const pairKey = pair.childForFieldName('key')?.text.replace(/['"]/g, '');
              const pairValue = pair.childForFieldName('value');
              if (pairKey === 'method' && pairValue !== null) method = (stringValue(pairValue) ?? 'GET').toUpperCase();
              if (pairKey !== undefined && pairKey.toLowerCase() === 'authorization' && pairValue !== null && pairValue.text !== "''") tokenForwarded = true;
            });
          }
          fetchCalls.push({urlText: url, method, tokenForwarded, client: qualifiedClient(node), span: spanOf(node, path)});
        }
      }
      // A route registration on the app or a router of this file.
      if (fn !== null && fn !== undefined && fn.type === 'member_expression') {
        const object = fn.childForFieldName('object')?.text ?? '';
        const verb = fn.childForFieldName('property')?.text ?? '';
        if (HTTP_VERBS.has(verb) && (object === appVar || routerFactories.has(object))) {
          const args = node.childForFieldName('arguments');
          const first = args?.namedChild(0);
          const pathText = first === null || first === undefined ? undefined : urlText(first);
          if (args !== null && args !== undefined) registrations.push({verb, object, pathText, args, spanNode: node});
        }
      }
      // A SQL execution sink.
      const prop = fn !== null && fn !== undefined && fn.type === 'member_expression' ? fn.childForFieldName('property')?.text ?? '' : '';
      if (prop.startsWith('$queryRaw')) {
        sqlSinks.push({callee: prop, fn: enclosingFunctionName(node), span: spanOf(node, path)});
      }
      return;
    }
    // A read of a request query parameter: `req.query.<name>`.
    if (node.type === 'member_expression') {
      const object = node.childForFieldName('object');
      if (object !== null && object !== undefined && (object.text === 'req.query' || object.text === 'request.query')) {
        const name = node.childForFieldName('property')?.text;
        if (name !== undefined && name !== '') inputs.push({name, fn: enclosingFunctionName(node), span: spanOf(node, path)});
      }
      return;
    }
    // The client field a deadline comes from: `const deadline = ... this.<field>`.
    if (node.type === 'variable_declarator' && node.childForFieldName('name')?.text === 'deadline' && deadlineField === undefined) {
      const match = /this\.([A-Za-z0-9_]+)/.exec(node.childForFieldName('value')?.text ?? '');
      if (match !== null) {
        const className = classOfField(root, match[1]!);
        if (className !== undefined) deadlineField = {field: match[1]!, className};
      }
      return;
    }
  });

  // A file starts a process when a top-level statement listens, or calls a local function that listens.
  for (const call of callsNamedAtTopStatement(root, 'listen')) {
    if (entry === undefined) entry = {symbol: 'index'};
    const portArg = call.childForFieldName('arguments')?.namedChild(0)?.text;
    const port = portArg !== undefined ? (consts.get(portArg) ?? portArg) : undefined;
    started.push({kind: 'http-server', symbol: call.text, ...(port !== undefined ? {port} : {})});
  }
  walkTree(root, (node) => {
    if (node.type !== 'expression_statement' || entry !== undefined) return;
    const first = node.namedChild(0);
    if (first === null || first.type !== 'call_expression') return;
    const fn = first.childForFieldName('function');
    let inner = fn?.type === 'member_expression' ? fn.childForFieldName('object') : fn;
    // `main().catch(...)`: the object is the call `main()`; its function names the entry.
    if (inner !== null && inner !== undefined && inner.type === 'call_expression') {
      inner = inner.childForFieldName('function');
    }
    if (inner === null || inner === undefined || inner.type !== 'identifier') return;
    const name = inner.text;
    const body = functionBodyOf(root, name);
    if (body === undefined) return;
    const listens = callsNamedIn(body, 'listen');
    const grpc = callsNamedIn(body, 'startGrpcServer');
    if (listens.length === 0 && grpc.length === 0) return;
    entry = {symbol: name};
    for (const call of listens) {
      const portArg = call.childForFieldName('arguments')?.namedChild(0)?.text;
      const port = portArg !== undefined ? (consts.get(portArg) ?? portArg) : undefined;
      started.push({kind: 'http-server', symbol: call.text, ...(port !== undefined ? {port} : {})});
    }
    for (const call of grpc) {
      const portArg = call.childForFieldName('arguments')?.namedChild(1)?.text;
      const port = portArg !== undefined ? (consts.get(portArg) ?? portArg) : undefined;
      started.push({kind: 'grpc-server', symbol: call.text, ...(port !== undefined ? {port} : {})});
    }
  });

  // The app's global middleware and the mounts.
  const appMiddlewares: string[] = [];
  const mounts: {prefix: string; middlewares: string[]; factory?: string}[] = [];
  for (const reg of registrations) {
    if (reg.verb !== 'use' || reg.object !== appVar) continue;
    const parts = argNodes(reg.args);
    if (parts.length === 0) continue;
    const firstText = urlText(parts[0]!);
    if (firstText !== undefined && firstText.startsWith('/')) {
      const middlewares: string[] = [];
      let factory: string | undefined;
      for (const part of parts.slice(1)) {
        if (part.type === 'identifier') {
          const resolved = middlewareName(bindings, part.text);
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
        const resolved = middlewareName(bindings, part.text);
        if (resolved === undefined || isErrorFunction(root, part.text)) continue;
        appMiddlewares.push(resolved);
      }
      if (part.type === 'call_expression' && calleeName(part) === 'json') appMiddlewares.push('express.json');
    }
  }

  // The routes, with the mount each router variable is under in this file.
  const routes: TsRoute[] = [];
  for (const reg of registrations) {
    if (reg.verb === 'use' || reg.pathText === undefined) continue;
    const parts = argNodes(reg.args);
    const routeMiddlewares: string[] = [];
    for (const part of parts.slice(1)) {
      if (part.type === 'identifier') {
        const resolved = middlewareName(bindings, part.text);
        if (resolved !== undefined && !isErrorFunction(root, part.text)) routeMiddlewares.push(resolved);
      }
    }
    const mount = reg.object === appVar ? undefined : mounts.find((held) => routerFactories.get(reg.object) === held.factory);
    const chain = mount === undefined ? [...appMiddlewares, ...routeMiddlewares] : [...mount.middlewares, ...routeMiddlewares];
    const prefix = mount !== undefined ? mount.prefix : '';
    routes.push({
      method: reg.verb.toUpperCase(),
      path: joinPath(prefix, reg.pathText),
      middleware: chain,
      routerVar: reg.object,
      ...(routerFactories.get(reg.object) !== undefined && routerFactories.get(reg.object) !== '' ? {routerFactory: routerFactories.get(reg.object)} : {}),
      span: spanOf(reg.spanNode, path),
    });
  }

  // The functions that splice a parameter property into a string.
  walkTree(root, (node) => {
    if (node.type !== 'function_declaration') return;
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    const parameterNames = (node.childForFieldName('parameters')?.namedChildren ?? [])
      .map((p) => (p === null ? '' : p.text.split(/[:={\s]/)[0] ?? ''))
      .filter((text) => text !== '');
    if (name === undefined || body === null) return;
    const spliced = new Set<string>();
    walkTree(body, (inner) => {
      if (inner.type !== 'member_expression') return;
      const inString = inner.parent !== null && ((inner.parent.type === 'template_substitution') || (inner.parent.type === 'binary_expression' && inner.parent.childForFieldName('operator')?.text === '+'));
      if (!inString) return;
      const object = inner.childForFieldName('object')?.text ?? '';
      const prop = inner.childForFieldName('property')?.text;
      if (parameterNames.includes(object) && prop !== undefined) spliced.add(prop);
    });
    if (spliced.size > 0) stringSplicers.push({fn: name, spliced: [...spliced].sort()});
  });

  // The builders whose result reaches a sink's function, through the file's bindings.
  const buildersOnPath: string[] = [];
  for (const sink of sqlSinks) {
    if (sink.fn === undefined) continue;
    const sinkArgVars: string[] = [];
    walkTree(root, (node) => {
      if (node.type !== 'call_expression' || calleeName(node) !== sink.fn) return;
      const args = node.childForFieldName('arguments');
      if (args === null) return;
      for (let i = 0; i < args.childCount; i++) {
        const arg = args.child(i);
        if (arg !== null && arg.type === 'identifier') sinkArgVars.push(arg.text);
      }
    });
    for (const splicer of stringSplicers) {
      const reaches = sinkArgVars.some((variable) => {
        const binding = bindings.get(variable);
        if (binding === undefined) return false;
        if (binding.calls.has(splicer.fn)) return true;
        return [...binding.vars].some((inner) => bindings.get(inner)?.calls.has(splicer.fn) ?? false);
      });
      if (reaches && !buildersOnPath.includes(splicer.fn)) buildersOnPath.push(splicer.fn);
    }
  }
  buildersOnPath.sort();

  return {
    path,
    consts,
    typeUnions,
    hs256Functions,
    appMiddlewares,
    mounts,
    routerFactories,
    routes,
    entry,
    started,
    sends,
    fetchCalls,
    protoRel,
    grpcSites,
    callSiteArgs,
    deadlineField,
    newCalls,
    configDefaults,
    inputs,
    returnedQueryProps: returnedQueryProps(root),
    stringSplicers,
    bindings: new Map([...bindings].map(([name, held]) => [name, {calls: [...held.calls].sort(), vars: [...held.vars].sort()}])),
    buildersOnPath,
    sqlSinks,
  };
}

/** The query parameters each function of the file returns under its own name. */
function returnedQueryProps(root: SyntaxNode): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, Set<string>>();
  walkTree(root, (node) => {
    if (node.type !== 'function_declaration') return;
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    if (name === undefined || body === null) return;
    walkTree(body, (inner) => {
      if (inner.type !== 'return_statement') return;
      const value = inner.namedChild(0);
      if (value === null || value.type !== 'object') return;
      walkTree(value, (pair) => {
        if (pair.type !== 'pair') return;
        const key = pair.childForFieldName('key')?.text;
        const pairValue = pair.childForFieldName('value')?.text ?? '';
        const match = key !== undefined ? /query\.([A-Za-z0-9_]+)/.exec(pairValue ?? '') : null;
        if (match !== null && match !== undefined && key !== undefined && key === match[1]) {
          const held = out.get(name) ?? new Set<string>();
          held.add(key);
          out.set(name, held);
        }
      });
    });
  });
  return new Map([...out].map(([name, held]) => [name, [...held].sort()]));
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

/** The `.listen(...)` calls whose statement stands at the file's top level. */
function callsNamedAtTopStatement(root: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  walkTree(root, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    const field = fn?.type === 'member_expression' ? fn.childForFieldName('property')?.text : fn?.type === 'identifier' ? fn.text : undefined;
    if (field !== name) return;
    let held: SyntaxNode | null = node;
    while (held !== null && held.parent !== null && held.parent.type !== 'program') held = held.parent;
    if (held !== null && held.type === 'expression_statement') out.push(node);
  });
  return out;
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

function callsNamedIn(body: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  walkTree(body, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    const field = fn?.type === 'member_expression' ? fn.childForFieldName('property')?.text : fn?.type === 'identifier' ? fn.text : undefined;
    if (field === name) out.push(node);
  });
  return out;
}

/** The middleware an identifier names: a local binding (`auth`) or its own name (`requestLogger`). */
function middlewareName(bindings: Map<string, {calls: Set<string>; vars: Set<string>}>, identifier: string): string | undefined {
  const binding = bindings.get(identifier);
  if (binding === undefined) return identifier;
  if (binding.calls.size === 1) return [...binding.calls][0]!;
  if (binding.calls.size === 0 && binding.vars.size === 1) return [...binding.vars][0]!;
  return identifier;
}

/** A function of four parameters handles errors, not requests. */
function isErrorFunction(root: SyntaxNode, identifier: string): boolean {
  let four = false;
  walkTree(root, (node) => {
    if (four || node.type !== 'function_declaration') return;
    if (node.childForFieldName('name')?.text !== identifier) return;
    four = (node.childForFieldName('parameters')?.namedChildCount ?? 0) === 4;
  });
  return four;
}

/** The class a node stands in, when one does. */
function enclosingClassName(node: SyntaxNode): string | undefined {
  let held: SyntaxNode | null = node;
  while (held !== null) {
    if (held.type === 'class_declaration') return held.childForFieldName('name')?.text;
    held = held.parent;
  }
  return undefined;
}

/** `OrdersClient.placeOrder`: the class and method a node stands in. */
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

/** The class whose constructor carries a parameter property of this name. */
function classOfField(root: SyntaxNode, field: string): string | undefined {
  let found: string | undefined;
  walkTree(root, (node) => {
    if (found !== undefined || node.type !== 'class_declaration') return;
    const body = node.childForFieldName('body');
    if (body === null) return;
    walkTree(body, (inner) => {
      if (found !== undefined) return;
      const isParameterProperty = inner.type === 'required_parameter' && /private|readonly|public/.test(inner.text);
      const isProperty = (inner.type === 'property_definition' || inner.type === 'field_definition') && /private|readonly|public/.test(inner.text);
      if ((isParameterProperty || isProperty) && new RegExp(`\\b${field}\\b`).test(inner.text)) {
        found = node.childForFieldName('name')?.text;
      }
    });
  });
  return found;
}

function enclosingFunctionName(node: SyntaxNode): string | undefined {
  let held: SyntaxNode | null = node;
  while (held !== null) {
    if (held.type === 'function_declaration' || held.type === 'method_definition') {
      return held.childForFieldName('name')?.text;
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
