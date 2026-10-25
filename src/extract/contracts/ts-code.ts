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

/** One Kafka send the file makes. */
export interface TsSend {
  /** Direct imported producer or locally proved wrapper; false is an unresolved site, not a publication fact. */
  readonly receiverGrounded: boolean;
  readonly receiverMessagingEvidence: boolean;
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
  readonly listenerPorts: readonly string[];
  readonly sends: readonly TsSend[];
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

/** Resolve direct imported producer types and locally implemented messaging wrappers.
 * No receiver is inferred from its spelling. Unsupported aliases or bindings stay unresolved.
 */
function messagingReceiver(call: SyntaxNode, root: SyntaxNode): boolean {
  const named = (node: SyntaxNode): SyntaxNode[] => node.namedChildren.filter((child): child is SyntaxNode => child !== null);
  const fn = call.childForFieldName('function');
  const receiver = fn?.type === 'member_expression' ? fn.childForFieldName('object')?.text : undefined;
  if (receiver === undefined) return false;
  const imports = new Map<string, string>();
  for (const statement of named(root)) {
    if (statement.type !== 'import_statement' || statement.childForFieldName('source')?.text.slice(1, -1) !== 'kafkajs') continue;
    walkTree(statement, (node) => {
      if (node.type !== 'import_specifier') return;
      const name = node.childForFieldName('name');
      if (name === null || !['Producer', 'Kafka'].includes(name.text)) return;
      imports.set(node.childForFieldName('alias')?.text ?? name.text, name.text);
    });
  }
  const typeOf = (node: SyntaxNode): string | undefined => node.childForFieldName('type')?.text.replace(/^:\s*/, '').trim();
  const nameOf = (node: SyntaxNode): string | undefined => node.childForFieldName('pattern')?.text ?? node.childForFieldName('name')?.text;
  const shadowsImport = (at: SyntaxNode, name: string): boolean => {
    let scope: SyntaxNode | null = at;
    while (scope !== null) {
      const parameters = scope.childForFieldName('type_parameters');
      if (parameters !== null && named(parameters).some((parameter) => parameter.childForFieldName('name')?.text === name || parameter.text === name)) return true;
      const values = scope.childForFieldName('parameters');
      if (values !== null && named(values).some((parameter) => nameOf(parameter) === name)) return true;
      for (const child of named(scope).flatMap((statement) => statement.type === 'export_statement' ? named(statement) : [statement])) {
        if (['class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'function_declaration'].includes(child.type) && child.childForFieldName('name')?.text === name) return true;
        if (['lexical_declaration', 'variable_declaration'].includes(child.type) && named(child).some((declaration) => declaration.childForFieldName('name')?.text === name)) return true;
      }
      scope = scope.parent;
    }
    return false;
  };
  const producerType = (declaration: SyntaxNode): boolean => {
    const type = typeOf(declaration);
    return type !== undefined && imports.get(type) === 'Producer' && !shadowsImport(call, type);
  };
  const classOf = (node: SyntaxNode): SyntaxNode | null => {
    let owner: SyntaxNode | null = node.parent;
    while (owner !== null && owner.type !== 'class_declaration') owner = owner.parent;
    return owner;
  };
  const fieldsOf = (owner: SyntaxNode): SyntaxNode[] => {
    const body = owner.childForFieldName('body');
    if (body === null) return [];
    const members = named(body);
    const fields = members.filter((member) => member.type === 'public_field_definition');
    for (const member of members) {
      if (member.type !== 'method_definition' || member.childForFieldName('name')?.text !== 'constructor') continue;
      const parameters = member.childForFieldName('parameters');
      if (parameters === null) continue;
      for (const parameter of named(parameters)) {
        if (parameter.children.some((child) => child !== null && (child.type === 'accessibility_modifier' || child.type === 'readonly'))) fields.push(parameter);
      }
    }
    return fields;
  };
  const implementedWrappers = new Set<string>();
  // A wrapper signature alone is insufficient. A local implementing class must
  // delegate send to its real Producer field and construct a Kafka producer.
  for (const owner of named(root).flatMap((statement) => statement.type === 'export_statement' ? named(statement) : [statement])) {
    if (owner.type !== 'class_declaration') continue;
    const fields = fieldsOf(owner).filter(producerType);
    if (fields.length === 0) continue;
    const body = owner.childForFieldName('body');
    const send = body === null ? undefined : named(body).find((member) => member.type === 'method_definition' && member.childForFieldName('name')?.text === 'send');
    if (send === undefined) continue;
    let delegated = false;
    const producedBindings: {name: string; method: number}[] = [];
    const wrapperCalls: {arguments: string[]; method: number}[] = [];
    const methodOf = (node: SyntaxNode): number | null => {
      let method: SyntaxNode | null = node.parent;
      while (method !== null && method.type !== 'method_definition' && method.type !== 'function_declaration') method = method.parent;
      return method?.startIndex ?? null;
    };
    const className = owner.childForFieldName('name')?.text;
    const constructor = body === null ? undefined : named(body).find((member) => member.type === 'method_definition' && member.childForFieldName('name')?.text === 'constructor');
    const constructorParameters = constructor?.childForFieldName('parameters');
    const producerIndexes = constructorParameters == null ? [] : named(constructorParameters).flatMap((parameter, index) => fields.some((field) => field.startIndex === parameter.startIndex) ? [index] : []);
    walkTree(owner, (node) => {
      // Reject evidence from a nested class or another receiver's field.
      if (classOf(node)?.startIndex !== owner.startIndex) return;
      if (node.type === 'new_expression') {
        const constructedType = node.childForFieldName('constructor')?.text;
        const method = methodOf(node);
        if (constructedType !== undefined && imports.get(constructedType) === 'Kafka' && !shadowsImport(node, constructedType)) {
          const parent = node.parent;
          const factoryCall = parent?.type === 'member_expression' && parent.childForFieldName('property')?.text === 'producer' ? parent.parent : null;
          const binding = factoryCall?.type === 'call_expression' ? factoryCall.parent : null;
          const name = binding?.type === 'variable_declarator' ? binding.childForFieldName('name')?.text : undefined;
          if (name !== undefined && method !== null) producedBindings.push({name, method});
        }
        if (constructedType === className && method !== null) {
          const argumentsNode = node.childForFieldName('arguments');
          if (argumentsNode !== null) wrapperCalls.push({arguments: named(argumentsNode).map((argument) => argument.text), method});
        }
      }
      if (node.type !== 'call_expression' || node.startIndex < send.startIndex || node.endIndex > send.endIndex) return;
      const target = node.childForFieldName('function');
      if (target?.type !== 'member_expression' || target.childForFieldName('property')?.text !== 'send') return;
      const object = target.childForFieldName('object')?.text;
      if (!fields.some((field) => object === `this.${nameOf(field)}`)) return;
      const argument = node.childForFieldName('arguments')?.namedChild(0);
      if (argument?.type !== 'object') return;
      const keys = named(argument).map((property) => property.type === 'shorthand_property_identifier' ? property.text : property.childForFieldName('key')?.text);
      delegated ||= keys.includes('topic') && keys.includes('messages');
    });
    const constructed = wrapperCalls.some((call) => producerIndexes.some((index) => producedBindings.some((binding) => binding.method === call.method && call.arguments[index] === binding.name)));
    if (!delegated || !constructed) continue;
    const heritage = named(owner).find((child) => child.type === 'class_heritage');
    if (heritage === undefined) continue;
    for (const clause of named(heritage)) if (clause.type === 'implements_clause') for (const name of named(clause)) implementedWrappers.add(name.text);
  }
  const accepts = (declaration: SyntaxNode): boolean => {
    const type = typeOf(declaration);
    if (producerType(declaration)) return true;
    if (type === undefined || !implementedWrappers.has(type)) return false;
    let scope: SyntaxNode | null = call.parent;
    while (scope !== null && scope.type !== 'program') {
      const parameters = scope.childForFieldName('type_parameters');
      if (parameters !== null && named(parameters).some((parameter) => parameter.childForFieldName('name')?.text === type || parameter.text === type)) return false;
      if (named(scope).some((child) => ['interface_declaration', 'class_declaration', 'type_alias_declaration'].includes(child.type) && child.childForFieldName('name')?.text === type)) return false;
      scope = scope.parent;
    }
    return true;
  };
  if (receiver.startsWith('this.')) {
    const owner = classOf(call);
    return owner !== null && fieldsOf(owner).some((field) => nameOf(field) === receiver.slice(5) && accepts(field));
  }
  // The nearest binding wins. A local variable or function parameter shadows an
  // outer producer even if the unrelated binding has the same spelling.
  let enclosing: SyntaxNode | null = call.parent;
  while (enclosing !== null) {
    const parameters = enclosing.childForFieldName('parameters');
    if (parameters !== null) for (const parameter of named(parameters)) if (nameOf(parameter) === receiver) return accepts(parameter);
    if (enclosing.type === 'statement_block' || enclosing.type === 'program') for (const statement of named(enclosing)) {
      if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') continue;
      for (const declaration of named(statement)) if (declaration.type === 'variable_declarator' && nameOf(declaration) === receiver) {
        if (accepts(declaration)) return true;
        const value = declaration.childForFieldName('value');
        const target = value?.type === 'call_expression' ? value.childForFieldName('function') : null;
        if (target?.type !== 'member_expression' || target.childForFieldName('property')?.text !== 'producer') return false;
        let constructed = target.childForFieldName('object');
        if (constructed?.type === 'parenthesized_expression') constructed = constructed.namedChild(0);
        if (constructed?.type !== 'new_expression') return false;
        const constructor = constructed.childForFieldName('constructor')?.text;
        return constructor !== undefined && imports.get(constructor) === 'Kafka' && !shadowsImport(constructed, constructor);
      }
    }
    enclosing = enclosing.parent;
  }
  return false;
}

/** A located unresolved site is reported only for an explicit messaging type. */
function messagingTypeEvidence(call: SyntaxNode, root: SyntaxNode): boolean {
  const fn = call.childForFieldName('function');
  const receiver = fn?.type === 'member_expression' ? fn.childForFieldName('object')?.text : undefined;
  if (receiver === undefined) return false;
  const names = new Set<string>();
  walkTree(root, (node) => {
    if (node.type === 'interface_declaration' && /\bsend\s*\(\s*topic\s*:\s*string\s*,\s*key\s*:\s*string\s*,\s*value\s*:\s*string\s*\)/.test(node.text)) {
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) names.add(name);
    }
    if (node.type !== 'import_statement' || node.childForFieldName('source')?.text.slice(1, -1) !== 'kafkajs') return;
    walkTree(node, (specifier) => {
      if (specifier.type !== 'import_specifier' || specifier.childForFieldName('name')?.text !== 'Producer') return;
      names.add(specifier.childForFieldName('alias')?.text ?? 'Producer');
    });
  });
  let scope: SyntaxNode | null = call.parent;
  while (scope !== null) {
    const parameters = scope.childForFieldName('parameters');
    if (parameters !== null) for (const parameter of parameters.namedChildren) {
      if (parameter === null || (parameter.childForFieldName('pattern')?.text ?? parameter.childForFieldName('name')?.text) !== receiver) continue;
      const type = parameter.childForFieldName('type')?.text.replace(/^:\s*/, '').trim();
      return type !== undefined && names.has(type);
    }
    scope = scope.parent;
  }
  return false;
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
      // A Kafka send.
      if (calleeName(node) === 'send') {
        const args = node.childForFieldName('arguments');
        const topicArg = args?.namedChild(0);
        if (topicArg !== null && topicArg !== undefined) {
          let channel = topicArg.type === 'identifier' ? consts.get(topicArg.text) : stringValue(topicArg);
          const keyArg = args?.namedChild(1);
          if (topicArg.type === 'object') {
            const pairs = topicArg.namedChildren.filter((child): child is SyntaxNode => child !== null && child.type === 'pair');
            const field = (name: string): SyntaxNode | null => {
              const explicit = pairs.find((pair) => pair.childForFieldName('key')?.text.replace(/['"]/g, '') === name)?.childForFieldName('value');
              if (explicit != null) return explicit;
              return topicArg.namedChildren.find((child) => child !== null && child.type === 'shorthand_property_identifier' && child.text === name) ?? null;
            };
            const topic = field('topic');
            const messages = field('messages');
            // KafkaJS send takes both a topic and messages. A topic-bearing
            // object alone, or an unrelated object elsewhere, proves nothing.
            if (topic === null || messages === null) return;
            channel = topic.type === 'identifier' || topic.type === 'shorthand_property_identifier' ? consts.get(topic.text) : stringValue(topic);
          }
          sends.push({
            receiverGrounded: messagingReceiver(node, root),
            receiverMessagingEvidence: messagingTypeEvidence(node, root),
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
