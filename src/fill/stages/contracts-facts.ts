/**
 * One file's code facts as the contracts reading's own readers ask them, rebuilt from the graph
 * (decision 0033, items 5, 14 and 15; madarch-8bdc.2.4).
 *
 * The code-facts stage publishes what one file's walk read: its expressions with their place, the
 * names they bind and their children, its call sites, its fields and its callables. The extract
 * driver reads the same facts from one in-memory object for a whole tree, and its contract readers
 * — the publisher proof, the gRPC deadline, the Go consumer configuration — take the facts, the
 * resolver's sites and the bytes. This module builds the part of that object one file's unit needs,
 * from bounded reads by the file's property: no tree reader and no repository-wide object is held.
 *
 * **The two joins the published facts do not hold.** The driver's call facts name their holder (the
 * callable the call stands in), and its sites name what each mention resolved to and what an
 * interface method's implementations are. The graph holds neither as a field: the holder is the
 * innermost callable whose span holds the call, the target is the file's own declaration the
 * mention's name and receiver type name, and an implementation is the type a `code.inherits` edge
 * joins to the interface. Both are computed here, one file at a time.
 */
import { byCodePoint } from '../../model/order.js';
import type { SourceSpan } from '../../extract/records.js';
import type { PublisherExpression, PublisherFacts } from '../../extract/contracts/ts-code.js';
import { decodeStringToken } from '../../extract/code/literals.js';
import { messagingTypes } from '../../extract/library-models/messaging-models.js';
import { fieldSymbolKeyOf } from './operations-code-facts.js';
import { STATIC_READ_ROW_LIMIT, type StaticStageContext } from './static-context.js';

type Row = Readonly<Record<string, unknown>>;

/** The file's facts, the resolver links the readers ask for, and the answers read from the graph. */
export interface FileCodeView {
  readonly facts: PublisherFacts;
  readonly code: { readonly edges: readonly {readonly type: string; readonly from: string; readonly to: string}[] };
  readonly roles: readonly {readonly expression: string; readonly role: string; readonly origin: {readonly importId: string}}[];
  libraryFacts(): {readonly roles: readonly {readonly expression: string; readonly role: string; readonly origin: {readonly importId: string}}[]};
  readonly tree: {read(path: string): Uint8Array};
  read(path: string): Uint8Array;
  spanOfFile(path: string): SourceSpan;
  factGap(path: string, reason: string): void;
  /** The gaps the view recorded; a reader's unresolved proof is one of these. */
  readonly gaps: {readonly path: string; readonly reason: string}[];
}

/** One call site as the readers ask it: whose it is and what it reaches. */
interface CallRow {
  readonly expression: string;
  readonly path: string;
  readonly span: SourceSpan;
  readonly callee: string;
  readonly arguments: readonly string[];
  readonly construct: boolean;
  readonly holder: string;
}

/** One declaration the file states, as the call resolution and the publisher proof name it. */
interface SymbolRow {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: string;
  readonly callable: boolean;
  readonly span: SourceSpan;
  readonly bodySpan?: SourceSpan;
}

/** One page after another, bounded by the static read cap. */
async function rowsOf(stage: StaticStageContext, kind: string, path: string, repository: string): Promise<Row[]> {
  const rows: Row[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty(kind, 'file', path, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    for (const row of page.rows) if (row.properties['repository'] === repository) rows.push(row.properties);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** One span, as a fact holds one; a value that names no whole range names no span. */
function spanOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const held = value as Record<string, unknown>;
  if (typeof held['path'] !== 'string' || typeof held['byteStart'] !== 'number' || typeof held['byteEnd'] !== 'number') return undefined;
  return {
    path: held['path'],
    byteStart: held['byteStart'],
    byteEnd: held['byteEnd'],
    lineStart: typeof held['lineStart'] === 'number' ? held['lineStart'] : 1,
    lineEnd: typeof held['lineEnd'] === 'number' ? held['lineEnd'] : 1,
  };
}

/** Every string of a list property. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Whether a span holds another whole, on one path. */
function contains(outer: SourceSpan, inner: SourceSpan): boolean {
  return outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;
}

/**
 * One file's view: its facts, its calls with their holder, the mentions the publisher and consumer
 * proofs ask for, and the declared types the call resolution joins.
 */
export async function fileCodeViewOf(
  stage: StaticStageContext,
  repository: string,
  path: string,
  bytes: Uint8Array,
  roles: FileCodeView['roles'] = [],
  extra: { readonly symbols?: readonly {readonly key: string; readonly path: string; readonly name: string; readonly qualifiedName: string; readonly symbolKind: string; readonly callable: boolean; readonly span: SourceSpan; readonly bodySpan?: SourceSpan}[]; readonly implements?: readonly {readonly from: string; readonly to: string}[] } = {},
): Promise<FileCodeView> {
  const [expressionRows, bindingRows, callRows, callableRows, fieldRows, inheritEdges] = await Promise.all([
    rowsOf(stage, 'code.expression', path, repository),
    rowsOf(stage, 'code.binding', path, repository),
    rowsOf(stage, 'code.call', path, repository),
    rowsOf(stage, 'code.callable', path, repository),
    rowsOf(stage, 'code.field', path, repository),
    stage.edgesByProperty('code.inherits', 'file', path, { limit: STATIC_READ_ROW_LIMIT }),
  ]);
  const expressions = new Map<string, PublisherExpression>();
  for (const row of expressionRows) expressions.set(String(row['id']), {...row} as unknown as PublisherExpression);
  const bindings = bindingRows.map((row) => ({...row}));
  // A short declaration's right side is an expression list: the value a name holds is the one
  // expression that list names, as the driver's own facts record it.
  for (const binding of bindings) {
    const initial = typeof binding['initializer'] === 'string' ? expressions.get(binding['initializer']) : undefined;
    if (initial?.syntaxKind === 'expression_list' && initial.children.length === 1) binding['initializer'] = initial.children[0]!;
  }
  const classNames = new Map<string, PublisherExpression>();
  /** A child expression of one node, where the walk kept the id under the grammar's field. */
  const childIn = (node: PublisherExpression, field: string): PublisherExpression | undefined => {
    const ids = node.fields[field] ?? [];
    if (ids.length !== 1) return undefined;
    const child = expressions.get(ids[0]!);
    return child !== undefined && node.children.includes(child.id) && contains(node.span, child.span) ? child : undefined;
  };
  for (const node of expressions.values()) {
    if (node.syntaxKind !== 'class_declaration' && node.syntaxKind !== 'abstract_class_declaration') continue;
    const name = node.fields['name'] && node.fields['name']!.length === 1 ? expressions.get(node.fields['name']![0]!) : undefined;
    if (name?.name !== undefined) classNames.set(name.name, node);
  }
  // A shorthand property (`{ topic }`) names the binding it writes; the walk keeps the token but not
  // the name, and the publisher proof selects the topic by it. The token's bytes are the name.
  const text = new TextDecoder('utf-8').decode(bytes);
  for (const expression of expressions.values()) {
    if (expression.name !== undefined || expression.syntaxKind !== 'shorthand_property_identifier' || expression.span.path !== path) continue;
    const name = text.slice(expression.span.byteStart, expression.span.byteEnd);
    (expression as unknown as {name?: string}).name = name;
    if (expression.bindingId !== undefined) continue;
    const candidates = bindings.filter((binding) => binding['name'] === name && (binding['kind'] === 'import' || (spanOf(binding['scope']) !== undefined && contains(spanOf(binding['scope'])!, expression.span))));
    // The innermost declaration is the one a name reads; two parameters of one name in two
    // declarations both "hold" the place by their scopes, and the narrower scope is the answer.
    const narrowest = candidates.map((binding) => ({binding, size: (() => { const scope = spanOf(binding['scope']); return scope === undefined ? Number.MAX_SAFE_INTEGER : scope.byteEnd - scope.byteStart; })()})).sort((left, right) => left.size - right.size);
    if (narrowest.length > 0 && (narrowest.length === 1 || narrowest[0]!.size < narrowest[1]!.size)) (expression as unknown as {bindingId?: string}).bindingId = String(narrowest[0]!.binding['id']);
  }
  // A type declaration and the fields it declares: the driver's Go receiver proof asks the type
  // binding's declaration to be the field's owner declaration. The walk publishes no type binding,
  // so one per type declaration names it, and an unbound type identifier of the name reads it.
  const typeBindings = new Map<string, {id: string; name: string; node: PublisherExpression; nameNode: PublisherExpression; typeNode?: PublisherExpression}>();
  for (const node of expressions.values()) {
    if (node.syntaxKind !== 'type_spec' && node.syntaxKind !== 'type_declaration') continue;
    const nameNode = childIn(node, 'name');
    if (nameNode?.name === undefined) continue;
    const typeNode = childIn(node, 'type');
    if (typeBindings.has(nameNode.name)) continue;
    typeBindings.set(nameNode.name, {id: `${nameNode.id}:type`, name: nameNode.name, node, nameNode, ...(typeNode === undefined ? {} : {typeNode})});
  }
  for (const [name, declared] of typeBindings) {
    bindings.push({
      id: declared.id,
      path,
      name,
      kind: 'type',
      span: declared.nameNode.span,
      scope: {path, byteStart: 0, byteEnd: bytes.byteLength, lineStart: 1, lineEnd: 1},
      typeDeclaration: {
        expression: declared.node.id,
        nameExpression: declared.nameNode.id,
        typeExpression: declared.typeNode?.id ?? declared.node.id,
        declarationSpan: declared.node.span,
        scopeExpression: declared.nameNode.id,
        scopeStart: 0,
        shape: declared.typeNode?.syntaxKind === 'struct_type' ? 'struct' : 'unknown',
      },
    });
    for (const expression of expressions.values()) {
      if (expression.bindingId === undefined && expression.syntaxKind === 'type_identifier' && expression.name === name) {
        (expression as unknown as {bindingId?: string}).bindingId = declared.id;
      }
    }
  }
  // A name the walk left unbound that one import of the file binds: the driver's resolver binds
  // every identifier to its declaration, and a proof that a type comes from a package asks the
  // import by the name it binds. The file's own imports are the only candidates.
  const importBindings = new Map<string, Row[]>();
  const importsByDeclaredName = new Map<string, Row[]>();
  const declaredNames = new Map(messagingTypes.flatMap((model) => model.ecosystem === 'go' && model.packageName !== undefined ? [[model.package, model.packageName] as const] : []));
  for (const row of bindingRows) {
    if (row['kind'] !== 'import' || typeof row['name'] !== 'string') continue;
    importBindings.set(row['name'], [...(importBindings.get(row['name']) ?? []), row]);
    // A Go package's name is not always its path's tail (`.../kafka-go` is `kafka`): the library
    // models name the package the import binds, as the Go reader's own rule reads it.
    const declared = typeof row['specifier'] === 'string' ? declaredNames.get(row['specifier']) : undefined;
    if (declared !== undefined) importsByDeclaredName.set(declared, [...(importsByDeclaredName.get(declared) ?? []), row]);
  }
  for (const expression of expressions.values()) {
    if (expression.bindingId !== undefined || (expression.syntaxKind !== 'identifier' && expression.syntaxKind !== 'type_identifier' && expression.syntaxKind !== 'package_identifier') || expression.name === undefined) continue;
    const candidates = expression.syntaxKind === 'package_identifier'
      ? [...(importBindings.get(expression.name) ?? []), ...(importsByDeclaredName.get(expression.name) ?? [])]
      : importBindings.get(expression.name) ?? [];
    if (candidates.length !== 1) continue;
    const scope = spanOf(candidates[0]!['scope']);
    if (scope === undefined || !contains(scope, expression.span)) continue;
    (expression as unknown as {bindingId?: string}).bindingId = String(candidates[0]!['id']);
  }
  // The class a `this` stands for is a binding the code-facts walk does not publish: a class is
  // not a declaration of a name. One receiver binding per class answers the driver's own
  // `classes` map, and each `this` of the class names it.
  let classBinding = 0;
  for (const [name, node] of classNames) {
    const nameNode = node.fields['name'] && node.fields['name']!.length === 1 ? expressions.get(node.fields['name']![0]!) : undefined;
    if (nameNode === undefined) continue;
    classBinding += 1;
    const id = `${nameNode.id}:receiver`;
    bindings.push({id, path, name, kind: 'receiver', span: nameNode.span, scope: node.span});
    for (const expression of expressions.values()) {
      if (expression.syntaxKind === 'this' && contains(node.span, expression.span)) (expression as unknown as {bindingId?: string}).bindingId = id;
    }
  }
  /** The identifier a member access names, or the identifier itself: the place a mention stands. */
  const mentionSpanOf = (callee: PublisherExpression): SourceSpan | undefined => {
    if (callee.syntaxKind === 'identifier') return callee.span;
    if (callee.syntaxKind !== 'member_expression' && callee.syntaxKind !== 'selector_expression') return undefined;
    const member = childIn(callee, 'field') ?? childIn(callee, 'property');
    return member?.span;
  };
  /** The name a type expression declares: the grammar's own type identifier, through a pointer. */
  const typeNameOf = (expression: PublisherExpression | undefined): string | undefined => {
    let held = expression;
    for (let depth = 0; held !== undefined && depth < 8; depth += 1) {
      if (held.syntaxKind !== 'type_annotation' && held.syntaxKind !== 'pointer_type') {
        return held.syntaxKind === 'type_identifier' || held.syntaxKind === 'qualified_type' ? held.name : undefined;
      }
      held = childIn(held, 'type') ?? (held.children.length === 1 ? expressions.get(held.children[0]!) : undefined);
    }
    return undefined;
  };

  const callables: SymbolRow[] = callableRows.map((row) => ({
    key: String(row['symbolKey']),
    path,
    name: String(row['name']),
    qualifiedName: String(row['qualifiedName']),
    symbolKind: String(row['symbolKind']),
    callable: true,
    span: spanOf(row['span'])!,
    ...(spanOf(row['bodySpan']) === undefined ? {} : { bodySpan: spanOf(row['bodySpan'])! }),
  }));
  for (const [name, node] of classNames) callables.push({key: `code.symbol:${path}#${name}`, path, name, qualifiedName: name, symbolKind: 'class', callable: false, span: node.span});
  // The declarations of the other files of one service, and their inheritance, so a call through an
  // interface declared here and implemented there reaches its implementation: the outbox chain
  // crosses relay.go and kafka.go.
  for (const symbol of extra.symbols ?? []) callables.push({...symbol});
  const callableAt = (span: SourceSpan): SymbolRow | undefined => {
    const held = callables.filter((callable) => callable.span.byteStart <= span.byteStart && span.byteStart < callable.span.byteEnd && callable.bodySpan !== undefined && contains(callable.bodySpan, span));
    return held.sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart))[0];
  };
  const calls: CallRow[] = callRows.map((row) => ({
    expression: String(row['expression']),
    path,
    span: spanOf(row['span'])!,
    callee: String(row['callee'] ?? ''),
    arguments: stringsOf(row['arguments']),
    construct: row['construct'] === true,
    holder: callableAt(spanOf(row['span'])!)?.key ?? `code.file:${path}`,
  }));
  const bindingOf = (id: string | undefined): Row | undefined => id === undefined ? undefined : bindings.find((row) => row['id'] === id);
  const typeNameOfReceiver = (receiver: PublisherExpression | undefined, span: SourceSpan): string | undefined => {
    if (receiver === undefined) return undefined;
    if (receiver.syntaxKind === 'this') {
      const cls = [...expressions.values()].filter((node) => (node.syntaxKind === 'class_declaration' || node.syntaxKind === 'abstract_class_declaration') && contains(node.span, span));
      return cls.sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart))[0]?.name;
    }
    if (receiver.bindingId !== undefined) {
      const binding = bindingOf(receiver.bindingId);
      if (binding === undefined) return undefined;
      const bindingSpan = spanOf(binding['span']);
      if (binding['kind'] === 'receiver') {
        const method = [...expressions.values()].filter((node) => (node.syntaxKind === 'method_declaration' || node.syntaxKind === 'method_definition') && contains(node.span, span));
        const nearest = method.sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart))[0];
        const receiverNode = nearest === undefined ? undefined : childIn(nearest, 'receiver');
        const parameters = receiverNode === undefined ? [] : receiverNode.children.map((id) => expressions.get(id)).filter((node): node is PublisherExpression => node !== undefined);
        const declaration = parameters.find((node) => node.syntaxKind === 'parameter_declaration' && node.children.some((id) => expressions.get(id)?.bindingId === binding['id']));
        return typeNameOf(declaration === undefined ? undefined : childIn(declaration, 'type'));
      }
      const parameter = [...expressions.values()].filter((node) => ['parameter_declaration', 'required_parameter', 'optional_parameter', 'variadic_parameter_declaration'].includes(node.syntaxKind) && bindingSpan !== undefined && contains(node.span, bindingSpan));
      const nearest = parameter.sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart))[0];
      return typeNameOf(nearest === undefined ? undefined : childIn(nearest, 'type'));
    }
    // A field's own type names the receiver of a method the field holds (`r.publisher.Publish`):
    // the interface the field is declared with, and the implementation its fan-out reaches.
    if ((receiver.syntaxKind === 'member_expression' || receiver.syntaxKind === 'selector_expression') && receiver.receiver !== undefined && receiver.member !== undefined) {
      const base = expressions.get(receiver.receiver);
      const owner = typeNameOfReceiver(base, receiver.span);
      const declared = owner === undefined ? undefined : fieldNamed(owner, receiver.member);
      const type = declared === undefined || declared.typeExpression === '' ? undefined : expressions.get(declared.typeExpression);
      return typeNameOf(type);
    }
    return undefined;
  };
  const fields = fieldRows.map((row) => {
    const name = String(row['name']);
    const ownerTypeName = String(row['ownerTypeName']);
    const span = spanOf(row['span'])!;
    return {
      key: fieldSymbolKeyOf(path, ownerTypeName, name),
      path,
      name,
      ownerTypeName,
      ownerDeclaration: typeDeclarationOf(span, ownerTypeName),
      span,
      typeExpression: String(row['typeExpression'] ?? ''),
    };
  });
  const implementsOf = new Map<string, string[]>();
  for (const edge of extra.implements ?? []) implementsOf.set(edge.from, [...(implementsOf.get(edge.from) ?? []), edge.to]);
  for (const edge of inheritEdges.rows) {
    const from = String(edge.from.properties['qualifiedName'] ?? '');
    const to = String(edge.to.properties['qualifiedName'] ?? '');
    if (from === '' || to === '') continue;
    implementsOf.set(from, [...(implementsOf.get(from) ?? []), to]);
  }
  const fieldNamed = (owner: string, name: string) => fields.find((field) => field.ownerTypeName === owner && field.name === name);
  const callSites: {path: string; span: SourceSpan; to: string; use: 'call'; roles: readonly string[]; fanOut: readonly string[]; holder: string}[] = [];
  for (const call of calls) {
    const callee = call.callee === undefined ? undefined : expressions.get(call.callee);
    if (callee === undefined) continue;
    const siteSpan = mentionSpanOf(callee);
    if (siteSpan === undefined) continue;
    const targets: {to: string; fanOut: readonly string[]}[] = [];
    if (callee.syntaxKind === 'identifier' && callee.name !== undefined) {
      const declared = callables.filter((symbol) => symbol.name === callee.name && symbol.bodySpan !== undefined);
      if (declared.length === 1) targets.push({to: declared[0]!.key, fanOut: []});
      // A construction names its class, which is no declaration of a callable but a record the
      // publisher proof's wiring asks for.
      const constructed = classNames.get(callee.name);
      const classSymbol = constructed === undefined ? undefined : callables.find((symbol) => !symbol.callable && symbol.qualifiedName === callee.name);
      if (classSymbol !== undefined) targets.push({to: classSymbol.key, fanOut: []});
      // A construction is also the constructor declaration it runs; a deadline's wiring is proved
      // by the construction's arguments, and the driver names that declaration.
      const constructor = constructed === undefined ? undefined : callables.find((symbol) => symbol.callable && symbol.qualifiedName === `${callee.name}.constructor`);
      if (constructor !== undefined) targets.push({to: constructor.key, fanOut: []});
    } else if ((callee.syntaxKind === 'member_expression' || callee.syntaxKind === 'selector_expression') && callee.member !== undefined && callee.receiver !== undefined) {
      const receiver = expressions.get(callee.receiver);
      const owner = typeNameOfReceiver(receiver, callee.span);
      const declared = owner === undefined ? undefined : callables.find((symbol) => symbol.qualifiedName === `${owner}.${callee.member}`);
      if (declared !== undefined) {
        const implementations = owner === undefined ? [] : callables.filter((symbol) => symbol.qualifiedName.endsWith(`.${callee.member}`) && symbol.qualifiedName !== declared.qualifiedName && [...(implementsOf.get(symbol.qualifiedName.slice(0, symbol.qualifiedName.lastIndexOf('.'))) ?? [])].includes(owner));
        targets.push({to: declared.key, fanOut: implementations.map((symbol) => symbol.key)});
      }
    }
    for (const target of targets) callSites.push({path, span: siteSpan, to: target.to, use: 'call', roles: ['read-access'], fanOut: target.fanOut, holder: call.holder});
  }
  const referenceSites: {path: string; span: SourceSpan; to: string; use: 'reference'; roles: readonly string[]; fanOut: readonly string[]; holder: string}[] = [];
  for (const node of expressions.values()) {
    if ((node.syntaxKind !== 'member_expression' && node.syntaxKind !== 'selector_expression') || node.member === undefined || node.receiver === undefined) continue;
    const receiver = expressions.get(node.receiver);
    const owner = typeNameOfReceiver(receiver, node.span);
    if (owner === undefined) continue;
    const declared = fieldNamed(owner, node.member);
    if (declared === undefined) continue;
    const member = childIn(node, 'field') ?? childIn(node, 'property');
    const span = member?.span ?? node.span;
    referenceSites.push({path, span, to: declared.key, use: 'reference', roles: ['read-access'], fanOut: [], holder: callableAt(span)?.key ?? `code.file:${path}`});
  }
  /** The declarations some type declares, as the proof that a receiver's type owns a field asks it. */
  function typeDeclarationOf(span: SourceSpan, ownerTypeName: string): string {
    const declarations = [...expressions.values()].filter((node) => (node.syntaxKind === 'type_spec' || node.syntaxKind === 'type_declaration') && contains(node.span, span) && (node.name === ownerTypeName || childIn(node, 'name')?.name === ownerTypeName));
    return declarations.sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart))[0]?.id ?? '';
  }
  const gaps: {path: string; reason: string}[] = [];
  const facts: PublisherFacts = {
    files: [{path, language: path.endsWith('.go') ? 'go' : 'typescript', parsed: true}],
    expressions: [...expressions.values()],
    bindings: bindings.map((row) => row as unknown as PublisherFacts['bindings'][number]),
    calls,
    symbols: callables,
    imports: bindingRows.filter((row) => row['kind'] === 'import' && typeof row['specifier'] === 'string').map((row) => ({
      id: String(row['importId'] ?? row['id']),
      path,
      local: String(row['name']),
      specifier: String(row['specifier']),
      imported: row['form'] === 'named' ? {form: 'named' as const, name: String(row['importedName'] ?? row['name'])} : row['form'] === 'default' ? {form: 'default' as const} : {form: 'namespace' as const},
      ...(typeof row['targetPath'] === 'string' ? {targetPath: row['targetPath']} : {}),
    })),
    sites: [...callSites, ...referenceSites],
    fields,
  };
  return {
    facts,
    code: {edges: callSites.flatMap((site) => [site.to, ...site.fanOut].map((to) => ({type: 'code.calls', from: site.holder, to})))},
    roles,
    libraryFacts: () => ({roles}),
    tree: {read: (wanted: string): Uint8Array => {
      if (wanted !== path) throw new Error(`${wanted}:1: the file view reads one file, and a reader asked for another (src/fill/stages/contracts-facts.ts)`);
      return bytes;
    }},
    read: (wanted: string): Uint8Array => {
      if (wanted !== path) throw new Error(`${wanted}:1: the file view reads one file, and a reader asked for another (src/fill/stages/contracts-facts.ts)`);
      return bytes;
    },
    spanOfFile: (wanted: string): SourceSpan => spanOfFileSpan(wanted, wanted === path ? bytes : new Uint8Array()),
    factGap: (wanted: string, reason: string) => gaps.push({path: wanted, reason}),
    gaps,
  };
}

/** The span of a whole file: its first line to its last, its first byte to its length. */
function spanOfFileSpan(path: string, bytes: Uint8Array): SourceSpan {
  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text === '' ? 1 : text.split('\n').length;
  return {path, byteStart: 0, byteEnd: bytes.byteLength, lineStart: 1, lineEnd: lines};
}



/** The resolved URL parts of one fetch call, as the driver's `httpCallUrl` reads them. */
export function httpCallUrlOf(view: FileCodeView, span: SourceSpan): readonly string[] | undefined {
  const one = <T>(values: readonly T[]): T | undefined => values.length === 1 ? values[0] : undefined;
  const expressions = new Map<string, PublisherExpression>(view.facts.expressions.map((node) => [node.id, node]));
  const bindings = view.facts.bindings;
  const calls = view.facts.calls.filter((call) => call.path === span.path && call.span.byteStart === span.byteStart && call.span.byteEnd === span.byteEnd);
  const call = one(calls);
  const argument = call === undefined ? undefined : expressions.get(call.arguments[0] ?? '');
  if (argument === undefined) return undefined;
  const changed = new Set<string>();
  const mark = (id: string): void => {
    const node = expressions.get(id);
    if (node === undefined) return;
    if (node.bindingId !== undefined) changed.add(node.bindingId);
    for (const child of node.children) mark(child);
  };
  for (const node of view.facts.expressions) {
    if (!['assignment_expression', 'augmented_assignment_expression', 'update_expression'].includes(node.syntaxKind)) continue;
    for (const id of node.fields['left'] ?? node.children) mark(id);
  }
  const parameter = (node: PublisherExpression | undefined): boolean => {
    if (node?.syntaxKind !== 'identifier' || node.bindingId === undefined) return false;
    const binding = bindings.find((held) => held.id === node.bindingId);
    return binding?.kind === 'parameter' && !changed.has(binding.id) && binding.path === node.path
      && binding.scope.path === node.path && node.span.byteStart >= binding.scope.byteStart && node.span.byteEnd <= binding.scope.byteEnd;
  };
  const resolve = (node: PublisherExpression, seen = new Set<string>()): readonly string[] | undefined => {
    if (seen.has(node.id) || seen.size >= 40) return undefined;
    seen = new Set([...seen, node.id]);
    if (node.literal?.kind === 'string' && typeof node.literal.value === 'string') return [node.literal.value];
    if (node.syntaxKind === 'parenthesized_expression') {
      const child = one(node.children.flatMap((id) => {
        const held = expressions.get(id);
        return held === undefined || held.syntaxKind === 'comment' ? [] : [held];
      }));
      return child === undefined ? undefined : resolve(child, seen);
    }
    if (node.bindingId !== undefined) {
      const binding = one(bindings.filter((held) => held.id === node.bindingId));
      if (binding === undefined || changed.has(binding.id) || node.path !== binding.scope.path || node.span.byteStart < binding.scope.byteStart || node.span.byteEnd > binding.scope.byteEnd) return undefined;
      const imported = binding.importId === undefined ? undefined : one(view.facts.imports.filter((held) => held.id === binding.importId && held.typeOnly !== true));
      const target = binding.kind === 'import' ? imported?.targetExpression : binding.initializer;
      const value = target === undefined ? undefined : expressions.get(target);
      return value === undefined ? undefined : resolve(value, seen);
    }
    if (node.syntaxKind !== 'template_string' || node.literal?.kind !== 'string') return undefined;
    const raw = Buffer.from(node.literal.raw, 'utf8');
    if (raw.length !== node.span.byteEnd - node.span.byteStart) return undefined;
    const substitutions = node.children.flatMap((id) => {
      const child = expressions.get(id);
      return child?.syntaxKind === 'template_substitution' ? [child] : [];
    }).sort((left, right) => left.span.byteStart - right.span.byteStart);
    if (substitutions.length === 0) return undefined;
    let at = 1;
    let value = '';
    const parts: string[] = [];
    for (const substitution of substitutions) {
      const start = substitution.span.byteStart - node.span.byteStart;
      const end = substitution.span.byteEnd - node.span.byteStart;
      if (substitution.path !== node.path || start < at || end > raw.length - 1) return undefined;
      const fragment = decodeStringToken('template_string', '`' + raw.subarray(at, start).toString('utf8') + '`');
      if (fragment === undefined) return undefined;
      value += fragment;
      const child = one(substitution.children.flatMap((id) => {
        const held = expressions.get(id);
        return held === undefined || held.syntaxKind === 'comment' ? [] : [held];
      }));
      const resolved = child === undefined ? undefined : resolve(child, seen);
      if (resolved === undefined) {
        if (start === 1 && parts.length === 0 && value === '') { /* A relative suffix only. */ }
        else if (parameter(child)) { parts.push(value); value = ''; }
        else return undefined;
      } else {
        if (resolved.length !== 1) return undefined;
        value += resolved[0]!;
      }
      at = end;
    }
    const tail = decodeStringToken('template_string', '`' + raw.subarray(at, raw.length - 1).toString('utf8') + '`');
    return tail === undefined ? undefined : [...parts, value + tail];
  };
  return resolve(argument);
}

/** The alternating parameter path a resolved URL names, as `httpParameterPath` reads it. */
export function httpParameterPathOf(parts: readonly string[]): readonly (string | undefined)[] | undefined {
  if (parts.length < 2 || parts.some((part) => part.includes('?') || part.includes('#'))) return undefined;
  let prefix = parts[0]!;
  try { prefix = new URL(prefix).pathname; } catch { /* A relative path has no origin. */ }
  if (!prefix.startsWith('/') || !prefix.endsWith('/')) return undefined;
  const segments: (string | undefined)[] = prefix.split('/').slice(0, -1);
  for (const [index, tail] of parts.slice(1).entries()) {
    if (tail !== '' && !tail.startsWith('/')) return undefined;
    if (index < parts.length - 2 && !tail.endsWith('/')) return undefined;
    segments.push(undefined);
    const suffix = tail === '' ? [] : tail.slice(1).split('/');
    segments.push(...(index < parts.length - 2 ? suffix.slice(0, -1) : suffix));
  }
  return segments;
}
