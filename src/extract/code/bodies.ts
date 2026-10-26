/**
 * The calls and references the plain-name resolver does not see: a member
 * reached through a value (`h.svc.Place(...)`, `this.deps.repository.create(...)`)
 * and a name qualified by a Go package (`application.NewService`, a
 * `domain.Order` type). The walk keeps a small scope of what each local name
 * holds (parameters, receivers, `x := f()`, `const x = new T()`), types an
 * expression from the declarations of the repository (`Program`), and records
 * a site where the expression names a member or a top-level name it can tie to
 * a symbol.
 *
 * It claims only what the declarations say: a value of a type outside the
 * repository, a map or function value, an `any`, has no type here, and a
 * member reached through it has no site. A call through an interface site
 * names the interface's method and, in `fanOut`, the same method of each type
 * that implements the interface.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { readSyntaxTree, spanFactory, type SyntaxSpan } from '../../fill/stages/syntax-extract.js';
import { goTypeName, tsTypeName } from './decls.js';
import type { Program, Ty, TopInfo } from './program.js';
import type { SourceFile } from './source.js';
import { fileKey, symbolKey } from './keys.js';
import { codeQuery } from './query.js';
import { decodeNumberToken, decodeStringToken } from './literals.js';
import { codeFactId, type CodeBindingFact, type CodeCallFact, type CodeExpressionFact, type CodeImportFact, type CodeExportFact, type CodeFieldFact } from './facts.js';
import type { ExtractionGap, SourceSpan } from '../records.js';
import { holderAt, type FileSymbol } from './symbols.js';

export interface MemberSite {
  readonly span: SyntaxSpan;
  /** The symbol key the site reaches. */
  readonly to: string;
  readonly use: 'call' | 'reference' | 'type';
  readonly roles?: readonly string[];
  /** The same member of each implementor, when the site reaches an interface's method. */
  readonly fanOut: readonly string[];
}

function textOf(node: SyntaxNode, text: string): string {
  return text.slice(node.startIndex, node.endIndex);
}

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

const FUNCTION_NODES: ReadonlySet<string> = new Set([
  'arrow_function', 'func_literal', 'function', 'function_declaration', 'function_expression', 'generator_function',
  'generator_function_declaration', 'method_declaration', 'method_definition',
]);

export interface MemberFacts {
  readonly sites: readonly MemberSite[];
  readonly accesses: ReadonlyMap<number, readonly string[]>;
  readonly suppressed: ReadonlySet<number>;
  readonly bindings: readonly CodeBindingFact[];
  readonly expressions: readonly CodeExpressionFact[];
  readonly calls: readonly CodeCallFact[];
  readonly exports: readonly CodeExportFact[];
  readonly fields: readonly CodeFieldFact[];
  readonly typeOnlyImports: readonly string[];
  readonly callables: readonly { readonly key: string; readonly bodySpan: SourceSpan; readonly bodySyntaxKind: string; readonly receiver?: { readonly bindingId: string; readonly name: string; readonly typeName?: string } }[];
  readonly gaps: readonly ExtractionGap[];
  readonly read: boolean;
}

export async function memberSites(file: SourceFile, program: Program, imports: readonly CodeImportFact[] = [], symbols: readonly FileSymbol[] = []): Promise<MemberFacts> {
  const ctx = program.files.get(file.path);
  if (ctx === undefined) return { sites: [], accesses: new Map(), suppressed: new Set(), bindings: [], expressions: [], calls: [], exports: [], fields: [], typeOnlyImports: [], callables: [], gaps: [], read: false };
  const go = file.language === 'go';
  const read = await readSyntaxTree(file.path, file.bytes, (parsed) => {
    const text = parsed.text;
    const spanOf = spanFactory(text);
    const sites: MemberSite[] = [];
    const accesses = new Map<number, readonly string[]>();
    const suppressed = new Set<number>();
    const scopes: Map<string, Ty | null>[] = [new Map()];
    const typeParameters: Set<string>[] = [];
    const captures = parsed.captures(codeQuery(parsed.language));
    const captured = new Set(captures.map((capture) => capture.node.id));
    const sourceSpan = (node: SyntaxNode): SourceSpan => {
      const span = spanOf(node);
      return { path: file.path, byteStart: span.startByte, byteEnd: span.endByte, lineStart: span.startLine, lineEnd: span.endLine };
    };
    const expressionId = (node: SyntaxNode): string => codeFactId(sourceSpan(node), node.type);
    const factScopes: Map<string, string>[] = [new Map()];
    const goAmbiguousScopes: Set<string>[] = [new Set()];
    const scopeSpans: SourceSpan[] = [sourceSpan(parsed.root)];
    const scopeNodes: SyntaxNode[] = [parsed.root];
    const bindings = new Map<string, CodeBindingFact>();
    const expressions = new Map<string, CodeExpressionFact>();
    const calls = new Map<string, CodeCallFact>();
    const fields: CodeFieldFact[] = [];
    const callables: { key: string; bodySpan: SourceSpan; bodySyntaxKind: string; receiver?: { bindingId: string; name: string; typeName?: string } }[] = [];
    const factGaps = new Map<string, ExtractionGap>();
    const lookupBinding = (name: string): string | undefined => {
      for (let i = factScopes.length - 1; i >= 0; i--) {
        const bound = factScopes[i]!.get(name);
        if (bound !== undefined) return bound;
      }
      return undefined;
    };
    for (const imported of imports) {
      const id = codeFactId(imported.span, 'binding');
      factScopes[0]!.set(imported.local, id);
      bindings.set(id, { id, path: file.path, name: imported.local, kind: 'import', span: imported.span, scope: scopeSpans[0]!, importId: imported.id });
    }
    const pushScope = (node: SyntaxNode): void => { scopes.push(new Map()); factScopes.push(new Map()); goAmbiguousScopes.push(new Set()); scopeSpans.push(sourceSpan(node)); scopeNodes.push(node); };
    const popScope = (): void => { scopes.pop(); factScopes.pop(); goAmbiguousScopes.pop(); scopeSpans.pop(); scopeNodes.pop(); };
    const genericNames: Set<string>[] = [];
    const compositeProof = (node: SyntaxNode, type: SyntaxNode | null): import('./facts.js').CodeExpressionFact['compositeType'] => {
      if (!go || node.type !== 'composite_literal' || type === null) return undefined;
      if (type.type === 'struct_type') return { shape: 'struct', typeExpression: expressionId(type), declarationSpan: sourceSpan(type) };
      if (type.type !== 'type_identifier' || typeParameters.some((scope) => scope.has(textOf(type,text))) ||
        genericNames.some((scope) => scope.has(textOf(type,text)))) return undefined;
      const bindingId = lookupBinding(textOf(type, text));
      const binding = bindingId === undefined ? undefined : bindings.get(bindingId);
      const declaration = binding?.typeDeclaration;
      if (binding?.kind !== 'type' || declaration?.shape !== 'struct' || sourceSpan(type).byteStart < declaration.scopeStart) return undefined;
      return { shape: 'struct', typeExpression: expressionId(type), declarationSpan: declaration.declarationSpan,
        bindingId: binding.id, declarationExpression: declaration.expression };
    };
    const recordExpression = (node: SyntaxNode, resolveBinding = true): void => {
      if (!captured.has(node.id)) return;
      const id = expressionId(node);
      const span = sourceSpan(node);
      const token = textOf(node, text);
      const isName = ['identifier', 'property_identifier', 'field_identifier', 'shorthand_property_identifier', 'this', 'type_identifier', 'package_identifier'].includes(node.type);
      const lexicalName = !['property_identifier', 'field_identifier'].includes(node.type);
      const generic = genericNames.some((scope) => scope.has(token));
      const candidateBinding = resolveBinding && lexicalName && !generic ? lookupBinding(token) : undefined;
      const binding = candidateBinding === undefined ? undefined : bindings.get(candidateBinding);
      const availableBinding = binding !== undefined && binding.kind === 'local' && span.byteStart < binding.span.byteStart ? undefined : candidateBinding;
      if (binding !== undefined && availableBinding === undefined) factGaps.set(id, { path: file.path, reason: `line ${span.lineStart}: lexical binding is not initialized at bytes ${span.byteStart}-${span.byteEnd}` });
      const object = node.childForFieldName(node.type === 'qualified_type' ? 'package' : go ? 'operand' : 'object');
      const property = node.childForFieldName(node.type === 'qualified_type' ? 'name' : go ? 'field' : 'property');
      const callee = node.childForFieldName(node.type === 'new_expression' ? 'constructor' : node.type === 'composite_literal' ? 'type' : 'function');
      const args = node.childForFieldName(node.type === 'composite_literal' ? 'body' : 'arguments');
      const isCall = ['call_expression', 'new_expression', 'composite_literal'].includes(node.type);
      const argumentsOf = (): string[] => node.type === 'composite_literal' ? args === null ? [] : [expressionId(args)] : (args === null ? [] : named(args)).filter((arg) => arg.type !== 'comment').map(expressionId);
      const literalKind = ['string', 'template_string', 'interpreted_string_literal', 'raw_string_literal'].includes(node.type) ? 'string'
        : ['number', 'int_literal', 'float_literal'].includes(node.type) ? 'number'
        : ['true', 'false'].includes(node.type) ? 'boolean' : ['null', 'nil'].includes(node.type) ? 'null' : undefined;
      const isMember = node.type === 'member_expression' || node.type === 'selector_expression' || node.type === 'qualified_type';
      const fieldEntries = new Map<string, string[]>();
      node.namedChildren.forEach((child, index) => {
        if (child === null) return;
        const field = node.fieldNameForNamedChild(index);
        if (field !== null) { const held = fieldEntries.get(field) ?? []; held.push(expressionId(child)); fieldEntries.set(field, held); }
      });
      const fields: Record<string, string[]> = Object.fromEntries(fieldEntries);
      const decoded = literalKind === 'string' ? decodeStringToken(node.type, token) : literalKind === 'boolean' ? token === 'true' : literalKind === 'null' ? null : literalKind === 'number' ? decodeNumberToken(node.type, token, go) : undefined;
      const value = typeof decoded === 'number' && !Number.isFinite(decoded) ? undefined : decoded;
      const dynamicTemplate = node.type === 'template_string' && named(node).some((child) => child.type === 'template_substitution');
      // A parsed interpolation is a supported dynamic expression, not an unread
      // literal. Static consumers still receive no value and must report a gap.
      if (literalKind !== undefined && value === undefined && !dynamicTemplate) factGaps.set(id, { path: file.path, reason: `line ${span.lineStart}: unsupported ${node.type} literal at bytes ${span.byteStart}-${span.byteEnd}` });
      const typeProof = resolveBinding ? compositeProof(node, callee) : undefined;
      const operatorNode = node.childForFieldName('operator');
      const unaryTokens = node.type === 'unary_expression' ? node.children.filter((child): child is SyntaxNode => child !== null && !child.isNamed) : [];
      const operator = operatorNode?.type ?? (unaryTokens.length === 1 ? unaryTokens[0]!.type : undefined);
      expressions.set(id, {
        id, path: file.path, syntaxKind: node.type, span,
        ...(operator === undefined ? {} : { operator }),
        ...(isName ? { name: token, ...(availableBinding === undefined ? {} : { bindingId: availableBinding }) } : {}),
        ...(isMember && object !== null && property !== null ? { receiver: expressionId(object), member: textOf(property, text) } : {}),
        ...(callee !== null && isCall ? { callee: expressionId(callee), arguments: argumentsOf() } : {}),
        ...(typeProof === undefined ? {} : { compositeType: typeProof }),
        children: named(node).map(expressionId), fields,
        ...(literalKind === undefined ? {} : { literal: { kind: literalKind, raw: token, ...(value === undefined ? {} : { value }) } }),
      });
      if (callee !== null && isCall) {
        const holder = holderAt(symbols, span.byteStart);
        const opening = args?.children.find((child) => child?.type === '(');
        const invocationSpan = opening === undefined || opening === null ? undefined : {
          path: file.path, byteStart: span.byteStart, byteEnd: sourceSpan(opening).byteEnd,
          lineStart: span.lineStart, lineEnd: sourceSpan(opening).lineEnd,
        };
        calls.set(id, { expression: id, path: file.path, span, ...(invocationSpan === undefined ? {} : { invocationSpan }),
          callee: expressionId(callee), arguments: argumentsOf(), holder: holder?.keptKey ?? fileKey(file.path), construct: node.type === 'new_expression' || node.type === 'composite_literal' });
      }
    };

    const lookup = (name: string): Ty | null | undefined => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const held = scopes[i]!;
        if (held.has(name)) return held.get(name);
      }
      return undefined;
    };
    const bind = (name: string, ty: Ty | undefined, node?: SyntaxNode, kind: CodeBindingFact['kind'] = 'local', initializer?: SyntaxNode | null): void => {
      if (name === '_') return;
      scopes[scopes.length - 1]!.set(name, ty ?? null);
      if (node === undefined) return;
      const span = sourceSpan(node);
      const id = codeFactId(span, 'binding');
      if (go && goAmbiguousScopes[goAmbiguousScopes.length - 1]!.has(name)) {
        recordExpression(node); return;
      }
      factScopes[factScopes.length - 1]!.set(name, id);
      const previous = bindings.get(id);
      let declarationSpan: SourceSpan | undefined;
      if (initializer !== undefined && initializer !== null) {
        const end = sourceSpan(initializer);
        const parent = node.parent;
        const declaration = parent?.type === 'variable_declarator' ? parent.parent : parent?.type === 'var_spec' || parent?.type === 'const_spec' ? parent.parent : undefined;
        const start = declaration !== undefined && declaration !== null && ['lexical_declaration', 'variable_declaration', 'var_declaration', 'const_declaration'].includes(declaration.type) ? sourceSpan(declaration) : span;
        declarationSpan = { path: file.path, byteStart: start.byteStart, byteEnd: end.byteEnd, lineStart: start.lineStart, lineEnd: end.lineEnd };
      }
      bindings.set(id, { id, path: file.path, name, kind, span, scope: previous?.scope ?? scopeSpans[scopeSpans.length - 1]!, ...(initializer === undefined || initializer === null ? {} : { initializer: expressionId(initializer) }), ...(declarationSpan === undefined ? {} : { declarationSpan }) });
      recordExpression(node);
    };
    const bindPattern = (node: SyntaxNode, kind: CodeBindingFact['kind']): void => {
      if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') { bind(textOf(node, text), undefined, node, kind); return; }
      if (node.type === 'pair_pattern') { const value = node.childForFieldName('value'); if (value !== null) bindPattern(value, kind); return; }
      if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') { const left = node.childForFieldName('left'); if (left !== null) bindPattern(left, kind); return; }
      if (['object_pattern', 'array_pattern', 'rest_pattern'].includes(node.type)) for (const child of named(node)) bindPattern(child, kind);
    };
    const reserveFunctionVars = (root: SyntaxNode): void => {
      const visit = (node: SyntaxNode): void => {
        if (node !== root && (FUNCTION_NODES.has(node.type) || ['class', 'class_declaration', 'abstract_class_declaration'].includes(node.type))) return;
        if (node.type === 'variable_declaration') for (const declarator of named(node)) {
          const name = declarator.childForFieldName('name');
          if (name !== null) bindPattern(name, 'local');
        }
        for (const child of named(node)) visit(child);
      };
      visit(root);
    };
    const asType = (id: string | undefined): Ty | undefined => (id === undefined ? undefined : { t: 'type', id });
    const typeFrom = (written: string | undefined): Ty | undefined =>
      written !== undefined && typeParameters.some((scope) => scope.has(written)) ? undefined : asType(program.resolveTypeText(written, file.path));
    const pushTypeParameters = (node: SyntaxNode): void => {
      const parameters = node.childForFieldName('type_parameters');
      const names = new Set<string>();
      for (const parameter of parameters === null ? [] : named(parameters)) {
        const name = parameter.childForFieldName('name') ?? named(parameter)[0];
        if (name !== undefined && name !== null) names.add(textOf(name, text));
      }
      typeParameters.push(names);
    };

    const evalTop = (top: TopInfo, scope: string): Ty | undefined => {
      if (top.kind === 'type') return { t: 'type', id: `${scope}#${top.name}` };
      if (top.kind === 'var') return asType(program.resolveTypeText(top.varType, top.file));
      return undefined;
    };

    const evalIdentifier = (name: string): Ty | undefined => {
      const bound = lookup(name);
      if (bound !== undefined) return bound ?? undefined;
      const binding = ctx.imports.get(name);
      if (binding !== undefined) {
        if (binding.kind === 'package') return { t: 'scope', scope: binding.scope };
        if (binding.kind === 'namespace') return { t: 'scope', scope: binding.file };
        const top = program.top(binding.file, binding.kind === 'named' ? binding.name : 'default');
        return top === undefined ? undefined : evalTop(top, binding.file);
      }
      const top = program.top(ctx.scope, name);
      return top === undefined ? undefined : evalTop(top, ctx.scope);
    };

    const parts = (node: SyntaxNode): { object: SyntaxNode | null; property: SyntaxNode | null } =>
      go
        ? { object: node.childForFieldName('operand'), property: node.childForFieldName('field') }
        : { object: node.childForFieldName('object'), property: node.childForFieldName('property') };

    /** What a call to this callee gives back: a function's first result, or the type a conversion or constructor makes. */
    const callResult = (callee: SyntaxNode): Ty | undefined => {
      if (callee.type === 'identifier') {
        const name = textOf(callee, text);
        if (lookup(name) !== undefined) return undefined;
        const binding = ctx.imports.get(name);
        const top = binding !== undefined && (binding.kind === 'named' || binding.kind === 'default')
          ? program.top(binding.file, binding.kind === 'named' ? binding.name : 'default')
          : binding === undefined ? program.top(ctx.scope, name) : undefined;
        if (top === undefined) return undefined;
        if (top.kind === 'type') return { t: 'type', id: `${program.files.get(top.file)?.scope ?? top.file}#${top.name}` };
        return top.kind === 'func' ? typeFrom2(top.returns, top.file) : undefined;
      }
      if (callee.type === 'selector_expression' || callee.type === 'member_expression') {
        const { object, property } = parts(callee);
        if (object === null || property === null) return undefined;
        const holder = evaluate(object);
        if (holder === undefined) return undefined;
        const name = textOf(property, text);
        if (holder.t === 'scope') {
          const top = program.top(holder.scope, name);
          if (top === undefined) return undefined;
          if (top.kind === 'type') return { t: 'type', id: `${holder.scope}#${top.name}` };
          return top.kind === 'func' ? typeFrom2(top.returns, top.file) : undefined;
        }
        const found = program.findMember(holder.id, name);
        return found !== undefined && found.member.kind === 'method' ? typeFrom2(found.member.type, found.member.file) : undefined;
      }
      return undefined;
    };
    const typeFrom2 = (written: string | undefined, fromFile: string): Ty | undefined => asType(program.resolveTypeText(written, fromFile));

    const evaluate = (node: SyntaxNode | null | undefined): Ty | undefined => {
      if (node === null || node === undefined) return undefined;
      switch (node.type) {
        case 'identifier':
        case 'this':
          return evalIdentifier(textOf(node, text));
        case 'parenthesized_expression':
        case 'await_expression':
        case 'non_null_expression':
        case 'as_expression':
        case 'satisfies_expression':
        case 'unary_expression':
          return evaluate(named(node)[0]);
        case 'selector_expression':
        case 'member_expression': {
          const { object, property } = parts(node);
          if (object === null || property === null) return undefined;
          const holder = evaluate(object);
          if (holder === undefined) return undefined;
          const name = textOf(property, text);
          if (holder.t === 'scope') {
            const top = program.top(holder.scope, name);
            return top === undefined ? undefined : evalTop(top, holder.scope);
          }
          const found = program.findMember(holder.id, name);
          return found !== undefined && found.member.kind === 'field' ? typeFrom2(found.member.type, found.member.file) : undefined;
        }
        case 'call_expression':
          return callResult(node.childForFieldName('function') ?? node);
        case 'new_expression': {
          const made = node.childForFieldName('constructor');
          return evaluate(made);
        }
        case 'composite_literal':
          return typeFrom(goTypeName(node.childForFieldName('type'), text));
        default:
          return undefined;
      }
    };

    /** Assignment targets are writes; a compound assignment or increment also reads. */
    const accessRoles = (node: SyntaxNode): readonly string[] => {
      const parent = node.parent;
      if (parent === null) return ['read-access'];
      // Index writes affect only the indexed operand. The key is still a read,
      // even when it is another resolved field of the same receiver.
      if (parent.type === 'index_expression' && parent.childForFieldName('operand')?.id === node.id) return accessRoles(parent);
      if (['update_expression', 'inc_statement', 'dec_statement'].includes(parent.type)) return ['read-access', 'write-access'];
      if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement'].includes(parent.type)) {
        const left = parent.childForFieldName('left');
        if (left !== null && left.startIndex <= node.startIndex && node.endIndex <= left.endIndex) {
          const operator = parent.childForFieldName('operator');
          const written = operator === null ? text.slice(left.endIndex, (parent.childForFieldName('right')?.startIndex ?? parent.endIndex)).trim() : textOf(operator, text);
          return written === '=' ? ['write-access'] : ['read-access', 'write-access'];
        }
      }
      // Go's assignment left side is an expression list, not the selector's immediate parent.
      if (parent.type === 'expression_list' && parent.parent?.type === 'assignment_statement') return accessRoles(parent);
      return ['read-access'];
    };

    /** Records the site of a member or qualified name: `object.name`. */
    const memberSite = (node: SyntaxNode, use: 'call' | 'reference'): void => {
      const { object, property } = parts(node);
      if (object === null || property === null) return;
      const holder = evaluate(object);
      if (holder === undefined) return;
      const name = textOf(property, text);
      if (holder.t === 'scope') {
        const top = program.top(holder.scope, name);
        if (top === undefined) return;
        sites.push({ span: spanOf(property), to: symbolKey(top.file, top.name), use, roles: top.kind === 'var' ? accessRoles(node) : ['read-access'], fanOut: [] });
        return;
      }
      const found = program.findMember(holder.id, name);
      if (found === undefined) return;
      if (found.member.kind === 'field') {
        sites.push({ span: spanOf(property), to: symbolKey(found.member.file, found.member.qualifiedName), use: 'reference', roles: accessRoles(node), fanOut: [] });
        return;
      }
      const fanOut: string[] = [];
      if (found.owner.kind === 'interface') {
        for (const impl of program.implementorsOf(found.owner.id)) {
          const implemented = program.findMember(impl.id, name);
          if (implemented !== undefined && implemented.member.kind === 'method') fanOut.push(symbolKey(implemented.member.file, implemented.member.qualifiedName));
        }
      }
      sites.push({ span: spanOf(property), to: symbolKey(found.member.file, found.member.qualifiedName), use, fanOut: [...new Set(fanOut)].sort() });
    };

    const bindParameters = (list: SyntaxNode | null): void => {
      if (list === null) return;
      for (const parameter of named(list)) {
        if (go) {
          if (parameter.type !== 'parameter_declaration' && parameter.type !== 'variadic_parameter_declaration') continue;
          const ty = typeFrom(goTypeName(parameter.childForFieldName('type'), text));
          for (const name of parameter.childrenForFieldName('name')) if (name !== null) bind(textOf(name, text), ty, name, 'parameter');
        } else {
          if (['identifier', 'object_pattern', 'array_pattern', 'rest_pattern', 'assignment_pattern'].includes(parameter.type)) { bindPattern(parameter, 'parameter'); continue; }
          if (parameter.type !== 'required_parameter' && parameter.type !== 'optional_parameter') continue;
          const pattern = parameter.childForFieldName('pattern');
          if (pattern === null) continue;
          if (pattern.type === 'identifier') bind(textOf(pattern, text), typeFrom(tsTypeName(parameter.childForFieldName('type'), text)), pattern, 'parameter');
          else bindPattern(pattern, 'parameter');
        }
      }
    };

    const declareGoType = (spec: SyntaxNode, fileScope: boolean): void => {
      const name = spec.childForFieldName('name'); const type = spec.childForFieldName('type');
      if (name === null || type === null) return;
      const written = textOf(name, text); const scope = scopeSpans[scopeSpans.length - 1]!;
      if (goAmbiguousScopes[goAmbiguousScopes.length - 1]!.has(written)) return;
      const span = sourceSpan(name); const id = codeFactId(span, 'type-binding');
      factScopes[factScopes.length - 1]!.set(written, id);
      bindings.set(id, { id, path:file.path, name:written, kind:'type', span, scope,
        typeDeclaration: { expression:expressionId(spec), nameExpression:expressionId(name), typeExpression:expressionId(type),
          declarationSpan:sourceSpan(spec), scopeExpression:expressionId(scopeNodes[scopeNodes.length-1]!), scopeStart:fileScope ? scope.byteStart : span.byteStart,
          shape:spec.type === 'type_spec' && type.type === 'struct_type' && spec.childForFieldName('type_parameters') === null ? 'struct' : 'unknown' } });
    };
    const prepareGoScope = (node: SyntaxNode, fileScope: boolean): void => {
      // Only this grammar's direct statement list is transparent. Nested blocks,
      // functions and arbitrary descendants never contribute declarations here.
      const direct = named(node).flatMap((child) => child.type === 'statement_list' ? named(child) : [child]);
      const names = new Map<string, SyntaxNode[]>(); const types: SyntaxNode[] = [];
      const add = (name: SyntaxNode): void => { const key = textOf(name,text); const held = names.get(key) ?? []; held.push(name); names.set(key,held); };
      for (const entry of direct) {
        if (entry.type === 'type_declaration') for (const spec of named(entry)) {
          if (!['type_spec','type_alias'].includes(spec.type)) continue;
          const name = spec.childForFieldName('name'); if (name !== null) { add(name); types.push(spec); }
        }
        if (['var_declaration','const_declaration'].includes(entry.type)) for (const spec of named(entry).flatMap((child) => child.type === 'var_spec_list' ? named(child) : [child])) {
          for (const name of spec.childrenForFieldName('name')) if (name !== null) add(name);
        }
        if (entry.type === 'short_var_declaration') {
          const left=entry.childForFieldName('left'); for(const name of left===null?[]:named(left)) if(name.type==='identifier') {
            const written=textOf(name,text);
            const previous=names.get(written)??[];
            const priorType=previous.some((entry)=>entry.parent?.type==='type_spec'||entry.parent?.type==='type_alias');
            const functionBody=node.parent!==null && FUNCTION_NODES.has(node.parent.type) && node.parent.childForFieldName('body')?.id===node.id;
            const parameter=functionBody && factScopes.length>1 ? bindings.get(factScopes[factScopes.length-2]!.get(written)??'') : undefined;
            if(priorType || parameter?.kind!=='parameter' && !names.has(written) && !factScopes[factScopes.length-1]!.has(written))add(name);
          }
        }
        if (fileScope && ['function_declaration','method_declaration'].includes(entry.type)) {
          const name=entry.childForFieldName('name'); if(name!==null&&entry.type==='function_declaration')add(name);
        }
      }
      const scope = scopeSpans[scopeSpans.length - 1]!;
      for (const [name, declarations] of names) {
        const current = factScopes[factScopes.length-1]!.get(name);
        const parent = factScopes.length>1 ? bindings.get(factScopes[factScopes.length-2]!.get(name) ?? '') : undefined;
        const parentNode=node.parent;
        const functionBody=parentNode!==null && FUNCTION_NODES.has(parentNode.type) && parentNode.childForFieldName('body')?.id===node.id;
        const clash = declarations.length>1 || current!==undefined || functionBody && parent?.kind==='parameter';
        if (!clash) continue;
        const span=sourceSpan(declarations[0]!); const id=codeFactId(span,'ambiguous-binding');
        goAmbiguousScopes[goAmbiguousScopes.length-1]!.add(name);factScopes[factScopes.length-1]!.set(name,id);
        bindings.set(id,{id,path:file.path,name,kind:'local',span,scope});
        factGaps.set(id,{path:file.path,reason:`line ${span.lineStart}: ambiguous same-scope Go declaration at bytes ${span.byteStart}-${span.byteEnd}`});
      }
      if(fileScope)for(const spec of types)declareGoType(spec,true);
    };
    const visitChildren = (node: SyntaxNode): void => {
      for (const child of named(node)) visit(child);
    };

    const visit = (node: SyntaxNode): void => {
      const type = node.type;
      recordExpression(node);
      if (type === 'identifier' || type === 'shorthand_property_identifier') accesses.set(spanOf(node).startByte, accessRoles(node));
      if (FUNCTION_NODES.has(type)) {
        pushScope(node);
        if (!go) reserveFunctionVars(node);
        pushTypeParameters(node);
        const genericParameters = node.childForFieldName('type_parameters');
        genericNames.push(new Set(genericParameters === null ? [] : named(genericParameters).flatMap((parameter) =>
          parameter.childrenForFieldName('name').filter((name): name is SyntaxNode => name !== null).map((name) => textOf(name,text)))));
        if (go) {
          bindParameters(node.childForFieldName('receiver'));
          bindParameters(node.childForFieldName('parameters'));
        } else {
          bindParameters(node.childForFieldName('parameters'));
          const single = node.childForFieldName('parameter');
          if (single !== null) bindPattern(single, 'parameter');
        }
        const body = node.childForFieldName('body');
        const at = sourceSpan(node);
        const candidates = symbols.filter((symbol) => symbol.functionLike && !symbol.local && symbol.span.startByte <= at.byteStart && symbol.span.endByte === at.byteEnd);
        const nearestStart = Math.max(...candidates.map((symbol) => symbol.span.startByte));
        const owners = candidates.filter((symbol) => symbol.span.startByte === nearestStart);
        if (body === null) factGaps.set(expressionId(node), {path:file.path, reason:`line ${at.lineStart}: callable declaration has no body at bytes ${at.byteStart}-${at.byteEnd}`});
        else if (owners.length !== 1) factGaps.set(expressionId(node), {path:file.path, reason:`line ${at.lineStart}: callable has no unique canonical symbol at bytes ${at.byteStart}-${at.byteEnd}`});
        if (body !== null && owners.length === 1) {
          const receiverList = go ? node.childForFieldName('receiver') : null;
          const receiverParameter = receiverList === null ? undefined : named(receiverList).find((parameter) => parameter.type === 'parameter_declaration');
          const names = receiverParameter?.childrenForFieldName('name').filter((name): name is SyntaxNode => name !== null) ?? [];
          const receiverName = names.length === 1 ? names[0] : undefined;
          const receiverBinding = receiverName === undefined ? undefined : lookupBinding(textOf(receiverName, text));
          const typeNode = receiverParameter?.childForFieldName('type');
          const directType = typeNode?.type === 'pointer_type' ? named(typeNode)[0] : typeNode;
          const typeName = directType?.type === 'type_identifier' ? textOf(directType, text) : undefined;
          callables.push({ key: owners[0]!.key, bodySpan: sourceSpan(body), bodySyntaxKind: body.type,
            ...(receiverName === undefined || receiverBinding === undefined ? {} : { receiver: { bindingId: receiverBinding, name: textOf(receiverName, text), ...(typeName === undefined ? {} : { typeName }) } }) });
        }
        visitChildren(node);
        popScope();
        genericNames.pop();
        typeParameters.pop();
        return;
      }
      if (type === 'class_declaration' || type === 'abstract_class_declaration' || type === 'class') {
        pushScope(node);
        pushTypeParameters(node);
        const name = node.childForFieldName('name');
        if (name !== null) bind('this', asType(program.resolveTypeText(textOf(name, text), file.path)), name, 'receiver');
        visitChildren(node);
        popScope();
        typeParameters.pop();
        return;
      }
      if (['statement_block', 'block', 'program', 'source_file'].includes(type)) {
        const nested = type === 'statement_block' || type === 'block';
        if (nested) pushScope(node);
        if (go) prepareGoScope(node, !nested);
        if (!go) {
          // Lexical declarations shadow for their whole scope, including TDZ.
          for (const entry of named(node)) {
            const statement = entry.type === 'export_statement' ? entry.childForFieldName('declaration') ?? entry : entry;
            if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
              for (const declarator of named(statement)) {
                const name = declarator.childForFieldName('name');
                if (name !== null) bindPattern(name, 'local');
              }
            } else if (['function_declaration', 'class_declaration'].includes(statement.type)) {
              const name = statement.childForFieldName('name');
              if (name !== null) bind(textOf(name, text), undefined, name);
            }
          }
        }
        // The existing type resolver never predeclared the file scope. The
        // fact-only TDZ reservation must not change its top-level type lookup.
        if (!nested && !go) scopes[0]!.clear();
        visitChildren(node);
        if (nested) popScope();
        return;
      }
      if (type === 'catch_clause') {
        pushScope(node);
        const parameter = node.childForFieldName('parameter');
        if (parameter !== null) bindPattern(parameter, 'parameter');
        visitChildren(node);
        popScope();
        return;
      }
      if (type === 'new_expression') {
        const constructor = node.childForFieldName('constructor');
        if (constructor !== null) {
          recordExpression(constructor);
          for (const child of named(constructor)) recordExpression(child);
        }
        const made = evaluate(constructor);
        const owner = made?.t === 'type' ? program.types.get(made.id) : undefined;
        if (constructor !== null && owner?.kind === 'class') {
          const explicit = owner.members.get('constructor');
          sites.push({ span: spanOf(constructor), to: symbolKey(explicit?.file ?? owner.file, explicit?.qualifiedName ?? owner.name), use: 'call', fanOut: [] });
          // Construction also names the class. Keep navigation, liveness and
          // test subjects without claiming a second call to the class itself.
          sites.push({ span: spanOf(constructor), to: symbolKey(owner.file, owner.name), use: 'reference', fanOut: [] });
        }
        for (const child of named(node)) if (constructor === null || child.id !== constructor.id) visit(child);
        return;
      }
      if (type === 'type_identifier' || type === 'nested_type_identifier') {
        if (typeParameters.some((scope) => scope.has(textOf(node, text)))) {
          suppressed.add(spanOf(node).startByte);
          return;
        }
        // A namespace-qualified type still has a lexical module reference.
        // Retain its binding without treating the property name as a variable.
        if (type === 'nested_type_identifier') {
          const module = node.childForFieldName('module');
          if (module !== null) visit(module);
        }
        const parent = node.parent;
        const declarationName = parent?.childForFieldName('name');
        const heritage = ['extends_clause', 'extends_type_clause', 'implements_clause'].includes(parent?.type ?? '');
        if (!heritage && (declarationName?.id !== node.id || parent?.type === 'generic_type')) {
          const resolved = typeFrom(textOf(node, text));
          const target = resolved?.t === 'type' ? program.types.get(resolved.id) : undefined;
          if (target !== undefined) sites.push({ span: spanOf(node), to: symbolKey(target.file, target.name), use: 'type', fanOut: [] });
        }
        return;
      }
      if (type === 'call_expression') {
        const callee = node.childForFieldName('function');
        if (callee !== null) {
          recordExpression(callee);
          for (const child of named(callee)) recordExpression(child);
        }
        for (const child of named(node)) {
          if (callee !== null && child.id === callee.id && (callee.type === 'selector_expression' || callee.type === 'member_expression')) {
            memberSite(callee, 'call');
            const { object } = parts(callee);
            if (object !== null) visit(object);
            continue;
          }
          visit(child);
        }
        return;
      }
      if (type === 'selector_expression' || type === 'member_expression') {
        memberSite(node, 'reference');
        const { object } = parts(node);
        if (object !== null) visit(object);
        return;
      }
      if (type === 'qualified_type' && go) {
        for (const child of named(node)) recordExpression(child);
        const pkg = node.childForFieldName('package');
        const name = node.childForFieldName('name');
        const binding = pkg === null ? undefined : ctx.imports.get(textOf(pkg, text));
        if (name !== null && binding !== undefined && binding.kind === 'package' && lookup(textOf(pkg!, text)) === undefined) {
          const top = program.top(binding.scope, textOf(name, text));
          if (top !== undefined) sites.push({ span: spanOf(name), to: symbolKey(top.file, top.name), use: 'type', fanOut: [] });
        }
        return;
      }
      if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement', 'update_expression', 'inc_statement', 'dec_statement'].includes(type)) {
        visitChildren(node);
        // Declaration facts retain their original import/initializer identity.
        // Assignment expressions carry writes; consumers must reject stale
        // values without erasing the origin needed to diagnose that rejection.
        return;
      }
      if (go && (type === 'type_spec' || type === 'type_alias')) {
        const name = node.childForFieldName('name'); const body = node.childForFieldName('type');
        if (type === 'type_spec' && name !== null && body?.type === 'struct_type') {
          const ownerTypeName = textOf(name,text);
          const list = named(body).find((child) => child.type === 'field_declaration_list');
          for (const field of list === undefined ? [] : named(list)) {
            const typeNode = field.childForFieldName('type');
            if (field.type !== 'field_declaration' || typeNode === null) continue;
            for (const fieldName of field.childrenForFieldName('name')) if (fieldName !== null && fieldName.type === 'field_identifier') {
              const written = textOf(fieldName,text);
              fields.push({key:symbolKey(file.path,`${ownerTypeName}.${written}`),path:file.path,name:written,ownerTypeName,
                ownerDeclaration:expressionId(node),span:sourceSpan(fieldName),typeExpression:expressionId(typeNode)});
            }
          }
        }
        // The scope starts at the TypeSpec identifier, including its own body.
        if (factScopes.length > 1) declareGoType(node, false);
        visitChildren(node); return;
      }
      if (type === 'short_var_declaration' && go) {
        visitChildren(node);
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const targets = left === null ? [] : named(left);
        const values = right === null ? [] : named(right);
        const scopeNode=scopeNodes[scopeNodes.length-1]!;
        const functionBody=scopeNode.parent!==null && FUNCTION_NODES.has(scopeNode.parent.type) && scopeNode.parent.childForFieldName('body')?.id===scopeNode.id;
        const reused=(target:SyntaxNode):CodeBindingFact|undefined=>{
          const written=textOf(target,text);const current=factScopes[factScopes.length-1]!.get(written);
          if(current!==undefined)return bindings.get(current);
          const parent=functionBody&&factScopes.length>1?bindings.get(factScopes[factScopes.length-2]!.get(written)??''):undefined;
          return parent?.kind==='parameter'?parent:undefined;
        };
        const identifiers=targets.filter((target)=>target.type==='identifier'&&textOf(target,text)!=='_');
        const hasNew=identifiers.some((target)=>reused(target)===undefined);
        const unique=new Set(identifiers.map((target)=>textOf(target,text))).size===identifiers.length;
        if(!hasNew || !unique){
          const at=sourceSpan(node);factGaps.set(expressionId(node),{path:file.path,reason:`line ${at.lineStart}: Go short declaration has no unique new binding at bytes ${at.byteStart}-${at.byteEnd}`});
          return;
        }
        targets.forEach((target, index) => {
          if (target.type !== 'identifier' || textOf(target,text)==='_') return;
          const previous=reused(target);
          if(previous!==undefined){
            // A legal := reuse assigns the existing binding; it does not create
            // a new local identity or replace a parameter's declaration. Its old
            // initializer is no longer reaching-definition evidence.
            if(previous.kind==='local'){
              const {initializer:discarded,...retained}=previous;
              void discarded;bindings.set(previous.id,retained);
            }
            for(let scope=scopes.length-1;scope>=0;scope--)if(scopes[scope]!.has(previous.name)){
              scopes[scope]!.set(previous.name,null);break;
            }
            recordExpression(target);return;
          }
          bind(textOf(target, text), values.length === targets.length ? evaluate(values[index]) : index === 0 ? evaluate(values[0]) : undefined, target, 'local', values.length === targets.length ? values[index] : index === 0 ? values[0] : undefined);
        });
        return;
      }
      if ((type === 'var_spec' || type === 'const_spec') && go) {
        visitChildren(node);
        const declared = typeFrom(goTypeName(node.childForFieldName('type'), text));
        const value = node.childForFieldName('value');
        const values = value === null ? [] : named(value);
        node.childrenForFieldName('name').forEach((name, index) => {
          if (name !== null) bind(textOf(name, text), declared ?? evaluate(values[index]), name, 'local', values[index]);
        });
        return;
      }
      if (type === 'variable_declarator' && !go) {
        visitChildren(node);
        const name = node.childForFieldName('name');
        if (name === null) return;
        const annotation = node.childForFieldName('type');
        const value = node.childForFieldName('value');
        const ty = annotation !== null ? typeFrom(tsTypeName(annotation, text)) : evaluate(value);
        if (name.type === 'identifier') bind(textOf(name, text), ty, name, 'local', value);
        else if (name.type === 'object_pattern' && ty !== undefined && ty.t === 'type') {
          bindPattern(name, 'local');
          for (const entry of named(name)) {
            if (entry.type !== 'shorthand_property_identifier_pattern') continue;
            const field = program.findMember(ty.id, textOf(entry, text));
            if (field !== undefined && field.member.kind === 'field') bind(textOf(entry, text), typeFrom2(field.member.type, field.member.file), entry);
          }
        } else bindPattern(name, 'local');
        return;
      }
      visitChildren(node);
    };
    // Copy every structural child, including nodes deliberately skipped by the
    // member resolver. Missing semantic binding is unknown, not an outer name.
    for (const capture of captures) {
      recordExpression(capture.node, false);
      if (capture.node.type === 'ERROR' || capture.node.isMissing) {
        const span = sourceSpan(capture.node);
        factGaps.set(expressionId(capture.node), { path: file.path, reason: `line ${span.lineStart}: syntax ${capture.node.isMissing ? 'missing node' : 'error'} at bytes ${span.byteStart}-${span.byteEnd}` });
      }
    }
    visit(parsed.root);
    const typeOnlyImports: string[] = [];
    if (!go) for (const statement of named(parsed.root).filter((node) => node.type === 'import_statement')) {
      const wholeType = statement.children.some((child) => child !== null && child.type === 'type');
      for (const imported of imports) {
        const statementSpan = sourceSpan(statement);
        if (imported.span.byteStart < statementSpan.byteStart || imported.span.byteEnd > statementSpan.byteEnd) continue;
        const selected = captures.map((capture) => capture.node).find((node) => node.type === 'import_specifier' && sourceSpan(node).byteStart <= imported.span.byteStart && sourceSpan(node).byteEnd >= imported.span.byteEnd);
        if (wholeType || selected?.children.some((child) => child !== null && child.type === 'type')) typeOnlyImports.push(imported.id);
      }
    }
    const exports: CodeExportFact[] = [];
    if (!go) for (const statement of named(parsed.root).filter((node) => node.type === 'export_statement')) {
      if (statement.children.some((child) => child !== null && child.type === 'type')) continue;
      const declaration = statement.childForFieldName('declaration');
      const value = statement.childForFieldName('value');
      const source = statement.childForFieldName('source');
      const specifier = source === null ? undefined : decodeStringToken(source.type, textOf(source, text));
      const isDefault = statement.children.some((child) => child !== null && child.type === 'default');
      const append = (name: string, at: SyntaxNode, expression?: string, localBinding?: string, reexport?: CodeExportFact['reexport']): void => {
        const span = sourceSpan(at);
        exports.push({ id: codeFactId(span, `export:${name}`), path: file.path, name, span,
          ...(expression === undefined ? {} : { expression }), ...(localBinding === undefined ? {} : { localBinding }), ...(reexport === undefined ? {} : { reexport }) });
      };
      if (isDefault) {
        const exported = value ?? declaration;
        if (exported !== null) {
          const binding = exported.type === 'identifier' ? lookupBinding(textOf(exported, text)) : undefined;
          append('default', statement, exported.type === 'identifier' ? undefined : expressionId(exported), binding);
        }
        continue;
      }
      if (declaration !== null) {
        if (['lexical_declaration', 'variable_declaration'].includes(declaration.type)) for (const binding of bindings.values()) {
          if (binding.kind !== 'local' || binding.scope.byteStart !== scopeSpans[0]!.byteStart || binding.scope.byteEnd !== scopeSpans[0]!.byteEnd) continue;
          if (binding.span.byteStart < sourceSpan(declaration).byteStart || binding.span.byteEnd > sourceSpan(declaration).byteEnd) continue;
          append(binding.name, declaration, undefined, binding.id);
        }
        // Functions/classes have their own canonical expression, not a value binding.
        const name = declaration.childForFieldName('name');
        if (name !== null && !['lexical_declaration', 'variable_declaration'].includes(declaration.type)) append(textOf(name, text), declaration, expressionId(declaration));
      }
      for (const clause of named(statement).filter((node) => node.type === 'export_clause')) for (const item of named(clause)) {
        if (item.type !== 'export_specifier' || item.children.some((child) => child !== null && child.type === 'type')) continue;
        const name = item.childForFieldName('name');
        const alias = item.childForFieldName('alias');
        if (name === null) continue;
        const exportedName = alias === null ? textOf(name, text) : alias.type === 'string' ? decodeStringToken(alias.type, textOf(alias, text)) : textOf(alias, text);
        const localName = name.type === 'string' ? decodeStringToken(name.type, textOf(name, text)) : textOf(name, text);
        if (typeof exportedName !== 'string' || typeof localName !== 'string') continue;
        if (source !== null) {
          if (typeof specifier === 'string') append(exportedName, item, undefined, undefined, { specifier, name: localName });
        } else append(exportedName, item, undefined, lookupBinding(localName));
      }
      if (source !== null && !named(statement).some((node) => node.type === 'export_clause')) {
        const span = sourceSpan(statement);
        factGaps.set(expressionId(statement), { path: file.path, reason: `line ${span.lineStart}: wildcard/namespace re-export has no unambiguous exported-value facts at bytes ${span.byteStart}-${span.byteEnd}` });
      }
    }
    return { sites, accesses, suppressed, bindings: [...bindings.values()], expressions: [...expressions.values()], calls: [...calls.values()], exports, fields, typeOnlyImports, callables, gaps: [...factGaps.values()] };
  });
  return read.read ? { ...read.value, read: true } : { sites: [], accesses: new Map(), suppressed: new Set(), bindings: [], expressions: [], calls: [], exports: [], fields: [], typeOnlyImports: [], callables: [], gaps: [], read: false };
}
