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
import type {SourceSpan, ExtractionGap} from '../../extract/records.js';
import type {CodeBindingFact, CodeCallFact, CodeExpressionFact} from '../code/facts.js';
import type {TreeText} from '../operations/source.js';
import {libraryRegistry} from '../library-models/validate.js';
import {messagingTypes} from '../library-models/messaging-models.js';

/** One route registered on an Express app or router, as the file states it (mounts joined later). */
export interface TsRoute {
  readonly method: string;
  readonly path: string;
  /** The middleware chain this file states, outermost first. */
  readonly middleware: readonly string[];
  /** The app or router variable the registration goes through (`app`, `router`). */
  readonly routerVar: string;
  /** The final registration argument, positioned for shared symbol resolution. */
  readonly handler?: {text: string; inline: boolean; span: SourceSpan};
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
  readonly listenerPorts: readonly string[];
  readonly fetchCalls: readonly {urlText: string; method: string; tokenForwarded: boolean; client?: string; span: SourceSpan}[];
  /** `const PROTO_PATH = path.resolve(__dirname, '<rel>')`: the relative part. */
  readonly protoRel?: string;
  readonly grpcSites: readonly {kind: 'serve' | 'call'; rpc: string; fn?: string; className?: string; handlerSpan?: SourceSpan; span: SourceSpan}[];
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
  readonly stringSplicers: readonly {fn: string; spliced: readonly string[]; span: SourceSpan}[];
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
  const fetchCalls: {urlText: string; method: string; tokenForwarded: boolean; client?: string; span: SourceSpan}[] = [];
  let protoRel: string | undefined;
  const grpcSites: {kind: 'serve' | 'call'; rpc: string; fn?: string; className?: string; handlerSpan?: SourceSpan; span: SourceSpan}[] = [];
  let deadlineField: {field: string; className: string} | undefined;
  const newCalls = new Map<string, string[]>();
  const configDefaults = new Map<string, number>();
  const inputs: {name: string; fn?: string; span: SourceSpan}[] = [];
  const stringSplicers: {fn: string; spliced: string[]; span: SourceSpan}[] = [];
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
    if (node.type === 'type_alias' || node.type === 'type_alias_declaration') {
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
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value');
      if (name !== undefined && value !== null) {
        // The app of the file is the one variable `express()` builds; it stands
        // inside the app factory, not at the top level.
        if (value.type === 'call_expression' && calleeName(value) === 'express') appVar = name;
        // The client field a deadline comes from: `const deadline = ... this.<field>`.
        if (name === 'deadline' && deadlineField === undefined) {
          const match = /this\.([A-Za-z0-9_]+)/.exec(value.text);
          if (match !== null) {
            const className = classOfField(root, match[1]!);
            if (className !== undefined) deadlineField = {field: match[1]!, className};
          }
        }
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
          grpcSites.push({kind: 'serve', rpc: key, fn: enclosingFunctionName(node), handlerSpan: spanOf(value, path), span: spanOf(node, path)});
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
    // A path-less `use` after a route or a mount of this file is the error
    // tail of the pipeline, not a middleware of the routes before it.
    const pipelineStarted = registrations.some((other) => other !== reg && other.verb !== 'use' && other.spanNode.startIndex < reg.spanNode.startIndex)
      || mounts.length > 0;
    if (pipelineStarted) continue;
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
      ...(parts.at(-1) === undefined ? {} : {handler: {
        text: parts.at(-1)!.text,
        inline: ['arrow_function', 'function_expression'].includes(parts.at(-1)!.type),
        span: spanOf(parts.at(-1)!, path),
      }}),
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
    if (spliced.size > 0) stringSplicers.push({fn: name, spliced: [...spliced].sort(), span: spanOf(node, path)});
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

  const listenerPorts = new Set<string>();
  walkTree(root, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'listen') return;
    const object = fn.childForFieldName('object')?.text;
    if (object === undefined || (object !== appVar && !routerFactories.has(object))) return;
    const argument = node.childForFieldName('arguments')?.namedChild(0)?.text;
    const port = argument === undefined ? undefined : consts.get(argument) ?? argument;
    if (port !== undefined && /^\d+$/.test(port)) listenerPorts.add(port);
  });
  return {
    path,
    listenerPorts: [...listenerPorts].sort(),
    consts,
    typeUnions,
    hs256Functions,
    appMiddlewares,
    mounts,
    routerFactories,
    routes,
    entry,
    started,
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

/** A publication proved from the shared binding/call graph, before channel matching. */
export interface StructuralPublication {
  readonly span: SourceSpan;
  readonly channel?: string;
  readonly publisher?: string;
  readonly key?: string;
  readonly evidence: readonly SourceSpan[];
}

/**
 * Library identity is data. Lexical identity, parameter substitution and local
 * delegation are structural joins over the immutable shared facts only.
 */
export function structuralPublishers(source: TreeText): {sites: StructuralPublication[]; gaps: ExtractionGap[]} {
  const facts = source.facts;
  if (facts === undefined) return {sites: [], gaps: []};
  const unique = <T>(entries: readonly T[]): T | undefined => entries.length === 1 ? entries[0] : undefined;
  const contains = (a: SourceSpan, b: SourceSpan): boolean => a.path === b.path && a.byteStart <= b.byteStart && b.byteEnd <= a.byteEnd;
  const same = (a: SourceSpan, b: SourceSpan): boolean => contains(a, b) && contains(b, a);
  // Duplicate identities are tombstones, not a last-writer-wins selection.
  const index = <T>(entries: readonly T[], key: (entry: T) => string): Map<string, T> => {
    const result = new Map<string, T>(); const duplicates = new Set<string>();
    for (const entry of entries) { const id = key(entry); if (result.has(id) || duplicates.has(id)) { result.delete(id); duplicates.add(id); } else result.set(id, entry); }
    return result;
  };
  const expressions = index(facts.expressions, x => x.id);
  const bindings = index(facts.bindings, x => x.id);
  const imports = index(facts.imports, x => x.id);
  const calls = index(facts.calls, x => x.expression);
  const symbols = index(facts.symbols, x => x.key);
  const models = libraryRegistry.models.filter(model => model.effect === 'message-publish' && model.target.kind === 'member');
  const roles = source.libraryFacts()?.roles ?? [];
  const sites: StructuralPublication[] = []; const gaps: ExtractionGap[] = [];
  const reported = new Set<string>();
  const gap = (call: CodeCallFact, detail: string): void => {
    const reason = `contracts: line ${call.span.lineStart}: ${detail} (${call.path})`;
    if (!reported.has(reason)) { reported.add(reason); gaps.push({path: call.path, reason}); }
  };
  const parsedPaths = new Set(facts.files.filter(file => file.parsed).map(file => file.path));
  const expression = (id: string): CodeExpressionFact | undefined => {
    const value = expressions.get(id);
    return value !== undefined && value.path === value.span.path && parsedPaths.has(value.path) ? value : undefined;
  };
  const children = (value: CodeExpressionFact): CodeExpressionFact[] => value.children.flatMap(id => {
    const child = expression(id); return child !== undefined && contains(value.span, child.span) && child.syntaxKind !== 'comment' ? [child] : [];
  });
  const field = (value: CodeExpressionFact, name: string): CodeExpressionFact | undefined => {
    const id = unique(value.fields[name] ?? []); const child = id === undefined ? undefined : expression(id);
    return child !== undefined && value.children.includes(child.id) && contains(value.span, child.span) ? child : undefined;
  };
  // These joins are reused for every call in a repository. Index copied
  // identities once rather than walking the whole expression set per receiver.
  const parents = new Map<string, CodeExpressionFact[]>();
  const declarations = new Map<string, CodeExpressionFact[]>();
  const lexicalTypes = new Map<string, CodeExpressionFact[]>();
  const classes = new Map<string, CodeExpressionFact[]>();
  const functions = new Map<string, CodeExpressionFact[]>();
  const callsByHolder = new Map<string, CodeCallFact[]>();
  const rolesByExpression = new Map<string, typeof roles[number][]>();
  const receiverDeclarations = new Map<string, CodeBindingFact[]>();
  const spanKey = (span: SourceSpan): string => JSON.stringify([span.path, span.byteStart, span.byteEnd]);
  for (const binding of bindings.values()) if (binding.kind === 'receiver') {
    const key = spanKey(binding.span); const held = receiverDeclarations.get(key) ?? []; held.push(binding); receiverDeclarations.set(key, held);
  }
  const append = <T>(map: Map<string, T[]>, key: string, item: T): void => { const held = map.get(key) ?? []; held.push(item); map.set(key, held); };
  for (const node of expressions.values()) {
    for (const child of node.children) append(parents, child, node);
    if (['required_parameter', 'optional_parameter', 'parameter_declaration', 'variadic_parameter_declaration', 'variable_declarator', 'var_spec'].includes(node.syntaxKind)) {
      for (const id of [...(node.fields.pattern ?? []), ...(node.fields.name ?? [])]) {
        const name = expression(id); const binding = name?.bindingId === undefined ? undefined : bindings.get(name.bindingId);
        if (name !== undefined && binding !== undefined && contains(node.span, binding.span) && same(name.span, binding.span)) append(declarations, binding.id, node);
      }
    }
    if (['interface_declaration', 'type_alias_declaration', 'class_declaration', 'enum_declaration'].includes(node.syntaxKind)) {
      const name = field(node, 'name')?.name; if (name !== undefined) append(lexicalTypes, name, node);
    }
    if (['class_declaration', 'abstract_class_declaration', 'class'].includes(node.syntaxKind)) {
      const name = field(node, 'name');
      const binding = name === undefined ? undefined : unique(receiverDeclarations.get(spanKey(name.span)) ?? []);
      if (binding !== undefined && contains(binding.scope, node.span)) append(classes, binding.id, node);
    }
    if (['function_declaration', 'method_definition', 'method_declaration', 'arrow_function', 'function_expression', 'func_literal'].includes(node.syntaxKind)) append(functions, JSON.stringify([node.path, node.span.byteEnd]), node);
  }
  for (const call of calls.values()) append(callsByHolder, call.holder, call);
  for (const role of roles) append(rolesByExpression, role.expression, role);
  const callSitesByHolder = new Map<string, typeof facts.sites[number][]>();
  const referencesBySpan = new Map<string, typeof facts.sites[number][]>();
  const fieldsByKey = new Map<string, NonNullable<typeof facts.fields>[number][]>();
  for (const site of facts.sites) {
    if (site.use === 'call') append(callSitesByHolder, site.holder, site);
    if (site.use === 'reference') append(referencesBySpan, spanKey(site.span), site);
  }
  for (const declared of facts.fields ?? []) append(fieldsByKey, declared.key, declared);
  const callEdges = new Set((source.code?.edges ?? []).filter(edge => edge.type === 'code.calls').map(edge => JSON.stringify([edge.from, edge.to])));
  const boundImports = new Set(facts.bindings.filter(binding => binding.kind === 'import' && binding.importId !== undefined).map(binding => binding.importId));
  const importedTargets = new Set(facts.imports.filter(imported => imported.targetPath !== undefined && boundImports.has(imported.id)).map(imported => JSON.stringify([imported.path, imported.targetPath])));
  const written = new Set<string>();
  const mark = (value: CodeExpressionFact): void => { if (value.bindingId !== undefined) written.add(value.bindingId); for (const child of children(value)) mark(child); };
  for (const value of expressions.values()) {
    if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement'].includes(value.syntaxKind)) for (const id of value.fields.left ?? []) { const target = expression(id); if (target !== undefined) mark(target); }
    if (['update_expression', 'inc_statement', 'dec_statement'].includes(value.syntaxKind)) mark(value);
    if (value.syntaxKind === 'short_var_declaration') for (const id of value.fields.left ?? []) {
      const left = expression(id); if (left === undefined) continue;
      for (const target of children(left)) {
        const binding = target.bindingId === undefined ? undefined : bindings.get(target.bindingId);
        // := may assign an existing Go parameter/local beside a new binding.
        if (binding !== undefined && !same(binding.span, target.span)) mark(target);
      }
    }
  }
  const bindingOf = (value: CodeExpressionFact): CodeBindingFact | undefined => {
    const binding = value.bindingId === undefined ? undefined : bindings.get(value.bindingId);
    return binding !== undefined && binding.path === value.path && contains(binding.scope, value.span) && !written.has(binding.id) && (binding.kind !== 'local' || binding.span.byteStart <= value.span.byteStart) ? binding : undefined;
  };
  type Value = {id: string; env: ReadonlyMap<string, Value>};
  const unwrap = (value: Value, seen = new Set<string>()): Value | undefined => {
    if (seen.has(value.id) || seen.size > 80) return undefined; seen.add(value.id);
    const node = expression(value.id); if (node === undefined) return undefined;
    if (node.bindingId !== undefined) {
      const binding = bindingOf(node); if (binding === undefined) return undefined;
      const argument = value.env.get(binding.id); if (argument !== undefined) return unwrap(argument, seen);
      if (binding.kind === 'local' && binding.initializer !== undefined) return unwrap({id: binding.initializer, env: value.env}, seen);
    }
    if (['parenthesized_expression', 'literal_element', 'expression_list', 'await_expression'].includes(node.syntaxKind)) {
      const child = unique(children(node)); return child === undefined ? undefined : unwrap({id: child.id, env: value.env}, seen);
    }
    return value;
  };
  const literal = (value: Value): string | undefined => { const held = unwrap(value); const node = held === undefined ? undefined : expression(held.id); return node?.literal?.kind === 'string' && typeof node.literal.value === 'string' ? node.literal.value : undefined; };
  type Property = {kind: 'absent'} | {kind: 'unknown'} | {kind: 'value'; value: Value};
  // Object spread copies properties in source order. An unresolved spread may
  // overwrite an earlier key; only a later proved property can restore it.
  // Absence is distinct from uncertainty so a known unrelated spread is inert.
  const objectProperty = (value: Value, key: string, seen = new Set<string>()): Property => {
    const held = unwrap(value);
    if (held === undefined || seen.has(held.id) || seen.size >= 80) return {kind: 'unknown'};
    const node = expression(held.id);
    if (node?.syntaxKind !== 'object') return {kind: 'unknown'};
    const next = new Set(seen); next.add(held.id);
    const entries: CodeExpressionFact[] = [];
    let end = node.span.byteStart;
    for (const id of node.children) {
      const entry = expression(id);
      // Never turn a partial or reordered fact view into a smaller object.
      if (entry === undefined || !contains(node.span, entry.span) || entry.span.byteStart < end) return {kind: 'unknown'};
      entries.push(entry); end = entry.span.byteEnd;
    }
    let result: Property = {kind: 'absent'};
    for (const entry of entries) {
      if (entry.syntaxKind === 'comment') continue;
      if (entry.syntaxKind === 'spread_element') {
        const operands = entry.children.map(expression);
        const operand = unique(operands);
        const spread: Property = operand === undefined || !contains(entry.span, operand.span)
          ? {kind: 'unknown'} : objectProperty({id: operand.id, env: held.env}, key, next);
        if (spread.kind !== 'absent') result = spread;
        continue;
      }
      if (entry.syntaxKind === 'shorthand_property_identifier') {
        if (entry.name === undefined) result = {kind: 'unknown'};
        else if (entry.name === key) result = {kind: 'value', value: {id: entry.id, env: held.env}};
        continue;
      }
      if (entry.syntaxKind !== 'pair' && entry.syntaxKind !== 'method_definition') { result = {kind: 'unknown'}; continue; }
      const name = field(entry, entry.syntaxKind === 'pair' ? 'key' : 'name');
      let named = name?.name ?? (typeof name?.literal?.value === 'string' ? name.literal.value : undefined);
      if (name?.syntaxKind === 'computed_property_name') {
        const operands = name.children.map(expression); const operand = unique(operands);
        named = operand === undefined || !contains(name.span, operand.span) ? undefined : literal({id: operand.id, env: held.env});
      }
      if (named === undefined) { result = {kind: 'unknown'}; continue; }
      if (named !== key) continue;
      const selected = entry.syntaxKind === 'pair' ? field(entry, 'value') : undefined;
      result = selected === undefined ? {kind: 'unknown'} : {kind: 'value', value: {id: selected.id, env: held.env}};
    }
    return result;
  };
  const select = (value: Value, path: readonly string[]): Value | undefined => {
    let held: Value | undefined = value;
    for (const key of path) {
      held = held === undefined ? undefined : unwrap(held); const node: CodeExpressionFact | undefined = held === undefined ? undefined : expression(held.id);
      if (node === undefined || held === undefined) return undefined;
      if (node.syntaxKind === 'object') {
        const selected = objectProperty(held, key);
        if (selected.kind !== 'value') return undefined;
        held = selected.value;
        continue;
      }
      let object: CodeExpressionFact = node;
      if (node.syntaxKind === 'composite_literal') { const body = field(node, 'body'); if (body === undefined) return undefined; object = body; }
      const candidates: CodeExpressionFact[] = children(object).flatMap((entry): CodeExpressionFact[] => {
        if (entry.syntaxKind === 'shorthand_property_identifier' && entry.name === key) return [entry];
        if (entry.syntaxKind !== 'pair' && entry.syntaxKind !== 'keyed_element') return [];
        let name = field(entry, 'key'); let result = field(entry, 'value');
        // Go's keyed_element has two ordered literal_element operands, not
        // named key/value fields. Read only that direct grammar pair; a nested
        // key or a surviving half of a partial pair cannot supply the selector.
        if (entry.syntaxKind === 'keyed_element' && entry.fields.key === undefined && entry.fields.value === undefined) {
          const operands = children(entry);
          if (operands.length !== 2 || operands.some(operand => operand.syntaxKind !== 'literal_element') || operands[0]!.span.byteEnd > operands[1]!.span.byteStart) return [];
          [name, result] = operands;
        }
        if (name?.syntaxKind === 'literal_element') name = unique(children(name));
        const named = name?.name ?? (typeof name?.literal?.value === 'string' ? name.literal.value : undefined);
        return named === key && result !== undefined ? [result] : [];
      });
      const chosen: CodeExpressionFact | undefined = unique(candidates); if (chosen === undefined) return undefined;
      held = {id: chosen.id, env: held.env};
    }
    return held;
  };
  const externalType = (raw: CodeExpressionFact): {package: string; path: readonly string[]; pointer: boolean} | undefined => {
    let node: CodeExpressionFact | undefined = raw; let pointer = false;
    const visited = new Set<string>();
    while (node !== undefined && ['type_annotation', 'parenthesized_type', 'pointer_type'].includes(node.syntaxKind)) {
      if (visited.has(node.id) || visited.size >= 80) return undefined; visited.add(node.id);
      if (node.syntaxKind === 'pointer_type') { if (pointer) return undefined; pointer = true; }
      node = unique(children(node));
    }
    if (node === undefined) return undefined;
    const path: string[] = [];
    while (['nested_type_identifier', 'qualified_type'].includes(node.syntaxKind)) {
      if (visited.has(node.id) || visited.size >= 80) return undefined; visited.add(node.id);
      const name = field(node, 'name');
      const base: CodeExpressionFact | undefined = field(node, node.syntaxKind === 'qualified_type' ? 'package' : 'module');
      if (name?.name === undefined || base === undefined) return undefined;
      path.unshift(name.name); node = base;
    }
    // Type declarations occupy a lexical namespace too. The fact pass retains
    // their grammar even where a consumer has no exported type identity.
    for (const declaration of lexicalTypes.get(node.name ?? '') ?? []) {
      const parent = unique(parents.get(declaration.id) ?? []);
      const scope = parent?.syntaxKind === 'export_statement' ? unique(parents.get(parent.id) ?? []) : parent;
      if (scope !== undefined && ['statement_block', 'program'].includes(scope.syntaxKind) && contains(scope.span, raw.span)) return undefined;
    }
    const binding = bindingOf(node); const imported = binding?.importId === undefined ? undefined : imports.get(binding.importId);
    if (binding?.kind !== 'import' || imported === undefined || imported.path !== node.path || imported.targetPath !== undefined) return undefined;
    const exported = imported.imported.form === 'named' ? [imported.imported.name] : imported.imported.form === 'default' ? ['default'] : [];
    return {package: imported.specifier, path: [...exported, ...path], pointer};
  };
  const parameter = (binding: CodeBindingFact): CodeExpressionFact | undefined => unique(declarations.get(binding.id) ?? []);
  const producerType = (raw: CodeExpressionFact | undefined): string | undefined => {
    const type = raw === undefined ? undefined : externalType(raw);
    return type === undefined ? undefined : unique(messagingTypes.filter(model => model.package === type.package && model.pointer === type.pointer && JSON.stringify(model.exportedPath) === JSON.stringify(type.path)))?.package;
  };
  const receiverPackage = (id: string, env: ReadonlyMap<string, Value>, seen = new Set<string>()): string | undefined => {
    const value = unwrap({id, env}); if (value === undefined || seen.has(value.id)) return undefined; seen.add(value.id);
    const node = expression(value.id); if (node === undefined) return undefined;
    const modeled = unique((rolesByExpression.get(node.id) ?? []).filter(role => role.role === 'message-producer'));
    if (modeled !== undefined) return imports.get(modeled.origin.importId)?.specifier;
    const binding = bindingOf(node);
    if (binding !== undefined) { const declaration = parameter(binding); const type = declaration === undefined ? undefined : field(declaration, 'type'); const grounded = producerType(type); if (grounded !== undefined) return grounded; }
    if (node.receiver === undefined || node.member === undefined) return undefined;
    const base = expression(node.receiver); const owner = base === undefined ? undefined : bindingOf(base);
    if (base?.syntaxKind === 'this' && owner?.kind === 'receiver') {
      const cls = unique(classes.get(owner.id) ?? []);
      const body = cls === undefined || !contains(cls.span, base.span) ? undefined : field(cls, 'body'); if (body === undefined) return undefined;
      const members = children(body); const candidates: CodeExpressionFact[] = [];
      for (const member of members) {
        if (member.syntaxKind === 'public_field_definition' && field(member, 'name')?.name === node.member) candidates.push(member);
        if (member.syntaxKind !== 'method_definition' || field(member, 'name')?.name !== 'constructor') continue;
        const params = field(member, 'parameters'); if (params === undefined) continue;
        for (const param of children(params)) if (field(param, 'pattern')?.name === node.member && children(param).some(modifier => ['accessibility_modifier', 'readonly'].includes(modifier.syntaxKind))) candidates.push(param);
      }
      const declared = unique(candidates); return producerType(declared === undefined ? undefined : field(declared, 'type'));
    }
    // Go field identity must come from the exact reference site and declared owner.
    const property = field(node, 'field');
    const target = property === undefined ? undefined : unique((referencesBySpan.get(spanKey(property.span)) ?? []).map(site => site.to));
    const declared = target === undefined ? undefined : unique(fieldsByKey.get(target) ?? []);
    if (declared === undefined) return undefined;
    const ownerType = owner === undefined ? undefined : parameter(owner);
    let raw = ownerType === undefined ? undefined : field(ownerType, 'type');
    if (raw?.syntaxKind === 'pointer_type') raw = unique(children(raw));
    const typeBinding = raw === undefined ? undefined : bindingOf(raw);
    if (typeBinding?.typeDeclaration?.expression !== declared.ownerDeclaration) return undefined;
    return producerType(expression(declared.typeExpression));
  };
  const validCall = (call: CodeCallFact): boolean => {
    const node = expression(call.expression); const callee = expression(call.callee);
    return node !== undefined && callee !== undefined && same(node.span, call.span) && node.callee === call.callee && node.children.includes(call.callee) && JSON.stringify(node.arguments ?? []) === JSON.stringify(call.arguments) && call.arguments.every(id => { const arg = expression(id); return arg !== undefined && contains(node.span, arg.span); });
  };
  const callableCache = new Map<string, CodeExpressionFact | undefined>();
  const callable = (key: string): CodeExpressionFact | undefined => {
    if (callableCache.has(key)) return callableCache.get(key);
    const symbol = symbols.get(key);
    const result = symbol?.callable !== true || symbol.bodySpan === undefined ? undefined :
      unique((functions.get(JSON.stringify([symbol.path, symbol.span.byteEnd])) ?? []).filter(node => contains(symbol.span, node.span) && same(field(node, 'body')?.span ?? node.span, symbol.bodySpan!)));
    callableCache.set(key, result); return result;
  };
  const targets = (call: CodeCallFact): {key: string; fan: boolean}[] => {
    const callee = expression(call.callee); if (callee === undefined) return [];
    const resolved = (callSitesByHolder.get(call.holder) ?? []).filter(site => contains(callee.span, site.span));
    const direct = [...new Set(resolved.map(site => site.to))];
    if (direct.length !== 1) return [];
    const candidate = direct[0]!;
    const keys = callable(candidate) === undefined ? [...new Set(resolved.flatMap(site => site.fanOut))] : [candidate];
    return keys.filter(key => {
      const target = symbols.get(key);
      if (target === undefined || !callEdges.has(JSON.stringify([call.holder, key]))) return false;
      // A cross-file callable requires the shared resolver's actual import
      // edge, not only a surviving same-name call site in a partial fact view.
      return target.path === call.path || importedTargets.has(JSON.stringify([call.path, target.path]));
    }).map(key => ({key, fan: key !== candidate}));
  };
  const argumentsFor = (target: CodeExpressionFact, call: CodeCallFact, env: ReadonlyMap<string, Value>): ReadonlyMap<string, Value> | undefined => {
    const parameters = field(target, 'parameters'); if (parameters === undefined) return undefined;
    const result = new Map<string, Value>();
    for (const [at, param] of children(parameters).entries()) {
      const name = field(param, 'pattern') ?? field(param, 'name') ?? (param.syntaxKind === 'identifier' ? param : undefined);
      const binding = name === undefined ? undefined : bindingOf(name); const arg = call.arguments[at];
      if (binding === undefined || binding.kind !== 'parameter' || arg === undefined) return undefined;
      result.set(binding.id, {id: arg, env});
    }
    return result;
  };
  // Interface fan-out is an implementation possibility. It becomes publisher
  // evidence only when a real factory result reaches that implementation's constructor.
  const connected = (target: CodeExpressionFact): boolean => {
    const cls = [...expressions.values()].filter(node => node.syntaxKind === 'class_declaration' && contains(node.span, target.span)).sort((a,b) => (a.span.byteEnd-a.span.byteStart)-(b.span.byteEnd-b.span.byteStart))[0];
    if (cls === undefined) return false;
    const body = field(cls, 'body'); const ctor = body === undefined ? undefined : unique(children(body).filter(node => node.syntaxKind === 'method_definition' && field(node, 'name')?.name === 'constructor'));
    const params = ctor === undefined ? undefined : field(ctor, 'parameters'); if (params === undefined) return false;
    const producerIndexes = children(params).flatMap((param, at) => producerType(field(param, 'type')) === undefined ? [] : [at]);
    const owner = unique(facts.symbols.filter(symbol => !symbol.callable && contains(symbol.span, cls.span) && symbol.name === field(cls, 'name')?.name));
    return [...calls.values()].some(call => call.construct && validCall(call) && facts.sites.some(site => site.use === 'call' && contains(expression(call.callee)!.span, site.span) && (site.to === owner?.key || site.to === facts.symbols.find(symbol => symbol.callable && same(symbol.span, ctor!.span))?.key)) && producerIndexes.some(at => { const arg = call.arguments[at]; return arg !== undefined && roles.some(role => role.expression === arg && role.role === 'message-producer'); }));
  };
  const targetCache = new Map<string, ReturnType<typeof targets>>();
  const targetsOf = (call: CodeCallFact): ReturnType<typeof targets> => {
    let held = targetCache.get(call.expression); if (held === undefined) { held = targets(call); targetCache.set(call.expression, held); } return held;
  };
  const directModel = (call: CodeCallFact, env: ReadonlyMap<string, Value>): typeof models[number] | undefined => {
    const callee = expression(call.callee);
    const pkg = callee?.receiver === undefined ? undefined : receiverPackage(callee.receiver, env);
    return unique(models.filter(model => model.target.kind === 'member' && model.target.member === callee?.member && model.package === pkg));
  };
  // Publication ownership does not follow reachability. A sender method may
  // adapt its own modeled producer call, but its callers are not sender methods
  // merely because they eventually reach one. Index only directly owned sends.
  const senderMethods = new Map<string, CodeCallFact[]>();
  for (const call of calls.values()) {
    if (!validCall(call) || directModel(call, new Map()) === undefined) continue;
    const body = callable(call.holder);
    if (body !== undefined && ['method_definition', 'method_declaration'].includes(body.syntaxKind)) append(senderMethods, call.holder, call);
  }
  type Found = {channel?: string; evidence: SourceSpan[]};
  const directPublication = (call: CodeCallFact, env: ReadonlyMap<string, Value>): Found[] => {
    if (!validCall(call)) return [];
    const model = directModel(call, env);
    if (model === undefined) return [];
    for (const selector of model.arguments.filter(selector => selector.required)) {
      const arg = call.arguments[selector.index];
      if (arg === undefined || select({id: arg, env}, selector.path) === undefined) { gap(call, `publisher required argument ${selector.name} is unresolved`); return []; }
    }
    const topic = model.arguments.find(selector => selector.name === 'topic');
    if (topic === undefined) { gap(call, 'publisher model has no supported topic selector'); return []; }
    const indexes = model.ecosystem === 'go' ? call.arguments.map((_, at) => at).filter(at => at >= topic.index) : [topic.index];
    const result: Found[] = [];
    for (const at of indexes) {
      const id = call.arguments[at]; const value = id === undefined ? undefined : select({id, env}, topic.path);
      const channel = value === undefined ? undefined : literal(value);
      if (channel === undefined) gap(call, 'publisher topic is unresolved through the supplied bindings and call arguments');
      result.push({...(channel === undefined ? {} : {channel}), evidence: [call.span]});
    }
    return result;
  };
  const analyze = (call: CodeCallFact, env: ReadonlyMap<string, Value>): Found[] => {
    if (!validCall(call)) return [];
    if (directModel(call, env) !== undefined) return directPublication(call, env);
    const callee = expression(call.callee);
    // Only an actual receiver invocation of a resolved sender method adapts
    // arguments. A free function that calls that sender has no publisher role.
    if (callee?.receiver === undefined) return [];
    const result: Found[] = [];
    for (const target of targetsOf(call)) {
      const sends = senderMethods.get(target.key); if (sends === undefined) continue;
      const body = callable(target.key); if (body === undefined || target.fan && !connected(body)) continue;
      const args = argumentsFor(body, call, env); if (args === undefined) {
        gap(call, 'publisher delegation arguments cannot be bound to the resolved callable');
        continue;
      }
      for (const inner of sends) for (const found of directPublication(inner, args)) result.push({...found, evidence: [call.span, ...found.evidence]});
    }
    return result;
  };
  const empty = new Map<string, Value>();
  for (const call of calls.values()) {
    const found = analyze(call, empty);
    const uniqueChannels = new Set<string>();
    for (const item of found) {
      const id = item.channel ?? ''; if (uniqueChannels.has(id)) continue; uniqueChannels.add(id);
      const symbol = symbols.get(call.holder); const arg = call.arguments[1]; const keySpan = arg === undefined ? undefined : expression(arg)?.span;
      const key = keySpan === undefined ? undefined : new TextDecoder().decode(source.tree.read(keySpan.path).subarray(keySpan.byteStart,keySpan.byteEnd));
      if (item.channel === undefined) gap(call, 'publisher topic is unresolved through the supplied bindings and call arguments');
      sites.push({span: call.span, ...(item.channel === undefined ? {} : {channel: item.channel}), ...(symbol === undefined ? {} : {publisher: symbol.name}), ...(key === undefined ? {} : {key}), evidence: item.evidence});
    }
    // An explicitly typed local send is a candidate even when its implementation
    // is absent. An untyped response/cache method is not messaging evidence.
    if (found.length === 0) {
      const callee = expression(call.callee); const receiverValue = callee?.receiver === undefined ? undefined : unwrap({id: callee.receiver, env: empty});
      const receiver = receiverValue === undefined ? undefined : expression(receiverValue.id);
      const binding = receiver === undefined ? undefined : bindingOf(receiver); const declaration = binding === undefined ? undefined : parameter(binding);
      const type = declaration === undefined ? undefined : field(declaration, 'type');
      let namedType = type?.syntaxKind === 'type_annotation' ? unique(children(type)) : type;
      if (namedType?.syntaxKind === 'pointer_type') namedType = unique(children(namedType));
      const typed = namedType !== undefined && ['type_identifier','generic_type','nested_type_identifier','qualified_type'].includes(namedType.syntaxKind);
      const channelArg = call.arguments[0]; const channel = channelArg === undefined ? undefined : literal({id:channelArg,env:empty});
      if (typed && models.some(model => model.target.kind === 'member' && model.target.member === callee?.member)) gap(call, channel === undefined ? 'typed publisher candidate has no resolved receiver/delegation; no publisher is claimed' : `send names channel ${channel} but its receiver has no resolved publisher delegation; no publisher is claimed`);
      // A local shadow is not its outer producer. Keep the located candidate
      // diagnostic only when the exact enclosing binding proves a producer and
      // the call's direct modeled topic selector resolves. Ordinary any/cache/
      // response sends have no such lexical producer evidence.
      const rawReceiver = callee?.receiver === undefined ? undefined : expression(callee.receiver);
      const local = rawReceiver === undefined ? undefined : bindingOf(rawReceiver);
      if (validCall(call) && local?.kind === 'local' && rawReceiver !== undefined && models.some(model => model.target.kind === 'member' && model.target.member === callee?.member)) {
        const enclosing = [...bindings.values()].filter(candidate => candidate.id !== local.id && candidate.path === local.path && candidate.name === local.name && contains(candidate.scope, local.scope) && !same(candidate.scope, local.scope) && contains(candidate.scope, rawReceiver.span));
        enclosing.sort((a, b) => (a.scope.byteEnd - a.scope.byteStart) - (b.scope.byteEnd - b.scope.byteStart));
        const nearest = enclosing[0];
        const outer = nearest === undefined ? undefined : unique(enclosing.filter(candidate => same(candidate.scope, nearest.scope)));
        const declared = outer?.kind === 'parameter' && !written.has(outer.id) ? parameter(outer) : undefined;
        const pkg = producerType(declared === undefined ? undefined : field(declared, 'type'));
        const model = unique(models.filter(candidate => candidate.target.kind === 'member' && candidate.target.member === callee?.member && candidate.package === pkg));
        const topic = model?.arguments.find(selector => selector.name === 'topic');
        const arg = topic === undefined ? undefined : call.arguments[topic.index];
        const selected = arg === undefined || topic === undefined ? undefined : select({id: arg, env: empty}, topic.path);
        const shadowedChannel = selected === undefined ? undefined : literal(selected);
        if (shadowedChannel !== undefined) gap(call, `send names channel ${shadowedChannel} but its receiver shadows a proved producer binding; no publisher is claimed`);
      }
    }
  }
  return {sites,gaps};
}
