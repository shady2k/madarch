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
import { symbolKey } from './keys.js';

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

export async function memberSites(file: SourceFile, program: Program): Promise<{ readonly sites: readonly MemberSite[]; readonly accesses: ReadonlyMap<number, readonly string[]>; readonly suppressed: ReadonlySet<number>; readonly read: boolean }> {
  const ctx = program.files.get(file.path);
  if (ctx === undefined) return { sites: [], accesses: new Map(), suppressed: new Set(), read: false };
  const go = file.language === 'go';
  const read = await readSyntaxTree(file.path, file.bytes, (parsed) => {
    const text = parsed.text;
    const spanOf = spanFactory(text);
    const sites: MemberSite[] = [];
    const accesses = new Map<number, readonly string[]>();
    const suppressed = new Set<number>();
    const scopes: Map<string, Ty | null>[] = [new Map()];
    const typeParameters: Set<string>[] = [];

    const lookup = (name: string): Ty | null | undefined => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const held = scopes[i]!;
        if (held.has(name)) return held.get(name);
      }
      return undefined;
    };
    const bind = (name: string, ty: Ty | undefined): void => {
      if (name === '_') return;
      scopes[scopes.length - 1]!.set(name, ty ?? null);
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
          for (const name of parameter.childrenForFieldName('name')) if (name !== null) bind(textOf(name, text), ty);
        } else {
          if (parameter.type !== 'required_parameter' && parameter.type !== 'optional_parameter') continue;
          const pattern = parameter.childForFieldName('pattern');
          if (pattern === null || pattern.type !== 'identifier') continue;
          bind(textOf(pattern, text), typeFrom(tsTypeName(parameter.childForFieldName('type'), text)));
        }
      }
    };

    const visitChildren = (node: SyntaxNode): void => {
      for (const child of named(node)) visit(child);
    };

    const visit = (node: SyntaxNode): void => {
      const type = node.type;
      if (type === 'identifier' || type === 'shorthand_property_identifier') accesses.set(spanOf(node).startByte, accessRoles(node));
      if (FUNCTION_NODES.has(type)) {
        scopes.push(new Map());
        pushTypeParameters(node);
        if (go) {
          bindParameters(node.childForFieldName('receiver'));
          bindParameters(node.childForFieldName('parameters'));
        } else {
          bindParameters(node.childForFieldName('parameters'));
          const single = node.childForFieldName('parameter');
          if (single !== null && single.type === 'identifier') bind(textOf(single, text), undefined);
        }
        visitChildren(node);
        scopes.pop();
        typeParameters.pop();
        return;
      }
      if (type === 'class_declaration' || type === 'abstract_class_declaration' || type === 'class') {
        scopes.push(new Map());
        pushTypeParameters(node);
        const name = node.childForFieldName('name');
        if (name !== null) bind('this', asType(program.resolveTypeText(textOf(name, text), file.path)));
        visitChildren(node);
        scopes.pop();
        typeParameters.pop();
        return;
      }
      if (['statement_block', 'block'].includes(type)) {
        scopes.push(new Map());
        if (!go) {
          // Lexical bindings shadow the outer name throughout this block,
          // including their temporal dead zone before the declaration.
          for (const statement of named(node)) {
            if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
              for (const declarator of named(statement)) {
                const name = declarator.childForFieldName('name');
                if (name?.type === 'identifier') bind(textOf(name, text), undefined);
              }
            } else if (['function_declaration', 'class_declaration'].includes(statement.type)) {
              const name = statement.childForFieldName('name');
              if (name !== null) bind(textOf(name, text), undefined);
            }
          }
        }
        visitChildren(node);
        scopes.pop();
        return;
      }
      if (type === 'new_expression') {
        const constructor = node.childForFieldName('constructor');
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
        const pkg = node.childForFieldName('package');
        const name = node.childForFieldName('name');
        const binding = pkg === null ? undefined : ctx.imports.get(textOf(pkg, text));
        if (name !== null && binding !== undefined && binding.kind === 'package' && lookup(textOf(pkg!, text)) === undefined) {
          const top = program.top(binding.scope, textOf(name, text));
          if (top !== undefined) sites.push({ span: spanOf(name), to: symbolKey(top.file, top.name), use: 'type', fanOut: [] });
        }
        return;
      }
      if (type === 'short_var_declaration' && go) {
        visitChildren(node);
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const targets = left === null ? [] : named(left);
        const values = right === null ? [] : named(right);
        targets.forEach((target, index) => {
          if (target.type !== 'identifier') return;
          bind(textOf(target, text), values.length === targets.length ? evaluate(values[index]) : index === 0 ? evaluate(values[0]) : undefined);
        });
        return;
      }
      if ((type === 'var_spec' || type === 'const_spec') && go) {
        visitChildren(node);
        const declared = typeFrom(goTypeName(node.childForFieldName('type'), text));
        const value = node.childForFieldName('value');
        const values = value === null ? [] : named(value);
        node.childrenForFieldName('name').forEach((name, index) => {
          if (name !== null) bind(textOf(name, text), declared ?? evaluate(values[index]));
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
        if (name.type === 'identifier') bind(textOf(name, text), ty);
        else if (name.type === 'object_pattern' && ty !== undefined && ty.t === 'type') {
          for (const entry of named(name)) {
            if (entry.type !== 'shorthand_property_identifier_pattern') continue;
            const field = program.findMember(ty.id, textOf(entry, text));
            if (field !== undefined && field.member.kind === 'field') bind(textOf(entry, text), typeFrom2(field.member.type, field.member.file));
          }
        }
        return;
      }
      visitChildren(node);
    };
    visit(parsed.root);
    return { sites, accesses, suppressed };
  });
  return read.read ? { ...read.value, read: true } : { sites: [], accesses: new Map(), suppressed: new Set(), read: false };
}
