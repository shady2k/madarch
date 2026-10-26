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
import type {CodeExpressionFact} from '../code/facts.js';
import type {TreeText} from '../operations/source.js';
import {libraryRegistry} from '../library-models/validate.js';
import {messagingTypes} from '../library-models/messaging-models.js';

/** One route registered on a net/http mux. */
export interface GoRoute {
  readonly method: string;
  readonly path: string;
  /** The handler expression as written (`deps.Orders.Export`). */
  readonly handler: string;
  /** The handler's owner resolved through the field or receiver it comes through (`OrderHandlers.Export`). */
  readonly handlerSymbol: string;
  readonly handlerSpan: SourceSpan;
  readonly inline: boolean;
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
  /** Decoded channel proved by the shared lexical binding, never a service-name lookup. */
  readonly channel?: string;
  readonly group?: string;
  /** Reads through the exact declared Kafka Reader field, when that association is proved. */
  readonly reads?: readonly SourceSpan[];
  readonly readerOwner?: string;
  readonly readerField?: string;
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
  /** Whether a loop of this file applies a handler as a statement and then commits the reader it reads, reading only the commit's error. */
  readonly unconditionalCommit: boolean;
  /** The interface methods this file declares (`ApplyPaymentEvent` of PaymentEventHandler). */
  readonly interfaceMethods: readonly string[];
  /** The methods each method of the file calls, by the caller's name. */
  readonly calledMethods: ReadonlyMap<string, readonly string[]>;
  readonly kafkaSites: readonly GoKafkaSite[];
  /** Consumer reads through a reader field this file declares as a type of the package it imports. */
  readonly kafkaReads: readonly {owner: string; field: string; span: SourceSpan}[];
  /** The middleware a `X := Chain(...)` binding names, and whether it authenticates. */
  readonly chainBindings: ReadonlyMap<string, {names: readonly string[]; auth: boolean}>;
  /** The chain of the router's global wrap, when the file returns `Chain(...)(mux)`. */
  readonly globalChain: readonly string[];
}

interface RawRoute {
  method: string;
  path: string;
  handlerText: string;
  handlerSpan: SourceSpan;
  inline: boolean;
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
      if (arg === null || arg.type === ',' || arg.type === '(' || arg.type === ')') continue;
      if (arg.type === 'call_expression') {
        const name = calleeName(arg) ?? arg.text;
        const first = arg.childForFieldName('arguments')?.namedChild(0) ?? null;
        const literal = stringValue(first);
        const shown = literal !== undefined ? `${name}("${literal}")` : name;
        names.push(shown);
        if (name === 'RequireAuth') auth = true;
        continue;
      }
      // A middleware value without its own call (`deps.Metrics.Count`).
      names.push(arg.text);
    }
  }
  return {names, auth};
}

/** The handler expression at the bottom of middleware wrappers (`authed(http.HandlerFunc(h))` -> h). */
function unwrappedHandler(node: SyntaxNode): SyntaxNode {
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
  // A literal handler has no name to carry; the property stays small.
  return held;
}

// ---- the library data a consumer read is proved from ------------------------

/**
 * The consumer methods the library data registers, per declaring package: the
 * models whose receiver role is `message-consumer`. A consumer read is
 * recognised from these names, never from a list written in this file.
 */
const consumerMemberModels: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const members = new Map<string, Set<string>>();
  for (const model of libraryRegistry.models) {
    if (model.ecosystem !== 'go' || model.invoke !== 'call' || model.target.kind !== 'member' || model.target.receiverRole !== 'message-consumer') continue;
    const held = members.get(model.package) ?? new Set<string>();
    held.add(model.target.member);
    members.set(model.package, held);
  }
  return members;
})();

/** Every registered consumer method, whichever package declares it. */
const consumerMethods: ReadonlySet<string> = new Set([...consumerMemberModels.values()].flatMap((members) => [...members]));

/**
 * The commit method of a consumer reader. The library data models a consumer's
 * reads but not its commit, so the name stands here: the registry needs a
 * `kafka-go.Reader.CommitMessages` member model of the `message-consumer`
 * receiver role before it can be read from the data. What a commit is is still
 * decided from grammar nodes, never from the text of a statement.
 */
const offsetCommitMember = 'CommitMessages';

/** The Go package name each documented package declares, for an import written without an alias. */
const declaredGoPackageNames: ReadonlyMap<string, string> = new Map(
  messagingTypes.flatMap((model) => model.ecosystem === 'go' && model.packageName !== undefined ? [[model.package, model.packageName] as const] : []),
);

/** The name a Go file binds an import under: its alias, the documented package name, or the path's tail. */
function goImportLocalName(specifier: string, alias: string | undefined): string {
  if (alias !== undefined) return alias;
  const declared = declaredGoPackageNames.get(specifier);
  if (declared !== undefined) return declared;
  const parts = specifier.split('/').filter((part) => part !== '');
  return parts.length === 0 ? specifier : parts[parts.length - 1]!;
}

export function readGoFile(path: string, root: SyntaxNode, source?: TreeText): GoFileFacts {
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
  const kafkaReads: {owner: string; field: string; span: SourceSpan}[] = [];
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

  // The consumer namespaces this file binds (`import stream ".../kafka-go"`),
  // each with the methods the library data registers for its package.
  const consumerNamespaces = new Map<string, ReadonlySet<string>>();
  // The declared type of each struct field of this file, read once from the tree
  // the read owns: a struct declared in another file of the package stays
  // unknown here, and a read through its field is never claimed.
  let structFieldTypes: Map<string, Map<string, {qualifier?: string; name: string}>> | undefined;
  const fieldTypeOf = (owner: string, field: string): {qualifier?: string; name: string} | undefined => {
    if (structFieldTypes === undefined) {
      const collected = new Map<string, Map<string, {qualifier?: string; name: string}>>();
      walkTree(root, (node) => {
        if (node.type !== 'type_spec') return;
        const name = node.childForFieldName('name')?.text;
        const body = node.childForFieldName('type');
        if (name === undefined || body === null || body.type !== 'struct_type') return;
        const fields = collected.get(name) ?? new Map<string, {qualifier?: string; name: string}>();
        walkTree(body, (declared) => {
          if (declared.type !== 'field_declaration') return;
          const fieldName = declared.childForFieldName('name')?.text;
          const written = declared.childForFieldName('type');
          if (fieldName === undefined || written === null) return;
          const element = written.type === 'pointer_type' ? written.namedChild(0) : written;
          if (element === null) return;
          // A qualified type names the namespace its package is bound under here.
          const qualifier = element.type === 'qualified_type' ? element.childForFieldName('package')?.text : undefined;
          fields.set(fieldName, {...(qualifier !== undefined ? {qualifier} : {}), name: element.childForFieldName('name')?.text ?? element.text});
        });
        collected.set(name, fields);
      });
      structFieldTypes = collected;
    }
    return structFieldTypes.get(owner)?.get(field);
  };
  /**
   * The reader a consumer call goes through, when the callee is a selector on a
   * field this file declares as a type of a consumer namespace: the field's
   * owner, the field, the member called, and the methods that namespace binds.
   * Every part is a grammar node, so the same call with spaces around its dots
   * is the same call; the method names come from the library data.
   */
  const readerCallOf = (call: SyntaxNode): {owner: string; field: string; member: string; members: ReadonlySet<string>} | undefined => {
    if (consumerNamespaces.size === 0 || call.type !== 'call_expression') return undefined;
    const fn = call.childForFieldName('function');
    if (fn === null || fn.type !== 'selector_expression') return undefined;
    const operand = fn.childForFieldName('operand');
    const member = fn.childForFieldName('field');
    if (operand === null || operand.type !== 'selector_expression' || member === null || member.type !== 'field_identifier') return undefined;
    const base = operand.childForFieldName('operand');
    const field = operand.childForFieldName('field');
    if (base === null || base.type !== 'identifier' || field === null || field.type !== 'field_identifier') return undefined;
    const owner = receiverNames.get(base.text);
    if (owner === undefined) return undefined;
    const declared = fieldTypeOf(owner, field.text);
    const members = declared === undefined || declared.qualifier === undefined ? undefined : consumerNamespaces.get(declared.qualifier);
    return members === undefined ? undefined : {owner, field: field.text, member: member.text, members};
  };

  walkTree(root, (node) => {
    // A function whose text verifies a token with HS256 (`jwt.WithValidMethods([]string{"HS256"})`).
    if ((node.type === 'function_declaration' || node.type === 'method_declaration') && /['"]HS256['"]/.test(node.text)) {
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) hs256Functions.push(name);
    }
    // `import stream "github.com/segmentio/kafka-go"`: the local name the consumer
    // package's namespace is bound under in this file, and the methods it declares.
    if (node.type === 'import_spec') {
      const specifier = stringValue(node.childForFieldName('path'));
      const named = node.childForFieldName('name');
      const members = specifier === undefined ? undefined : consumerMemberModels.get(specifier);
      const local = specifier === undefined ? undefined : goImportLocalName(specifier, named === null ? undefined : named.text);
      // A dot or blank import binds no name, so no read reaches the package through it.
      if (members !== undefined && local !== undefined && local !== '.' && local !== '_') consumerNamespaces.set(local, members);
      return;
    }
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
      return;
    }
    // One const spec per line here; a const block carries several. The value
    // field is an expression list; its single element is the literal.
    if (node.type === 'const_spec') {
      const name = node.childForFieldName('name')?.text;
      const value = node.childForFieldName('value')?.namedChild(0) ?? null;
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
            if (element.type !== 'method_spec' && element.type !== 'method_element') return;
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
      // `server := &http.Server{Addr: ...}` -- a server a main starts. The right
      // side is found by its text, whatever the parse wraps around it.
      if (left !== undefined && !serverAddrs.has(left)) {
        const rightNode = node.childForFieldName('right');
        const rightText = rightNode?.text ?? '';
        if (rightText.includes('http.Server{')) {
          const addrMatch = /Addr:\s*([A-Za-z0-9_.":]+)/.exec(rightText);
          if (addrMatch !== null) serverAddrs.set(left, addrMatch[1]!);
        }
      }
      return;
    }
    // `return Chain(A, B)(mux)` -- the router's global chain. The return's
    // value is an expression list; its element is the wrapped call.
    if (node.type === 'return_statement') {
      const listed = node.namedChild(0);
      const call = listed?.type === 'expression_list' ? listed.namedChild(0) : listed;
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
        const handler = unwrappedHandler(handlerNode);
        rawRoutes.push({method, path: routePath, handlerText: handler.text, handlerSpan: spanOf(handler, path), inline: handler.type === 'func_literal', wrappedBy, span: spanOf(node, path)});
      }
      return;
    }
    // A consumer read: a call of a method the reader's library data declares,
    // through a field this file declares as a type of that package's namespace.
    if (node.type === 'call_expression') {
      const reader = readerCallOf(node);
      if (reader !== undefined && reader.members.has(reader.member)) {
        kafkaReads.push({owner: reader.owner, field: reader.field, span: spanOf(node, path)});
      }
    }
    // The consumer loop: a read through its reader, the handler applied as a
    // statement, then the commit of that same reader, read only for its own
    // error. The commit is decided from grammar nodes: the if statement's own
    // deciding parts -- its initializer and its condition, never its blocks --
    // hold a call of the commit member on the reader the loop reads.
    if (node.type === 'for_statement' && !unconditionalCommit) {
      const body = node.childForFieldName('body');
      if (body === null) return;
      const readers = new Set<string>();
      let applies = false;
      let commits = false;
      for (let i = 0; i < body.childCount; i++) {
        const statement = body.child(i);
        if (statement === null) continue;
        // What the loop reads through a proved consumer reader, wherever the read stands.
        walkTree(statement, (inner) => {
          const read = readerCallOf(inner);
          if (read !== undefined && read.members.has(read.member)) readers.add(`${read.owner}.${read.field}`);
        });
        if (statement.type === 'expression_statement') {
          const call = statement.namedChild(0);
          const name = call !== null && call.type === 'call_expression' ? calleeName(call) : undefined;
          // A read or a commit is no application of a handler.
          if (name !== undefined && !consumerMethods.has(name) && name !== offsetCommitMember) applies = true;
        }
        if (statement.type === 'if_statement') {
          for (const deciding of statement.namedChildren) {
            // The blocks are what the if does, not what decides it.
            if (deciding === null || deciding.type === 'block') continue;
            walkTree(deciding, (inner) => {
              if (commits) return;
              const commit = readerCallOf(inner);
              if (commit === undefined || commit.member !== offsetCommitMember) return;
              // The reader the loop reads; when the read stands in a function of
              // its own, any consumer reader proved from this file's receiver.
              if (readers.size === 0 || readers.has(`${commit.owner}.${commit.field}`)) commits = true;
            });
          }
        }
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
    routes.push({method: raw.method, path: raw.path, handler: raw.handlerText, handlerSymbol, handlerSpan: raw.handlerSpan, inline: raw.inline, middleware, authGroup: auth, span: raw.span});
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
    kafkaSites: source === undefined ? kafkaSites : structuralGoReaders(source, path),
    kafkaReads,
    chainBindings,
    globalChain,
  };
}

/** Kafka reader configuration from the shared tree copy. No source text is parsed here. */
export function structuralGoReaders(source: TreeText, path: string): GoKafkaSite[] {
  const facts = source.facts;
  const gap = (span: SourceSpan, detail: string): void => source.factGap(path,
    `contracts: line ${span.lineStart}: ${detail} (${path}); bytes ${span.byteStart}-${span.byteEnd}`);
  if (facts === undefined || !facts.files.some(file => file.path === path && file.language === 'go' && file.parsed)) {
    gap(source.spanOfFile(path), 'Kafka reader configuration requires shared parsed code facts');
    return [];
  }
  const unique = <T>(values: readonly T[]): T | undefined => values.length === 1 ? values[0] : undefined;
  const contains = (outer: SourceSpan, inner: SourceSpan): boolean => outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;
  const same = (a: SourceSpan, b: SourceSpan): boolean => contains(a, b) && contains(b, a);
  // A duplicate identity is unknown, never a last-writer-wins replacement.
  const index = <T>(values: readonly T[], key: (value: T) => string): Map<string, T> => {
    const result = new Map<string, T>(); const duplicated = new Set<string>();
    for (const value of values) {
      const id = key(value);
      if (result.has(id) || duplicated.has(id)) { result.delete(id); duplicated.add(id); }
      else result.set(id, value);
    }
    return result;
  };
  const expressions = index(facts.expressions.filter(node => node.path === path), node => node.id);
  const bindings = index(facts.bindings.filter(binding => binding.path === path), binding => binding.id);
  const imports = index(facts.imports.filter(imported => imported.path === path), imported => imported.id);
  const expression = (id: string | undefined): CodeExpressionFact | undefined => {
    const node = id === undefined ? undefined : expressions.get(id);
    return node !== undefined && node.span.path === path ? node : undefined;
  };
  const children = (node: CodeExpressionFact): CodeExpressionFact[] | undefined => {
    const result: CodeExpressionFact[] = []; let end = node.span.byteStart;
    for (const id of node.children) {
      const child = expression(id);
      if (child === undefined || !contains(node.span, child.span) || child.span.byteStart < end) return undefined;
      end = child.span.byteEnd;
      if (child.syntaxKind !== 'comment') result.push(child);
    }
    return result;
  };
  const field = (node: CodeExpressionFact, name: string): CodeExpressionFact | undefined => {
    const child = expression(unique(node.fields[name] ?? []));
    return child !== undefined && node.children.includes(child.id) && contains(node.span, child.span) ? child : undefined;
  };
  const written = new Set<string>();
  const writeTargets: CodeExpressionFact[] = [];
  const mark = (node: CodeExpressionFact): void => {
    if (node.bindingId !== undefined) written.add(node.bindingId);
    writeTargets.push(node);
    for (const child of children(node) ?? []) mark(child);
  };
  for (const node of expressions.values()) {
    if (node.syntaxKind === 'assignment_statement') for (const id of node.fields.left ?? []) {
      const target = expression(id); if (target !== undefined) mark(target);
    }
    if (node.syntaxKind === 'inc_statement' || node.syntaxKind === 'dec_statement') mark(node);
    if (node.syntaxKind === 'short_var_declaration') {
      const left = field(node, 'left');
      for (const target of left === undefined ? [] : children(left) ?? []) {
        const binding = target.bindingId === undefined ? undefined : bindings.get(target.bindingId);
        if (binding !== undefined && !same(binding.span, target.span)) mark(target);
      }
    }
  }
  const bindingOf = (node: CodeExpressionFact) => {
    const binding = node.bindingId === undefined ? undefined : bindings.get(node.bindingId);
    return binding !== undefined && contains(binding.scope, node.span) && !written.has(binding.id) &&
      (binding.kind !== 'local' || binding.span.byteStart <= node.span.byteStart) ? binding : undefined;
  };
  const unwrap = (raw: CodeExpressionFact, seen = new Set<string>()): CodeExpressionFact | undefined => {
    if (seen.has(raw.id) || seen.size >= 80) return undefined;
    seen.add(raw.id);
    if (['literal_element', 'parenthesized_expression', 'expression_list'].includes(raw.syntaxKind)) {
      const child = unique(children(raw) ?? []); return child === undefined ? undefined : unwrap(child, seen);
    }
    if (raw.bindingId !== undefined) {
      const binding = bindingOf(raw);
      if (binding === undefined) return undefined;
      if (binding.kind === 'local') {
        const initial = expression(binding.initializer);
        return initial === undefined ? undefined : unwrap(initial, seen);
      }
    }
    return raw;
  };
  const literal = (raw: CodeExpressionFact | undefined): string | undefined => {
    const node = raw === undefined ? undefined : unwrap(raw);
    return node?.literal?.kind === 'string' && typeof node.literal.value === 'string' ? node.literal.value : undefined;
  };
  const readerModel = unique(libraryRegistry.models.filter(model => model.id === 'kafka-go.NewReader' && model.ecosystem === 'go' && model.returnRole === 'message-consumer'));
  // The methods the reader's package declares, from the data that declares them.
  const readerMembers = readerModel === undefined ? undefined : consumerMemberModels.get(readerModel.package);
  const importedMember = (node: CodeExpressionFact | undefined, member: string): boolean => {
    if (node === undefined || !['qualified_type', 'selector_expression'].includes(node.syntaxKind)) return false;
    const receiver = field(node, node.syntaxKind === 'qualified_type' ? 'package' : 'operand');
    const property = field(node, node.syntaxKind === 'qualified_type' ? 'name' : 'field');
    const binding = receiver === undefined ? undefined : bindingOf(receiver);
    const imported = binding?.importId === undefined ? undefined : imports.get(binding.importId);
    return property?.name === member && node.member === member && node.receiver === receiver?.id &&
      binding?.kind === 'import' && readerModel !== undefined && imported?.specifier === readerModel.package &&
      imported.imported.form === 'namespace' && imported.targetPath === undefined && imported.typeOnly !== true;
  };
  const entryPair = (entry: CodeExpressionFact): {key: CodeExpressionFact; value: CodeExpressionFact} | undefined => {
    if (entry.syntaxKind !== 'keyed_element') return undefined;
    let key = field(entry, 'key'); let value = field(entry, 'value');
    if (entry.fields.key === undefined && entry.fields.value === undefined) {
      const operands = children(entry);
      if (operands?.length !== 2 || operands.some(node => node.syntaxKind !== 'literal_element')) return undefined;
      [key, value] = operands;
    }
    if (key?.syntaxKind === 'literal_element') key = unique(children(key) ?? []);
    return key === undefined || value === undefined ? undefined : {key, value};
  };
  const property = (node: CodeExpressionFact, name: string): CodeExpressionFact | undefined => {
    const body = field(node, 'body'); const entries = body === undefined ? undefined : children(body);
    if (entries === undefined) return undefined;
    const pairs = entries.map(entryPair);
    if (pairs.some(pair => pair === undefined)) return undefined;
    return unique(pairs.filter(pair => pair?.key.name === name).flatMap(pair => pair === undefined ? [] : [pair.value]));
  };
  const calls = facts.calls.filter(call => call.path === path && expression(call.expression)?.callee === call.callee &&
    same(expression(call.expression)!.span, call.span));
  const configs = [...expressions.values()].filter(node => node.syntaxKind === 'composite_literal' && importedMember(field(node, 'type'), 'ReaderConfig'));
  const sites: GoKafkaSite[] = [];
  for (const config of configs) {
    const topic = property(config, 'Topic'); const channel = literal(topic);
    if (channel === undefined) { gap(topic?.span ?? config.span, 'Kafka reader topic is unresolved; no consumption claimed'); continue; }
    const reads: SourceSpan[] = [];
    // A constructor's returned struct can lend its declared Reader field to
    // methods. Both ends must carry that exact declaration identity.
    const readerCalls = calls.filter(call => {
      const argument = expression(call.arguments[0]);
      return importedMember(expression(call.callee), 'NewReader') && call.arguments.length === 1 &&
        argument !== undefined && unwrap(argument)?.id === config.id;
    });
    const declaredFields = (facts.fields ?? []).filter(declared => declared.path === path);
    for (const composite of expressions.values()) {
      const declaration = composite.compositeType?.declarationExpression;
      if (composite.syntaxKind !== 'composite_literal' || declaration === undefined ||
        ![...expressions.values()].some(node => node.syntaxKind === 'return_statement' && contains(node.span, composite.span))) continue;
      const body = field(composite, 'body');
      for (const entry of body === undefined ? [] : children(body) ?? []) {
        const pair = entryPair(entry); const value = pair === undefined ? undefined : unwrap(pair.value);
        if (pair === undefined || value === undefined || !readerCalls.some(call => call.expression === value.id)) continue;
        const declared = unique(declaredFields.filter(held => held.ownerDeclaration === declaration && held.name === pair.key.name));
        let type = declared === undefined ? undefined : expression(declared.typeExpression);
        if (type?.syntaxKind !== 'pointer_type') continue;
        type = unique(children(type) ?? []);
        if (declared === undefined || !importedMember(type, 'Reader')) continue;
        const references = facts.sites.filter(site => site.path === path && site.use === 'reference' && site.to === declared.key);
        if (writeTargets.some(target => references.some(site => contains(target.span, site.span)))) continue;
        for (const call of calls) {
          const callee = expression(call.callee);
          if (callee?.syntaxKind !== 'selector_expression' || readerMembers?.has(callee.member ?? '') !== true) continue;
          const receiver = field(callee, 'operand'); const member = receiver === undefined ? undefined : field(receiver, 'field');
          if (member !== undefined && references.some(site => same(site.span, member.span)) && !reads.some(span => same(span, call.span))) reads.push(call.span);
        }
      }
    }
    if (reads.length === 0) gap(config.span, 'Kafka reader configuration is proved but its consuming function association is unresolved');
    reads.sort((a, b) => a.byteStart - b.byteStart || a.byteEnd - b.byteEnd);
    sites.push({kind: 'consume', topic: JSON.stringify(channel), channel, group: literal(property(config, 'GroupID')), reads, span: config.span});
  }
  return sites;
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
