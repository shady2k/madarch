/**
 * The Go half of the contracts extractor's code reading: the routes a
 * net/http router registers (with the middleware chain each one sits behind,
 * outermost first, and whether the chain carries the auth middleware), the
 * process entry points (a `package main` file's `main`, with what it starts),
 * and the Kafka sites -- a `kafka.Message` write and a `kafka.ReaderConfig`
 * with its topic and consumer group. One file's tree is walked once, inside
 * the read that owns it; the answer is plain data, so the file's joins with
 * the rest of the tree (const values, method declarations) happen later,
 * without a tree.
 */
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {calleeName, spanOf, stringValue, walkTree} from './walk.js';
import type {SourceSpan} from '../../extract/records.js';

/** One route registered on a net/http mux. */
export interface GoRoute {
  readonly method: string;
  readonly path: string;
  /** The handler expression as written (`deps.Orders.Export`). */
  readonly handler: string;
  /** The handler's owner resolved through the field or receiver it comes through (`OrderHandlers.Export`). */
  readonly handlerSymbol: string;
  /** The middleware chain, outermost first, as written. */
  readonly middleware: readonly string[];
  /** Whether the chain carries the auth middleware. */
  readonly authGroup: boolean;
  readonly span: SourceSpan;
}

/** One long-running piece a `main` starts, as the file states it before the package's joins. */
export interface RawStart {
  readonly kind: 'listen' | 'loop' | 'plain-call';
  /** The call text (`relay.New(db, publisher, log, time.Second).Run(ctx)`). */
  readonly text: string;
  /** For a listen: the server variable it went through. */
  readonly serverObject?: string;
  /** For a plain call: the function's own name. */
  readonly fn?: string;
}

/** One Kafka site of a file. */
export interface GoKafkaSite {
  readonly kind: 'publish' | 'consume';
  /** For a consume: the topic expression as written, and the group literal. */
  readonly topic?: string;
  readonly group?: string;
  readonly span: SourceSpan;
}

export interface GoFileFacts {
  readonly path: string;
  readonly packageName: string;
  /** String-valued constants of the file, by name (`OrdersTopic` -> `orders.events`). */
  readonly consts: ReadonlyMap<string, string>;
  /** The struct field types of the file, by field name (`Orders` -> `OrderHandlers`). */
  readonly structFields: ReadonlyMap<string, string>;
  /** The receiver variable each method is declared on (`h` -> `Handler`). */
  readonly receiverNames: ReadonlyMap<string, string>;
  /** Methods declared `(x *T) Name`, as `T.Name`. */
  readonly methods: readonly string[];
  readonly functions: readonly string[];
  /** The functions of the file whose text verifies a token with HS256. */
  readonly hs256Functions: readonly string[];
  /** `X := &http.Server{Addr: ...}`: the server variable and its Addr as written. */
  readonly serverAddrs: ReadonlyMap<string, string>;
  readonly routes: readonly GoRoute[];
  /** A `package main` file whose `main` the process starts with. */
  readonly entryPoint: boolean;
  /** What `main` (and the zero-argument local functions it calls) start, unresolved across the package. */
  readonly rawStarts: readonly RawStart[];
  /** The zero-argument local functions `main` calls, whose bodies hold starts of their own (`run`). */
  readonly mainDelegates: readonly string[];
  /** Methods whose body decides a repeat by comparing a status for equality. */
  readonly statusComparisons: readonly string[];
  /** The string-literal switch cases of each method that carries any (`ApplyPaymentEvent` -> the event kinds). */
  readonly switchCases: ReadonlyMap<string, readonly string[]>;
  /** Whether a loop of this file applies a handler as a statement and then commits, reading only the commit's error. */
  readonly unconditionalCommit: boolean;
  /** The interface methods this file declares (`ApplyPaymentEvent` of PaymentEventHandler). */
  readonly interfaceMethods: readonly string[];
  /** The methods each method of the file calls, by the caller's name. */
  readonly calledMethods: ReadonlyMap<string, readonly string[]>;
  readonly kafkaSites: readonly GoKafkaSite[];
  /** The middleware a `X := Chain(...)` binding names, and whether it authenticates. */
  readonly chainBindings: ReadonlyMap<string, {names: readonly string[]; auth: boolean}>;
  /** The chain of the router's global wrap, when the file returns `Chain(...)(mux)`. */
  readonly globalChain: readonly string[];
}

interface RawRoute {
  method: string;
  path: string;
  handlerText: string;
  wrappedBy?: string;
  span: SourceSpan;
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
  while (held.type === 'call_expression' || held.type === 'parenthesized_expression') {
    if (held.type === 'call_expression') {
      const only = held.childForFieldName('arguments')?.namedChild(0) ?? null;
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
  const receiverNames = new Map<string, string>();
  const methods: string[] = [];
  const functions: string[] = [];
  const hs256Functions: string[] = [];
  const serverAddrs = new Map<string, string>();
  const routes: GoRoute[] = [];
  const kafkaSites: GoKafkaSite[] = [];
  const chainBindings = new Map<string, {names: string[]; auth: boolean}>();
  let globalChain: string[] = [];
  let entryPoint = false;
  const rawStarts: RawStart[] = [];
  const mainDelegates: string[] = [];
  const statusComparisons = new Set<string>();
  const switchCases = new Map<string, string[]>();
  let unconditionalCommit = false;
  const interfaceMethods: string[] = [];
  const rawRoutes: RawRoute[] = [];
  const calledMethods = new Map<string, Set<string>>();

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
      const body = node.childForFieldName('body');
      if (receiverType !== '' && name !== '') methods.push(`${receiverType}.${name}`);
      if (receiverVar !== '' && receiverType !== '') receiverNames.set(receiverVar, receiverType);
      if (body !== null && name !== '') {
        // A method that decides a repeat by comparing a status for equality.
        walkTree(body, (inner) => {
          if (inner.type === 'binary_expression' && inner.childForFieldName('operator')?.text === '==' && /\.Status|Status ==/.test(inner.text)) {
            statusComparisons.add(name);
          }
          // The string-literal switch cases of the method (the event kinds).
          if (inner.type === 'expression_switch_case' || inner.type === 'expression_case') {
            walkTree(inner, (value) => {
              if (value.type !== 'interpreted_string_literal') return;
              const literal = stringValue(value);
              if (literal !== undefined && literal.includes('.')) {
                const heldCases = switchCases.get(name) ?? [];
                if (!heldCases.includes(literal)) switchCases.set(name, [...heldCases, literal]);
              }
            });
          }
          // The methods this one calls, for the guard chain.
          if (inner.type === 'call_expression') {
            const fn = inner.childForFieldName('function');
            const called = fn?.type === 'selector_expression' ? fn.childForFieldName('field')?.text : fn?.type === 'identifier' ? fn.text : undefined;
            if (called !== undefined && called !== name) {
              const held = calledMethods.get(name) ?? new Set<string>();
              held.add(called);
              calledMethods.set(name, held);
            }
          }
        });
      }
      // A function whose text verifies with HS256.
      if (/"HS256"/.test(node.text)) hs256Functions.push(name);
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
        if (inner.type !== 'type_spec') return;
        const name = inner.childForFieldName('name')?.text;
        const body = inner.childForFieldName('type');
        if (name === undefined) return;
        if (body?.type === 'struct_type') {
          walkTree(body, (field) => {
            if (field.type !== 'field_declaration') return;
            const fieldName = field.childForFieldName('name')?.text;
            const fieldType = field.childForFieldName('type')?.text.replace(/^\*+/, '') ?? '';
            if (fieldName !== undefined && fieldType !== '') structFields.set(fieldName, fieldType);
          });
        }
        // The interface methods the file declares.
        if (body?.type === 'interface_type') {
          walkTree(body, (element) => {
            if (element.type !== 'method_element') return;
            const methodName = element.childForFieldName('name')?.text;
            if (methodName !== undefined) interfaceMethods.push(methodName);
          });
        }
      });
      return;
    }
    // `authed := Chain(...)` -- a middleware binding the routes refer to.
    if (node.type === 'short_var_declaration') {
      const left = node.childForFieldName('left')?.namedChild(0)?.text;
      const right = node.childForFieldName('right')?.namedChild(0);
      if (left !== undefined && right !== null && right !== undefined && right.type === 'call_expression' && calleeName(right) === 'Chain') {
        chainBindings.set(left, chainOf(right));
        return;
      }
      // `server := &http.Server{Addr: ...}` -- a server a main starts.
      const rightComposite = right?.type === 'composite_literal' ? right : right?.namedChild(0);
      if (left !== undefined && rightComposite !== null && rightComposite !== undefined && rightComposite.type === 'composite_literal') {
        const typeText = rightComposite.childForFieldName('type')?.text ?? '';
        if (typeText === 'http.Server') {
          const body = rightComposite.childForFieldName('body');
          if (body !== null) {
            walkTree(body, (element) => {
              if (element.type !== 'keyed_element' || serverAddrs.has(left)) return;
              if (element.childForFieldName('key')?.text === 'Addr') {
                const value = element.childForFieldName('value');
                serverAddrs.set(left, value?.type === 'identifier' ? value.text : stringValue(value) ?? value?.text ?? '');
              }
            });
          }
        }
      }
      return;
    }
    // `return Chain(A, B)(mux)` -- the router's global chain.
    if (node.type === 'return_statement') {
      const call = node.namedChild(0);
      if (call !== null && call !== undefined && call.type === 'call_expression') {
        const inner = call.childForFieldName('function');
        if (inner !== null && inner !== undefined && inner.type === 'call_expression' && calleeName(inner) === 'Chain') {
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
      if (pattern !== undefined && handlerNode !== null && handlerNode !== undefined) {
        const space = pattern.indexOf(' ');
        const method = space > 0 ? pattern.slice(0, space) : '';
        const routePath = space > 0 ? pattern.slice(space + 1) : pattern;
        const wrappedBy = handlerNode.type === 'call_expression' ? calleeName(handlerNode) : undefined;
        rawRoutes.push({method, path: routePath, handlerText: unwrappedHandler(handlerNode), wrappedBy, span: spanOf(node, path)});
      }
      return;
    }
    // kafka.Message{...} -- a publish site; kafka.ReaderConfig{...} -- a consume site.
    if (node.type === 'composite_literal') {
      const typeText = node.childForFieldName('type')?.text ?? '';
      if (typeText === 'kafka.Message') {
        kafkaSites.push({kind: 'publish', span: spanOf(node, path)});
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
        kafkaSites.push({kind: 'consume', topic, group, span: spanOf(node, path)});
      }
      return;
    }
    // The consumer loop: the handler applied as a statement, then the commit reading only its own error.
    if (node.type === 'for_statement' && !unconditionalCommit) {
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
      unconditionalCommit = applies && commits;
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
    routes.push({method: raw.method, path: raw.path, handler: raw.handlerText, handlerSymbol, middleware, authGroup: auth, span: raw.span});
  }

  // What main starts, from its own body and the bodies of the zero-argument local functions it calls.
  if (entryPoint) {
    const mainBody = functionBodyOf(root, 'main');
    const bodies: SyntaxNode[] = [];
    if (mainBody !== undefined) bodies.push(mainBody);
    // The zero-argument local functions `main` calls (`run()`): their bodies start things too.
    if (mainBody !== undefined) {
      walkTree(mainBody, (node) => {
        if (node.type !== 'call_expression') return;
        const fn = node.childForFieldName('function');
        if (fn?.type !== 'identifier') return;
        const declaration = functionDeclarationOf(root, fn.text);
        if (declaration === undefined) return;
        const parameterCount = declaration.childForFieldName('parameters')?.namedChildCount ?? 0;
        if (parameterCount !== 0 || mainDelegates.includes(fn.text)) return;
        mainDelegates.push(fn.text);
        const body = declaration.childForFieldName('body');
        if (body !== null) bodies.push(body);
      });
    }
    for (const body of bodies) {
      for (const call of callsNamedIn(body, 'ListenAndServe')) {
        const object = call.childForFieldName('function')?.childForFieldName('operand')?.text;
        rawStarts.push({kind: 'listen', text: call.text, ...(object !== undefined ? {serverObject: object} : {})});
      }
      for (const call of callsNamedIn(body, 'Run')) {
        const fn = call.childForFieldName('function');
        if (fn?.type === 'selector_expression' && fn.childForFieldName('operand')?.type === 'call_expression') {
          rawStarts.push({kind: 'loop', text: call.text});
        }
      }
      walkTree(body, (node) => {
        if (node.type !== 'call_expression') return;
        const fn = node.childForFieldName('function');
        if (fn?.type !== 'identifier') return;
        if (rawStarts.some((start) => start.text === node.text)) return;
        rawStarts.push({kind: 'plain-call', text: node.text, fn: fn.text});
      });
    }
  }

  return {
    path,
    packageName,
    consts,
    structFields,
    receiverNames,
    methods,
    functions,
    hs256Functions,
    serverAddrs,
    routes,
    entryPoint,
    rawStarts,
    mainDelegates,
    statusComparisons: [...statusComparisons].sort(),
    switchCases,
    unconditionalCommit,
    interfaceMethods,
    calledMethods: new Map([...calledMethods].map(([name, called]) => [name, [...called].sort()])),
    kafkaSites,
    chainBindings,
    globalChain,
  };
}

// ---- small local helpers ----------------------------------------------------

/** The body of one named function declaration of the tree. */
function functionBodyOf(root: SyntaxNode, name: string): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walkTree(root, (node) => {
    if (found !== undefined || node.type !== 'function_declaration') return;
    if (node.childForFieldName('name')?.text === name) found = node.childForFieldName('body') ?? undefined;
  });
  return found;
}

function functionDeclarationOf(root: SyntaxNode, name: string): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walkTree(root, (node) => {
    if (found !== undefined || node.type !== 'function_declaration') return;
    if (node.childForFieldName('name')?.text === name) found = node;
  });
  return found;
}

function callsNamedIn(body: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  walkTree(body, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    const object = fn?.type === 'selector_expression' ? fn.childForFieldName('field')?.text : fn?.type === 'identifier' ? fn.text : undefined;
    if (object === name) out.push(node);
  });
  return out;
}

/** Joins one file's raw starts across its package: ports from the package's consts and server addresses, jobs from the package's files. */
export function resolveGoStarts(
  files: readonly {path: string; go: GoFileFacts}[],
  ownPath: string,
): {kind: string; symbol: string; path?: string; port?: string}[] {
  const consts = new Map<string, string>();
  const functionFiles = new Map<string, string>();
  const serverAddrs = new Map<string, string>();
  for (const file of files) {
    for (const [name, value] of file.go.consts) if (!consts.has(name)) consts.set(name, value);
    for (const [name, value] of file.go.serverAddrs) if (!serverAddrs.has(name)) serverAddrs.set(name, value);
    for (const name of file.go.functions) if (!functionFiles.has(name)) functionFiles.set(name, file.path);
  }
  const out: {kind: string; symbol: string; path?: string; port?: string}[] = [];
  for (const start of files.find((file) => file.path === ownPath)!.go.rawStarts) {
    if (start.kind === 'listen') {
      const addr = start.serverObject !== undefined ? serverAddrs.get(start.serverObject) : undefined;
      const port = addr !== undefined ? (consts.get(addr) ?? addr).replace(/^:/, '') : undefined;
      out.push({kind: 'http-server', symbol: start.text, ...(port !== undefined && port !== '' ? {port} : {})});
      continue;
    }
    if (start.kind === 'loop') {
      out.push({kind: 'loop', symbol: start.text});
      continue;
    }
    const file = start.fn !== undefined ? functionFiles.get(start.fn) : undefined;
    if (file === undefined || file === ownPath) continue;
    out.push({kind: 'job', symbol: start.text, path: file});
  }
  return out;
}

/** Whether the handler method the consumer names decides repeats by a status comparison. */
export function duplicatesByStatusComparison(
  files: readonly {go: GoFileFacts}[],
  handlerName: string,
): boolean {
  const called = new Set<string>();
  for (const file of files) {
    for (const name of file.go.calledMethods.get(handlerName) ?? []) called.add(name);
  }
  for (const file of files) {
    if (file.go.statusComparisons.some((name) => called.has(name))) return true;
  }
  return false;
}
