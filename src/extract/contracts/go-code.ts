/**
 * The Go half of the contracts extractor's code reading: the routes a
 * net/http router registers (with the middleware chain each one sits behind,
 * outermost first, and whether the chain carries the auth middleware), the
 * process entry points (a `package main` file's `main`, with what it starts),
 * and the Kafka sites -- a `kafka.Message` write and a `kafka.ReaderConfig`
 * with its topic and consumer group. Everything is read from the bytes of one
 * file plus the indexes the extractor builds over the whole tree (const values,
 * method declarations), never from a run.
 */
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {calleeName, callsNamed, stringValue, walkTree} from './walk.js';

/** One route registered on a net/http mux. */
export interface GoRoute {
  readonly method: string;
  readonly path: string;
  /** The handler expression as written (`deps.Orders.Export`). */
  readonly handler: string;
  /** The handler's owner resolved through the struct field it comes through (`OrderHandlers.Export`). */
  readonly handlerSymbol: string;
  /** The middleware chain, outermost first, as written. */
  readonly middleware: readonly string[];
  /** Whether the chain carries the auth middleware. */
  readonly authGroup: boolean;
  readonly spanNode: SyntaxNode;
}

/** One long-running piece a `main` starts. */
export interface StartedUnit {
  readonly kind: 'http-server' | 'grpc-server' | 'loop' | 'job';
  readonly symbol: string;
  readonly path?: string;
  readonly port?: string;
}

/** One Kafka site of a file. */
export interface GoKafkaSite {
  readonly kind: 'publish' | 'consume';
  /** For a consume: the topic expression as written, and the group literal. */
  readonly topic?: string;
  readonly group?: string;
  readonly spanNode: SyntaxNode;
}

export interface GoFileFacts {
  readonly path: string;
  readonly packageName: string;
  /** String-valued constants of the file, by name (`OrdersTopic` -> `orders.events`). */
  readonly consts: ReadonlyMap<string, string>;
  /** The struct field types of the file, by field name (`Orders` -> `OrderHandlers`). */
  readonly structFields: ReadonlyMap<string, string>;
  /** Methods declared `(x *T) Name`, as `T.Name`. */
  readonly methods: readonly string[];
  readonly functions: readonly string[];
  readonly routes: readonly GoRoute[];
  readonly entryPoint: boolean;
  readonly started: readonly StartedUnit[];
  readonly kafkaSites: readonly GoKafkaSite[];
  /** The middleware a `X := Chain(...)` binding names, and whether it authenticates. */
  readonly chainBindings: ReadonlyMap<string, {names: readonly string[]; auth: boolean}>;
  /** The chain of the router's global wrap, when the file returns `Chain(...)(mux)`. */
  readonly globalChain: readonly string[];
}

/** The middleware descriptors of a `Chain(...)` call: `RequireAuth`, `RequireRole("support")`. */
function chainOf(call: SyntaxNode): {names: string[]; auth: boolean} {
  const names: string[] = [];
  let auth = false;
  const args = call.childForFieldName('arguments');
  if (args !== null) {
    for (let i = 0; i < args.childCount; i++) {
      const arg = args.child(i);
      if (arg === null || arg.type !== 'call_expression') continue;
      const name = calleeName(arg) ?? arg.text;
      const first = arg.childForFieldName('arguments')?.namedChild(0) ?? null;
      const literal = stringValue(first);
      const shown = literal !== undefined ? `${name}("${literal}")` : name;
      names.push(shown);
      if (name === 'RequireAuth') auth = true;
    }
  }
  return {names, auth};
}

/** The handler expression at the bottom of middleware wrappers (`authed(http.HandlerFunc(h))` -> h). */
function unwrappedHandler(node: SyntaxNode): string {
  let held = node;
  while (held.type === 'call_expression' || held.type === 'parenthesized_expression' || held.type === 'unary_expression') {
    if (held.type === 'call_expression') {
      const args = held.childForFieldName('arguments');
      const only = args?.namedChild(0) ?? null;
      if (only === null) break;
      held = only;
    } else {
      const only = held.namedChild(0);
      if (only === null) break;
      held = only;
    }
  }
  return held.text;
}

export function readGoFile(path: string, root: SyntaxNode): GoFileFacts {
  let packageName = '';
  const consts = new Map<string, string>();
  const structFields = new Map<string, string>();
  const methods: string[] = [];
  const functions: string[] = [];
  const routes: GoRoute[] = [];
  const kafkaSites: GoKafkaSite[] = [];
  const chainBindings = new Map<string, {names: string[]; auth: boolean}>();
  let globalChain: string[] = [];
  let entryPoint = false;
  const started: StartedUnit[] = [];
  /** The receiver variable a method is declared on (`h` -> `Handler`), for resolving `h.apply`. */
  const receiverNames = new Map<string, string>();
  interface RawRoute {
    method: string;
    path: string;
    handlerText: string;
    wrappedBy?: string;
    spanNode: SyntaxNode;
  }
  const rawRoutes: RawRoute[] = [];

  walkTree(root, (node) => {
    if (node.type === 'package_clause') {
      packageName = node.namedChild(0)?.text ?? '';
      return;
    }
    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) functions.push(name);
      if (packageName === 'main' && name === 'main') entryPoint = true;
      return;
    }
    if (node.type === 'method_declaration') {
      const declaration = node.childForFieldName('receiver')?.namedChild(0) ?? null;
      const typeNode = declaration?.childForFieldName('type') ?? null;
      const receiverType = (typeNode?.text ?? '').replace(/^\*+/, '');
      const receiverVar = declaration?.childForFieldName('name')?.text ?? '';
      const name = node.childForFieldName('name')?.text ?? '';
      if (receiverType !== '' && name !== '') methods.push(`${receiverType}.${name}`);
      if (receiverVar !== '' && receiverType !== '') receiverNames.set(receiverVar, receiverType);
      return;
    }
    // One const spec per line here; a const block carries several.
    if (node.type === 'const_spec') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value');
      const literal = value === null ? undefined : stringValue(value);
      if (name !== undefined && literal !== undefined) consts.set(name, literal);
      return;
    }
    if (node.type === 'type_declaration') {
      walkTree(node, (inner) => {
        if (inner.type === 'type_spec') {
          const name = inner.childForFieldName('name')?.text;
          const body = inner.childForFieldName('type');
          if (name !== undefined && body?.type === 'struct_type') {
            walkTree(body, (field) => {
              if (field.type === 'field_declaration') {
                const fieldName = field.childForFieldName('name')?.text;
                const fieldType = field.childForFieldName('type')?.text.replace(/^\*?/, '') ?? '';
                if (fieldName !== undefined && fieldType !== '') structFields.set(fieldName, fieldType);
              }
            });
          }
        }
      });
      return;
    }
    // `authed := Chain(...)` -- a middleware binding the routes refer to.
    if (node.type === 'short_var_declaration') {
      const left = node.childForFieldName('left')?.namedChild(0)?.text;
      const right = node.childForFieldName('right')?.namedChild(0);
      if (left !== undefined && right?.type === 'call_expression' && calleeName(right) === 'Chain') {
        const chain = chainOf(right);
        chainBindings.set(left, chain);
        return;
      }
    }
    // `return Chain(A, B)(mux)` -- the router's global chain.
    if (node.type === 'return_statement') {
      const call = node.namedChild(0);
      if (call?.type === 'call_expression') {
        const inner = call.childForFieldName('function');
        if (inner?.type === 'call_expression' && calleeName(inner) === 'Chain') {
          globalChain = chainOf(inner).names;
        }
      }
      return;
    }
    // `mux.HandleFunc("GET /healthz", Health)` and `mux.Handle("POST /orders", authed(...))`.
    if (node.type === 'call_expression' && (calleeName(node) === 'HandleFunc' || calleeName(node) === 'Handle')) {
      const args = node.childForFieldName('arguments');
      const pattern = stringValue(args?.namedChild(0) ?? null);
      const handlerNode = args?.namedChild(1);
      if (pattern !== undefined && handlerNode !== undefined && handlerNode !== null) {
        const space = pattern.indexOf(' ');
        const method = space > 0 ? pattern.slice(0, space) : '';
        const routePath = space > 0 ? pattern.slice(space + 1) : pattern;
        const wrappedBy = handlerNode.type === 'call_expression' ? calleeName(handlerNode) : undefined;
        rawRoutes.push({method, path: routePath, handlerText: unwrappedHandler(handlerNode), wrappedBy, spanNode: node});
      }
      return;
    }
    // kafka.Message{Topic: ..., Key: ..., Value: ...} -- a publish site.
    if (node.type === 'composite_literal') {
      const typeText = node.childForFieldName('type')?.text ?? '';
      if (typeText === 'kafka.Message') {
        kafkaSites.push({kind: 'publish', spanNode: node});
        return;
      }
      if (typeText === 'kafka.ReaderConfig') {
        let topic: string | undefined;
        let group: string | undefined;
        const body = node.childForFieldName('body');
        if (body !== null) {
          walkTree(body, (element) => {
            if (element.type !== 'keyed_element') return;
            const key = element.childForFieldName('key')?.text;
            const value = element.childForFieldName('value');
            if (key === 'Topic') topic = value?.text;
            if (key === 'GroupID') group = stringValue(value) ?? value?.text;
          });
        }
        kafkaSites.push({kind: 'consume', topic, group, spanNode: node});
      }
      return;
    }
  });

  // Resolve the registrations now that every binding and the global chain are known.
  for (const raw of rawRoutes) {
    let middleware: string[] = [...globalChain];
    let auth = globalChain.some((name) => name === 'RequireAuth');
    if (raw.wrappedBy !== undefined) {
      const binding = chainBindings.get(raw.wrappedBy);
      if (binding !== undefined) {
        middleware = [...globalChain, ...binding.names];
        auth = auth || binding.auth;
      }
    }
    const dot = raw.handlerText.lastIndexOf('.');
    const owner = dot > 0 ? raw.handlerText.slice(0, dot) : '';
    const owned = owner.includes('.') ? owner.slice(owner.lastIndexOf('.') + 1) : owner;
    const fieldType = structFields.get(owned) ?? receiverNames.get(owned);
    const handlerSymbol = fieldType !== undefined ? `${fieldType}.${raw.handlerText.slice(dot + 1)}` : raw.handlerText;
    routes.push({method: raw.method, path: raw.path, handler: raw.handlerText, handlerSymbol, middleware, authGroup: auth, spanNode: raw.spanNode});
  }

  return {
    path,
    packageName,
    consts,
    structFields,
    methods,
    functions,
    routes,
    entryPoint,
    started: [],
    kafkaSites,
    chainBindings,
    globalChain,
  };
}

/** The trees of one Go package (the files of its folder), as the extractor holds them. */
export type PackageTrees = ReadonlyMap<string, SyntaxNode>;

/**
 * Collects what a `package main` file's `main` starts: the HTTP server it
 * binds (`server.ListenAndServe()` with the `&http.Server{Addr: ...}` of the
 * same package), every `something.New(...).Run(ctx)` loop a goroutine starts,
 * and the package-local jobs it calls from another file of the same folder
 * (`runRetention` of retention.go).
 */
export function goEntryPointStarts(mainBody: SyntaxNode, trees: PackageTrees, ownPath: string): StartedUnit[] {
  const started: StartedUnit[] = [];
  const consts = new Map<string, string>();
  const functionFiles = new Map<string, string>();
  for (const [file, tree] of trees) {
    walkTree(tree, (node) => {
      if (node.type === 'const_spec') {
        const name = node.childForFieldName('name')?.text;
        const literal = stringValue(node.childForFieldName('value'));
        if (name !== undefined && literal !== undefined && !consts.has(name)) consts.set(name, literal);
      }
      if (node.type === 'function_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (name !== undefined && !functionFiles.has(name)) functionFiles.set(name, file);
      }
    });
  }

  const serverAddrOf = (object: string): string | undefined => {
    for (const tree of trees.values()) {
      const found = findServerAddr(tree, object);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const functionBodyOf = (name: string): SyntaxNode | undefined => {
    for (const tree of trees.values()) {
      let found: SyntaxNode | undefined;
      walkTree(tree, (node) => {
        if (found !== undefined || node.type !== 'function_declaration') return;
        if (node.childForFieldName('name')?.text === name) found = node.childForFieldName('body') ?? undefined;
      });
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const visitBody = (body: SyntaxNode): void => {
    for (const call of callsNamed(body, new Set(['ListenAndServe']))) {
      const object = call.childForFieldName('function')?.childForFieldName('operand')?.text;
      const addr = object !== undefined ? serverAddrOf(object) : undefined;
      const port = addr !== undefined ? (consts.get(addr) ?? addr).replace(/^:/, '') : undefined;
      started.push({kind: 'http-server', symbol: call.text, ...(port !== undefined ? {port} : {})});
    }
    for (const call of callsNamed(body, new Set(['Run']))) {
      const fn = call.childForFieldName('function');
      if (fn?.type === 'selector_expression' && fn.childForFieldName('operand')?.type === 'call_expression') {
        if (!started.some((unit) => unit.symbol === call.text)) started.push({kind: 'loop', symbol: call.text});
      }
    }
    // Plain package-local calls from another file of the same folder: the retention job.
    walkTree(body, (node) => {
      if (node.type !== 'call_expression') return;
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'identifier') return;
      const file = functionFiles.get(fn.text);
      if (file === undefined || file === ownPath) return;
      if (started.some((unit) => unit.symbol === node.text)) return;
      started.push({kind: 'job', symbol: node.text, path: file});
    });
  };

  visitBody(mainBody);
  // The zero-argument local functions `main` calls (`run()`): their bodies start things too.
  for (const call of callsNamed(mainBody, new Set(['run']))) {
    const fn = call.childForFieldName('function');
    if (fn?.type === 'identifier') {
      const runBody = functionBodyOf('run');
      if (runBody !== undefined) visitBody(runBody);
    }
  }
  return started;
}

/** `X := &http.Server{...}` in one tree: the Addr value of the server named X. */
function findServerAddr(node: SyntaxNode, object: string): string | undefined {
  let addr: string | undefined;
  walkTree(node, (held) => {
    if (addr !== undefined || held.type !== 'short_var_declaration') return;
    const left = held.childForFieldName('left')?.namedChild(0)?.text;
    const right = held.childForFieldName('right')?.namedChild(0);
    if (left !== object || right === null || right === undefined) return;
    const composite = right.type === 'composite_literal' ? right : right.namedChild(0);
    if (composite === null || composite === undefined || composite.type !== 'composite_literal') return;
    const body = composite.childForFieldName('body');
    if (body === null) return;
    walkTree(body, (element) => {
      if (element.type !== 'keyed_element' || addr !== undefined) return;
      if (element.childForFieldName('key')?.text === 'Addr') {
        const value = element.childForFieldName('value');
        addr = value?.type === 'identifier' ? value.text : stringValue(value) ?? value?.text;
      }
    });
  });
  return addr;
}
