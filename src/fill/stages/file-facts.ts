/**
 * One file's code facts, read from its bytes (madarch-8bdc.2.5): the walk the
 * code-facts stage used to publish as graph nodes, answered here in memory for
 * every stage that asks what a file's bytes say.
 *
 * **Why the facts left the graph.** The expressions, bindings, calls and exports
 * of a file were nodes of the graph, and the only readers of them were stages
 * that read one file back — the operations reading, the library-effects reading,
 * the data-model reading. A parse kept in the store is 29 267 rows of 42 294 on
 * the training repository, and every one of them was written, indexed and read
 * again to answer a question the reader could answer from the bytes it already
 * held. Decision 0033, item 5 gives a static stage one file's bytes and bounded
 * graph queries; this module is the one function that turns those bytes into the
 * facts, and `createFileFactsCache` is the per-run memory that keeps a file
 * parsed once for every reader of it.
 *
 * **One answer, whoever asks.** The walk is the walk the driver's own readings
 * use (`src/extract/code`): a stage that reads a route, an environment variable,
 * a metric or a logger from a parsed file reads the same expression and binding
 * facts the driver reads, so the fill's reading and the extractor's reading stay
 * one reading. The tree lives inside the call and nothing of it escapes.
 */

import { byCodePoint } from '../../model/order.js';
import { readFileFindings, readSyntaxTree, spanFactory, syntaxLanguageOf, type ExtractedFileSyntax, type SyntaxLanguage } from './syntax-extract.js';
import { listeningPortsOfTree } from './listening-ports.js';
import { fileSymbolsOf } from './code-symbols.js';
import { importCandidates } from './syntax-facts.js';

/** The kind prefixes the facts' ids carry: the graph keys the readings named these facts by. */
const EXPRESSION_KIND = 'code.expression';
const BINDING_KIND = 'code.binding';
const CALL_KIND = 'code.call';
const FIELD_KIND = 'code.field';
const EXPORT_KIND = 'code.export';


/** Where one fact stands in a file: the bytes a reader slices and the lines it counts, 1-based. */
interface SourceSpan {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

interface LiteralFact {
  readonly kind: 'string' | 'number' | 'boolean' | 'null';
  readonly raw: string;
  readonly value?: string | number | boolean | null;
}

/** One expression the walk read: the place it stands at and everything a reader asks of it. */
interface ExpressionFact {
  readonly id: string;
  readonly syntaxKind: string;
  readonly span: SourceSpan;
  readonly parent?: string;
  readonly children: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly operator?: string;
  readonly name?: string;
  readonly receiver?: string;
  readonly member?: string;
  readonly callee?: string;
  readonly arguments?: readonly string[];
  readonly literal?: LiteralFact;
}

/** One binding a declaration makes, and — for an import — the name it binds to which file. */
interface BindingFact {
  readonly id: string;
  readonly name: string;
  readonly kind: 'import' | 'parameter' | 'local' | 'receiver' | 'type';
  readonly span: SourceSpan;
  readonly scope: SourceSpan;
  readonly initializer?: string;
  /** The import fact an import binding names, which is the binding it stands at. */
  readonly importId?: string;
  /** An import's specifier as written (`./logging/logger.js`, `pino`). */
  readonly specifier?: string;
  /** The form the import binds by, and the name it imports under that form. */
  readonly form?: 'default' | 'namespace' | 'named';
  readonly importedName?: string;
  /** The file of this repository the specifier answers, where one does. */
  readonly targetPath?: string;
  /** The declaration a binding is made in, from its statement's first byte to its initializer's last. */
  readonly declarationSpan?: SourceSpan;
}

/** One call site: the invocation and the callee and arguments it names. */
interface CallFact {
  readonly id: string;
  readonly expression: string;
  readonly span: SourceSpan;
  /** The invocation's own prefix: from the call's first byte to the argument list's opening bracket. */
  readonly invocationSpan?: SourceSpan;
  readonly callee?: string;
  readonly arguments: readonly string[];
  readonly construct: boolean;
}

/** One Go struct field: the name it is declared under and the type it holds. */
export interface FieldFact {
  readonly id: string;
  readonly name: string;
  readonly ownerTypeName: string;
  readonly span: SourceSpan;
  readonly typeExpression?: string;
}

/** One name a file exports, and the binding the file declares it under. */
interface ExportFact {
  readonly id: string;
  readonly name: string;
  readonly span: SourceSpan;
  readonly localBinding?: string;
}

/** The body one declaration node holds, by the node's own byte span: where the code of a callable begins and what it is. */
export interface BodyFact {
  readonly startByte: number;
  readonly endByte: number;
  readonly bodyStartByte: number;
  readonly bodyEndByte: number;
  readonly bodyStartLine: number;
  readonly bodyEndLine: number;
  readonly bodySyntaxKind: string;
}

/** Everything one file's walk read. */
interface FileFacts {
  readonly expressions: readonly ExpressionFact[];
  readonly bindings: readonly BindingFact[];
  readonly calls: readonly CallFact[];
  readonly fields: readonly FieldFact[];
  readonly exports: readonly ExportFact[];
  /** The body of every node that holds one, by the node's own span: what a callable's body stands over. */
  readonly bodies: readonly BodyFact[];
}

/** The node types whose text is the name a reader sees, by the grammar's own spelling. */
const NAME_KINDS: ReadonlySet<string> = new Set(['field_identifier', 'identifier', 'package_identifier', 'property_identifier', 'type_identifier']);

/** The node types that hold a literal, by the two grammars' spellings, and the kind of value each holds. */
const LITERAL_KINDS: ReadonlyMap<string, LiteralFact['kind']> = new Map([
  ['false', 'boolean'], ['float_literal', 'number'], ['imaginary_literal', 'number'], ['int_literal', 'number'],
  ['nil', 'null'], ['null', 'null'], ['number', 'number'], ['raw_string_literal', 'string'],
  ['interpreted_string_literal', 'string'], ['rune_literal', 'string'], ['string', 'string'],
  ['template_string', 'string'], ['true', 'boolean'], ['undefined', 'null'],
]);

/** The statements that hold a declaration of a name: where a binding's declaration stands. */
const DECLARATION_STATEMENTS: ReadonlySet<string> = new Set([
  'const_declaration', 'lexical_declaration', 'var_declaration', 'variable_declaration',
]);

/** The node types that declare a name in TypeScript and JavaScript. */
const TS_BINDING_DECLARATIONS: ReadonlySet<string> = new Set(['variable_declarator']);

/** The node types that declare a name in Go. */
const GO_BINDING_DECLARATIONS: ReadonlySet<string> = new Set(['const_spec', 'short_var_declaration', 'var_spec']);

/** The grammar's callable nodes, by both spellings: the nodes whose `body` field is a callable's body. */
const CALLABLE_NODES: ReadonlySet<string> = new Set([
  'arrow_function', 'func_literal', 'function', 'function_declaration', 'function_expression', 'generator_function',
  'generator_function_declaration', 'method_declaration', 'method_definition',
]);

/** The node types that declare a parameter, by both grammars' spellings. */
const PARAMETER_KINDS: ReadonlySet<string> = new Set(['optional_parameter', 'parameter_declaration', 'required_parameter', 'variadic_parameter_declaration']);


/** One callable a file declares: what the extract readings call it, where it stands and where its body is. */
export interface CallableFact {
  /** The key the extract readings name this callable by (`code.symbol:<path>#<qualified name>`). */
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: string;
  readonly callable: true;
  readonly span: SourceSpan;
  readonly bodySpan?: SourceSpan;
  readonly bodySyntaxKind?: string;
}

/**
 * The callables one file declares, named as the extract readings name them: the
 * driver's own symbol reader (`fileSymbolsOf`) over the syntax pass's findings,
 * with each callable's body matched from the walk by the node's own span. A
 * callable written as an argument — a route handler, a store callback — is named
 * by the callable it stands in and the place it starts at, which is the key the
 * extract driver gives it.
 */
export async function callablesOfFile(path: string, bytes: Uint8Array, findings: ExtractedFileSyntax, bodies: readonly BodyFact[]): Promise<readonly CallableFact[]> {
  const language = syntaxLanguageOf(path);
  if (language === undefined) return [];
  const held = fileSymbolsOf({ path, bytes, language: language === 'go' ? 'go' : 'typescript' }, findings);
  // The driver matches a callable node to the symbol that owns it by the nearest start of a
  // symbol that starts before the node and ends where it ends (`bodies.ts`): a symbol's body
  // is the innermost callable node it owns.
  const bodiesByEnd = new Map<number, readonly BodyFact[]>();
  for (const body of bodies) bodiesByEnd.set(body.endByte, [...(bodiesByEnd.get(body.endByte) ?? []), body]);
  const callables: CallableFact[] = [];
  for (const symbol of held.symbols) {
    if (!symbol.functionLike || symbol.local) continue;
    const candidates = (bodiesByEnd.get(symbol.span.endByte) ?? []).filter((body) => body.startByte >= symbol.span.startByte);
    const nearest = Math.min(...candidates.map((body) => body.startByte), Number.POSITIVE_INFINITY);
    const body = candidates.filter((candidate) => candidate.startByte === nearest)[0];
    callables.push({
      key: `code.symbol:${path}#${symbol.qualifiedName}`,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      symbolKind: symbol.symbolKind,
      callable: true,
      span: spanOf(path, symbol.span.startByte, symbol.span.endByte, symbol.span.startLine, symbol.span.endLine),
      ...(body === undefined ? {} : {
        bodySpan: spanOf(path, body.bodyStartByte, body.bodyEndByte, body.bodyStartLine, body.bodyEndLine),
        bodySyntaxKind: body.bodySyntaxKind,
      }),
    });
  }
  // Two declarations of one name in two scopes are two callables, and the extract reading names
  // both `code.symbol:<path>#<name>`. A key that repeats takes its own place in the file, so one
  // draft names one node by one key; a name written once keeps the reading's key unchanged.
  const counts = new Map<string, number>();
  for (const callable of callables) counts.set(callable.qualifiedName, (counts.get(callable.qualifiedName) ?? 0) + 1);
  const keyed = callables.map((callable) => (counts.get(callable.qualifiedName) ?? 0) > 1
    ? { ...callable, key: `code.symbol:${path}#${callable.qualifiedName}#${String(callable.span.byteStart)}` }
    : callable);
  return keyed.sort((left, right) => byCodePoint(left.key, right.key));
}

/** One syntax span as the graph's own span. */
function spanOf(path: string, byteStart: number, byteEnd: number, lineStart: number, lineEnd: number): SourceSpan {
  return { path, byteStart, byteEnd, lineStart, lineEnd };
}

/** What one unreadable file says in its coverage: the reader's own words, or the path and the failure where it named none. */
export function gapWhatOf(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${path}:`) ? message : `${path}:1: ${message}`;
}

/**
 * One file's facts, walked from its syntax tree: every named node as an
 * expression with its place, its parent, its named children by field, its
 * operator, its name and — where it holds one — its literal value; every
 * declaration's names as bindings, with the initializer the declaration writes;
 * every call as a call site; every Go struct field by its declaration.
 *
 * The walk is one pass in source order with a stack of scopes, so a binding is
 * recorded under the scope it stands in and an initializer by the expression
 * the declaration names. It reads no other file and keeps no syntax node: the
 * tree is gone when the unit returns.
 */
export function collectFileFacts(repository: string, path: string, text: string, root: SyntaxNodeLike, language: SyntaxLanguage | null): FileFacts {
  const spanOf = spanFactory(text);
  const expressions: ExpressionFact[] = [];
  const bindings: BindingFact[] = [];
  const calls: CallFact[] = [];
  const fields: FieldFact[] = [];
  const exports: ExportFact[] = [];
  const scopeSpans: SourceSpan[] = [toSpan(path, spanOf(root as never))];
  /** The names each scope binds, innermost last: what an identifier expression resolves to. */
  const scopeBindings: Map<string, string>[] = [new Map()];
  const resolveBinding = (name: string): string | undefined => {
    for (let index = scopeBindings.length - 1; index >= 0; index -= 1) {
      const held = scopeBindings[index]!.get(name);
      if (held !== undefined) return held;
    }
    return undefined;
  };

  const idOf = (syntaxKind: string, span: SourceSpan): string => `${EXPRESSION_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}:${syntaxKind}`;
  const spanOfNode = (node: SyntaxNodeLike): SourceSpan => toSpan(path, spanOf(node as never));

  // A node's id is its place and syntax kind; a parser can give two nodes one place (an error node and
  // its child at the same byte), so a second node there takes an ordinal. The parser's own node id is the
  // key — the tree hands out a new object per access, so `namedChildren[0]` and `child(0)` are one node
  // under two objects — and every reference to one node (its parent's field, its own fact) answers the
  // same id.
  const nodeIds = new Map<number, string>();
  const idCounts = new Map<string, number>();
  const idOfNode = (node: SyntaxNodeLike): string => {
    const known = nodeIds.get(node.id);
    if (known !== undefined) return known;
    const base = idOf(node.type, spanOfNode(node));
    const count = idCounts.get(base) ?? 0;
    idCounts.set(base, count + 1);
    const id = count === 0 ? base : `${base}#${String(count)}`;
    nodeIds.set(node.id, id);
    return id;
  };

  /**
   * The text a name node holds, without its quotes: a name is written as written, but for the
   * bytes no JSON string or PostgreSQL text can carry (U+0000 and a lone surrogate), which stand
   * as the escape a reader sees — the same rule the store's writes applied to every property
   * (madarch-8bdc.2.5: a fact is now answered in memory, and still has to be storable).
   */
  const nameOf = (node: SyntaxNodeLike): string => storeText(node.text);

  /** The binding an identifier's name resolves to, in the scopes the walk has entered. */
  const bindingOfName = (name: string): string | undefined => resolveBinding(name);

  /** The id a declaration's name node binds under: the place it stands at, as every binding id is. */
  const bindingIdOfName = (nameNode: SyntaxNodeLike): string => {
    const span = spanOfNode(nameNode);
    return `${BINDING_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}:binding`;
  };

  /** The literal a node holds, decoded where the decoder proves one and raw where it does not. */
  const literalOf = (node: SyntaxNodeLike, kind: LiteralFact['kind']): LiteralFact => {
    const raw = storeText(node.text);
    if (kind === 'boolean') return { kind, raw, value: raw === 'true' };
    if (kind === 'null') return { kind, raw, value: null };
    if (kind === 'number') {
      const value = Number(raw);
      return Number.isFinite(value) ? { kind, raw, value } : { kind, raw };
    }
    const quoted = raw.startsWith('`') && raw.endsWith('`') && node.type === 'template_string' ? raw.slice(1, -1) : undefined;
    // A template with an interpolation holds code, not one value: its raw text stands and no value is claimed.
    if (node.type === 'template_string' && node.namedChildren.some((child) => child !== null && child.type !== 'string_fragment')) return { kind, raw };
    const decoded = quoted === undefined ? decodeQuoted(raw) : storeText(quoted);
    return decoded === undefined ? { kind, raw } : { kind, raw, value: decoded };
  };

  /** The names one declaration binds: a name node, a pattern's names, or a Go identifier list. */
  const declaredNames = (node: SyntaxNodeLike): { readonly name: string; readonly node: SyntaxNodeLike; readonly initializer?: SyntaxNodeLike }[] => {
    const found: { name: string; node: SyntaxNodeLike; initializer?: SyntaxNodeLike }[] = [];
    const visitPattern = (pattern: SyntaxNodeLike | null): void => {
      if (pattern === null) return;
      if (NAME_KINDS.has(pattern.type)) {
        found.push({ name: pattern.text, node: pattern });
        return;
      }
      if (pattern.type === 'object_pattern' || pattern.type === 'array_pattern' || pattern.type === 'expression_list' || pattern.type === 'parenthesized_expression') {
        for (const child of pattern.namedChildren) visitPattern(child);
        return;
      }
      if (pattern.type === 'pair_pattern' || pattern.type === 'shorthand_property_identifier_pattern') {
        const value = pattern.type === 'pair_pattern' ? pattern.childForFieldName('value') : null;
        if (value !== null) visitPattern(value);
        return;
      }
      if (pattern.type === 'rest_pattern' || pattern.type === 'assignment_pattern') {
        visitPattern(pattern.namedChildren[0] ?? null);
      }
    };
    const initializer = node.childForFieldName('value') ?? node.childForFieldName('right') ?? undefined;
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('left') ?? null;
    if (nameNode !== null) visitPattern(nameNode);
    else if (node.type === 'short_var_declaration') {
      const left = node.childForFieldName('left');
      if (left !== null) visitPattern(left);
    }
    if (node.type === 'parameter_declaration' || node.type === 'required_parameter' || node.type === 'optional_parameter' || node.type === 'variadic_parameter_declaration') {
      const pattern = node.childForFieldName('pattern') ?? node.childForFieldName('name');
      if (pattern !== null) {
        found.length = 0;
        visitPattern(pattern);
        // A Go parameter declares one or more names before its type: each is a parameter.
        if (found.length === 0) {
          const name = node.childForFieldName('name');
          if (name !== null) found.push({ name: name.text, node: name });
        }
        return found.map((entry) => ({ ...entry, initializer: undefined }));
      }
      return [];
    }
    return found.map((entry) => ({ ...entry, ...(initializer === undefined ? {} : { initializer }) }));
  };

  const bodies: BodyFact[] = [];
  /** The declaration statements the walk stands inside, innermost last: where a binding's declaration starts. */
  const declarationStarts: SourceSpan[] = [];
  const visit = (node: SyntaxNodeLike, parentId: string | undefined): void => {
    if (!node.isNamed) return;
    if (node.type === 'comment') return;
    const span = spanOfNode(node);
    let invocationSpan: SourceSpan | undefined;
    if (DECLARATION_STATEMENTS.has(node.type)) declarationStarts.push(span);
    const bodyNode = CALLABLE_NODES.has(node.type) ? node.childForFieldName('body') : null;
    if (bodyNode !== null) {
      const bodySpan = spanOfNode(bodyNode);
      bodies.push({
        startByte: span.byteStart, endByte: span.byteEnd, bodyStartByte: bodySpan.byteStart, bodyEndByte: bodySpan.byteEnd,
        bodyStartLine: bodySpan.lineStart, bodyEndLine: bodySpan.lineEnd, bodySyntaxKind: bodyNode.type,
      });
    }
    const id = idOfNode(node);
    const children: string[] = [];
    // A grammar's field names are words a file writes (`constructor` is the field of a
    // `new_expression`), and a plain object inherits `constructor` from Object.prototype: the
    // record is built without a prototype, so a field name can never reach an inherited member.
    const fieldLinks: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    const argumentNodes: SyntaxNodeLike[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child === null || !child.isNamed) continue;
      if (child.type === 'comment') continue;
      const childId = idOfNode(child);
      children.push(childId);
      const fieldName = node.fieldNameForChild(index);
      if (fieldName !== null && fieldName !== '') (fieldLinks[fieldName] ??= []).push(childId);
      if (node.type === 'call_expression' || node.type === 'new_expression') {
        const args = node.childForFieldName('arguments') ?? node.childForFieldName('arguments_list');
        if (args !== null && args.id === child.id) {
          argumentNodes.push(...args.namedChildren.filter((entry): entry is SyntaxNodeLike => entry !== null));
          // The invocation's prefix ends at the opening bracket, which the grammar names as a child.
          for (let inner = 0; inner < args.childCount; inner += 1) {
            const bracket = args.child(inner);
            if (bracket === null || bracket.type !== '(') continue;
            const bracketSpan = spanOfNode(bracket);
            invocationSpan = { path, byteStart: span.byteStart, byteEnd: bracketSpan.byteEnd, lineStart: span.lineStart, lineEnd: bracketSpan.lineEnd };
            break;
          }
        }
      }
    }
    const operatorNode = operatorOf(node);
    const literalKind = LITERAL_KINDS.get(node.type);
    const nameNode = NAME_KINDS.has(node.type) ? node : null;
    const member = node.type === 'member_expression' || node.type === 'selector_expression' ? node.childForFieldName('property') ?? node.childForFieldName('field') : null;
    const object = node.type === 'member_expression' || node.type === 'selector_expression' ? node.childForFieldName('object') ?? node.childForFieldName('operand') : null;
    const callee = node.type === 'call_expression' || node.type === 'new_expression' ? node.childForFieldName('function') ?? node.childForFieldName('constructor') : null;
    const literal = literalKind === undefined ? undefined : literalOf(node, literalKind);
    expressions.push({
      id,
      syntaxKind: node.type,
      span,
      ...(parentId === undefined ? {} : { parent: parentId }),
      children,
      fields: fieldLinks,
      ...(operatorNode === null ? {} : { operator: storeText(operatorNode.text) }),
      ...(nameNode === null ? {} : { name: nameOf(nameNode) }),
      ...(object === null ? {} : { receiver: object === undefined || object === null ? undefined : idOfNode(object) }),
      ...(member === null || member === undefined ? {} : { member: storeText(member.text) }),
      ...(callee === null || callee === undefined ? {} : { callee: idOfNode(callee) }),
      ...(argumentNodes.length === 0 ? {} : { arguments: [...new Set(argumentNodes.map((entry) => idOfNode(entry)))] }),
      ...(node.type !== 'identifier' ? {} : bindingOfName(node.text) === undefined ? {} : { bindingId: bindingOfName(node.text)! }),
      ...(literal === undefined ? {} : { literal }),
    } as ExpressionFact);

    const declares = TS_BINDING_DECLARATIONS.has(node.type) || GO_BINDING_DECLARATIONS.has(node.type) || PARAMETER_KINDS.has(node.type);
    if (declares) {
      for (const entry of declaredNames(node)) {
        // A parameter is a parameter; a Go `const_spec` declares a constant, a TypeScript
        // `variable_declarator` whatever `const`/`let`/`var` its parent says.
        const kind: BindingFact['kind'] = PARAMETER_KINDS.has(node.type) ? 'parameter' : constantDeclaration(node) ? 'local' : 'local';
        const bindingId = `${BINDING_KIND}:${repository}:${path}@${String(spanOfNode(entry.node).byteStart)}:${String(spanOfNode(entry.node).byteEnd)}:binding`;
        const initializer = entry.initializer === undefined ? undefined : spanOfNode(entry.initializer);
        const start = declarationStarts[declarationStarts.length - 1] ?? spanOfNode(entry.node);
        bindings.push({
          id: bindingId,
          name: entry.name,
          kind,
          span: spanOfNode(entry.node),
          scope: scopeSpans[scopeSpans.length - 1]!,
          ...(entry.initializer === undefined ? {} : { initializer: idOfNode(entry.initializer) }),
          ...(initializer === undefined ? {} : {
            declarationSpan: { path, byteStart: start.byteStart, byteEnd: initializer.byteEnd, lineStart: start.lineStart, lineEnd: initializer.lineEnd },
          }),
        });
        scopeBindings[scopeBindings.length - 1]!.set(entry.name, bindingId);
      }
    }
    for (const exported of exportNamesOf(node, bindingIdOfName)) {
      exports.push({
        // One name can be exported twice in one file (a merged type and value), so the id names
        // the place the export stands at as well as the name: one draft names one node by one key.
        id: `${EXPORT_KIND}:${repository}:${path}#${exported.name}@${String(spanOfNode(exported.nameNode).byteStart)}`,
        name: exported.name,
        span: spanOfNode(exported.nameNode),
        ...(exported.localBinding === undefined ? {} : { localBinding: exported.localBinding }),
      });
    }
    for (const imported of importDeclarationsOf(node)) {
      const nameId = `${BINDING_KIND}:${repository}:${path}@${String(spanOfNode(imported.nameNode).byteStart)}:${String(spanOfNode(imported.nameNode).byteEnd)}:binding`;
      bindings.push({
        id: nameId,
        name: imported.local,
        kind: 'import',
        span: spanOfNode(imported.nameNode),
        scope: scopeSpans[0]!,
        specifier: imported.specifier,
        form: imported.form,
        // The import fact and the binding are one record here: its id is the import the
        // evaluator chains, and `importId` names it the way the code pass's binding does.
        importId: nameId,
        ...(imported.importedName === undefined ? {} : { importedName: imported.importedName }),
      });
      scopeBindings[0]!.set(imported.local, nameId);
    }
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      calls.push({
        id: `${CALL_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}`,
        expression: id,
        span,
        ...(invocationSpan === undefined ? {} : { invocationSpan }),
        ...(callee === null || callee === undefined ? {} : { callee: idOfNode(callee) }),
        arguments: [...new Set(argumentNodes.map((entry) => idOfNode(entry)))],
        construct: node.type === 'new_expression',
      });
    }
    if (language === 'go' && node.type === 'field_declaration') {
      const nameNode = node.childForFieldName('name');
      const typeNode = node.childForFieldName('type');
      if (nameNode !== null) {
        fields.push({
          id: `${FIELD_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}`,
          name: nameNode.text,
          ownerTypeName: ownerTypeNameOf(node),
          span,
          ...(typeNode === null ? {} : { typeExpression: idOfNode(typeNode) }),
        });
      }
    }
    // A node that opens a scope binds its own names for its body: the block, the
    // function, the class and the loop each stand as one scope here.
    const opensScope = ['block', 'statement_block', 'function_declaration', 'method_definition', 'arrow_function', 'class_declaration', 'for_statement', 'function', 'func_literal', 'method_declaration'].includes(node.type);
    if (opensScope) {
      scopeSpans.push(span);
      scopeBindings.push(new Map());
    }
    for (const child of node.namedChildren) if (child !== null) visit(child, id);
    if (DECLARATION_STATEMENTS.has(node.type)) declarationStarts.pop();
    if (opensScope) {
      scopeSpans.pop();
      scopeBindings.pop();
    }
  };

  visit(root, undefined);
  // The walk is in source order already; the sort is the one a reader relies on when a
  // grammar hands its children in another order, and it is a code point order of ids.
  expressions.sort((left, right) => (left.span.byteStart - right.span.byteStart) || (left.span.byteEnd - right.span.byteEnd) || byCodePoint(left.id, right.id));
  bindings.sort((left, right) => byCodePoint(left.id, right.id));
  calls.sort((left, right) => byCodePoint(left.id, right.id));
  fields.sort((left, right) => byCodePoint(left.id, right.id));
  return {
    expressions,
    bindings,
    calls,
    fields,
    bodies,
    exports: [...new Map(exports.map((entry) => [`${entry.name}\u0000${String(entry.span.byteStart)}`, entry])).values()].sort((left, right) => byCodePoint(left.id, right.id)),
  };
}

/** The syntax node shape the walk reads: the web-tree-sitter node's own members, named once for this module. */
interface SyntaxNodeLike {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly childCount: number;
  readonly namedChildren: readonly (SyntaxNodeLike | null)[];
  readonly id: number;
  child(index: number): SyntaxNodeLike | null;
  childForFieldName(name: string): SyntaxNodeLike | null;
  fieldNameForChild(index: number): string | null;
}

/**
 * The names an export declaration exports, with the binding the file declares
 * each under: `export const x`, `export function f`, `export class C`, and the
 * names an `export { a, b as c }` clause lists. A binding's id is the place its
 * name stands at, so the export and the binding are one record seen twice.
 */
function exportNamesOf(node: SyntaxNodeLike, bindingAt: (nameNode: SyntaxNodeLike) => string): readonly { readonly name: string; readonly nameNode: SyntaxNodeLike; readonly localBinding?: string }[] {
  if (node.type !== 'export_statement') return [];
  const found: { name: string; nameNode: SyntaxNodeLike; localBinding?: string }[] = [];
  const declaration = node.childForFieldName('declaration');
  if (declaration !== null) {
    if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
      for (const declarator of declaration.namedChildren) {
        if (declarator === null || declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        if (name !== null && NAME_KINDS.has(name.type)) found.push({ name: name.text, nameNode: name, localBinding: bindingAt(name) });
      }
    } else {
      const name = declaration.childForFieldName('name');
      if (name !== null && NAME_KINDS.has(name.type)) found.push({ name: name.text, nameNode: name, localBinding: bindingAt(name) });
    }
  }
  for (const child of node.namedChildren) {
    if (child === null || child.type !== 'export_clause') continue;
    for (const specifier of child.namedChildren) {
      if (specifier === null || specifier.type !== 'export_specifier') continue;
      const name = specifier.childForFieldName('name');
      const alias = specifier.childForFieldName('alias');
      if (name === null) continue;
      found.push({ name: (alias ?? name).text, nameNode: alias ?? name });
    }
  }
  return found;
}

/**
 * The names an import declaration binds, by the form it binds them in: a
 * TypeScript `import`'s default, namespace and named specifiers, and a Go
 * `import_spec`'s name (the package's own last segment where it writes none).
 * The specifier is the text the file wrote, and a file it answers is another
 * file's business: the unit fills `targetPath` from the pinned tree.
 */
function importDeclarationsOf(node: SyntaxNodeLike): readonly { readonly local: string; readonly nameNode: SyntaxNodeLike; readonly specifier: string; readonly form: 'default' | 'namespace' | 'named'; readonly importedName?: string }[] {
  if (node.type !== 'import_statement' && node.type !== 'import_spec') return [];
  const source = node.childForFieldName('source') ?? node.childForFieldName('path');
  if (source === null) return [];
  const specifier = source.text.replace(/^["'`]|["'`]$/g, '');
  if (node.type === 'import_spec') {
    // A Go import binds the package as a whole, under its own last segment or the name the file
    // writes: the library models name that binding form a namespace, and a Go package's member is
    // its export (`slog.New`), never a named import.
    const name = node.childForFieldName('name');
    const local = name === null ? (specifier.slice(specifier.lastIndexOf('/') + 1)) : name.text;
    return [{ local, nameNode: name ?? source, specifier, form: 'namespace' }];
  }
  const found: { local: string; nameNode: SyntaxNodeLike; specifier: string; form: 'default' | 'namespace' | 'named'; importedName?: string }[] = [];
  const visitClause = (clause: SyntaxNodeLike | null): void => {
    if (clause === null) return;
    if (clause.type === 'import_specifier') {
      const name = clause.childForFieldName('name');
      const alias = clause.childForFieldName('alias');
      if (name === null) return;
      found.push({ local: (alias ?? name).text, nameNode: alias ?? name, specifier, form: 'named', importedName: name.text });
      return;
    }
    if (clause.type === 'namespace_import') {
      const name = clause.namedChildren.find((child): child is SyntaxNodeLike => child !== null && child.isNamed) ?? null;
      if (name !== null) found.push({ local: name.text, nameNode: name, specifier, form: 'namespace' });
      return;
    }
    if (clause.type === 'identifier') {
      found.push({ local: clause.text, nameNode: clause, specifier, form: 'default', importedName: 'default' });
      return;
    }
    for (const child of clause.namedChildren) if (child !== null) visitClause(child);
  };
  for (const child of node.namedChildren) {
    if (child === null || child.type === 'string') continue;
    visitClause(child);
  }
  return found;
}

/** The operator a binary, unary or update expression holds, from the field the grammar names it by. */
function operatorOf(node: SyntaxNodeLike): SyntaxNodeLike | null {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.fieldNameForChild(index) === 'operator') return node.child(index);
  }
  return null;
}

/** Whether a declaration writes a constant; kept for the binding's kind where a reader asks. */
function constantDeclaration(node: SyntaxNodeLike): boolean {
  return node.type === 'const_spec' || node.type === 'const_declaration';
}

/** The type a Go struct field belongs to: the struct type's declaration name, where the walk stands inside one. */
function ownerTypeNameOf(node: SyntaxNodeLike): string {
  // The grammar gives no parent link in this binding's public shape, so the walk records the
  // field with the type name its enclosing shape names where it has one; an unnamed struct
  // holds none, and the field keeps the empty name a reader sees as unknown.
  const owner = (node as unknown as { parent?: SyntaxNodeLike | null }).parent;
  let held: SyntaxNodeLike | null | undefined = owner ?? null;
  while (held !== null && held !== undefined) {
    if (held.type === 'type_declaration' || held.type === 'type_spec') {
      const name = held.childForFieldName('name');
      if (name !== null) return name.text;
    }
    held = (held as unknown as { parent?: SyntaxNodeLike | null }).parent ?? null;
  }
  return '';
}

/** One node's span: the bytes and lines a reader counts. */
function toSpan(path: string, span: { readonly startByte: number; readonly endByte: number; readonly startLine: number; readonly endLine: number }): SourceSpan {
  return { path, byteStart: span.startByte, byteEnd: span.endByte, lineStart: span.startLine, lineEnd: span.endLine };
}

/**
 * The text a quoted string token holds, decoded: the escapes a reader can see and
 * a value can hold. A token whose escape this decoder does not know answers
 * `undefined`, and the fact keeps the raw text without claiming a value.
 */
function decodeQuoted(raw: string): string | undefined {
  if (raw.length < 2) return undefined;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || raw[raw.length - 1] !== quote) return undefined;
  const body = raw.slice(1, -1);
  let out = '';
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]!;
    if (char !== '\\') { out += char; continue; }
    const next = body[at + 1];
    if (next === undefined) return undefined;
    at += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === 'v') out += '\v';
    else if (next === '0') out += '\u0000';
    else if (next === 'x') {
      const hex = body.slice(at + 1, at + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      at += 2;
    } else if (next === 'u') {
      const hex = body.slice(at + 1, at + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      at += 4;
    } else if (next === 'u{') {
      const end = body.indexOf('}', at + 2);
      if (end < 0) return undefined;
      const hex = body.slice(at + 2, end);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return undefined;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      at = end;
    } else if (next === '\n') { /* a line continuation holds nothing */ }
    else out += next;
  }
  return storeText(out);
}

/**
 * The text a fact can hold: a JSON string and PostgreSQL's text cannot carry
 * U+0000 or a lone surrogate, so each is kept as the escape a reader sees
 * written (`\u0000`, `\ud800`) instead of disappearing or failing the
 * publication. The source's own escape stays visible, and the fact keeps its
 * place in the graph.
 */
export function storeText(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0) { out += '\\u0000'; continue; }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += text[at]! + text[at + 1]!; at += 1; continue; }
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += text[at]!;
  }
  return out;
}

/** What one unit's draft writes: one node per fact, and the file's declaration of its bindings and calls. */

/** One file's facts as one parse answered them, with what the walk could not read. */
export interface ParsedFileFacts {
  readonly repository: string;
  readonly path: string;
  readonly commit: string;
  /** The blob the bytes stood under: the identity a cache entry and a coverage row compare. */
  readonly blob: string;
  /** Whether a syntax tree was made and walked whole. */
  readonly parsed: boolean;
  readonly facts: FileFacts;
  /** The ports the file's code listens on (`listeningPortsOfTree`), in the order the walk found them. */
  readonly ports: readonly string[];
  /** The callables the file declares or writes as an argument, as the extract readings name them. */
  readonly callables: readonly CallableFact[];
  /** The syntax pass's own findings: what the callables are proved by. */
  readonly findings: ExtractedFileSyntax | undefined;
  /**
   * Why no syntax tree was made, where none was: `unsupported` for a path no
   * grammar of this stage reads, `error` for bytes that are not UTF-8 text or a
   * parser that answered nothing. Null where the tree was walked.
   */
  readonly unreadReason: 'unsupported' | 'error' | 'too-large' | 'inaccessible' | 'budget' | null;
  /** What the walk could not read of a file it did read: the ports' reading, a tree with errors. */
  readonly gaps: readonly { readonly what: string; readonly reason: 'unsupported' | 'error' | 'too-large' | 'inaccessible' | 'budget' }[];
}

/** How one file's parse answers: the bytes, the tree in them, and the pinned tree the imports answer in. */
export interface FileFactsInput {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly blob: string;
  readonly bytes: Uint8Array;
  /** Whether the pinned tree holds a path: the one question an import's specifier is resolved by. */
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * Reads one file's bytes and answers its facts: one parse, the driver's own
 * walk, and the import specifiers tied to the files the pinned tree holds. Pure
 * but for `exists`, and every answer depends on the bytes and the blob alone, so
 * a cache may keep it.
 */
export async function parseFileFacts(input: FileFactsInput): Promise<ParsedFileFacts> {
  const gaps: { what: string; reason: 'unsupported' | 'error' | 'too-large' | 'inaccessible' | 'budget' }[] = [];
  let facts: FileFacts = { expressions: [], bindings: [], calls: [], fields: [], bodies: [], exports: [] };
  let ports: readonly string[] = [];
  let findings: ExtractedFileSyntax | undefined;
  let parsed = false;
  const read = await readSyntaxTree(input.path, input.bytes, (tree) => {
    const held = collectFileFacts(input.repository, input.path, tree.text, tree.root, tree.language);
    const findings = readFileFindings(tree);
    try {
      return { facts: held, ports: listeningPortsOfTree(input.path, tree.root, tree.language), findings };
    } catch (error) {
      return { facts: held, ports: [] as readonly string[], portsGap: gapWhatOf(error, input.path), findings };
    }
  });
  let unreadReason: 'unsupported' | 'error' | 'too-large' | 'inaccessible' | 'budget' | null = null;
  if (!read.read) {
    unreadReason = read.unread[0]?.reason ?? 'error';
  } else {
    facts = read.value.facts;
    ports = read.value.ports;
    findings = read.value.findings;
    parsed = true;
    if ('portsGap' in read.value && read.value.portsGap !== undefined) gaps.push({ what: read.value.portsGap, reason: 'error' });
    if (read.complete === false) gaps.push({ what: `${input.path} is read with syntax errors`, reason: 'error' });
  }
  let callables: readonly CallableFact[] = [];
  if (findings !== undefined) {
    try {
      callables = await callablesOfFile(input.path, input.bytes, findings, facts.bodies);
    } catch (error) {
      gaps.push({ what: gapWhatOf(error, input.path), reason: 'error' });
    }
  }
  // An import's specifier is tied to the file it answers through a path-scoped lookup of the
  // pinned tree, one candidate at a time: no list of the repository's files is read for it, and
  // the same specifier answers the same file on every reader's parse of this blob.
  if (facts.bindings.some((binding) => binding.kind === 'import' && binding.targetPath === undefined)) {
    const resolved: BindingFact[] = [];
    for (const binding of facts.bindings) {
      if (binding.kind !== 'import' || binding.specifier === undefined || binding.targetPath !== undefined) {
        resolved.push(binding);
        continue;
      }
      let targetPath: string | undefined;
      for (const candidate of importCandidates(input.path, binding.specifier)) {
        if (await input.exists(candidate)) {
          targetPath = candidate;
          break;
        }
      }
      resolved.push(targetPath === undefined ? binding : { ...binding, targetPath });
    }
    facts = { ...facts, bindings: resolved.sort((left, right) => byCodePoint(left.id, right.id)) };
  }
  return { repository: input.repository, path: input.path, commit: input.commit, blob: input.blob, parsed, facts, ports, callables, findings, unreadReason, gaps };
}

/** What a run's parsed files cost and answered: the size of the memory and the work it saved. */
interface FileFactsStats {
  /** Parses this cache made: one per entry, and one again after an entry left the bound. */
  parses: number;
  /** Answers the cache gave without a parse. */
  hits: number;
  /** Entries held now. */
  entries: number;
  /** Bytes of source text held now. */
  bytes: number;
  /** Entries a full cache pushed out. */
  evictions: number;
}

/** A run's memory of parsed files: one parse per (repository, commit, path, blob), bounded. */
export interface FileFactsCache {
  /** The file's facts, parsed now or answered from the memory. */
  parse(input: FileFactsInput): Promise<ParsedFileFacts>;
  readonly stats: FileFactsStats;
}

/**
 * The bound of the cache: files and bytes of source text. A fill of a mid-sized
 * repository holds every file it reads (the training repository holds 154); a
 * repository past the bound keeps the most recently read files and parses the
 * others again, which costs a parse and never a wrong answer.
 */
const FILE_FACTS_CACHE_LIMITS = { entries: 512, bytes: 64 * 1024 * 1024 } as const;

/** One run's parse memory: a least-recently-used map of the files it read, bounded by files and by bytes. */
export function createFileFactsCache(limits: { readonly entries: number; readonly bytes: number } = FILE_FACTS_CACHE_LIMITS): FileFactsCache {
  const held = new Map<string, ParsedFileFacts>();
  const sizes = new Map<string, number>();
  const stats: FileFactsStats = { parses: 0, hits: 0, entries: 0, bytes: 0, evictions: 0 };
  const settle = (): void => {
    stats.entries = held.size;
    stats.bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  };
  return {
    stats,
    async parse(input: FileFactsInput): Promise<ParsedFileFacts> {
      const key = `${input.repository}\u0000${input.commit}\u0000${input.path}\u0000${input.blob}`;
      const known = held.get(key);
      if (known !== undefined) {
        // A hit moves the entry to the young end: the bound forgets what nothing asked for last.
        held.delete(key);
        held.set(key, known);
        stats.hits += 1;
        return known;
      }
      const parsed = await parseFileFacts(input);
      stats.parses += 1;
      held.set(key, parsed);
      sizes.set(key, input.bytes.byteLength);
      while (held.size > limits.entries || [...sizes.values()].reduce((sum, size) => sum + size, 0) > limits.bytes) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
        sizes.delete(oldest);
        stats.evictions += 1;
      }
      settle();
      return parsed;
    },
  };
}
